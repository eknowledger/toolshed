/**
 * Metric cardinality: how many time series one metric becomes, where it is stored, and what that backend bills.
 *
 * The product of label values is the same everywhere. What changes with the backend is what one label set
 * writes, whether each process writing the metric gets its own series, the limits worth knowing, and the unit
 * the bill is counted in. Each backend's rules are in BACKENDS below, and every one of them is a rule the
 * provider's own documentation states; the README's provider table quotes and links each one.
 *
 * For self-hosted Prometheus:
 *
 * Every number is a product, so nothing here is estimated except the disk, which uses the 1 to 2 bytes per sample
 * Prometheus's storage documentation gives:
 *
 *  - label sets are the product of each label's value count, times the share of combinations that occur;
 *  - each label set writes a fixed number of series for its type: a classic histogram one per bucket, +Inf
 *    included, plus `_sum` and `_count`; a summary one per quantile plus `_sum` and `_count`; a counter one; a
 *    gauge or a native histogram one. Clients that write `_created` add one more to counters, histograms and
 *    summaries, which prometheus_client for Python does by default;
 *  - every scrape target attaches its own `instance` label, so every process exposing the metric multiplies it.
 *
 * A summary's quantile count is folded into the type: Python's prometheus_client writes summaries with no
 * quantiles at all, and three (0.5, 0.9, 0.99) is a typical configuration, so those are the two options rather
 * than a number input that only one type reads.
 *
 * The mistakes it exists for are the common ones: counting a histogram as one series, forgetting the targets, and
 * treating a label's value count as additive rather than a multiplier.
 */
import type { Field, Output, Row, Tool } from "@toolbench/sdk";

type Input = {
	backend: string;
	labels: Row[];
	type: string;
	client: string;
	buckets: number;
	created: boolean;
	targets: number;
	occur: number;
	interval: number;
	price: number;
};

/**
 * Retention is not an input. The disk figure is for Prometheus's default 15 days, which the note says, and is the
 * one number here that scales trivially with the reader's own retention. Cutting it left the form with one fewer
 * thing to fill in on the way to the series count, which is the answer people come for.
 */
const RETENTION_DAYS = 15;

/** Billing month for the per-sample and per-byte backends. AWS's own examples use 744 hours; a month is said in the note. */
const MONTH_S = 30 * 86_400;

type Family = "prom" | "cloudwatch" | "azure-custom" | "gcm-custom";

export type Backend = {
	name: string;
	/** How the provider's documentation names the thing it stores. */
	unit: "series" | "custom metrics";
	family: Family;
	/** Each target attaches its own identity: an `instance` label, or Cloud Monitoring's monitored resource. */
	targetsMultiply: boolean;
	/** What the price input is per, for this backend. */
	priceUnit?: string;
	/** A limit on series, with what it applies to. */
	seriesLimit?: { n: number; per: "metric" | "target"; what: string };
	/** A limit on labels per metric. Only those under the parser's own 30 can be broken. */
	labelLimit?: { n: number; what: string };
	/** The shortest interval the backend accepts, in seconds. */
	minInterval?: number;
	note: string;
};

/*
 * ⚠️ Every number here is quoted in the README with its source and the date it was checked. Change one only
 * from the provider's own page, and change the README in the same commit.
 *
 * Limits that apply to a whole workspace or subscription are judged against this one metric, so the tone is
 * "this metric alone breaks it", which is the case worth flagging; the method note says they are shared.
 */
