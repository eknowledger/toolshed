/**
 * Percentiles across hosts: the p99 of a whole service, from per-instance histograms or from raw latencies, beside
 * the averaged per-instance p99 a dashboard shows, and how wrong that one is.
 *
 * What is pasted decides how it is read, with no switch to set:
 *
 *  - **Prometheus buckets**, the counts `histogram_quantile` reads: lines from a `/metrics` page or a query result,
 *    `..._bucket{instance="a",le="0.05"} 120`, the JSON the query API returns (which is also what Amazon's and
 *    Azure's managed Prometheus services return), or a CSV with an `le` column. Each bucket counts every request at
 *    or under its edge, so counts are cumulative.
 *  - **Google Cloud Monitoring distributions**, the `timeSeries.list` JSON of a DISTRIBUTION metric. Its buckets are
 *    described by `bucketOptions` (linear, exponential or explicit) and counted per bucket, not cumulatively, with an
 *    underflow bucket first and an overflow bucket last.
 *  - **AWS X-Ray response-time histograms**, from GetServiceGraph or GetTimeSeriesServiceStatistics: pairs of a
 *    response time in seconds and how many requests took it.
 *  - **Bucket and count rows** from a log query, KQL in Azure Monitor or CloudWatch Logs Insights, as CSV or as the
 *    query API's JSON: a duration rounded down to a bin, and how many requests fell in it.
 *  - **Raw latencies**, a group per host or per minute separated by a blank line, rolled up exactly.
 *
 * Every histogram is summed across groups edge by edge, which is what `sum by (le)` does, and the quantile estimated
 * from the total the way Prometheus does: find the bucket the rank falls in and interpolate linearly inside it. That
 * estimate is only known to within the bucket, so the bucket's two edges are reported as the error bound. The share
 * under each edge is exact. X-Ray pairs and raw latencies are values rather than buckets, so they are ranked exactly.
 *
 * ⚠️ Some exports carry only percentiles already worked out per period or per host: CloudWatch metric statistics,
 * Azure Monitor metrics, a Cloud Monitoring series aligned with ALIGN_PERCENTILE_99, a query that ends in pct() or
 * percentile(). Those are refused with a message saying why and what to paste instead, because pooling them is the
 * mistake this tool exists to show, and a confident wrong number is worse than an error.
 *
 * ⚠️ The direction is the point. Averaging percentiles does not always understate the tail. When the slow instance
 * carries a small share of the traffic, its own p99 enters the average at full weight and the average OVERSTATES the
 * true p99; when it carries most of the traffic, the average understates it. The tool says which, every time.
 *
 * For raw latencies the headline uses nearest rank, the smallest measurement with at least p% at or below it, which
 * is always a value that was observed. The detail table also gives linear interpolation, numpy's and R's default
 * (Hyndman and Fan's type 7), because tools disagree and a p99 from one is not comparable with a p99 from the other.
 */
import type { Cell, Field, Output, Tool } from "@toolbench/sdk";

type Input = { values: string; percentile: string; threshold: number };

class InputError extends Error {
	readonly input: string;
	readonly at: number | undefined;
	readonly len: number | undefined;

	constructor(message: string, input: string, at?: number, len?: number) {
		super(message);
		this.name = "InputError";
		this.input = input;
		this.at = at;
		this.len = len;
	}
}

const PERCENTILES: Record<string, number> = { p50: 50, p90: 90, p95: 95, p99: 99, "p99.9": 99.9 };

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * Enough digits to compare, and no more: one decimal place from 100 up, two below, three significant figures under
 * 1, with trailing zeros dropped so integer data reads as integers.
 */
function num(v: number): string {
	if (v === 0) return "0";
	const a = Math.abs(v);
	const text = a >= 100 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toPrecision(3);
	return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}
const pct = (f: number) => `${(f * 100).toFixed(3)}%`;
/** 100000 as 100,000, without leaning on Intl, which a tool cannot assume. */
function count(v: number): string {
	const rounded = Number.isInteger(v) ? String(v) : v.toFixed(1);
	const [whole, frac] = rounded.split(".");
	return whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? `.${frac}` : "");
}
/** Bucket edges computed as offset + width x i, or scale x factor ^ i, cleaned of float noise so they compare and print. */
const clean = (v: number) => Number(v.toPrecision(12));

/** How a value is written once its unit is known: seconds under one are shown as milliseconds, microseconds over 1,000 too. */
type Unit = "s" | "ms" | "us" | "";
function dur(v: number, unit: Unit): string {
	if (v === Number.POSITIVE_INFINITY) return "no upper limit";
	if (unit === "s") return Math.abs(v) < 1 ? `${num(v * 1000)} ms` : `${num(v)} s`;
	if (unit === "ms") return `${num(v)} ms`;
	if (unit === "us") return Math.abs(v) >= 1000 ? `${num(v / 1000)} ms` : `${num(v)} µs`;
	return num(v);
}
/** A value in milliseconds for the chart, which needs one unit for every bar. */
function plotValue(v: number, unit: Unit): number {
	return Number(num(unit === "s" ? v * 1000 : unit === "us" ? v / 1000 : v));
}
const ratioNote = (ratio: number) => {
	if (Math.abs(ratio - 1) < 0.05) return { text: "close to the pooled value", off: false };
	return { text: `${ratio.toFixed(2)}x the pooled value, ${ratio > 1 ? "too high" : "too low"}`, off: true };
};

/** What a group is called in the output: an instance, a Cloud Monitoring series, an X-Ray period. */
type Noun = { one: string; many: string };
const INSTANCE: Noun = { one: "instance", many: "instances" };
const GROUP: Noun = { one: "group", many: "groups" };
const SERIES: Noun = { one: "series", many: "series" };
const PERIOD: Noun = { one: "period", many: "periods" };
const SERVICE: Noun = { one: "service", many: "services" };
const poss = (word: string) => (word.endsWith("s") ? `${word}'` : `${word}'s`);
const across = (n: number, noun: Noun) => (n === 1 ? `this ${noun.one}` : n === 2 ? `both ${noun.many}` : `all ${n} ${noun.many}`);
const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * The refusal for an export that holds percentiles rather than counts. It says what the input is, why it cannot be
 * pooled, and where to find the histogram instead, because "wrong format" alone sends a reader back to the same export.
 */
function precomputed(what: string, instead: string): InputError {
	return new InputError(
		`${what} Those are percentiles already worked out, or averages, and they cannot be added up or averaged into a correct percentile for the whole service, which is the mistake this tool exists to show. ${instead}`,
		"values",
	);
}

// ── Histogram buckets ────────────────────────────────────────────────────────────────────────────────────────────

/** One histogram, as cumulative counts keyed by upper edge, the way histogram_quantile reads them. */
type Histogram = { label: string; buckets: Map<number, number>; sum?: number; count?: number };

/** Where a set of histograms came from, which changes the words around the numbers but never the arithmetic. */
type HistSource = {
	noun: Noun;
	unit: Unit;
	/** Prometheus's le counts requests at or under an edge; Cloud Monitoring and bin() count those under it. */
	inclusive: boolean;
	edgeColumn: string;
	estimate: (name: string, lower: string, upper: string) => string;
	overflow: (highest: string) => string;
	pool: (q: number, name: string) => string;
	/** The first row's name in the comparison: what this source's pooled estimate is made of. */
	method: string;
	/** The query that pools correctly, where the source has one to give: PromQL for Prometheus. */
	query?: (q: number) => string;
	meanNote: string;
	/** A word for "how many buckets", where the source's buckets are not called buckets. */
	bucketWord: string;
	/** What to do when the buckets are too coarse: add edges to a Prometheus histogram, narrow a bin, choose finer bucket options. */
	addAbove: (highest: string) => string;
	addBetween: (lower: string, upper: string) => string;
	addAt: (threshold: string) => string;
};

function prometheusSource(metric: string): HistSource {
	return {
		noun: INSTANCE,
		unit: unitOf(metric),
		inclusive: true,
		edgeColumn: "Bucket edge (le)",
		estimate: (name, lower, upper) => `Estimated from the summed buckets, as histogram_quantile does, so the true ${name} is somewhere between ${lower} and ${upper}.`,
		overflow: (highest) => `It falls in the +Inf bucket, so all we know is that it is above ${highest}, the highest edge, which is what Prometheus reports.`,
		pool: () => "Sum the buckets first, then estimate, with the query below.",
		method: "Sum the buckets, then estimate",
		query: (q) => `histogram_quantile(${q}, sum by (le) (rate(${metric || "your_metric"}_bucket[5m])))`,
		meanNote: "Exact: every _sum over every _count.",
		bucketWord: "buckets",
		addAbove: (highest) => `Add bucket edges above ${highest}`,
		addBetween: (lower, upper) => `Add bucket edges between ${lower} and ${upper}`,
		addAt: (threshold) => `Add a bucket edge at ${threshold}`,
	};
}

