/**
 * Metric cardinality: how many time series one Prometheus metric becomes, and what they cost to keep.
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
import type { Field, Output, Tool } from "@toolbench/sdk";

type Input = {
	labels: string;
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

class InputError extends Error {
	readonly input: string;
	constructor(message: string, input: string) {
		super(message);
		this.input = input;
	}
}

export type Label = { name: string; values: number };

const NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** Labels the client or the server already owns for a type, so a user label by that name collides. */
const RESERVED: Record<string, string[]> = { histogram: ["le"], summary: ["quantile"], summary3: ["quantile"] };
/** Types whose clients may write `_created`. */
const HAS_CREATED = new Set(["counter", "histogram", "summary", "summary3"]);

/** One label per line, or comma-separated: `route 12`, `route=12` and `route: 12` all read the same. */
export function parseLabels(text: string): Label[] {
	const out: Label[] = [];
	const parts = text
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter((s) => s && !s.startsWith("#"));
	for (const part of parts) {
		const m = /^([^\s=:]+)\s*[=:\s]\s*([0-9][0-9_]*)$/.exec(part);
		if (!m) throw new InputError(`"${part}" is not a label and a count, such as "route 12".`, "labels");
		const name = m[1]!;
		if (!NAME.test(name))
			throw new InputError(
				`"${name}" is not a valid label name: letters, digits and _, not starting with a digit.`,
				"labels",
			);
		if (name.startsWith("__"))
			throw new InputError("Label names starting with __ are reserved for Prometheus itself.", "labels");
		const values = Number(m[2]!.replace(/_/g, ""));
		if (!Number.isSafeInteger(values) || values < 1) throw new InputError(`${name} needs at least 1 value.`, "labels");
		if (out.some((l) => l.name === name)) throw new InputError(`${name} is listed twice.`, "labels");
		out.push({ name, values });
	}
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

export default {
	run(input: Input) {
		try {
			const labels = parseLabels(String(input.labels ?? ""));
			const type = String(input.type);
			for (const l of labels) {
				if ((RESERVED[type] ?? []).includes(l.name)) {
					const what = type === "histogram" ? "histogram" : "summary";
					throw new InputError(
						`"${l.name}" is the label a ${what} writes itself, so yours would collide with it.`,
						"labels",
					);
				}
			}
			const buckets = Number(input.buckets);
			if (type === "histogram" && (!Number.isInteger(buckets) || buckets < 0 || buckets > 1000)) {
				throw new InputError("Buckets is a whole number from 0 to 1,000, not counting +Inf.", "buckets");
			}
			const targets = Number(input.targets);
			if (!Number.isInteger(targets) || targets < 1)
				throw new InputError("At least 1 target exposes the metric.", "targets");
			const occur = Number(input.occur);
			if (!(occur > 0 && occur <= 100))
				throw new InputError("The share that occurs is above 0% and at most 100%.", "occur");
			const interval = Number(input.interval);
			if (!(interval > 0)) throw new InputError("The scrape interval is a positive number of seconds.", "interval");
			const price = Number(input.price ?? 0);
			if (!(price >= 0)) throw new InputError("The price can't be negative.", "price");
			const created = Boolean(input.created);

			const per = perLabelSet(type, buckets, 0, created);
			const sets = count(labels, occur);
			const series = sets * per.n * targets;
			const perSecond = series / interval;
			const perDay = perSecond * 86_400;
			const kept = perDay * RETENTION_DAYS;
			const without = (l: Label) =>
				count(
					labels.filter((x) => x !== l),
					occur,
				) *
				per.n *
				targets;

			/*
			 * Prometheus's instrumentation guide: keep a metric's cardinality below 10, and investigate anything over
			 * 100. Its "cardinality" is label sets, before the type multiplies them, which is the number judged here, and
			 * the only number on the page that carries a tone, because it is the only one a published rule judges.
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
			 * ceiling and the series count can sit a few above it.
			 */
			const factors = labels.length
				? labels.map(
						(l, i) =>
							`${num(l.values)} ${l.name}${i === labels.length - 1 ? (l.values === 1 ? " value" : " values") : ""}`,
					)
				: ["1 label set"];
			if (occur < 100) factors.push(`${num(occur)}% that occur`);
			factors.push(`${per.n} series per label set`, plural(targets, "target"));

			/*
			 * Each change the reader can make, scored by the same multiplication with it made, fewest series first. The
			 * native histogram is in it, because on a classic histogram it is usually the biggest cut, and an earlier
			 * chart left it out.
			 *
			 * ⚠️ A label's row is what DROPPING it leaves. Grouping its values into a few leaves something between that
			 * and today, which is why the row says "Without route" and the method notes say how to group.
			 */
			type Change = { name: string; after: number };
			const changes: Change[] = [];
			for (const l of labels) if (l.values > 1) changes.push({ name: `Without ${l.name}`, after: without(l) });
			if (type === "histogram" && per.n > 1) changes.push({ name: "Native histogram", after: sets * targets });
			if (created && HAS_CREATED.has(type))
				changes.push({ name: "Without _created", after: sets * (per.n - 1) * targets });
			changes.sort((a, b) => a.after - b.after);

			const metrics: Field[] = [
				{ label: "Label sets", value: num(sets), note: `${guide}${ceiling}`, ...(tone ? { tone } : {}) },
				{ label: "Samples", value: `${num(perSecond)} a second`, note: `One per series every ${num(interval)} s.` },
				{
					label: "Disk",
					value: `${bytes(kept)} to ${bytes(kept * 2)}`,
					note: `Over ${RETENTION_DAYS} days, Prometheus's default retention, at 1 to 2 bytes a sample.`,
				},
			];
			if (price > 0) {
				metrics.push({
					label: "Bill",
					value: `${money((series / 1000) * price)} a month`,
					note: `At ${money(price)} per 1,000 active series.`,
				});
			}

			const parts: Output[] = [
				{ kind: "fields", role: "key", fields: [{ label: "Time series", value: `${num(series)} series` }] },
				{ kind: "text", role: "formula", mono: true, text: factors.join(" x ") },
			];
			if (changes.length) {
				parts.push({
					kind: "series",
					chart: {
						id: "changes",
						xLabel: "Change",
						yLabel: "Series",
						orientation: "horizontal",
						x: [...changes.map((c) => c.name), "Now"],
						series: [{ label: "Series", shape: "bar", points: [...changes.map((c) => c.after), series] }],
						readout: { highlightTable: true },
					},
				});
				parts.push({
					kind: "table",
					role: "comparison",
					caption: "Each change on its own",
					columns: [
						{ label: "Change" },
						{ label: "Series after", align: "end", mono: true },
						{ label: "Saves", align: "end", mono: true },
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
			const method: Field[] = [
				{ group: "How this was worked out", label: "Series per label set", value: String(per.n), note: per.parts },
			];
			if (changes.some((c) => c.name.startsWith("Without ") && c.name !== "Without _created")) {
				method.push({
					group: how,
					label: "A label",
					value: "Drop it, or group its values into a few",
					note: "The table counts dropping it; grouping leaves more. Put the detail on a span or a log line instead.",
				});
			}
			if (changes.some((c) => c.name === "Native histogram")) {
				method.push({
					group: how,
					label: "Native histogram",
					value: "All the buckets in one series",
					note: "Prometheus has to have native histograms turned on.",
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
			if (error instanceof InputError) return { kind: "error", message: error.message, input: error.input };
			throw error;
		}
	},
} satisfies Tool<Input>;