export const BACKENDS: Record<string, Backend> = {
	prometheus: {
		name: "Prometheus, self-hosted",
		unit: "series",
		family: "prom",
		targetsMultiply: true,
		priceUnit: "1,000 active series",
		note: "Kept on your own servers.",
	},
	amp: {
		name: "Amazon Managed Service for Prometheus",
		unit: "series",
		family: "prom",
		targetsMultiply: true,
		priceUnit: "10 million samples ingested",
		seriesLimit: { n: 50_000_000, per: "metric", what: "active series per workspace, the default quota" },
		note: "Billed per metric sample ingested; storage and query samples are billed separately.",
	},
	"azure-prom": {
		name: "Azure Monitor managed service for Prometheus",
		unit: "series",
		family: "prom",
		targetsMultiply: true,
		priceUnit: "10 million samples ingested",
		seriesLimit: {
			n: 1_000_000,
			per: "metric",
			what: "active time series per Azure Monitor workspace, the default limit",
		},
		note: "Billed per sample ingested, retention included; query samples are billed separately.",
	},
	gmp: {
		name: "Google Cloud Managed Service for Prometheus",
		unit: "series",
		family: "prom",
		targetsMultiply: true,
		priceUnit: "1 million samples ingested",
		seriesLimit: { n: 1_000_000, per: "target", what: "active time series from Prometheus per monitored resource" },
		minInterval: 5,
		note: "Billed per sample ingested. A histogram is stored as one distribution series.",
	},
	cloudwatch: {
		name: "Amazon CloudWatch custom metrics",
		unit: "custom metrics",
		family: "cloudwatch",
		targetsMultiply: false,
		priceUnit: "metric-month",
		note: "Published with PutMetricData, or extracted from Embedded Metric Format logs.",
	},
	"azure-custom": {
		name: "Azure Monitor custom metrics",
		unit: "series",
		family: "azure-custom",
		targetsMultiply: false,
		seriesLimit: { n: 50_000, per: "metric", what: "active time series in a subscription per region" },
		labelLimit: { n: 10, what: "dimension keys per metric" },
		note: "In preview, and Microsoft says it won't become generally available.",
	},
	"gcm-custom": {
		name: "Google Cloud Monitoring custom metrics",
		unit: "series",
		family: "gcm-custom",
		targetsMultiply: true,
		priceUnit: "MiB ingested",
		seriesLimit: { n: 200_000, per: "target", what: "active time series from custom metrics per monitored resource" },
		minInterval: 5,
		note: "Billed per byte ingested: 8 bytes a point for a number, 80 for a distribution.",
	},
};

class InputError extends Error {
	readonly input: string;
	/** The row of a rows input at fault, 0 first, which the runtime shows the message under. */
	readonly row: number | undefined;
	constructor(message: string, input: string, row?: number) {
		super(message);
		this.input = input;
		this.row = row;
	}
}

export type Label = { name: string; values: number };

const NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** Labels the client or the server already owns for a type, so a user label by that name collides. */
const RESERVED: Record<string, string[]> = { histogram: ["le"], summary: ["quantile"], summary3: ["quantile"] };
/** Types whose clients may write `_created`. */
const HAS_CREATED = new Set(["counter", "histogram", "summary", "summary3"]);

/**
 * The labels, one row each: a name and how many values it takes. Prometheus's naming rule is checked only for a
 * Prometheus backend; CloudWatch dimensions and Azure dimensions take other names. Each refusal names its row.
 */
export function readLabels(rows: readonly Row[], prom = true): Label[] {
	const out: Label[] = [];
	rows.forEach((r, row) => {
		const name = String(r.name ?? "").trim();
		if (!name) throw new InputError("Give the label a name.", "labels", row);
		if (prom && !NAME.test(name))
			throw new InputError(
				`"${name}" is not a valid label name: letters, digits and _, not starting with a digit.`,
				"labels",
				row,
			);
		if (prom && name.startsWith("__"))
			throw new InputError("Label names starting with __ are reserved for Prometheus itself.", "labels", row);
		const values = Number(r.values);
		if (!Number.isSafeInteger(values) || values < 1)
			throw new InputError(`${name} needs a whole number of values, at least 1.`, "labels", row);
		if (out.some((l) => l.name === name)) throw new InputError(`${name} is listed twice.`, "labels", row);
		out.push({ name, values });
	});
	// The manifest's maxRows stops a reader at 30; this stops a caller that is not a form.
	if (out.length > 30) throw new InputError("At most 30 labels.", "labels");
	return out;
}

