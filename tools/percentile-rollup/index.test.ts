/**
 * Properties of the rollup that a fixture cannot pin, because they are claims about every input:
 *
 *  - the share under a threshold and the weighted mean are the same however the measurements are grouped;
 *  - the true percentile does not depend on the grouping either, while the average of the groups' does;
 *  - that average can be wrong in either direction, decided by how the traffic is split, not by the data alone;
 *  - nearest rank always returns a measurement, and linear interpolation never leaves the range.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Output, Tool } from "@toolbench/sdk";
import tool from "./index.ts";

type Input = { values: string; percentile: string; threshold: number };
const impl: Tool<Input> = tool;
const ctx = { signal: new AbortController().signal, progress: () => {} };

function run(values: string, extra: Partial<Input> = {}): Output[] {
	const out = impl.run({ values, percentile: "p99", threshold: 100, ...extra }, ctx);
	assert.ok(!(out instanceof Promise), "the rollup is synchronous: it runs on the main thread as a live card");
	assert.equal(out.kind, "group", out.kind === "error" ? out.message : "");
	return out.kind === "group" ? out.parts : [];
}

/**
 * The comparison's rows read as fields, so the assertions below name what they check: the caption and the pooled row as
 * "p99 across ...", with the claim as its note, the claim again as "How far off", and the averaged row as "Average".
 */
const asFields = (p: Output): { label: string; value: string; note?: string; tone?: string }[] => {
	if (p.kind === "fields") return p.fields;
	if (p.kind !== "table" || p.role !== "comparison") return [];
	const text = (c: unknown) => (typeof c === "string" ? c : (c as { text: string }).text);
	const [pooled, averaged] = p.rows;
	return [
		{ label: p.caption ?? "", value: text(pooled![1]), note: text(pooled![2]) },
		{ label: "How far off", value: text(pooled![2]), note: text(pooled![2]) },
		...(averaged ? [{ label: text(averaged[0]), value: text(averaged[1]), note: text(averaged[2]) }] : []),
	];
};
const field = (parts: Output[], prefix: string) => {
	for (const p of parts) {
		if (p.kind !== "fields" && p.kind !== "table") continue;
		const f = asFields(p).find((x) => x.label.startsWith(prefix));
		if (f) return f;
	}
	throw new Error(`no field starting "${prefix}"`);
};

/** mulberry32, so the generated data is the same on every run. */
function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Latencies around 20 with a slow tail on some, rounded to tenths so they paste the way a dashboard exports them. */
function latencies(n: number, slowShare: number, next: () => number): number[] {
	return Array.from({ length: n }, () => {
		const base = 10 + 20 * next();
		return Math.round((next() < slowShare ? base + 300 + 300 * next() : base) * 10) / 10;
	});
}

const paste = (groups: number[][]) => groups.map((g, i) => `host ${i + 1}: ${g.join(" ")}`).join("\n\n");

describe("what rolls up exactly does not depend on the grouping", () => {
	const next = rng(42);
	const all = latencies(600, 0.02, next);
	const groupings = [[all], [all.slice(0, 300), all.slice(300)], [all.slice(0, 50), all.slice(50, 120), all.slice(120, 400), all.slice(400)]];

	for (const threshold of [25, 100, 400]) {
		it(`the share under ${threshold} is the same for one, two and four groups`, () => {
			const shares = groupings.map((g) => field(run(paste(g), { threshold }), "Under").value);
			assert.equal(new Set(shares).size, 1, shares.join(" vs "));
		});
	}

	it("the mean is the same for every grouping, because it is weighted by count", () => {
		const means = groupings.map((g) => field(run(paste(g)), "Mean").value);
		assert.equal(new Set(means).size, 1, means.join(" vs "));
	});

	it("the true p99 is the same for every grouping", () => {
		const truths = groupings.map((g) => field(run(paste(g)), "p99 across").value);
		assert.equal(new Set(truths).size, 1, truths.join(" vs "));
	});
});