/** True when the text is Prometheus buckets rather than raw latencies: an `le` label, a `_bucket` series, or a CSV header with an `le` column. */
function looksLikeBuckets(text: string): boolean {
	return /\ble\s*=\s*"/.test(text) || /_bucket\b/.test(text) || /^[ \t]*(?:[A-Za-z_]+[ \t]*[,\t][ \t]*)?le[ \t]*[,\t]/im.test(text);
}

function edgeOf(raw: string, at: number): number {
	const t = raw.trim();
	if (/^\+?inf$/i.test(t)) return Number.POSITIVE_INFINITY;
	const v = Number(t);
	if (t === "" || !Number.isFinite(v)) throw new InputError(`"${t.slice(0, 20)}" is not a bucket edge. An le is a number, or +Inf.`, "values", at, Math.max(1, raw.length));
	return v;
}
function countOf(raw: string, at?: number): number {
	const t = raw.trim();
	const v = Number(t);
	if (t === "" || !Number.isFinite(v) || v < 0) {
		throw new InputError(`"${t.slice(0, 20)}" is not a count. A bucket's count is a number of requests, 0 or more.`, "values", at, at === undefined ? undefined : Math.max(1, raw.length));
	}
	return v;
}

/**
 * Lines in the Prometheus text format, or CSV rows, into one histogram per instance.
 *
 * The instance is the `instance` label where there is one; otherwise a `name:` line heading a block; otherwise the
 * block's number. Series of one instance that differ in other labels (method, status) are added edge by edge, which
 * is what `sum by (instance, le)` does. A line with labels and no metric name, `{instance="a",le="0.05"} 120`, is how
 * the Prometheus console shows the result of a `sum by (instance, le)` query, and is read the same way.
 */
function parseBuckets(text: string): { groups: Histogram[]; metric: string } {
	const groups = new Map<string, Histogram>();
	const get = (label: string) => {
		let g = groups.get(label);
		if (!g) {
			g = { label, buckets: new Map() };
			groups.set(label, g);
		}
		return g;
	};
	let metric = "";
	let block = 0;
	let heading = "";
	let blank = true;
	let csv: { instance: number; le: number; count: number } | undefined;
	let offset = 0;
	for (const line of text.split("\n")) {
		const at = offset;
		offset += line.length + 1;
		const trimmed = line.trim();
		if (trimmed === "") {
			blank = true;
			continue;
		}
		if (blank) {
			block++;
			heading = "";
			blank = false;
		}
		if (trimmed.startsWith("#")) continue;
		const lead = line.length - line.trimStart().length;

		const series = /^([A-Za-z_:][\w:]*)?(?:\{([^}]*)\})?\s+(\S+)(?:\s+\S+)?$/.exec(trimmed);
		const unnamed = series !== null && series[1] === undefined && series[2] !== undefined && /\ble\s*=/.test(series[2]);
		if (series && (unnamed || (series[1] !== undefined && /_(bucket|sum|count)$/.test(series[1])))) {
			const [, name = "_bucket", labelText = "", value] = series;
			const labels = new Map<string, string>();
			for (const m of labelText.matchAll(/([A-Za-z_]\w*)\s*=\s*"((?:[^"\\]|\\.)*)"/g)) labels.set(m[1]!, m[2]!);
			if (!unnamed) {
				const base = name.replace(/_(bucket|sum|count)$/, "");
				if (metric && base !== metric) {
					throw new InputError(`This is ${base}, and the lines above are ${metric}. Paste one histogram at a time.`, "values", at + lead, name.length);
				}
				metric = base;
			}
			const g = get(labels.get("instance") ?? (heading || `instance ${block}`));
			const valueAt = at + lead + trimmed.lastIndexOf(value!);
			if (name.endsWith("_bucket")) {
				const le = labels.get("le");
				if (le === undefined) throw new InputError("A _bucket line needs an le label: the edge it counts up to.", "values", at + lead, trimmed.length);
				const edge = edgeOf(le, at + lead + trimmed.indexOf(`"${le}"`) + 1);
				g.buckets.set(edge, (g.buckets.get(edge) ?? 0) + countOf(value!, valueAt));
			} else if (name.endsWith("_sum")) {
				const v = Number(value);
				if (!Number.isFinite(v)) throw new InputError(`"${value!.slice(0, 20)}" is not a number.`, "values", valueAt, value!.length);
				g.sum = (g.sum ?? 0) + v;
			} else {
				g.count = (g.count ?? 0) + countOf(value!, valueAt);
			}
			continue;
		}

		const cells = trimmed.split(/\s*[,\t]\s*/);
		const header = cells.map((c) => c.toLowerCase().replace(/^"|"$/g, ""));
		if (header.includes("le")) {
			const le = header.indexOf("le");
			const counted = header.findIndex((c) => c === "count" || c === "value" || c === "requests");
			const instance = header.findIndex((c) => c === "instance" || c === "host" || c === "name");
			if (counted < 0) throw new InputError("A CSV header with an le column also needs a count column.", "values", at + lead, trimmed.length);
			csv = { instance, le, count: counted };
			continue;
		}
		const named = /^([^\d,\t+.][^,\t:]*):$/.exec(trimmed);
		if (named) {
			heading = named[1]!.trim().slice(0, 40);
			continue;
		}
		const layout = csv ?? (cells.length === 3 ? { instance: 0, le: 1, count: 2 } : { instance: -1, le: 0, count: 1 });
		if (cells.length < 2 || cells.length <= Math.max(layout.le, layout.count, layout.instance)) {
			throw new InputError("This line is neither a Prometheus bucket line nor a CSV row of instance, le and count.", "values", at + lead, trimmed.length);
		}
		const cellAt = (i: number) => at + lead + Math.max(0, trimmed.indexOf(cells[i]!));
		const label = layout.instance >= 0 ? cells[layout.instance]!.replace(/^"|"$/g, "").slice(0, 40) : heading || `instance ${block}`;
		const g = get(label);
		const edge = edgeOf(cells[layout.le]!, cellAt(layout.le));
		g.buckets.set(edge, (g.buckets.get(edge) ?? 0) + countOf(cells[layout.count]!, cellAt(layout.count)));
	}

	const list = [...groups.values()].filter((g) => g.buckets.size > 0);
	if (list.length === 0) throw new InputError("No bucket counts found. Paste _bucket lines, or a CSV of instance, le and count.", "values");
	return { groups: list, metric };
}

type Sorted = { edges: number[]; counts: number[] };

/** Buckets in edge order, checked the way histogram_quantile needs them: a +Inf bucket, and counts that never fall. */
function sortBuckets(g: Histogram): Sorted {
	const edges = [...g.buckets.keys()].sort((a, b) => a - b);
	if (edges.at(-1) !== Number.POSITIVE_INFINITY) {
		throw new InputError(`${g.label} has no le="+Inf" bucket. That bucket holds the total, and histogram_quantile needs it.`, "values");
	}
	if (edges.length < 2) throw new InputError(`${g.label} has only the +Inf bucket, so there is no edge to estimate from.`, "values");
	const counts = edges.map((e) => g.buckets.get(e)!);
	for (let i = 1; i < counts.length; i++) {
		if (counts[i]! >= counts[i - 1]!) continue;
		// rate() can leave a count a hair under the one before it; Prometheus evens those out, and so does this.
		if (counts[i - 1]! - counts[i]! <= 1e-6 * Math.max(1, counts.at(-1)!)) {
			counts[i] = counts[i - 1]!;
			continue;
		}
		throw new InputError(
			`${g.label} counts ${count(counts[i]!)} at le=${edges[i]} but ${count(counts[i - 1]!)} at le=${edges[i - 1]}. Prometheus buckets are cumulative, each counting every request at or under its edge, so a count never falls. These look like counts per bucket: add each one to the counts before it.`,
			"values",
		);
	}
	return { edges, counts };
}

type Estimate = { value: number; lower: number; upper: number };

/** histogram_quantile, as Prometheus computes it: the bucket the rank falls in, and a straight line inside it. */
function bucketQuantile(q: number, { edges, counts }: Sorted): Estimate | undefined {
	const total = counts.at(-1)!;
	if (total === 0) return undefined;
	const rank = q * total;
	const b = counts.findIndex((c) => c >= rank);
	if (b === edges.length - 1) return { value: edges.at(-2)!, lower: edges.at(-2)!, upper: Number.POSITIVE_INFINITY };
	if (b === 0 && edges[0]! <= 0) return { value: edges[0]!, lower: edges[0]!, upper: edges[0]! };
	const lower = b === 0 ? 0 : edges[b - 1]!;
	const below = b === 0 ? 0 : counts[b - 1]!;
	const inBucket = counts[b]! - below;
	return { value: lower + (edges[b]! - lower) * ((rank - below) / inBucket), lower, upper: edges[b]! };
}