/** Series one label set writes, by type. */
export function perLabelSet(
	type: string,
	buckets: number,
	quantiles: number,
	created: boolean,
): { n: number; parts: string } {
	const c = created && HAS_CREATED.has(type) ? 1 : 0;
	const cr = c ? " + _created" : "";
	switch (type) {
		case "counter":
			return { n: 1 + c, parts: `_total${cr}` };
		case "gauge":
			return { n: 1, parts: "the value" };
		case "histogram":
			return { n: buckets + 1 + 2 + c, parts: `${buckets} buckets + le="+Inf" + _sum + _count${cr}` };
		case "summary":
		case "summary3": {
			const q = type === "summary3" ? 3 : quantiles;
			return { n: q + 2 + c, parts: `${q ? `${q} quantiles + ` : ""}_sum + _count${cr}` };
		}
		case "native":
			return { n: 1, parts: "one native histogram sample, its buckets inside it" };
		default:
			throw new InputError(`Unknown metric type "${type}".`, "type");
	}
}

/** 12345678 -> "12,345,678"; small fractions keep two digits. */
export function num(x: number): string {
	if (x >= 100 || Number.isInteger(x)) return Math.round(x).toLocaleString("en-US");
	return (Math.round(x * 100) / 100).toLocaleString("en-US");
}

/** Bytes in the largest unit that keeps the number at or above 1. */
export function bytes(n: number): string {
	const units = ["B", "KB", "MB", "GB", "TB", "PB"];
	let x = n;
	let i = 0;
	while (x >= 1000 && i < units.length - 1) {
		x /= 1000;
		i++;
	}
	return `${x >= 100 ? Math.round(x) : Math.round(x * 10) / 10} ${units[i]}`;
}

const money = (x: number) => (x >= 100 ? `$${Math.round(x).toLocaleString("en-US")}` : `$${x.toFixed(2)}`);
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
/** "45%", or "under 1%" for a share that would otherwise round to nothing. */
const pct = (part: number, whole: number) => {
	const p = (100 * part) / whole;
	if (p > 0 && p < 1) return "under 1%";
	if (p > 99 && p < 100) return "over 99%";
	return `${Math.round(p)}%`;
};

export function count(labels: Label[], occur: number): number {
	const product = labels.reduce((p, l) => p * l.values, 1);
	return Math.max(1, Math.ceil((product * occur) / 100));
}

/** 1,306,368,000 -> "1.31 billion"; below a million, the whole number. */
export function big(x: number): string {
	if (x >= 1e9) return `${num(Math.round(x / 1e7) / 100)} billion`;
	if (x >= 1e6) return `${num(Math.round(x / 1e4) / 100)} million`;
	return num(Math.round(x));
}

export type Writes = {
	/** Series one label set writes. */
	n: number;
	parts: string;
	/** Samples one label set writes per scrape or write, where the backend bills samples. */
	samples: number;
	/** "" exact, "up to" when it depends on how many buckets have counts, "at least" for the same, the other way. */
	bound: "" | "up to" | "at least";
	/** Where samples can't be counted from the inputs: the reason. */
	uncounted?: string;
	/** Bytes per point, for Cloud Monitoring's byte billing. */
	bytes: number;
};