describe("the average of the groups' percentiles is wrong in both directions", () => {
	it("is too high when the slow group carries little of the traffic", () => {
		const next = rng(7);
		const groups = [latencies(500, 0, next), latencies(500, 0, next), latencies(500, 0, next), latencies(500, 0.03, next)];
		const avg = field(run(paste(groups)), "Average");
		assert.match(avg.note ?? "", /too high$/);
	});

	it("is too low when the slow group carries most of it", () => {
		const next = rng(7);
		const groups = [latencies(100, 0, next), latencies(100, 0, next), latencies(100, 0, next), latencies(1700, 0.03, next)];
		const avg = field(run(paste(groups)), "Average");
		assert.match(avg.note ?? "", /too low$/);
	});
});

describe("the two definitions", () => {
	const next = rng(3);
	const pooledRow = (parts: Output[], percentile: string) => {
		const table = parts.find((p) => p.kind === "table" && p.columns.some((c) => c.label === "Nearest rank"));
		assert.ok(table && table.kind === "table");
		const row = table.rows.find((r) => r[0] === percentile)!;
		return row.map((c) => Number(typeof c === "object" ? c.text : c));
	};
	for (const n of [1, 2, 3, 7, 20, 101]) {
		it(`with ${n} measurement(s), nearest rank returns one of them and linear stays inside their range`, () => {
			const values = latencies(n, 0.2, next);
			for (const percentile of ["p50", "p90", "p99", "p99.9"]) {
				const parts = run(values.join(" "), { percentile });
				const [, nearest, linear] = pooledRow(parts, percentile);
				assert.equal(Number(field(parts, `${percentile} across`).value), nearest, "the headline is nearest rank");
				assert.ok(values.includes(nearest!), `${nearest} is not one of the measurements`);
				assert.ok(linear! >= Math.min(...values) && linear! <= Math.max(...values), `${linear} is outside the range`);
			}
		});
	}
});

/** Count raw latencies (ms) into cumulative buckets with edges in seconds, the way a Prometheus client does. */
const EDGES = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1];
function buckets(groups: number[][], metric = "rpc_duration_seconds"): string {
	return groups
		.flatMap((g, i) => [
			...EDGES.map((e) => `${metric}_bucket{instance="h${i + 1}",le="${e}"} ${g.filter((v) => v <= e * 1000).length}`),
			`${metric}_bucket{instance="h${i + 1}",le="+Inf"} ${g.length}`,
		])
		.join("\n");
}
/** The value in a "123.4 ms" or "about 123.4 ms" field, in ms. */
const ms = (text: string) => Number(/([\d.]+) ms/.exec(text)![1]);