function unitOf(metric: string): Unit {
	if (/(^|_)seconds$/.test(metric)) return "s";
	if (/(^|_)(milliseconds|ms)$/.test(metric)) return "ms";
	return "";
}

function histogramRollup(groups: Histogram[], src: HistSource, name: string, q: number, threshold: number): Output {
	const sorted = groups.map(sortBuckets);
	const edges = sorted[0]!.edges;
	for (const [i, s] of sorted.entries()) {
		if (s.edges.length !== edges.length || s.edges.some((e, j) => e !== edges[j])) {
			throw new InputError(
				`${groups[i]!.label} has different bucket edges from ${groups[0]!.label}. Summing buckets edge by edge only works when every ${src.noun.one} uses the same edges.`,
				"values",
			);
		}
	}
	const { noun } = src;
	const d = (v: number) => dur(v, src.unit);
	const under = src.inclusive ? "at or under" : "under";
	const Under = capital(under);
	const pooled: Sorted = { edges, counts: edges.map((_, j) => sum(sorted.map((s) => s.counts[j]!))) };
	const total = pooled.counts.at(-1)!;
	if (total === 0) throw new InputError("Every bucket is empty, so there is no request to estimate from.", "values");
	const est = bucketQuantile(q, pooled)!;
	const each = sorted.map((s) => bucketQuantile(q, s));
	const counted = each.filter((e): e is Estimate => e !== undefined);
	const averaged = sum(counted.map((e) => e.value)) / counted.length;
	const unbounded = est.upper === Number.POSITIVE_INFINITY;
	const width = est.upper - est.lower;

	const edgeAt = edges.findIndex((e) => Math.abs(e - threshold) <= 1e-9 * Math.max(1, threshold));
	const share = (c: number) => c / total;
	const below = edges.findLastIndex((e) => e < threshold);
	const above = edges.findIndex((e) => e > threshold);
	const sharePrecise = edgeAt >= 0;
	const shareLow = sharePrecise ? share(pooled.counts[edgeAt]!) : below >= 0 ? share(pooled.counts[below]!) : 0;
	const shareHigh = sharePrecise ? shareLow : share(pooled.counts[above]!);

	const r = groups.length > 1 && counted.length > 0 ? ratioNote(averaged / est.value) : undefined;
	const off = r?.off ?? false;
	const many = groups.length > 1 && counted.length > 0;

	/*
	 * The answer is the two methods side by side: the buckets only support a range, so the pooled value is rounded to a
	 * tenth of the bucket's order of magnitude (1 ms in a 25 ms bucket, 10 ms in a 250 ms one) and written beside the
	 * bucket, not to hundredths. Neither row is toned: they share one frame, and the third column says which way the
	 * average is wrong.
	 */
	const rough = (v: number) => {
		if (!(width > 0) || !Number.isFinite(width)) return v;
		const step = 10 ** (Math.floor(Math.log10(width)) - 1);
		const r2 = clean(Math.round(v / step) * step);
		return r2 >= est.lower && r2 <= est.upper ? r2 : v;
	};
	const parts: Output[] = [
		{
			kind: "table",
			role: "comparison",
			caption: `${name} across ${across(groups.length, noun)}`,
			columns: [
				{ label: "Method", wrap: "prose" },
				{ label: name, align: "end", mono: true, wrap: "none" },
				{ label: "What you can claim", wrap: "prose" },
			],
			rows: [
				[
					src.method,
					{ text: unbounded ? `above ${d(est.lower)}` : `about ${d(rough(est.value))}`, mono: true },
					unbounded ? "no upper bound: it is past the highest edge" : est.lower > 0 ? `somewhere in ${d(est.lower)} to ${d(est.upper)}` : `somewhere under ${d(est.upper)}`,
				],
				...(many ? [[`Average of the ${poss(noun.many)} ${name}s`, { text: d(averaged), mono: true }, r!.text] as Cell[]] : []),
			],
		},
	];

	/*
	 * Why the answer is a range: the share of requests slower than each edge, on log axes, with the percentile's line.
	 * The line crosses it inside one bucket, and the estimate can be anywhere in that bucket. The share at each edge is
	 * exact; the straight line between two edges is the assumption histogram_quantile makes.
	 */
	const finite = edges.map((e, j) => [e, j] as const).filter(([e]) => e !== Number.POSITIVE_INFINITY && e > 0);
	if (finite.length >= 2) {
		const plot = (v: number) => plotValue(v, src.unit);
		const tail = 100 * (1 - q);
		parts.push({
			kind: "series",
			chart: {
				xLabel: src.edgeColumn,
				...(src.unit === "" ? {} : { xUnit: "ms" }),
				yLabel: `Share slower than the edge`,
				yUnit: "%",
				xScale: "log",
				yScale: "log",
				x: finite.map(([e]) => plot(e)),
				series: [
					{
						label: `Requests ${src.inclusive ? "over" : "at or over"} each edge`,
						shape: "line",
						markers: true,
						unit: "%",
						points: finite.map(([, j]) => Number((100 * (1 - share(pooled.counts[j]!))).toPrecision(4))),
					},
				],
				thresholds: [{ y: Number(tail.toPrecision(4)), label: `${num(tail)}% slower: the ${name}` }],
				annotations: [
					...(est.lower > 0 ? [{ x: plot(est.lower), label: unbounded ? `${name} above here` : "from" }] : []),
					...(unbounded ? [] : [{ x: plot(est.upper), label: "to" }]),
				],
			},
		});
	}

	const metrics: Field[] = [
		{
			label: `${Under} ${d(threshold)}`,
			value: sharePrecise ? pct(shareLow) : `${pct(shareLow)} to ${pct(shareHigh)}`,
			note: sharePrecise ? `exact: ${count(pooled.counts[edgeAt]!)} of ${count(total)}` : `no bucket edge at ${d(threshold)}, so the range between the edges either side`,
		},
	];
	if (groups.every((g) => g.sum !== undefined && g.count !== undefined) && sum(groups.map((g) => g.count!)) > 0) {
		metrics.push({ label: "Mean", value: d(sum(groups.map((g) => g.sum!)) / sum(groups.map((g) => g.count!))), note: src.meanNote });
	}
	metrics.push({ label: "Requests", value: count(total), note: `${groups.length} ${groups.length === 1 ? noun.one : noun.many}, ${edges.length} ${src.bucketWord} each` });
	parts.push({ kind: "fields", role: "metrics", fields: metrics });

	const actions: { tone: "bad" | "warn"; what: string; why: string }[] = [];
	if (unbounded) {
		actions.push({
			tone: "bad",
			what: src.addAbove(d(est.lower)),
			why: `More than ${pct(1 - q)} of requests are slower than the highest edge, so the ${name} has no upper bound.`,
		});
	}
	if (off) {
		const ratio = averaged / est.value;
		actions.push({ tone: ratio > 2 || ratio < 0.5 ? "bad" : "warn", what: `Stop averaging per-${noun.one} ${name}s`, why: src.pool(q, name) });
	}
	if (!unbounded && width > 0.25 * est.value) {
		actions.push({
			tone: "warn",
			what: src.addBetween(d(est.lower), d(est.upper)),
			why: `The ${name} can be anywhere in that bucket, a range of ${d(width)}, which is ${Math.round((100 * width) / est.value)}% of the estimate.`,
		});
	}
	if (!sharePrecise) {
		actions.push({
			tone: "warn",
			what: src.addAt(d(threshold)),
			why: `Without one, the share of requests ${under} it is only known to be between ${pct(shareLow)} and ${pct(shareHigh)}.`,
		});
	}
	if (actions.length > 0) {
		parts.push({
			kind: "table",
			role: "actions",
			caption: "What to change, worst first",
			columns: [{ label: "What to do" }, { label: "Why" }],
			rows: actions.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "bad" ? -1 : 1)).map((a) => [{ text: a.what, tone: a.tone }, a.why]),
		});
	}
	if (src.query) parts.push({ kind: "code", lang: "promql", source: src.query(q) });

	// Slowest first, so the instance that decides the tail is the first row.
	const order = groups.map((_, i) => i).sort((a, b) => (each[b]?.value ?? -1) - (each[a]?.value ?? -1));
	parts.push({
		kind: "table",
		caption: `Each ${noun.one} on its own, slowest first, estimated from its own buckets`,
		columns: [
			{ label: capital(noun.one), wrap: "none", rowHeader: true },
			{ label: "Requests", align: "end", mono: true, wrap: "none" },
			{ label: `${name} estimate`, align: "end", mono: true, wrap: "none" },
			{ label: "Somewhere between", align: "end", mono: true, wrap: "none" },
			{ label: `${Under} ${d(threshold)}`, align: "end", mono: true, wrap: "none" },
		],
		rows: order.map((i) => {
			const g = groups[i]!;
			const e = each[i];
			const n = sorted[i]!.counts.at(-1)!;
			const own = !sharePrecise ? "no edge there" : n > 0 ? pct(sorted[i]!.counts[edgeAt]! / n) : "no requests";
			return [
				g.label,
				{ text: count(n), mono: true },
				{ text: e ? d(e.value) : "no requests", mono: true },
				{ text: !e ? "" : e.upper === Number.POSITIVE_INFINITY ? `above ${d(e.lower)}` : `${d(e.lower)} to ${d(e.upper)}`, mono: true },
				{ text: own, mono: true },
			];
		}),
	});
	parts.push({
		kind: "table",
		caption: `Every ${noun.one} together: the share ${under} each edge is exact`,
		columns: [
			{ label: src.edgeColumn, mono: true, wrap: "none", rowHeader: true },
			{ label: `Requests ${under} it`, align: "end", mono: true, wrap: "none" },
			{ label: "Share", align: "end", mono: true, wrap: "none" },
			{ label: "Note", wrap: "prose" },
		],
		rows: edges.map((e, j) => {
			const words = [j === edgeAt ? "your threshold" : "", e === est.upper && !unbounded ? `the ${name} falls in the bucket ending here` : ""].filter(Boolean).join("; ");
			return [
				{ text: e === Number.POSITIVE_INFINITY ? "+Inf" : `${num(e)}${src.unit === "s" ? ` (${d(e)})` : ""}`, mono: true },
				{ text: count(pooled.counts[j]!), mono: true },
				{ text: pct(share(pooled.counts[j]!)), mono: true },
				words,
			];
		}),
	});
	return { kind: "group", parts };
}

