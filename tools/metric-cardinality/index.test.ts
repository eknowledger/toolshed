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
 *    quiet numbers and the method.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Output } from "@toolbench/sdk";
import tool, { count, parseLabels, perLabelSet } from "./index.ts";

const base = {
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

function parts(values: Partial<typeof base>): Output[] {
	const out = tool.run({ ...base, ...values });
	assert.equal(out.kind, "group");
	return out.kind === "group" ? out.parts : [];
}
const n = (s: string) => Number(s.replace(/,/g, "").replace(/ series$/, ""));
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
			assert.equal(count(parseLabels(text), 100), combinations(counts), text);
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

	it("reads the three ways of writing a label", () => {
		assert.deepEqual(parseLabels("a 1\nb=2, c: 3\n# a comment\n\nd 1_000"), [
			{ name: "a", values: 1 },
			{ name: "b", values: 2 },
			{ name: "c", values: 3 },
			{ name: "d", values: 1000 },
		]);
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
});