describe("histogram buckets", () => {
	const next = rng(11);
	const all = latencies(4000, 0.02, next);
	const splits = [[all], [all.slice(0, 1000), all.slice(1000)], [all.slice(0, 200), all.slice(200, 900), all.slice(900, 3000), all.slice(3000)]];

	it("the pooled estimate and the shares are the same however the requests are split across instances", () => {
		const verdicts = splits.map((g) => field(run(buckets(g), { threshold: 0.1 }), "p99 across").value);
		const shares = splits.map((g) => field(run(buckets(g), { threshold: 0.1 }), "At or under").value);
		assert.equal(new Set(verdicts).size, 1, verdicts.join(" vs "));
		assert.equal(new Set(shares).size, 1, shares.join(" vs "));
	});

	it("the share at or under an edge is the exact share of the raw requests", () => {
		const exact = all.filter((v) => v <= 100).length / all.length;
		assert.equal(field(run(buckets(splits[2]!), { threshold: 0.1 }), "At or under").value, `${(exact * 100).toFixed(3)}%`);
	});

	it("the true percentile of the raw requests lies inside the bucket the tool names as the bound", () => {
		for (const percentile of ["p50", "p90", "p99"]) {
			const parts = run(buckets(splits[1]!), { percentile, threshold: 0.1 });
			const bound = field(parts, "How far off").note ?? "";
			const [lo, hi] = [...bound.matchAll(/([\d.]+) (ms|s)/g)].map((m) => Number(m[1]) * (m[2] === "s" ? 1000 : 1));
			const truth = [...all].sort((a, b) => a - b)[Math.ceil((Number(percentile.slice(1)) / 100) * all.length) - 1]!;
			assert.ok(truth >= lo! && truth <= hi!, `${percentile}: ${truth} outside ${lo} to ${hi}`);
			const est = ms(field(parts, `${percentile} across`).value);
			assert.ok(est >= lo! && est <= hi!, `${percentile}: the estimate ${est} is outside its own bucket`);
		}
	});

	it("matches histogram_quantile on a case worked by hand: rank 9 of 10 in the 0.1 to 0.2 bucket", () => {
		const text = 'x_seconds_bucket{le="0.1"} 8\nx_seconds_bucket{le="0.2"} 10\nx_seconds_bucket{le="+Inf"} 10';
		// rank 0.9 x 10 = 9; 8 below the bucket, 2 in it: 0.1 + 0.1 x (9 - 8) / 2 = 0.15 s.
		assert.equal(field(run(text, { percentile: "p90", threshold: 0.1 }), "p90 across").value, "about 150 ms");
	});

	it("averaging the instances' estimates is wrong in both directions, as with raw latencies", () => {
		const n = rng(5);
		const light = [latencies(2000, 0, n), latencies(2000, 0, n), latencies(2000, 0, n), latencies(2000, 0.03, n)];
		const heavy = [latencies(300, 0, n), latencies(300, 0, n), latencies(300, 0, n), latencies(7000, 0.03, n)];
		assert.match(field(run(buckets(light), { threshold: 0.1 }), "Average").note ?? "", /too high$/);
		assert.match(field(run(buckets(heavy), { threshold: 0.1 }), "Average").note ?? "", /too low$/);
	});

	it("a CSV and the text format of the same buckets give the same answer", () => {
		const groups = [all.slice(0, 1500), all.slice(1500)];
		const csv = ["instance,le,count", ...groups.flatMap((g, i) => [...EDGES.map((e) => `h${i + 1},${e},${g.filter((v) => v <= e * 1000).length}`), `h${i + 1},+Inf,${g.length}`])].join("\n");
		const fromCsv = field(run(csv, { threshold: 0.1 }), "p99 across").value;
		const fromText = field(run(buckets(groups), { threshold: 0.1 }), "p99 across").value;
		// The CSV has no metric name, so it has no unit: the same number in seconds, to three significant figures.
		assert.ok(Math.abs(Number(fromCsv.replace("about ", "")) * 1000 - ms(fromText)) <= 0.5, `${fromCsv} against ${fromText}`);
	});
});

// ── Cloud formats ────────────────────────────────────────────────────────────────────────────────────────────────

/** Every part of an error or a group, so a test can ask for a message without knowing the shape. */
function runAny(values: string, extra: Partial<Input> = {}) {
	const out = impl.run({ values, percentile: "p99", threshold: 100, ...extra }, ctx);
	assert.ok(!(out instanceof Promise));
	return out;
}
const errorOf = (values: string, extra: Partial<Input> = {}) => {
	const out = runAny(values, extra);
	assert.equal(out.kind, "error", "expected the input to be refused");
	return out.kind === "error" ? out.message : "";
};
/** The edge column of the "every group together" table, as printed. */
const edgeColumn = (parts: Output[]) => {
	const table = parts.find((p) => p.kind === "table" && p.caption?.startsWith("Every"));
	assert.ok(table && table.kind === "table");
	return table.rows.map((r) => (typeof r[0] === "object" ? r[0].text : r[0]));
};

