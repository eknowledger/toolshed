/**
 * Properties of the metric cardinality tool that single fixtures cannot pin.
 *
 *   pnpm test
 *
 *  - labels multiply: the series count is the product of the value counts, checked against a count made the slow
 *    way, by listing every combination;
 *  - adding a value to any label never reduces the count, and every target adds the same number again;
 *  - a classic histogram is always buckets + 3 per label set (+Inf, _sum, _count), one more with _created;
 *  - dropping a label never leaves more series than keeping it, and the chart's bars are the table's numbers;
 *  - the answer comes first: the number and its multiplication, then the changes, fewest series first, then the
 *    quiet numbers and the method;
 *  - on every backend the labels multiply the same way, and only what one label set writes, the targets factor,
 *    the limits and the billing unit change: a CloudWatch or Azure custom metric is one series whatever its type, and
 *    a provider's limit is flagged only when this metric breaks it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Output, Row } from "@toolbench/sdk";
import tool, { BACKENDS, count, perLabelSet, readLabels } from "./index.ts";

const base = {
	backend: "prometheus",
	labels: "route 8\nstatus 5",
	type: "histogram",
	client: "python",
	buckets: 14,
	created: true,
	targets: 1,
	occur: 100,
	interval: 15,
	price: 0,
};

/** "route 8\nstatus 5" as the rows the form gives `run`, so a test reads like the metric it describes. */
function rows(text: string): Row[] {
	return text
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			const [name, values] = line.trim().split(/\s+/);
			return { name: name!, values: Number(values) };
		});
}

function parts(values: Partial<typeof base>): Output[] {
	const out = tool.run({ ...base, ...values, labels: rows(values.labels ?? base.labels) });
	assert.equal(out.kind, "group");
	return out.kind === "group" ? out.parts : [];
}
const n = (s: string) => Number(s.replace(/,/g, "").replace(/ (series|custom metrics?)$/, ""));
/** The answer: the key number, "720 series". */
function seriesOf(values: Partial<typeof base>): number {
	const key = parts(values)[0];
	assert.ok(key?.kind === "fields" && key.role === "key");
	return n(key.fields[0]!.value);
}

/** Every combination of label values, listed one by one. */
function combinations(counts: number[]): number {
	let rows: number[][] = [[]];
	for (const c of counts) rows = rows.flatMap((r) => Array.from({ length: c }, (_, i) => [...r, i]));
	return rows.length;
}