// ── JSON exports from the cloud providers ────────────────────────────────────────────────────────────────────────

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };
const isObj = (v: Json | undefined): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
/** int64 fields arrive as strings in Cloud Monitoring's JSON, and as numbers everywhere else. */
const numberOf = (v: Json | undefined): number => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN);

/**
 * Cloud Monitoring's BucketOptions as the finite upper edges, in bucket order.
 *
 * Bucket 0 is the underflow bucket and the last is the overflow bucket. Bucket i's upper edge is offset + width x i
 * for linear buckets, scale x growthFactor ^ i for exponential ones, and bounds[i] for explicit ones, for i from 0 to
 * N - 2, so there is one more bucket than there are finite edges, and the overflow bucket becomes +Inf here. Proto3
 * JSON leaves out a field whose value is zero, which is why a missing offset is 0 rather than an error.
 */
function gcpEdges(options: Json | undefined, where: string): number[] {
	if (!isObj(options)) throw new InputError(`${where} has no bucketOptions, so its buckets have no edges.`, "values");
	const finite = (n: number) => {
		if (!Number.isInteger(n) || n < 1) throw new InputError(`${where}: numFiniteBuckets must be a whole number of 1 or more.`, "values");
		if (n > 2000) throw new InputError(`${where} has ${count(n)} finite buckets, more than this tool lays out. 2,000 is the limit.`, "values");
		return n;
	};
	const linearOpts = options.linearBuckets;
	if (isObj(linearOpts)) {
		const n = finite(numberOf(linearOpts.numFiniteBuckets));
		const width = numberOf(linearOpts.width);
		const offset = linearOpts.offset === undefined ? 0 : numberOf(linearOpts.offset);
		if (!(width > 0) || !Number.isFinite(offset)) throw new InputError(`${where}: linear buckets need a width above 0 and a numeric offset.`, "values");
		return Array.from({ length: n + 1 }, (_, i) => clean(offset + width * i));
	}
	const exponential = options.exponentialBuckets;
	if (isObj(exponential)) {
		const n = finite(numberOf(exponential.numFiniteBuckets));
		const factor = numberOf(exponential.growthFactor);
		const scale = numberOf(exponential.scale);
		if (!(factor > 1) || !(scale > 0)) throw new InputError(`${where}: exponential buckets need a growthFactor above 1 and a scale above 0.`, "values");
		return Array.from({ length: n + 1 }, (_, i) => clean(scale * factor ** i));
	}
	const explicit = options.explicitBuckets;
	if (isObj(explicit)) {
		const bounds = arr(explicit.bounds).map(numberOf);
		if (bounds.length === 0 || bounds.some((b) => !Number.isFinite(b))) throw new InputError(`${where}: explicit buckets need a list of numeric bounds.`, "values");
		if (bounds.some((b, i) => i > 0 && b <= bounds[i - 1]!)) throw new InputError(`${where}: explicit bounds must increase from one to the next.`, "values");
		if (bounds.length > 2001) throw new InputError(`${where} has ${count(bounds.length)} bounds, more than this tool lays out. 2,001 is the limit.`, "values");
		return bounds;
	}
	throw new InputError(`${where}: bucketOptions has none of linearBuckets, exponentialBuckets or explicitBuckets.`, "values");
}

/** One Distribution's per-bucket counts as cumulative counts at each finite edge, with the total beside them. */
function gcpBuckets(dist: Obj, where: string): { edges: number[]; counts: number[]; total: number; mean: number | undefined } {
	const edges = gcpEdges(dist.bucketOptions, where);
	const n = edges.length + 1;
	const raw = arr(dist.bucketCounts);
	if (raw.length > n) throw new InputError(`${where} has ${raw.length} bucket counts, but its bucketOptions describe only ${n} buckets.`, "values");
	// A shorter list leaves the rest at zero: Cloud Monitoring may drop trailing empty buckets.
	const perBucket = Array.from({ length: n }, (_, i) => (i < raw.length ? countOf(String(raw[i])) : 0));
	const counts: number[] = [];
	let running = 0;
	for (const c of perBucket) {
		running += c;
		counts.push(running);
	}
	const declared = dist.count === undefined ? running : numberOf(dist.count);
	if (Number.isFinite(declared) && Math.abs(declared - running) > 1e-6 * Math.max(1, running)) {
		throw new InputError(`${where} says its count is ${count(declared)}, but its bucket counts add up to ${count(running)}. The two must match.`, "values");
	}
	// Proto3 JSON drops a zero mean too, so a missing mean is 0 only when there is nothing to average.
	const mean = dist.mean === undefined ? (running === 0 ? 0 : undefined) : numberOf(dist.mean);
	return { edges, counts: counts.slice(0, edges.length), total: running, mean: mean !== undefined && Number.isFinite(mean) ? mean : undefined };
}

/** A Cloud Monitoring unit as one this tool prints. Anything else is shown as plain numbers. */
function gcpUnit(unit: Json | undefined): Unit {
	if (unit === "s") return "s";
	if (unit === "ms") return "ms";
	if (unit === "us") return "us";
	return "";
}

const GCP: Omit<HistSource, "unit"> = {
	noun: SERIES,
	inclusive: false,
	edgeColumn: "Bucket upper edge",
	estimate: (name, lower, upper) =>
		`Estimated from the summed distributions, interpolating inside a bucket as Prometheus's histogram_quantile does, so the true ${name} is somewhere between ${lower} and ${upper}.`,
	overflow: (highest) => `It falls in the overflow bucket, so all we know is that it is above ${highest}, the highest edge.`,
	pool: (_q, name) =>
		`Add the distributions together first, then take the ${name}, as this tool does. In Cloud Monitoring, REDUCE_SUM across the series keeps a distribution; a ${name} worked out per series cannot be combined afterwards.`,
	method: "Add the distributions, then estimate",
	meanNote: "Exact: each distribution's mean, weighted by its count.",
	bucketWord: "buckets",
	// A built-in metric's buckets come with it; only a metric you write yourself can be given other bucket options.
	addAbove: (highest) => `For a metric you write, use bucket options that reach above ${highest}`,
	addBetween: (lower, upper) => `For a metric you write, use finer buckets between ${lower} and ${upper}`,
	addAt: (threshold) => `For a metric you write, put a bucket boundary at ${threshold}`,
};

/**
 * Cloud Monitoring's JSON into one histogram per time series: a timeSeries.list response, a list of TimeSeries, one
 * TimeSeries, or a bare Distribution.
 *
 * A DELTA or GAUGE series holds one distribution per interval, and those add up. A CUMULATIVE series holds running
 * totals since its start time, so adding its points would count early requests again; the newest point already holds
 * them all, and it is the one used.
 */