/** A Cloud Monitoring TimeSeries of one DELTA point, with the counts as strings, as the API sends int64. */
function gcpSeries(bucketOptions: object, bucketCounts: number[], labels: Record<string, string> = {}, extra: object = {}) {
	const total = sum(bucketCounts);
	return {
		metric: { type: "custom.googleapis.com/rpc_latency", labels },
		resource: { type: "generic_task", labels: {} },
		metricKind: "DELTA",
		valueType: "DISTRIBUTION",
		unit: "ms",
		points: [{ interval: { endTime: "2026-03-02T15:00:00Z" }, value: { distributionValue: { count: String(total), bucketOptions, bucketCounts: bucketCounts.map(String) } } }],
		...extra,
	};
}
const gcp = (...series: object[]) => JSON.stringify({ timeSeries: series });
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("Google Cloud Monitoring: bucket options become edges", () => {
	it("linear buckets: the upper edge of bucket i is offset + width x i, so offset 10 and width 5 give 10, 15, 20, 25", () => {
		const parts = run(gcp(gcpSeries({ linearBuckets: { numFiniteBuckets: 3, width: 5, offset: 10 } }, [0, 4, 4, 2, 0])), { percentile: "p50", threshold: 20 });
		assert.deepEqual(edgeColumn(parts), ["10", "15", "20", "25", "+Inf"]);
		// rank 5 of 10: 4 below 15, 4 in [15, 20), so 15 + 5 x (5 - 4) / 4 = 16.25 ms.
		// Shown to a tenth of the bucket's 5 ms, because the buckets support no more.
		assert.equal(field(parts, "p50 across").value, "about 16.3 ms");
		assert.equal(field(parts, "Under 20 ms").value, "80.000%");
	});

	it("exponential buckets: the upper edge of bucket i is scale x growthFactor ^ i, so scale 2 and factor 3 give 2, 6, 18, 54", () => {
		const parts = run(gcp(gcpSeries({ exponentialBuckets: { numFiniteBuckets: 3, growthFactor: 3, scale: 2 } }, [1, 1, 6, 2])), { percentile: "p90", threshold: 18 });
		assert.deepEqual(edgeColumn(parts), ["2", "6", "18", "54", "+Inf"]);
		// rank 9 of 10: 8 at or below 18, 2 in [18, 54), so 18 + 36 x (9 - 8) / 2 = 36 ms.
		assert.equal(field(parts, "p90 across").value, "about 36 ms");
	});

	it("exponential edges are cleaned of float noise, so 1.1 ^ 3 prints as 1.33 and not 1.3310000000000004", () => {
		const parts = run(gcp(gcpSeries({ exponentialBuckets: { numFiniteBuckets: 3, growthFactor: 1.1, scale: 1 } }, [0, 1, 1, 1, 1])), { threshold: 1.21 });
		assert.deepEqual(edgeColumn(parts), ["1", "1.1", "1.21", "1.33", "+Inf"]);
		assert.doesNotMatch(field(parts, "Under 1.21 ms").value, / to /, "1.1 x 1.1 must match a threshold of 1.21 exactly");
	});

	it("explicit buckets: the bounds are the edges, one fewer than there are buckets", () => {
		const parts = run(gcp(gcpSeries({ explicitBuckets: { bounds: [5, 50, 500] } }, [1, 97, 2, 0])), { threshold: 50 });
		assert.deepEqual(edgeColumn(parts), ["5", "50", "500", "+Inf"]);
		assert.equal(field(parts, "Under 50 ms").value, "98.000%");
	});

	it("a missing offset is 0, because proto3 JSON leaves out zero values", () => {
		const parts = run(gcp(gcpSeries({ linearBuckets: { numFiniteBuckets: 2, width: 10 } }, [0, 3, 1])), { threshold: 10 });
		assert.deepEqual(edgeColumn(parts), ["0", "10", "20", "+Inf"]);
	});

	it("the underflow bucket counts from 0 up to the first edge", () => {
		// 5 below 10 ms, 5 in [10, 20): p50 is rank 5, the last request of the underflow bucket, so 0 + 10 x 5 / 5 = 10 ms.
		const parts = run(gcp(gcpSeries({ linearBuckets: { numFiniteBuckets: 1, width: 10, offset: 10 } }, [5, 5, 0])), { percentile: "p50", threshold: 10 });
		assert.equal(field(parts, "p50 across").value, "about 10 ms");
		assert.equal(field(parts, "Under 10 ms").value, "50.000%");
		const low = run(gcp(gcpSeries({ linearBuckets: { numFiniteBuckets: 1, width: 10, offset: 10 } }, [9, 1, 0])), { percentile: "p50", threshold: 10 });
		// rank 5 of 10, 9 in the underflow bucket: 0 + 10 x 5 / 9 = 5.56 ms.
		// Shown to the nearest 1 ms, a tenth of the 10 ms bucket.
		assert.equal(field(low, "p50 across").value, "about 6 ms");
	});

	it("the overflow bucket has no upper edge, so a percentile in it is only known to be above the highest edge", () => {
		const parts = run(gcp(gcpSeries({ explicitBuckets: { bounds: [10, 20] } }, [0, 90, 10])));
		assert.equal(field(parts, "p99 across").value, "above 20 ms");
		assert.match(field(parts, "p99 across").note ?? "", /past the highest edge/);
		assert.match(field(parts, "How far off").value, /no upper bound/);
	});

	it("a short bucketCounts list leaves the remaining buckets empty", () => {
		const full = run(gcp(gcpSeries({ explicitBuckets: { bounds: [10, 20, 40] } }, [0, 6, 4, 0])), { percentile: "p50" });
		const short = run(gcp(gcpSeries({ explicitBuckets: { bounds: [10, 20, 40] } }, [0, 6, 4])), { percentile: "p50" });
		assert.equal(field(short, "p50 across").value, field(full, "p50 across").value);
	});

	it("more bucket counts than buckets, or a count that disagrees with them, is refused", () => {
		assert.match(errorOf(gcp(gcpSeries({ explicitBuckets: { bounds: [10] } }, [1, 1, 1]))), /3 bucket counts, but its bucketOptions describe only 2/);
		const wrong = gcpSeries({ explicitBuckets: { bounds: [10] } }, [1, 1]);
		(wrong.points[0]!.value.distributionValue as { count: string }).count = "5";
		assert.match(errorOf(gcp(wrong)), /count is 5, but its bucket counts add up to 2/);
	});

	it("a DELTA series adds its points; a CUMULATIVE series uses only its newest point, which already holds the others", () => {
		const opts = { explicitBuckets: { bounds: [10, 20] } };
		const point = (end: string, counts: number[]) => ({ interval: { endTime: end }, value: { distributionValue: { count: String(sum(counts)), bucketOptions: opts, bucketCounts: counts.map(String) } } });
		const points = [point("2026-03-02T15:02:00Z", [0, 30, 10]), point("2026-03-02T15:01:00Z", [0, 20, 0])];
		const delta = run(JSON.stringify({ timeSeries: [{ metricKind: "DELTA", unit: "ms", points }] }), { threshold: 20 });
		assert.equal(field(delta, "Requests").value, "60");
		const cumulative = run(JSON.stringify({ timeSeries: [{ metricKind: "CUMULATIVE", unit: "ms", points }] }), { threshold: 20 });
		assert.equal(field(cumulative, "Requests").value, "40");
	});

	it("series are named by the labels that differ between them", () => {
		const opts = { explicitBuckets: { bounds: [10, 20] } };
		const parts = run(gcp(gcpSeries(opts, [0, 50, 0], { zone: "a", code: "200" }), gcpSeries(opts, [0, 40, 10], { zone: "b", code: "200" })), { threshold: 20 });
		const table = parts.find((p) => p.kind === "table" && p.caption?.startsWith("Each"));
		assert.ok(table && table.kind === "table");
		assert.deepEqual(
			table.rows.map((r) => r[0]),
			// Slowest first: b has 10 requests past 20 ms.
			["b", "a"],
		);
	});

	it("series with different bucket options are refused, because buckets only add edge by edge", () => {
		assert.match(errorOf(gcp(gcpSeries({ explicitBuckets: { bounds: [10, 20] } }, [0, 1, 0], { z: "a" }), gcpSeries({ explicitBuckets: { bounds: [10, 30] } }, [0, 1, 0], { z: "b" }))), /different bucket edges/);
	});

	it("Cloud Monitoring buckets give the same estimate as Prometheus buckets with the same edges", () => {
		const next = rng(21);
		const groups = [latencies(3000, 0, next), latencies(1000, 0.04, next)];
		const bounds = EDGES.map((e) => e * 1000);
		const series = groups.map((g, i) => {
			// The first count is the underflow bucket, below bounds[0]; the last is the overflow bucket.
			const per = [...bounds.map((b, j) => g.filter((v) => v < b && v >= (j === 0 ? 0 : bounds[j - 1]!)).length), g.filter((v) => v >= bounds.at(-1)!).length];
			return gcpSeries({ explicitBuckets: { bounds } }, per, { host: `h${i + 1}` });
		});
		const fromGcp = field(run(gcp(...series), { threshold: 100 }), "p99 across").value;
		const fromProm = field(run(buckets(groups), { threshold: 0.1 }), "p99 across").value;
		assert.equal(fromGcp, fromProm);
	});
});