/** What one label set writes, on this backend. */
export function writes(id: string, type: string, buckets: number, created: boolean): Writes {
	const b = BACKENDS[id]!;
	if (b.family === "cloudwatch") {
		perLabelSet(type, buckets, 0, false);
		return { n: 1, parts: "one metric per dimension combination, whatever the type", samples: 1, bound: "", bytes: 0 };
	}
	if (b.family === "azure-custom") {
		perLabelSet(type, buckets, 0, false);
		return {
			n: 1,
			parts: "one time series per combination of dimensions, whatever the type",
			samples: 1,
			bound: "",
			bytes: 0,
		};
	}
	if (b.family === "gcm-custom") {
		if (type === "histogram" || type === "native")
			return { n: 1, parts: "one distribution series, its buckets inside it", samples: 1, bound: "", bytes: 80 };
		const per = perLabelSet(type, buckets, 0, false);
		return { n: per.n, parts: per.parts, samples: per.n, bound: "", bytes: 8 };
	}
	const per = perLabelSet(type, buckets, 0, created);
	if (id === "gmp" && type === "histogram") {
		const c = per.n - (buckets + 3);
		return {
			n: 1 + c,
			parts: `one distribution series, its ${buckets + 1} buckets inside it${c ? " + _created" : ""}`,
			samples: buckets + 3 + c,
			bound: "up to",
			bytes: 0,
		};
	}
	if (id === "gmp" && type === "native") return { ...per, samples: 2, bound: "at least", bytes: 0 };
	if (id === "amp" && type === "native")
		return {
			...per,
			samples: 0,
			bound: "",
			uncounted:
				"Amazon meters a native histogram at 0.25 of a sample per bucket with counts in it, which depends on your data.",
			bytes: 0,
		};
	if (id === "azure-prom" && type === "native")
		return {
			...per,
			samples: 0,
			bound: "",
			uncounted: "Azure's pricing page doesn't say how a native histogram is counted.",
			bytes: 0,
		};
	return { ...per, samples: per.n, bound: "", bytes: 0 };
}