describe("metric-cardinality", () => {
	it("multiplies the labels, as listing every combination does", () => {
		for (const counts of [[1], [3, 4], [2, 3, 5], [7, 1, 2, 3], [4, 4, 4, 4]]) {
			const text = counts.map((c, i) => `l${i} ${c}`).join("\n");
			assert.equal(count(readLabels(rows(text)), 100), combinations(counts), text);
			assert.equal(seriesOf({ labels: text, type: "gauge" }), combinations(counts), text);
		}
	});

	it("never falls when a label gains a value, and grows by the same amount per target", () => {
		let last = 0;
		for (let v = 1; v <= 40; v++) {
			const s = seriesOf({ labels: `route 8\ntenant ${v}` });
			assert.ok(s >= last, `tenant ${v}`);
			last = s;
		}
		const one = seriesOf({ targets: 1 });
		for (let t = 1; t <= 50; t++) assert.equal(seriesOf({ targets: t }), one * t);
	});

	it("writes buckets + 3 series per histogram label set, one more with _created", () => {
		for (let b = 0; b <= 40; b++) {
			assert.equal(perLabelSet("histogram", b, 0, false).n, b + 3);
			assert.equal(perLabelSet("histogram", b, 0, true).n, b + 4);
		}
		assert.equal(perLabelSet("histogram", 14, 0, true).n, 18, "prometheus_client's default histogram");
	});

	it("never leaves more series without a label than with it, and draws the table's numbers", () => {
		const ps = parts({ labels: "route 12\nmethod 3\nstatus 6\ntenant 50", targets: 3, occur: 40 });
		const table = ps.find((p) => p.kind === "table" && p.role === "comparison");
		const chart = ps.find((p) => p.kind === "series");
		assert.ok(table?.kind === "table" && chart?.kind === "series");
		const points = chart.chart.series[0]!.points;
		const total = points.at(-1)!;
		assert.equal(chart.chart.x.at(-1), "Now");
		table.rows.forEach((row, i) => {
			const after = n((row[1] as { text: string }).text);
			assert.ok(after <= total);
			assert.equal(points[i], after);
			assert.equal(chart.chart.x[i], row[0]);
		});
	});

	it("names the row a label is refused on", () => {
		const refused = (labels: Row[]) => {
			const out = tool.run({ ...base, labels });
			return out.kind === "error" ? [out.input, out.row] : [];
		};
		assert.deepEqual(
			refused([
				{ name: "route", values: 8 },
				{ name: " ", values: 5 },
			]),
			["labels", 1],
		);
		assert.deepEqual(
			refused([
				{ name: "route", values: 8 },
				{ name: "route", values: 3 },
			]),
			["labels", 1],
		);
		assert.deepEqual(
			refused([
				{ name: "status", values: 5 },
				{ name: "le", values: 5 },
			]),
			["labels", 1],
		);
		assert.deepEqual(refused([{ name: "2xx", values: 5 }]), ["labels", 0]);
	});

	it("leads with the number and its multiplication, then the changes, then the quiet numbers and the method", () => {
		const ps = parts({ labels: "route 12\nmethod 3\nstatus 6\ntenant 50" });
		assert.deepEqual(
			ps.map((p) => p.role ?? p.kind),
			["key", "formula", "series", "comparison", "metrics", "method"],
		);
		const k = ps[0];
		assert.ok(
			k?.kind === "fields" && k.fields.length === 1 && k.fields[0]!.tone === undefined,
			"the key is a number, not a judgement",
		);
		const m = ps[4];
		assert.ok(m?.kind === "fields" && m.fields.length >= 3 && m.fields.length <= 4);
	});

	it("puts the native histogram in the chart, and offers no changes when there are none", () => {
		const chart = parts({}).find((p) => p.kind === "series");
		assert.ok(chart?.kind === "series");
		assert.deepEqual(chart.chart.x, ["Native histogram", "Without route", "Without status", "Without _created", "Now"]);
		assert.deepEqual(
			parts({ labels: "", type: "gauge" }).map((p) => p.role ?? p.kind),
			["key", "formula", "metrics", "method"],
		);
	});

	it("orders the actions by the series each leaves, fewest first", () => {
		for (const labels of ["route 8\nstatus 5", "route 12\nmethod 3\nstatus 6\ntenant 50", "user_id 250000"]) {
			const a = parts({ labels }).find((p) => p.role === "comparison");
			assert.ok(a?.kind === "table");
			const after = a.rows.map((r) => n((r[1] as { text: string }).text));
			assert.deepEqual(
				after,
				[...after].sort((x, y) => x - y),
				labels,
			);
			for (const v of after) assert.ok(v <= seriesOf({ labels }));
		}
	});

	it("each client preset is what that library writes for one default histogram", () => {
		assert.equal(seriesOf({ labels: "", buckets: 14, created: true }), 18, "Python");
		assert.equal(seriesOf({ labels: "", buckets: 14, created: false }), 17, "Python without _created");
		assert.equal(seriesOf({ labels: "", buckets: 11, created: false }), 14, "Go");
	});

	it("multiplies the labels the same way on every backend, and only the targets factor differs", () => {
		for (const backend of Object.keys(BACKENDS)) {
			const counts = [3, 4, 5];
			const text = counts.map((c, i) => `l${i} ${c}`).join("\n");
			const t = BACKENDS[backend]!.targetsMultiply ? 7 : 1;
			assert.equal(seriesOf({ backend, labels: text, type: "gauge", targets: 7 }), combinations(counts) * t, backend);
		}
	});

	it("counts a CloudWatch or Azure custom metric once per label set, whatever its type and however many write it", () => {
		for (const backend of ["cloudwatch", "azure-custom"]) {
			for (const type of ["histogram", "counter", "gauge", "summary3", "native"]) {
				assert.equal(seriesOf({ backend, type, targets: 1 }), 40, `${backend} ${type}`);
				assert.equal(seriesOf({ backend, type, targets: 50 }), 40, `${backend} ${type} on 50 targets`);
			}
		}
	});

	it("stores a histogram as one distribution on Google, but bills it up to its buckets + 3 samples", () => {
		const ps = parts({ backend: "gmp", created: false, interval: 30 });
		assert.equal(seriesOf({ backend: "gmp", created: false }), 40);
		const m = ps.find((p) => p.role === "metrics");
		assert.ok(m?.kind === "fields");
		const samples = m.fields.find((f) => f.label === "Samples ingested")!;
		// 40 label sets x (14 buckets + 1 overflow + 2) samples x 86,400 scrapes in 30 days at 30 s.
		assert.equal(40 * 17 * 86_400, 58_752_000);
		assert.equal(samples.value, "Up to 58.75 million a month");
	});

	it("flags a provider's limit only when this metric alone breaks it", () => {
		const over = (values: Partial<typeof base>) => {
			const m = parts(values).find((p) => p.role === "metrics");
			return m?.kind === "fields" ? m.fields.some((f) => f.label.endsWith(" limit") && f.tone === "bad") : false;
		};
		assert.equal(over({ backend: "azure-custom", labels: "user 50000", type: "gauge" }), false);
		assert.equal(over({ backend: "azure-custom", labels: "user 50001", type: "gauge" }), true);
		assert.equal(over({ backend: "azure-custom", labels: "a 1\nb 1\nc 1\nd 1\ne 1\nf 1\ng 1\nh 1\ni 1\nj 1" }), false);
		assert.equal(
			over({ backend: "azure-custom", labels: "a 1\nb 1\nc 1\nd 1\ne 1\nf 1\ng 1\nh 1\ni 1\nj 1\nk 1" }),
			true,
		);
		// Google's limit is per monitored resource, so spreading a metric over more targets does not break it.
		assert.equal(over({ backend: "gcm-custom", labels: "user 200000", type: "gauge", targets: 9 }), false);
		assert.equal(over({ backend: "gcm-custom", labels: "user 200001", type: "gauge", targets: 1 }), true);
		assert.equal(over({ backend: "prometheus", labels: "user 9000000", type: "gauge" }), false);
	});

	it("refuses an interval shorter than Google accepts", () => {
		for (const backend of ["gmp", "gcm-custom"]) {
			const out = tool.run({ ...base, labels: rows(base.labels), backend, interval: 4 });
			assert.equal(out.kind, "error", backend);
			assert.equal(tool.run({ ...base, labels: rows(base.labels), backend, interval: 5 }).kind, "group", backend);
		}
	});

	it("keeps the same order of parts on every backend", () => {
		for (const backend of Object.keys(BACKENDS)) {
			assert.deepEqual(
				parts({ backend }).map((p) => p.role ?? p.kind),
				["key", "formula", "series", "comparison", "metrics", "method"],
				backend,
			);
		}
	});
});