/** An X-Ray HistogramEntry list from latencies in ms: Value in seconds, Count how many took it. */
function xray(ms: number[]) {
	const tally = new Map<number, number>();
	for (const v of ms) tally.set(v / 1000, (tally.get(v / 1000) ?? 0) + 1);
	return [...tally.entries()].map(([Value, Count]) => ({ Value, Count }));
}

describe("AWS X-Ray: response-time histograms", () => {
	const next = rng(31);
	const groups = [latencies(400, 0, next), latencies(300, 0, next), latencies(500, 0.05, next)];
	const series = JSON.stringify({
		TimeSeriesServiceStatistics: groups.map((g, i) => ({ Timestamp: `2026-03-02T14:0${i}:00Z`, ResponseTimeHistogram: xray(g) })),
	});

	it("value and count pairs give the same percentiles as the raw latencies they count", () => {
		const fromXray = run(series, { threshold: 0.1 });
		const fromRaw = run(paste(groups), { threshold: 100 });
		for (const label of ["p99 across", "Average", "Mean"]) {
			assert.equal(ms(field(fromXray, label).value), Number(field(fromRaw, label).value), label);
		}
		assert.equal(field(fromXray, "Under 100 ms").value, field(fromRaw, "Under 100").value);
	});

	it("names each period by its minute, and each service of a service graph by its name, leaving out the client node", () => {
		assert.equal(field(run(series, { threshold: 0.1 }), "p99 across").label, "p99 across all 3 periods");
		const graph = JSON.stringify({
			Services: [
				{ Name: "callers", Type: "client", ResponseTimeHistogram: xray([1, 2, 3]) },
				{ Name: "checkout", Type: "AWS::EC2::Instance", ResponseTimeHistogram: xray(groups[0]!) },
				{ Name: "payments", Type: "AWS::Lambda::Function", ResponseTimeHistogram: xray(groups[1]!) },
			],
		});
		const parts = run(graph, { threshold: 0.1 });
		assert.equal(field(parts, "p99 across").label, "p99 across both services");
	});

	it("a bare HistogramEntry list is one group, and the tool says where to get one per minute", () => {
		const parts = run(JSON.stringify(xray(groups[0]!)), { threshold: 0.1 });
		assert.match(field(parts, "One group").value, /GetTimeSeriesServiceStatistics/);
	});

	it("a negative response time is refused", () => {
		assert.match(errorOf(JSON.stringify([{ Value: -0.1, Count: 2 }])), /response time is a number of seconds/);
	});
});