export default {
	run(input: Input) {
		try {
			const id = String(input.backend ?? "prometheus");
			const backend = BACKENDS[id];
			if (!backend) throw new InputError(`Unknown backend "${id}".`, "backend");
			const prom = backend.family === "prom";
			const labels = readLabels(input.labels ?? [], prom);
			const type = String(input.type);
			labels.forEach((l, row) => {
				if (prom && (RESERVED[type] ?? []).includes(l.name)) {
					const what = type === "histogram" ? "histogram" : "summary";
					throw new InputError(
						`"${l.name}" is the label a ${what} writes itself, so yours would collide with it.`,
						"labels",
						row,
					);
				}
			});
			const buckets = Number(input.buckets);
			if (type === "histogram" && (!Number.isInteger(buckets) || buckets < 0 || buckets > 1000)) {
				throw new InputError("Buckets is a whole number from 0 to 1,000, not counting +Inf.", "buckets");
			}
			if (id === "gcm-custom" && type === "histogram" && buckets + 1 > 200) {
				throw new InputError("Cloud Monitoring allows at most 200 buckets in a custom distribution.", "buckets");
			}
			const targets = Number(input.targets);
			if (!Number.isInteger(targets) || targets < 1)
				throw new InputError("At least 1 target exposes the metric.", "targets");
			const occur = Number(input.occur);
			if (!(occur > 0 && occur <= 100))
				throw new InputError("The share that occurs is above 0% and at most 100%.", "occur");
			const interval = Number(input.interval);
			if (!(interval > 0)) throw new InputError("The scrape interval is a positive number of seconds.", "interval");
			if (backend.minInterval && interval < backend.minInterval)
				throw new InputError(
					`${backend.name} accepts at most one point every ${backend.minInterval} s per series, so the interval is at least that.`,
					"interval",
				);
			const price = Number(input.price ?? 0);
			if (!(price >= 0)) throw new InputError("The price can't be negative.", "price");
			const created = prom && Boolean(input.created);

			const w = writes(id, type, buckets, created);
			const per = { n: w.n, parts: w.parts };
			const sets = count(labels, occur);
			const tf = backend.targetsMultiply ? targets : 1;
			const series = sets * per.n * tf;
			const without = (l: Label) =>
				count(
					labels.filter((x) => x !== l),
					occur,
				) *
				per.n *
				tf;

			/*
			 * Prometheus's instrumentation guide: keep a metric's cardinality below 10, and investigate anything over
			 * 100. Its "cardinality" is label sets, before the type multiplies them, which is the number judged here.
			 * The guide is Prometheus's, so only the Prometheus backends show it.
			 */
			const tone = sets > 100 ? "bad" : sets >= 10 ? "warn" : undefined;
			const guide =
				sets > 100
					? "Over 100, where Prometheus's guide says to look for another way."
					: sets >= 10
						? "Prometheus's guide aims for fewer than 10."
						: "Fewer than 10, as Prometheus's guide aims for.";
			const ceiling =
				occur === 100 && labels.filter((l) => l.values > 1).length >= 2
					? " Assumes every combination of values occurs; set the share that does if you know it."
					: "";

			/*
			 * The multiplication, factor by factor, so the answer can be checked by hand. The share that occurs is a
			 * factor of its own, and the label sets are rounded up after it, so with a share the product is the
			 * ceiling and the series count can sit a few above it. A backend where every process writes into the
			 * same metric has no targets factor, and the method says why.
			 */
			const one = backend.unit === "custom metrics" ? "metric" : "series";
			const factors = labels.length
				? labels.map(
						(l, i) =>
							`${num(l.values)} ${l.name}${i === labels.length - 1 ? (l.values === 1 ? " value" : " values") : ""}`,
					)
				: ["1 label set"];
			if (occur < 100) factors.push(`${num(occur)}% that occur`);
			factors.push(`${per.n} ${per.n === 1 ? one : one === "metric" ? "metrics" : "series"} per label set`);
			if (backend.targetsMultiply) factors.push(plural(targets, "target"));

			/*
			 * Each change the reader can make, scored by the same multiplication with it made, fewest series first. The
			 * native histogram is in it where a classic histogram is many series, because there it is usually the
			 * biggest cut.
			 *
			 * ⚠️ A label's row is what DROPPING it leaves. Grouping its values into a few leaves something between that
			 * and today, which is why the row says "Without route" and the method notes say how to group.
			 */
			type Change = { name: string; after: number };
			const changes: Change[] = [];
			for (const l of labels) if (l.values > 1) changes.push({ name: `Without ${l.name}`, after: without(l) });
			if (prom && type === "histogram" && per.n > 1 + (created ? 1 : 0))
				changes.push({ name: "Native histogram", after: sets * tf });
			if (created && HAS_CREATED.has(type)) changes.push({ name: "Without _created", after: sets * (per.n - 1) * tf });
			changes.sort((a, b) => a.after - b.after);

			const metrics: Field[] = [];
			if (prom)
				metrics.push({ label: "Label sets", value: num(sets), note: `${guide}${ceiling}`, ...(tone ? { tone } : {}) });

			/* What the backend bills, in its own unit, and the bill when the reader gives their price for it. */
			let bill: number | undefined;
			const bound = w.bound ? `${w.bound[0]!.toUpperCase()}${w.bound.slice(1)} ` : "";
			if (id === "prometheus") {
				const perSecond = series / interval;
				const kept = perSecond * 86_400 * RETENTION_DAYS;
				metrics.push(
					{ label: "Samples", value: `${num(perSecond)} a second`, note: `One per series every ${num(interval)} s.` },
					{
						label: "Disk",
						value: `${bytes(kept)} to ${bytes(kept * 2)}`,
						note: `Over ${RETENTION_DAYS} days, Prometheus's default retention, at 1 to 2 bytes a sample.`,
					},
				);
				bill = (series / 1000) * price;
			} else if (prom) {
				const monthly = (sets * tf * w.samples * MONTH_S) / interval;
				if (w.uncounted) {
					metrics.push({ label: "Samples ingested", value: "Not countable from these inputs", note: w.uncounted });
				} else {
					const how =
						id === "gmp" && type === "histogram"
							? `Each scrape of a histogram is 2 samples plus 1 per bucket with a count in it, ${buckets + 1} buckets here.`
							: id === "gmp" && type === "native"
								? "Each scrape of a native histogram is 2 samples plus 1 per 8 buckets with counts in them."
								: `One per series every ${num(interval)} s.`;
					metrics.push({
						label: "Samples ingested",
						value: `${bound}${big(monthly)} a month`,
						note: `${how} In a 30-day month.`,
					});
					bill = (monthly / (id === "gmp" ? 1e6 : 1e7)) * price;
				}
			} else if (id === "gcm-custom") {
				const mib = (sets * tf * w.samples * w.bytes * MONTH_S) / interval / 2 ** 20;
				metrics.push({
					label: "Bytes ingested",
					value: `${num(mib)} MiB a month`,
					note: `${w.bytes} bytes a point, one point per series every ${num(interval)} s, in a 30-day month. The first 150 MiB a month of each billing account are free.`,
				});
				bill = mib * price;
			} else if (id === "cloudwatch") {
				metrics.push({
					label: "Billed as",
					value: `${plural(series, "metric-month")}`,
					note: "Prorated by the hour, for the hours a metric gets data. PutMetricData requests, or an EMF log's ingestion, are billed on top.",
				});
				bill = series * price;
			} else {
				metrics.push({
					label: "Billed as",
					value: "Free during the preview",
					note: "For new work Microsoft points to OpenTelemetry metrics in an Azure Monitor workspace, billed per sample ingested.",
				});
			}
			if (bill !== undefined && price > 0) {
				metrics.push({
					label: "Bill",
					value: `${bound}${money(bill)} a month`,
					note: `At ${money(price)} per ${backend.priceUnit}.`,
				});
			}

			/* A provider's limit is flagged only when this metric alone breaks it. */
			const lim = backend.seriesLimit;
			if (lim) {
				const mine = lim.per === "target" ? series / tf : series;
				if (mine > lim.n)
					metrics.push({
						label: "Series limit",
						value: `${num(mine)} of ${num(lim.n)}`,
						note: `${backend.name} allows ${num(lim.n)} ${lim.what}${lim.per === "target" ? "; this is one target's share" : ""}.`,
						tone: "bad",
					});
			}
			if (id === "azure-prom") {
				const perMinute = (series * 60) / interval;
				if (perMinute > 1_000_000)
					metrics.push({
						label: "Ingest limit",
						value: `${num(perMinute)} events a minute`,
						note: "Azure allows 1,000,000 events per minute ingested into a workspace.",
						tone: "bad",
					});
			}
			if (backend.labelLimit && labels.length > backend.labelLimit.n)
				metrics.push({
					label: "Label limit",
					value: `${labels.length} labels`,
					note: `${backend.name} allows ${backend.labelLimit.n} ${backend.labelLimit.what}.`,
					tone: "bad",
				});

			const key = backend.unit === "custom metrics" ? plural(series, "custom metric") : `${num(series)} series`;
			const parts: Output[] = [
				{
					kind: "fields",
					role: "key",
					fields: [{ label: backend.unit === "custom metrics" ? "Custom metrics" : "Time series", value: key }],
				},
				{ kind: "text", role: "formula", mono: true, text: factors.join(" x ") },
			];
			if (changes.length) {
				parts.push({
					kind: "series",
					chart: {
						id: "changes",
						xLabel: "Change",
						yLabel: backend.unit === "custom metrics" ? "Metrics" : "Series",
						orientation: "horizontal",
						x: [...changes.map((c) => c.name), "Now"],
						series: [
							{
								label: backend.unit === "custom metrics" ? "Metrics" : "Series",
								shape: "bar",
								points: [...changes.map((c) => c.after), series],
							},
						],
						readout: { highlightTable: true },
					},
				});
				parts.push({
					kind: "table",
					role: "comparison",
					caption: "Each change on its own",
					columns: [
						{ label: "Change", wrap: "prose", rowHeader: true },
						{
							label: `${backend.unit === "custom metrics" ? "Metrics" : "Series"} after`,
							align: "end",
							mono: true,
							wrap: "none",
						},
						{ label: "Saves", align: "end", mono: true, wrap: "none" },
					],
					rows: changes.map((c) => [
						c.name,
						{ text: num(c.after), mono: true },
						{ text: `${num(series - c.after)} (${pct(series - c.after, series)})`, mono: true },
					]),
					link: { chart: "changes", keys: changes.map((c) => c.name) },
				});
			}
			parts.push({ kind: "fields", role: "metrics", fields: metrics });

			const how = "How to make each change";
			const worked = "How this was worked out";
			const method: Field[] = [
				{
					group: worked,
					label: prom
						? "Series per label set"
						: backend.unit === "custom metrics"
							? "Metrics per label set"
							: "Series per label set",
					value: String(per.n),
					note: per.parts,
				},
			];
			if (id !== "prometheus")
				method.push({ group: worked, label: "Stored in", value: backend.name, note: backend.note, mono: false });
			if (!backend.targetsMultiply && targets > 1) {
				method.push({
					group: worked,
					label: "Targets",
					value: "Not a factor here",
					note:
						id === "cloudwatch"
							? `CloudWatch treats each unique combination of dimensions as one metric, so ${num(targets)} processes publishing the same dimensions write the same metrics. If each adds its own, such as a host, list it as a label.`
							: `Microsoft counts a time series per unique combination of metric and dimension values, so ${num(targets)} processes sending the same dimensions to the same resource count once. If each adds its own, such as a host, list it as a label.`,
				});
			}
			if (id === "gcm-custom" && targets > 1) {
				method.push({
					group: worked,
					label: "Targets",
					value: "Each its own monitored resource",
					note: "A time series is its metric labels plus the monitored resource it is written against, such as one k8s_container.",
				});
			}
			if (id === "azure-custom") {
				method.push({
					group: worked,
					label: "Interval",
					value: "60 s, fixed",
					note: "Azure Monitor ingests custom metrics once a minute, however often they are sent.",
				});
			}
			if (lim && !metrics.some((m) => m.label === "Series limit")) {
				method.push({
					group: worked,
					label: "Limit",
					value: `${num(lim.n)} ${lim.what}`,
					mono: false,
					note: lim.per === "target" ? "Counted per target." : "Shared by every metric there, not this one alone.",
				});
			}
			if (id === "gmp" && created) {
				method.push({
					group: worked,
					label: "_created",
					value: "Counted as the toggle says",
					note: "Google's pages checked don't say whether its collector stores _created as a series.",
				});
			}
			if (changes.some((c) => c.name.startsWith("Without ") && c.name !== "Without _created")) {
				method.push({
					group: how,
					label: "A label",
					value: "Drop it, or group its values into a few",
					mono: false,
					note: "The table counts dropping it; grouping leaves more. Put the detail on a span or a log line instead.",
				});
			}
			if (changes.some((c) => c.name === "Native histogram")) {
				method.push({
					group: how,
					label: "Native histogram",
					value: "All the buckets in one series",
					note:
						id === "prometheus"
							? "Prometheus has to have native histograms turned on."
							: id === "amp"
								? "Amazon accepts them, and meters each scrape at 0.25 of a sample per bucket with counts in it."
								: "Microsoft's limits and pricing pages don't mention native histograms; check that yours are accepted.",
				});
			}
			if (changes.some((c) => c.name === "Without _created")) {
				method.push({
					group: how,
					label: "_created",
					value: "PROMETHEUS_DISABLE_CREATED_SERIES=True",
					note: "In Python's prometheus_client. Newer Prometheus servers can store it as metadata instead.",
				});
			}
			parts.push({ kind: "fields", role: "method", fields: method });
			return { kind: "group", parts };
		} catch (error) {
			if (error instanceof InputError)
				return {
					kind: "error",
					message: error.message,
					input: error.input,
					...(error.row === undefined ? {} : { row: error.row }),
				};
			throw error;
		}
	},
} satisfies Tool<Input>;