function gcpHistograms(json: Json): { groups: Histogram[]; src: HistSource } | undefined {
	let series: Obj[];
	if (isObj(json) && Array.isArray(json.timeSeries)) series = json.timeSeries.filter(isObj);
	else if (Array.isArray(json) && json.length > 0 && json.every((s) => isObj(s) && Array.isArray(s.points))) series = json as Obj[];
	else if (isObj(json) && Array.isArray(json.points)) series = [json];
	else if (isObj(json) && (isObj(json.bucketOptions) || isObj(json.distributionValue))) {
		series = [{ points: [{ value: { distributionValue: isObj(json.distributionValue) ? json.distributionValue : json } }] }];
	} else return undefined;
	if (series.length === 0) {
		throw new InputError("This timeSeries.list response has no time series in it. Check the filter and the interval, then paste the response again.", "values");
	}

	const labelsOf = (s: Obj): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const part of [s.resource, s.metric]) {
			const labels = isObj(part) ? part.labels : undefined;
			if (isObj(labels)) for (const [k, v] of Object.entries(labels)) out[k] = String(v);
		}
		return out;
	};
	const all = series.map(labelsOf);
	const keys = [...new Set(all.flatMap((l) => Object.keys(l)))];
	const varying = keys.filter((k) => new Set(all.map((l) => l[k] ?? "")).size > 1);

	const units = new Set(series.map((s) => gcpUnit(s.unit)));
	if (units.size > 1) throw new InputError("These series are in different units. Paste series of one metric.", "values");
	const groups: Histogram[] = [];
	for (const [i, s] of series.entries()) {
		const label = (varying.map((k) => all[i]![k]).filter(Boolean).join(" / ") || `series ${i + 1}`).slice(0, 40);
		const points = arr(s.points).filter(isObj);
		if (points.length === 0) continue;
		const values = points.map((p) => (isObj(p.value) ? p.value : {}));
		if (values.every((v) => !isObj(v.distributionValue))) {
			if (values.some((v) => v.doubleValue !== undefined || v.int64Value !== undefined)) {
				throw precomputed(
					`${label} holds single numbers, not distributions. A series aligned with a percentile aligner, such as ALIGN_PERCENTILE_99, comes back like this.`,
					"Ask for the series with ALIGN_DELTA, or with no aligner, and the points stay distributions, with every bucket count in them.",
				);
			}
			throw new InputError(`${label} has no distributionValue in its points. Paste a series of a DISTRIBUTION metric.`, "values");
		}
		const endOf = (p: Obj) => {
			const interval = isObj(p.interval) ? p.interval : {};
			return typeof interval.endTime === "string" ? Date.parse(interval.endTime) : 0;
		};
		const chosen = s.metricKind === "CUMULATIVE" ? [points.reduce((a, b) => (endOf(b) > endOf(a) ? b : a))] : points;
		let edges: number[] | undefined;
		let counts: number[] = [];
		let weighted = 0;
		let total = 0;
		let meanKnown = true;
		for (const p of chosen) {
			const dist = isObj(p.value) ? p.value.distributionValue : undefined;
			if (!isObj(dist)) continue;
			const b = gcpBuckets(dist, label);
			if (edges && (edges.length !== b.edges.length || edges.some((e, j) => e !== b.edges[j]))) {
				throw new InputError(`${label} changes its bucket options between points, so its points cannot be added edge by edge.`, "values");
			}
			edges = b.edges;
			counts = counts.length === 0 ? b.counts : counts.map((c, j) => c + b.counts[j]!);
			total += b.total;
			if (b.mean === undefined) meanKnown = false;
			else weighted += b.mean * b.total;
		}
		if (!edges) continue;
		const buckets = new Map<number, number>();
		edges.forEach((e, j) => buckets.set(e, counts[j]!));
		buckets.set(Number.POSITIVE_INFINITY, total);
		groups.push({ label, buckets, ...(meanKnown ? { sum: weighted, count: total } : {}) });
	}
	if (groups.length === 0) throw new InputError("None of these series has a point with a distribution in it.", "values");
	return { groups, src: { ...GCP, unit: [...units][0]! } };
}

/**
 * The Prometheus query API's JSON, which Amazon Managed Service for Prometheus and Azure Monitor's managed Prometheus
 * return as well: an instant query over the buckets, one sample per series, each with its le label.
 */
function prometheusJson(json: Obj): { groups: Histogram[]; src: HistSource } {
	const data = isObj(json.data) ? json.data : {};
	if (json.status === "error") throw new InputError(`The query failed: ${String(json.error ?? "no reason given").slice(0, 200)}`, "values");
	const result = arr(data.result).filter(isObj);
	if (data.resultType === "matrix") {
		throw new InputError(
			"This is a range query, a sample per step for each series. Run it as an instant query over the window instead, such as sum by (instance, le) (increase(your_metric_bucket[1h])), so each bucket has one count.",
			"values",
		);
	}
	if (result.some((r) => r.histogram !== undefined)) {
		throw new InputError("These are native histograms, Prometheus's newer sparse kind, which this tool does not read. Query a classic histogram's _bucket series instead.", "values");
	}
	if (result.length === 0) throw new InputError("This query returned no series. Check the metric name and the time.", "values");
	const metrics = result.map((r) => (isObj(r.metric) ? r.metric : {}));
	if (metrics.every((m) => m.le === undefined)) {
		throw precomputed(
			"These series have no le label, so each is one number rather than a bucket. A histogram_quantile() query returns this.",
			"Query the buckets themselves, such as sum by (instance, le) (increase(your_metric_bucket[1h])), and paste that.",
		);
	}
	const names = new Set(metrics.map((m) => String(m.__name__ ?? "")).filter(Boolean));
	if (names.size > 1) throw new InputError(`This result holds ${[...names].join(" and ")}. Query one histogram at a time.`, "values");
	const metric = [...names][0]?.replace(/_bucket$/, "") ?? "";
	const groups = new Map<string, Histogram>();
	for (const [i, r] of result.entries()) {
		const m = metrics[i]!;
		if (m.le === undefined) continue;
		const others = Object.entries(m)
			.filter(([k]) => k !== "le" && k !== "__name__")
			.map(([, v]) => String(v))
			.join(" / ");
		const label = String(m.instance ?? (others || "all instances")).slice(0, 40);
		let g = groups.get(label);
		if (!g) {
			g = { label, buckets: new Map() };
			groups.set(label, g);
		}
		const edge = edgeOf(String(m.le), 0);
		g.buckets.set(edge, (g.buckets.get(edge) ?? 0) + countOf(String(arr(r.value)[1] ?? "")));
	}
	return { groups: [...groups.values()], src: prometheusSource(metric) };
}

// ── Bucket and count rows from a log query ───────────────────────────────────────────────────────────────────────