describe("bucket and count rows from a log query", () => {
	const kql = ["AppRoleInstance,DurationMs,requests", "a,0,10", "a,10,70", "a,20,20", "b,10,50", "b,40,50"].join("\n");

	it("reads the bin width from the spacing, so bin 10 covers 10 up to 20, and a bin with no row is empty", () => {
		const parts = run(kql, { percentile: "p50", threshold: 20 });
		assert.deepEqual(edgeColumn(parts), ["10", "20", "30", "40", "50", "+Inf"]);
		// 200 requests: 10 under 10, 130 under 20. Rank 100 sits in [10, 20): 10 + 10 x (100 - 10) / 120 = 17.5 ms.
		// Shown to the nearest 1 ms, a tenth of the 10 ms bin.
		assert.equal(field(parts, "p50 across").value, "about 18 ms");
		assert.equal(field(parts, "Under 20 ms").value, "65.000%");
	});

	it("the same bins as Log Analytics JSON, Logs Insights JSON and quoted CSV give the same answer", () => {
		const rows = kql.split("\n").slice(1).map((r) => r.split(","));
		const analytics = JSON.stringify({
			tables: [{ name: "PrimaryResult", columns: [{ name: "AppRoleInstance", type: "string" }, { name: "DurationMs", type: "real" }, { name: "requests", type: "long" }], rows: rows.map(([a, b, c]) => [a, Number(b), Number(c)]) }],
		});
		const insights = JSON.stringify({
			status: "Complete",
			results: rows.map(([a, b, c]) => [
				{ field: "instance", value: a },
				{ field: "bucket", value: b },
				{ field: "count(*)", value: c },
			]),
		});
		const quoted = ['"AppRoleInstance","DurationMs","requests"', ...rows.map((r) => r.map((c) => `"${c}"`).join(","))].join("\n");
		const expected = field(run(kql, { percentile: "p50", threshold: 20 }), "p50 across").value;
		assert.equal(field(run(analytics, { percentile: "p50", threshold: 20 }), "p50 across").value, expected);
		assert.equal(field(run(quoted, { percentile: "p50", threshold: 20 }), "p50 across").value, expected);
		// Logs Insights names its column bucket, which says nothing about the unit, so the same number has none.
		assert.equal(field(run(insights, { percentile: "p50", threshold: 20 }), "p50 across").value, expected.replace(" ms", ""));
	});

	it("bins that are not a whole number of widths apart are refused", () => {
		assert.match(errorOf("DurationMs,count_\n0,5\n10,5\n25,5"), /not evenly spaced/);
	});

	it("a Logs Insights query that has not finished is refused, because its counts are partial", () => {
		assert.match(errorOf(JSON.stringify({ status: "Running", results: [] })), /Running, not Complete/);
	});
});

describe("exports that hold percentiles are refused, and say why", () => {
	const refusal = /cannot be added up or averaged into a correct percentile/;
	it("CloudWatch GetMetricData", () => {
		const message = errorOf(JSON.stringify({ MetricDataResults: [{ Id: "p99", Label: "Latency", Timestamps: [], Values: [0.2, 0.3] }] }));
		assert.match(message, refusal);
		assert.match(message, /Logs Insights/);
	});
	it("CloudWatch GetMetricStatistics", () => {
		assert.match(errorOf(JSON.stringify({ Label: "Latency", Datapoints: [{ ExtendedStatistics: { p99: 0.2 } }] })), refusal);
	});
	it("Azure Monitor metrics", () => {
		const message = errorOf(JSON.stringify({ value: [{ name: { value: "requests/duration" }, timeseries: [{ data: [{ average: 120 }] }] }] }));
		assert.match(message, refusal);
		assert.match(message, /bin\(DurationMs, 10\)/);
	});
	it("a Cloud Monitoring series aligned to a percentile", () => {
		const message = errorOf(JSON.stringify({ timeSeries: [{ metricKind: "GAUGE", valueType: "DOUBLE", points: [{ value: { doubleValue: 212.5 } }] }] }));
		assert.match(message, refusal);
		assert.match(message, /ALIGN_DELTA/);
	});
	it("a KQL percentile per instance", () => {
		assert.match(errorOf("AppRoleInstance,percentile_DurationMs_99\nweb-0,212.5\nweb-1,96.1"), refusal);
	});
	it("a Logs Insights pct() per bin, with the comma inside the quoted header", () => {
		assert.match(errorOf('bin(5m),"pct(@duration, 99)"\n2026-03-02 14:00:00.000,212.5'), refusal);
	});
	it("a histogram_quantile result from the Prometheus query API", () => {
		assert.match(errorOf(JSON.stringify({ status: "success", data: { resultType: "vector", result: [{ metric: { instance: "a" }, value: [1, "0.21"] }] } })), refusal);
	});
});

describe("the Prometheus query API, and its console", () => {
	const next = rng(41);
	const groups = [latencies(1500, 0, next), latencies(500, 0.04, next)];
	const text = buckets(groups);

	it("the query API's JSON, as Amazon and Azure managed Prometheus return it, reads the same as the text format", () => {
		const result = text.split("\n").map((line) => {
			const [, instance, le, value] = /instance="([^"]+)",le="([^"]+)"\} (\S+)/.exec(line)!;
			return { metric: { __name__: "rpc_duration_seconds_bucket", instance: instance!, le: le! }, value: [1767225600, value!] };
		});
		const json = JSON.stringify({ status: "success", data: { resultType: "vector", result } });
		assert.equal(field(run(json, { threshold: 0.1 }), "p99 across").value, field(run(text, { threshold: 0.1 }), "p99 across").value);
	});

	it("console lines with labels and no metric name, as a sum by (instance, le) query shows them", () => {
		const console = text.replace(/^rpc_duration_seconds_bucket/gm, "");
		const parts = run(console, { threshold: 0.1 });
		// No metric name means no unit, so the same estimate is in seconds, unformatted.
		assert.equal(Number(field(parts, "p99 across").value.replace("about ", "")) * 1000, ms(field(run(text, { threshold: 0.1 }), "p99 across").value));
	});

	it("a range query is refused, with the instant query to run instead", () => {
		assert.match(errorOf(JSON.stringify({ status: "success", data: { resultType: "matrix", result: [] } })), /instant query/);
	});
});