/** A CSV line into cells, honouring quotes, so `"pct(@duration, 99)"` is one cell. Tabs separate as well as commas. */
function splitCsv(line: string): string[] {
	const cells: string[] = [];
	let cell = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;
		if (quoted) {
			if (ch === '"' && line[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else cell += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === "," || ch === "\t") {
			cells.push(cell.trim());
			cell = "";
		} else cell += ch;
	}
	cells.push(cell.trim());
	return cells;
}

const isNumeric = (s: string) => s.trim() !== "" && Number.isFinite(Number(s));
/** KQL's count() is count_, sum(ItemCount) is sum_ItemCount; Logs Insights' count(*) keeps its spelling unless aliased. */
const COUNT_COLUMN = /^(count_?|count\(\*?\)|requests|sum_itemcount|itemcount|frequency)$/i;
/** percentile_DurationMs_99, percentiles_duration_99, pct(@duration, 99), p99: a percentile already worked out. */
const PERCENTILE_COLUMN = /^(percentiles?_|percentile\s*\(|pct\s*\()|^p\d+(\.\d+)?$/i;

type Table = { header: string[]; rows: { cells: string[]; at: number }[]; source: "kql" | "insights" | "csv" };

/** A CSV whose first line names its columns, one of them a count or a percentile and none of them le: a log query's result. */
function binTable(text: string): Table | undefined {
	let offset = 0;
	let header: string[] | undefined;
	const rows: Table["rows"] = [];
	for (const line of text.split("\n")) {
		const at = offset;
		offset += line.length + 1;
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const cells = splitCsv(trimmed);
		if (!header) {
			if (cells.length < 2 || cells.some((c) => c === "" || isNumeric(c))) return undefined;
			if (!cells.some((c) => COUNT_COLUMN.test(c) || PERCENTILE_COLUMN.test(c))) return undefined;
			header = cells;
			continue;
		}
		rows.push({ cells, at: at + (line.length - line.trimStart().length) });
	}
	if (!header) return undefined;
	// The column names say which query language wrote the table, which only changes the advice on how to pool.
	const source = header.some((h) => /^(count_|sum_itemcount|durationms|approleinstance|cloud_roleinstance)$/i.test(h))
		? "kql"
		: header.some((h) => /^count\(\*?\)$|^@/.test(h))
			? "insights"
			: "csv";
	return { header, rows, source };
}

/** Log Analytics' {"tables": [{columns, rows}]}, and Logs Insights' {"results": [[{field, value}]]}, as one table. */
function jsonTable(json: Obj): Table | undefined {
	const tables = arr(json.tables).filter(isObj);
	if (tables.length > 0) {
		const t = tables[0]!;
		const header = arr(t.columns).map((c) => (isObj(c) ? String(c.name ?? "") : String(c)));
		const rows = arr(t.rows).map((r) => ({ cells: arr(r).map((v) => (v === null ? "" : String(v))), at: 0 }));
		return { header, rows, source: "kql" };
	}
	if (Array.isArray(json.results) && json.results.every(Array.isArray)) {
		if (json.status !== undefined && json.status !== "Complete") {
			throw new InputError(`This Logs Insights query is ${String(json.status)}, not Complete, so its counts may be partial. Wait for it to finish, then paste the results again.`, "values");
		}
		const header: string[] = [];
		const records = json.results.map((r) => {
			const fields = new Map<string, string>();
			for (const f of arr(r).filter(isObj)) {
				const name = String(f.field ?? "");
				if (name === "@ptr") continue;
				if (!header.includes(name)) header.push(name);
				fields.set(name, String(f.value ?? ""));
			}
			return fields;
		});
		return { header, rows: records.map((f) => ({ cells: header.map((h) => f.get(h) ?? ""), at: 0 })), source: "insights" };
	}
	return undefined;
}

/** The unit a bin column's name gives away: DurationMs and Lambda's @duration are milliseconds. Otherwise none. */
function binUnit(column: string): Unit {
	if (/^@?duration$/i.test(column) || /(ms|millis|milliseconds)$/i.test(column)) return "ms";
	if (/(_us|micros|microseconds)$/i.test(column)) return "us";
	if (/(_s|_sec|seconds)$/i.test(column)) return "s";
	return "";
}

const BIN_POOL: Record<Table["source"], (q: number, name: string) => string> = {
	kql: (_q, name) => `Take the ${name} over every request at once, as this tool does with the bins. In KQL that is one percentile() with no split by instance, never an average of per-instance results.`,
	insights: (_q, name) => `Take the ${name} over every request at once, as this tool does with the bins. In Logs Insights that is one pct() with no by clause, never an average of per-group results.`,
	csv: (_q, name) => `Take the ${name} over every request at once, as this tool does with the bins, never an average of per-instance results.`,
};

/**
 * Bucket and count rows into histograms: a duration rounded down to a bin, as KQL's bin() and Logs Insights' floor()
 * produce, and how many requests fell in it.
 *
 * The bin width is not in the result, so it is read from the spacing: the smallest gap between two bin values, which
 * every bin must sit a whole number of widths from. A bin from b covers b up to b + width, so both are edges, and a
 * bin with no row is simply empty. Every group gets the same edges, which is what lets the counts be added edge by edge.
 */
function binHistograms(table: Table): { groups: Histogram[]; src: HistSource } {
	const { header, rows } = table;
	const numeric = header.map((_, i) => rows.length > 0 && rows.every((r) => isNumeric(r.cells[i] ?? "")));
	const countAt = header.findIndex((h) => COUNT_COLUMN.test(h));
	const percentileCols = header.filter((h) => PERCENTILE_COLUMN.test(h));
	const candidates = header.map((h, i) => ({ h, i })).filter(({ h, i }) => numeric[i] && i !== countAt && !PERCENTILE_COLUMN.test(h));
	if (countAt < 0 || candidates.length === 0) {
		if (percentileCols.length > 0) {
			throw precomputed(
				`${percentileCols[0]} is a percentile worked out for each row.`,
				"Run the query again counting requests in duration bins instead, such as AppRequests | summarize requests = sum(ItemCount) by AppRoleInstance, bin(DurationMs, 10) in KQL, and paste that.",
			);
		}
		if (countAt < 0) throw new InputError(`A table of bins needs a count column, named count_, count(*), requests or sum_ItemCount. This one has ${header.join(", ")}.`, "values");
		throw new InputError("This table has a count column but no numeric column of bin values beside it, so there is no duration to place the counts at.", "values");
	}
	let bin = candidates[0]!;
	if (candidates.length > 1) {
		const named = candidates.filter(({ h }) => /bin|bucket|duration|latency|elapsed|response|time/i.test(h));
		if (named.length !== 1) {
			throw new InputError(`Which column is the bin? ${candidates.map(({ h }) => h).join(" and ")} are all numbers. Keep one bin column, the count, and any instance column.`, "values");
		}
		bin = named[0]!;
	}
	const labelCols = header.map((_, i) => i).filter((i) => i !== countAt && i !== bin.i && !numeric[i] && !PERCENTILE_COLUMN.test(header[i]!));

	const parsed: { label: string; lower: number; n: number }[] = [];
	for (const r of rows) {
		const at = r.at > 0 ? r.at : undefined;
		if (r.cells.length !== header.length) {
			throw new InputError(`This row has ${r.cells.length} cells, and the header names ${header.length} columns.`, "values", at, at === undefined ? undefined : 1);
		}
		const lower = Number(r.cells[bin.i]);
		if (lower < 0) throw new InputError(`A bin starts at ${r.cells[bin.i]}, and a duration can't be negative.`, "values", at, at === undefined ? undefined : 1);
		const label = (labelCols.map((i) => r.cells[i]!).filter(Boolean).join(" / ") || "all requests").slice(0, 40);
		parsed.push({ label, lower, n: countOf(r.cells[countAt]!) });
	}
	if (parsed.length === 0) throw new InputError("The table has a header and no rows.", "values");
	const lowers = [...new Set(parsed.map((p) => p.lower))].sort((a, b) => a - b);
	if (lowers.length < 2) throw new InputError("Every row is in the same bin, so the bin width can't be read from the spacing. Use a narrower bin.", "values");
	if (lowers.length > 1000) throw new InputError(`There are ${count(lowers.length)} bins, more than this tool lays out. Use a wider bin, so there are 1,000 or fewer.`, "values");
	const width = clean(Math.min(...lowers.slice(1).map((v, i) => v - lowers[i]!)));
	const base = lowers[0]!;
	const misplaced = lowers.find((v) => Math.abs((v - base) / width - Math.round((v - base) / width)) > 1e-6);
	if (misplaced !== undefined) {
		throw new InputError(
			`The bins are not evenly spaced: ${num(misplaced)} is not a whole number of ${num(width)}-wide bins from ${num(base)}. Use one bin() size for every row.`,
			"values",
		);
	}
	const edges = [...new Set(lowers.flatMap((v) => [clean(v), clean(v + width)]))].filter((e) => e > 0).sort((a, b) => a - b);

	const byLabel = new Map<string, Map<number, number>>();
	for (const p of parsed) {
		const g = byLabel.get(p.label) ?? new Map<number, number>();
		const upper = clean(p.lower + width);
		g.set(upper, (g.get(upper) ?? 0) + p.n);
		byLabel.set(p.label, g);
	}
	const groups: Histogram[] = [...byLabel.entries()].map(([label, perBin]) => {
		const buckets = new Map<number, number>();
		let running = 0;
		for (const e of edges) {
			running += perBin.get(e) ?? 0;
			buckets.set(e, running);
		}
		buckets.set(Number.POSITIVE_INFINITY, running);
		return { label, buckets };
	});
	const unit = binUnit(bin.h);
	return {
		groups,
		src: {
			noun: labelCols.length > 0 ? INSTANCE : GROUP,
			unit,
			inclusive: false,
			edgeColumn: "Bin upper edge",
			estimate: (name, lower, upper) =>
				`Estimated from the summed bins, ${dur(width, unit)} wide, interpolating inside a bin as Prometheus's histogram_quantile does, so the true ${name} is somewhere between ${lower} and ${upper}.`,
			overflow: (highest) => `It is above ${highest}, the top of the highest bin.`,
			pool: BIN_POOL[table.source],
			method: "Add the bins, then estimate",
			meanNote: "",
			bucketWord: "edges",
			addAbove: (highest) => `Count the requests above ${highest} too`,
			addBetween: () => `Use a narrower bin than ${dur(width, unit)}`,
			addAt: (threshold) => `Choose a bin size that puts an edge at ${threshold}`,
		},
	};
}

// ── Raw latencies, and X-Ray's value and count pairs ─────────────────────────────────────────────────────────────

/** A group of measurements as distinct values in order, each with how many times it occurred. Raw latencies count 1 each. */
type Weighted = { label: string; values: number[]; counts: number[]; n: number };

function weigh(label: string, pairs: [number, number][]): Weighted {
	const merged = new Map<number, number>();
	for (const [v, c] of pairs) if (c > 0) merged.set(v, (merged.get(v) ?? 0) + c);
	const values = [...merged.keys()].sort((a, b) => a - b);
	const counts = values.map((v) => merged.get(v)!);
	return { label, values, counts, n: sum(counts) };
}

/** The value at a 0-based rank, as if every value were written out as many times as it occurred. */
function atRank(g: Weighted, k: number): number {
	let seen = 0;
	for (let i = 0; i < g.values.length; i++) {
		seen += g.counts[i]!;
		if (seen > k) return g.values[i]!;
	}
	return g.values.at(-1)!;
}

/** Nearest rank: the smallest value with at least p% of the measurements at or below it. */
function nearest(g: Weighted, p: number): number {
	return atRank(g, Math.max(0, Math.ceil((p / 100) * g.n) - 1));
}

/** Linear interpolation between closest ranks, numpy's default. */
function linear(g: Weighted, p: number): number {
	const h = (g.n - 1) * (p / 100);
	const lo = Math.floor(h);
	const hi = Math.min(lo + 1, g.n - 1);
	const a = atRank(g, lo);
	return a + (h - lo) * (atRank(g, hi) - a);
}

/** Where a set of value groups came from: the words around the numbers, never the arithmetic. */
type RawSource = { noun: Noun; unit: Unit; things: string; perWhat: string; single: string; pool: (truth: string, averaged: string) => string };

const RAW: RawSource = {
	noun: GROUP,
	unit: "",
	things: "measurements",
	perWhat: "per-host",
	single: "One group, so there is nothing to roll up: paste two or more, one per host or per minute, separated by a blank line.",
	pool: (truth, averaged) =>
		`The average is ${averaged} against ${truth} for every measurement together. Pool the measurements, or record a histogram with the same bucket edges on every host and sum it.`,
};

function xraySource(noun: Noun): RawSource {
	return {
		noun,
		unit: "s",
		things: "requests",
		perWhat: `per-${noun.one}`,
		single: "One histogram, so there is nothing to roll up. GetTimeSeriesServiceStatistics with a Period of 60 returns one per minute, the figures a dashboard averages.",
		pool: (truth, averaged) =>
			`The average is ${averaged} against ${truth} for every request together. Add the histograms up, as this tool does, or ask X-Ray for one histogram covering the whole window, and take the percentile of that.`,
	};
}

/** X-Ray's HistogramEntry list: a response time in seconds, and the number of requests that took it. */
function xrayEntries(list: Json | undefined, label: string): Weighted {
	const pairs: [number, number][] = [];
	for (const e of arr(list)) {
		if (!isObj(e)) continue;
		const v = numberOf(e.Value);
		const c = numberOf(e.Count);
		if (!Number.isFinite(v) || v < 0) throw new InputError(`${label} has a histogram Value of ${String(e.Value)}, and a response time is a number of seconds, 0 or more.`, "values");
		if (!Number.isFinite(c) || c < 0) throw new InputError(`${label} has a histogram Count of ${String(e.Count)}, and a count is a number of requests, 0 or more.`, "values");
		pairs.push([v, c]);
	}
	return weigh(label, pairs);
}

/** An X-Ray timestamp, epoch seconds from the API or ISO 8601 from the AWS CLI, as the minute it starts, in UTC. */
function minuteOf(t: Json | undefined): string {
	const ms = typeof t === "number" ? t * 1000 : typeof t === "string" ? Date.parse(t) : Number.NaN;
	if (!Number.isFinite(ms)) return "";
	return new Date(ms).toISOString().slice(11, 16);
}

/**
 * GetTimeSeriesServiceStatistics (a histogram per period), GetServiceGraph (a histogram per service), or one bare
 * HistogramEntry list. The client node of a service graph stands for the callers, not a service, so it is left out.
 */
function xrayGroups(json: Json): { groups: Weighted[]; src: RawSource } | undefined {
	const isEntryList = (v: Json | undefined) => Array.isArray(v) && v.length > 0 && v.every((e) => isObj(e) && "Value" in e && "Count" in e);
	if (isObj(json) && Array.isArray(json.TimeSeriesServiceStatistics)) {
		const stats = json.TimeSeriesServiceStatistics.filter(isObj);
		const labels = stats.map((s) => minuteOf(s.Timestamp));
		const clash = new Set(labels).size !== labels.length || labels.some((l) => l === "");
		const groups = stats.map((s, i) => xrayEntries(s.ResponseTimeHistogram, clash ? `period ${i + 1}` : `${labels[i]} UTC`)).filter((g) => g.n > 0);
		if (groups.length === 0) throw new InputError("None of these periods has a response-time histogram with requests in it.", "values");
		return { groups, src: xraySource(PERIOD) };
	}
	if (isObj(json) && Array.isArray(json.Services)) {
		const services = json.Services.filter(isObj).filter((s) => s.Type !== "client");
		const groups = services.map((s, i) => xrayEntries(s.ResponseTimeHistogram, String(s.Name ?? `service ${i + 1}`).slice(0, 40))).filter((g) => g.n > 0);
		if (groups.length === 0) throw new InputError("None of these services has a response-time histogram with requests in it.", "values");
		return { groups, src: xraySource(SERVICE) };
	}
	if (isEntryList(json)) return { groups: [xrayEntries(json, "histogram")], src: xraySource(GROUP) };
	if (isObj(json) && isEntryList(json.ResponseTimeHistogram)) {
		return { groups: [xrayEntries(json.ResponseTimeHistogram, String(json.Name ?? "histogram").slice(0, 40))], src: xraySource(GROUP) };
	}
	return undefined;
}

/**
 * Groups separated by one or more blank lines, each optionally starting with a label and a colon: `host 1: 12 14`.
 *
 * ⚠️ A comma between two digits is refused rather than guessed at, the same rule as the Percentiles tool in
 * toolbench, for the same reason: `1,204` is one number to someone pasting from a dashboard and two to someone
 * pasting a list, and a confident wrong percentile is worse than an error. A comma followed by a space separates.
 */
function parse(text: string): Weighted[] {
	const groups: Weighted[] = [];
	const blocks = [...text.matchAll(/[^\n]*\S[^\n]*(?:\n[^\n]*\S[^\n]*)*/g)];
	const lines = text.split("\n").filter((l) => l.trim() !== "");
	const allPairs = lines.length > 0 && lines.every((l) => /^\s*[\d.]+,[\d.]+\s*$/.test(l));
	for (const block of blocks) {
		let body = block[0];
		let offset = block.index ?? 0;
		let label = `group ${groups.length + 1}`;
		const head = /^\s*([^\n:]*[^\s\d.,;:\n][^\n:]*):/.exec(body);
		if (head) {
			label = head[1]!.trim().slice(0, 40);
			offset += head[0].length;
			body = body.slice(head[0].length);
		}
		const values: [number, number][] = [];
		for (const token of body.matchAll(/[^\s;]+/g)) {
			const raw = token[0];
			const at = offset + (token.index ?? 0);
			const comma = /\d,\d/.exec(raw);
			if (comma) {
				throw new InputError(
					allPairs
						? "These look like bucket edges and counts. Add a header line, le,count, so they are read as a histogram."
						: "A comma between two digits could be a thousands separator or two numbers run together. Write 1204, or put a space after each comma.",
					"values",
					at + comma.index + 1,
					1,
				);
			}
			for (const part of raw.split(",")) {
				if (part === "") continue;
				const v = Number(part);
				if (/^-\d/.test(part)) {
					throw new InputError(`${part.slice(0, 20)} is negative, and a duration can't be.`, "values", at + raw.indexOf(part), part.length);
				}
				if (!/^[+]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(part) || !Number.isFinite(v)) {
					throw new InputError(`"${part.slice(0, 20)}" is not a number.`, "values", at + raw.indexOf(part), part.length);
				}
				values.push([v, 1]);
			}
		}
		if (values.length > 0) groups.push(weigh(label, values));
	}
	return groups;
}

function rawRollup(groups: Weighted[], src: RawSource, name: string, p: number, threshold: number): Output {
	if (groups.length === 0) throw new InputError("Paste some measurements first, or Prometheus bucket lines.", "values");
	const { noun } = src;
	const d = (v: number) => dur(v, src.unit);
	const pooled = weigh(
		"all",
		groups.flatMap((g) => g.values.map((v, i): [number, number] => [v, g.counts[i]!])),
	);
	const n = pooled.n;

	const truth = nearest(pooled, p);
	const each = groups.map((g) => nearest(g, p));
	const averaged = sum(each) / each.length;
	const below = (g: Weighted) => sum(g.values.map((v, i) => (v < threshold ? g.counts[i]! : 0)));
	const under = groups.map(below);
	const good = sum(under);
	const total = (g: Weighted) => sum(g.values.map((v, i) => v * g.counts[i]!));
	const mean = total(pooled) / n;
	const plainMean = sum(groups.map((g) => total(g) / g.n)) / groups.length;
	const r = groups.length > 1 && truth > 0 ? ratioNote(averaged / truth) : undefined;

	// Every value is known, so the pooled row is exact and needs no range beside it.
	const parts: Output[] = [
		{
			kind: "table",
			role: "comparison",
			caption: `${name} across ${across(groups.length, noun)}`,
			columns: [
				{ label: "Method", wrap: "prose" },
				{ label: name, align: "end", mono: true, wrap: "none" },
				{ label: "What you can claim", wrap: "prose" },
			],
			rows: [
				[`Every ${src.things === "requests" ? "request" : "measurement"}, ranked`, { text: d(truth), mono: true }, `exact: nearest rank of ${count(n)}`],
				...(groups.length > 1 ? [[`Average of the ${poss(noun.many)} ${name}s`, { text: d(averaged), mono: true }, r ? r.text : "the true value is 0"] as Cell[]] : []),
			],
		},
	];

	// The share slower than each observed value, as a step: between two observed values nothing was measured, so it holds.
	const plot = (v: number) => plotValue(v, src.unit);
	const steps = pooled.values.map((v, i) => [v, i] as const).filter(([v]) => v > 0);
	if (steps.length >= 2 && steps.length <= 400) {
		let seen = 0;
		const slower = pooled.counts.map((c) => {
			seen += c;
			return Number((100 * (1 - seen / n)).toPrecision(4));
		});
		const tail = 100 - p;
		parts.push({
			kind: "series",
			chart: {
				xLabel: capital(src.things === "requests" ? "response time" : "measurement"),
				...(src.unit === "" ? {} : { xUnit: "ms" }),
				yLabel: "Share slower",
				yUnit: "%",
				xScale: "log",
				yScale: "log",
				x: steps.map(([v]) => plot(v)),
				series: [{ label: `${capital(src.things)} slower than each value`, shape: "step", unit: "%", points: steps.map(([, i]) => slower[i]!) }],
				thresholds: [{ y: Number(tail.toPrecision(4)), label: `${num(tail)}% slower: the ${name}` }],
				annotations: [{ x: plot(truth), label: `${name}, ${d(truth)}` }],
			},
		});
	}

	parts.push({
		kind: "fields",
		role: "metrics",
		fields: [
			{
				label: `Under ${d(threshold)}`,
				value: pct(good / n),
				note: `exact: ${count(good)} of ${count(n)}`,
			},
			{
				label: "Mean",
				value: d(mean),
				note: groups.length > 1 ? `weighted by count; the plain average of the ${noun.one} means is ${d(plainMean)}` : "for capacity, not for describing a request",
			},
			{ label: capital(src.things), value: count(n), note: `${groups.length} ${groups.length === 1 ? noun.one : noun.many}` },
		],
	});
	if (r?.off) {
		parts.push({
			kind: "table",
			role: "actions",
			caption: "What to change",
			columns: [{ label: "What to do" }, { label: "Why" }],
			rows: [[{ text: `Stop averaging ${src.perWhat} ${name}s`, tone: "warn" }, src.pool(d(truth), d(averaged))]],
		});
	}

	const order = groups.map((_, i) => i).sort((a, b) => each[b]! - each[a]!);
	parts.push({
		kind: "table",
		caption: `Each ${noun.one} on its own, slowest first, nearest rank`,
		columns: [
			{ label: capital(noun.one), wrap: "none", rowHeader: true },
			{ label: "Count", align: "end", mono: true, wrap: "none" },
			{ label: "Mean", align: "end", mono: true, wrap: "none" },
			{ label: "p50", align: "end", mono: true, wrap: "none" },
			{ label: name, align: "end", mono: true, wrap: "none" },
			{ label: `Under ${d(threshold)}`, align: "end", mono: true, wrap: "none" },
		],
		rows: order.map((i) => {
			const g = groups[i]!;
			return [
				g.label,
				{ text: count(g.n), mono: true },
				{ text: d(total(g) / g.n), mono: true },
				{ text: d(nearest(g, 50)), mono: true },
				{ text: d(each[i]!), mono: true },
				{ text: pct(under[i]! / g.n), mono: true },
			];
		}),
	});
	parts.push({
		kind: "table",
		caption: `Every ${src.things === "requests" ? "request" : "measurement"} together, under both definitions. On a small or lumpy sample they disagree.`,
		columns: [
			{ label: "Percentile", wrap: "none", rowHeader: true },
			{ label: "Nearest rank", align: "end", mono: true, wrap: "none" },
			{ label: "Linear, as numpy and R", align: "end", mono: true, wrap: "none" },
		],
		rows: Object.entries(PERCENTILES).map(([label, q]) => [label, { text: d(nearest(pooled, q)), mono: true }, { text: d(linear(pooled, q)), mono: true }]),
	});
	if (groups.length === 1) parts.push({ kind: "fields", role: "method", fields: [{ label: "One group", value: src.single, mono: false }] });
	return { kind: "group", parts };
}

// ── Reading what was pasted ──────────────────────────────────────────────────────────────────────────────────────

/** Exports that carry statistics rather than a distribution, each refused with where to find the histogram instead. */
function refuseStatistics(json: Json): void {
	if (!isObj(json)) return;
	if (Array.isArray(json.MetricDataResults) || Array.isArray(json.Datapoints)) {
		throw precomputed(
			"This is CloudWatch metric data: one statistic per period, such as p99 or Average, and never the distribution behind it.",
			"Ask CloudWatch for the p99 over the whole window and every dimension at once, so it is computed from the raw data, or count requests under your threshold with the PR(:0.1) or TC(:0.1) statistic. For a histogram, count requests per duration bin in CloudWatch Logs Insights, or use X-Ray's response-time histogram, and paste that.",
		);
	}
	if (arr(json.value).some((m) => isObj(m) && Array.isArray(m.timeseries))) {
		throw precomputed(
			"This is Azure Monitor metrics data, which keeps only a sum, a count, a minimum, a maximum and an average per interval.",
			"For a histogram, query the requests in Log Analytics instead, such as AppRequests | summarize requests = sum(ItemCount) by AppRoleInstance, bin(DurationMs, 10), and paste the result.",
		);
	}
}

function fromJson(text: string, name: string, q: number, threshold: number): Output {
	let json: Json;
	try {
		json = JSON.parse(text) as Json;
	} catch (error) {
		const reason = error instanceof Error ? error.message : "";
		throw new InputError(`This starts like JSON but does not parse${reason ? `: ${reason.slice(0, 120)}` : ""}. Paste the whole response, from its first brace to its last.`, "values");
	}
	refuseStatistics(json);
	if (isObj(json) && isObj(json.data) && "result" in json.data) {
		const { groups, src } = prometheusJson(json);
		return histogramRollup(groups, src, name, q, threshold);
	}
	const gcp = gcpHistograms(json);
	if (gcp) return histogramRollup(gcp.groups, gcp.src, name, q, threshold);
	const xray = xrayGroups(json);
	if (xray) return rawRollup(xray.groups, xray.src, name, q * 100, threshold);
	const table = isObj(json) ? jsonTable(json) : undefined;
	if (table) {
		const { groups, src } = binHistograms(table);
		return histogramRollup(groups, src, name, q, threshold);
	}
	throw new InputError(
		"This JSON is not a format this tool reads. It reads Cloud Monitoring's timeSeries.list, X-Ray's GetServiceGraph and GetTimeSeriesServiceStatistics, the Prometheus query API, and Log Analytics and CloudWatch Logs Insights query results.",
		"values",
	);
}

export default {
	run({ values, percentile, threshold }: Input) {
		try {
			const p = PERCENTILES[percentile];
			if (p === undefined) throw new InputError("Pick one of the listed percentiles.", "percentile");
			if (!(threshold > 0)) throw new InputError("The threshold must be greater than zero.", "threshold");
			const q = p / 100;
			const start = values.trimStart();
			// A line such as {instance="a",le="0.1"} 12 starts with a brace too, and is Prometheus text, not JSON.
			if ((start.startsWith("{") || start.startsWith("[")) && !/^\{[^}\n]*\ble\s*=\s*"[^"\n]*"[^}\n]*\}\s+\S/.test(start)) return fromJson(values, percentile, q, threshold);
			if (looksLikeBuckets(values)) {
				const { groups, metric } = parseBuckets(values);
				return histogramRollup(groups, prometheusSource(metric), percentile, q, threshold);
			}
			const table = binTable(values);
			if (table) {
				const { groups, src } = binHistograms(table);
				return histogramRollup(groups, src, percentile, q, threshold);
			}
			return rawRollup(parse(values), RAW, percentile, p, threshold);
		} catch (error) {
			if (error instanceof InputError) {
				return {
					kind: "error",
					message: error.message,
					input: error.input,
					...(error.at !== undefined ? { at: error.at } : {}),
					...(error.len !== undefined ? { len: error.len } : {}),
				};
			}
			throw error;
		}
	},
} satisfies Tool<Input>;
