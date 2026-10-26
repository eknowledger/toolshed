/**
 * PR split cost: what splitting a change into k pull requests costs in waiting for review.
 *
 * Paste (size, wait) pairs for your own merged PRs: lines changed, and hours from ready-for-review to the first
 * review by someone else. The tool fits a straight line to log(wait) against log(size). Its slope e is the
 * elasticity: double a PR and its wait is multiplied by 2^e. Busy open-source repositories come out between about
 * 0.2 and 0.45: the wait grows much more slowly than size.
 *
 * From e, three ways a change split into k PRs can be reviewed, each against one PR of the whole change:
 *
 *  - one after another: each piece waits its own pickup. The expected total is k x (1/k)^e = k^(1-e) times one
 *    PR's, exactly, under the fit, whatever the scatter around it, because expected waits add.
 *  - side by side, independently: the change waits for the slowest of k pickups. That depends on the scatter, not
 *    just on e, so it is computed exactly from the fit's own residuals: the expected largest of k draws.
 *  - in one sitting: one reviewer takes all k together, so the change waits for one pickup of a PR k times smaller,
 *    k^(-e). That assumes the reviewer starts the stack as soon as they would start one small piece.
 *
 * All three read e as if size drove the wait. The tool also prints the other end, as if size had no effect: k, the
 * slowest of k ordinary pickups, and 1. The truth for a team is somewhere between.
 *
 * ⚠️ What it is not: a causal model. The fit is a correlation, usually a weak one, and small PRs are often small
 * fixes by maintainers, picked up fast for that reason. The tool reports r and how much of the variation in wait size
 * explains, so the weakness is on the screen beside the answer.
 *
 * The result leads with the three ways side by side at the reader's k, slowest first, at both ends. Right under it is
 * how weak the fit is, because a 4.76x that rests on a fit explaining 3.5% of the variation must not read as a
 * measurement. Then the fit's numbers, the charts, what each way assumes, and a markdown copy for a PR description.
 * "In one sitting" is drawn muted, never green: its small multiple rests on an assumption about the reviewer, not on
 * the data. Nothing else is toned: no limit the reader typed decides that a multiple is bad.
 *
 * Seeded: the bootstrap and the draws use mulberry32 from a constant, so the same input always gives the same output.
 */
import type { Field, Output, Series, Tool } from "@toolbench/sdk";

type Input = { pairs: string; source: string; elasticity: number; lines: number; split: number; review: string };

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

const FLOOR_H = 0.05;
const BOOTSTRAPS = 1000;
const MIN_PAIRS = 10;

function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** One pair per line: size and hours, separated by a comma, tab, semicolon or spaces. A header line is skipped. */
function parse(text: string): { size: number; wait: number }[] {
	const out: { size: number; wait: number }[] = [];
	let offset = 0;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const at = offset;
		offset += line.length + 1;
		const trimmed = line.trim();
		if (trimmed === "") continue;
		const cells = trimmed.split(/\s*[,;\t]\s*|\s+/);
		if (out.length === 0 && i === lines.findIndex((l) => l.trim() !== "") && cells.some((c) => Number.isNaN(Number(c)))) {
			continue; // a header such as size,wait_hours
		}
		const start = at + line.indexOf(trimmed[0]!);
		if (cells.length < 2) throw new InputError(`Line ${i + 1} has one number; each line needs a size and a wait.`, "pairs", start, trimmed.length);
		const size = Number(cells[0]);
		const wait = Number(cells[1]);
		if (!Number.isFinite(size) || !Number.isFinite(wait) || cells[0] === "" || cells[1] === "") {
			throw new InputError(`Line ${i + 1} isn't two numbers: "${trimmed.slice(0, 30)}".`, "pairs", start, trimmed.length);
		}
		if (size < 0 || wait < 0) throw new InputError(`Line ${i + 1} has a negative number.`, "pairs", start, trimmed.length);
		out.push({ size: Math.max(1, size), wait: Math.max(FLOOR_H, wait) });
	}
	return out;
}

type Fit = { e: number; a: number; r: number };

function fitLogs(xs: Float64Array, ys: Float64Array, pick?: Uint32Array): Fit {
	const n = pick ? pick.length : xs.length;
	let sx = 0;
	let sy = 0;
	for (let i = 0; i < n; i++) {
		const j = pick ? pick[i]! : i;
		sx += xs[j]!;
		sy += ys[j]!;
	}
	const mx = sx / n;
	const my = sy / n;
	let sxx = 0;
	let sxy = 0;
	let syy = 0;
	for (let i = 0; i < n; i++) {
		const j = pick ? pick[i]! : i;
		const dx = xs[j]! - mx;
		const dy = ys[j]! - my;
		sxx += dx * dx;
		sxy += dx * dy;
		syy += dy * dy;
	}
	const e = sxy / sxx;
	return { e, a: my - e * mx, r: syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0 };
}

/**
 * Expected largest of k independent draws from `sorted` (ascending), over their mean. Exact, not sampled: the largest
 * of k is the i-th smallest with probability (i/n)^k - ((i-1)/n)^k. No randomness, so the answer can't depend on what
 * else was computed first, which a shared sampler did.
 */
function slowestOf(k: number, sorted: Float64Array, mean: number): number {
	const n = sorted.length;
	let total = 0;
	let below = 0;
	for (let i = 1; i <= n; i++) {
		const upto = (i / n) ** k;
		total += sorted[i - 1]! * (upto - below);
		below = upto;
	}
	return total / mean;
}

const median = (sorted: Float64Array) => {
	const n = sorted.length;
	return n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
};

/** A waiting multiple: "4.76x", "8x", "1x". */
const times = (v: number) => {
	const r = Math.round(v * 100) / 100;
	return Number.isInteger(r) ? `${r}x` : `${r.toFixed(2)}x`;
};
const hours = (h: number) => (h >= 48 ? `${(h / 24).toFixed(1)} days` : h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(h * 60)} min`);

type Way = "serial" | "parallel" | "sitting";
const WAY_NAME: Record<Way, string> = { serial: "One after another", parallel: "Side by side", sitting: "In one sitting" };
const WAY_RESTS_ON: Record<Way, string> = {
	serial: "Each piece waits for its own first review, and the next opens when the last one merges.",
	parallel: "All the pieces open at once and are picked up independently, so the change waits for the slowest.",
	sitting: "One reviewer takes them all together, as soon as they would start one small piece. That is an assumption about how they work, not a measurement.",
};

export default {
	run({ pairs, source, elasticity, lines, split, review }: Input, ctx) {
		try {
			if (!Number.isInteger(split) || split < 1 || split > 50) throw new InputError("Split into a whole number of PRs, from 1 to 50.", "split");
			if (!(lines >= 1)) throw new InputError("The change needs at least one line.", "lines");
			if (!["serial", "parallel", "sitting"].includes(review)) throw new InputError("Pick how the pieces are reviewed.", "review");
			const way = review as Way;

			const metrics: Field[] = [];
			let evidence = "";
			const charts: Output[] = [];
			let e: number;
			let lo: number | undefined;
			let hi: number | undefined;
			let residuals: Float64Array | undefined;
			let residualMean = 1;
			let residualMedian = 1;
			let waits: Float64Array | undefined;
			let waitMean = 1;
			let a = 0;
			let fitNote = "";

			if (source === "fit") {
				const data = parse(pairs);
				if (data.length < MIN_PAIRS) {
					throw new InputError(`Paste at least ${MIN_PAIRS} PRs to fit; there ${data.length === 1 ? "is" : "are"} ${data.length}.`, "pairs");
				}
				const xs = Float64Array.from(data, (d) => Math.log(d.size));
				const ys = Float64Array.from(data, (d) => Math.log(d.wait));
				if (Math.max(...xs) - Math.min(...xs) < 1e-9) throw new InputError("Every PR is the same size, so there is no slope to fit.", "pairs");
				const f = fitLogs(xs, ys);
				e = f.e;
				a = f.a;
				const next = rng(1);
				const pick = new Uint32Array(data.length);
				const es: number[] = [];
				for (let b = 0; b < BOOTSTRAPS; b++) {
					ctx?.signal?.throwIfAborted();
					for (let i = 0; i < pick.length; i++) pick[i] = Math.floor(next() * data.length);
					es.push(fitLogs(xs, ys, pick).e);
				}
				es.sort((p, q) => p - q);
				lo = es[Math.floor(0.025 * BOOTSTRAPS)]!;
				hi = es[Math.ceil(0.975 * BOOTSTRAPS) - 1]!;
				residuals = Float64Array.from(data, (_, i) => Math.exp(ys[i]! - (a + e * xs[i]!))).sort();
				residualMean = residuals.reduce((s, v) => s + v, 0) / residuals.length;
				residualMedian = median(residuals);
				waits = Float64Array.from(data, (d) => d.wait).sort();
				waitMean = waits.reduce((s, v) => s + v, 0) / waits.length;
				fitNote = `e = ${e.toFixed(2)} from ${data.length} PRs, r = ${f.r.toFixed(2)}`;
				const explained = (f.r * f.r * 100).toFixed(1);
				// Weak below r = 0.3, where size accounts for under a tenth of the variation: then the multiples only point.
				evidence =
					Math.abs(f.r) < 0.3
						? `Directional only: size explains ${explained}% of the variation in wait across ${data.length} PRs (r = ${f.r.toFixed(2)}). A correlation, not a cause.`
						: `Size explains ${explained}% of the variation in wait across ${data.length} PRs (r = ${f.r.toFixed(2)}). A correlation, not a cause.`;
				const typical = Math.exp(a + e * Math.log(lines));
				metrics.push(
					{ label: "Elasticity e", value: e.toFixed(2), note: `95% bootstrap range ${lo.toFixed(2)} to ${hi.toFixed(2)}` },
					{ label: "Doubling a PR", value: `${(2 ** e).toFixed(2)}x the wait` },
					{
						label: `Median wait, one PR of ${lines} lines`,
						value: hours(typical * residualMedian),
						note: `mean ${hours(typical * residualMean)}${residualMean > 1.1 * residualMedian ? ", pulled up by the slowest few" : ""}`,
					},
				);

				// The scatter and the line, both on log axes, because that is where the fit is a line.
				const sizes = data.map((d) => d.size);
				const minS = Math.min(...sizes);
				const maxS = Math.max(...sizes);
				const lineX = [minS, Math.sqrt(minS * maxS), maxS];
				charts.push({
					kind: "series",
					chart: {
						xLabel: "PR size, lines changed",
						yLabel: "Hours to first review",
						xScale: "log",
						yScale: "log",
						x: lineX,
						series: [
							{ label: "Pasted PRs", shape: "points", x: sizes, points: data.map((d) => d.wait) },
							{ label: `Fit, wait ∝ size^${e.toFixed(2)}`, shape: "line", x: lineX, points: lineX.map((s) => Number(Math.exp(a + e * Math.log(s)).toFixed(3))) },
						],
						readout: { mode: "point" },
					},
				});
			} else {
				if (!(elasticity >= 0 && elasticity <= 1)) throw new InputError("An elasticity between 0 and 1, please.", "elasticity");
				e = elasticity;
				fitNote = `e = ${e.toFixed(2)}, as given`;
				evidence = `e = ${e.toFixed(2)}, typed in rather than fitted, so nothing here says how well size predicts the wait.`;
				metrics.push({ label: "Doubling a PR", value: `${(2 ** e).toFixed(2)}x the wait` });
			}

			const serial = (k: number) => k ** (1 - e);
			const sitting = (k: number) => k ** -e;
			const parallel = (k: number) => (residuals ? sitting(k) * slowestOf(k, residuals, residualMean) : undefined);
			const onFit = (w: Way, k: number) => (w === "serial" ? serial(k) : w === "sitting" ? sitting(k) : parallel(k));
			// The other end: size has no effect on the pickup, so every piece waits like an ordinary PR.
			const noEffect = (w: Way, k: number) => (w === "serial" ? k : w === "sitting" ? 1 : waits ? slowestOf(k, waits, waitMean) : undefined);
			// "In one sitting" rests on an assumption about the reviewer, so it is never shown as good news.
			const tone = (w: Way) => (w === "sitting" ? "muted" : "normal");

			const k = split;
			const pieces = `${k} PR${k === 1 ? "" : "s"}`;

			// The three ways at the reader's k, slowest first, with the unpriceable one last. The pick is named in words.
			const ways = (["serial", "parallel", "sitting"] as Way[]).sort((p, q) => (onFit(q, k) ?? -1) - (onFit(p, k) ?? -1));
			const comparison: Output = {
				kind: "table",
				role: "comparison",
				caption: `${pieces} instead of one of ${lines} lines: the wait for a first review, as a multiple of the one PR's`,
				columns: [
					{ label: "Reviewed", wrap: "prose", rowHeader: true },
					{ label: source === "fit" ? "Fit says" : `At e = ${e.toFixed(2)}`, align: "end", mono: true, wrap: "none" },
					{ label: "If size does not matter", align: "end", mono: true, wrap: "none" },
				],
				rows: ways.map((w) => {
					const v = onFit(w, k);
					const b = noEffect(w, k);
					const t = tone(w);
					return [
						{ text: `${WAY_NAME[w]}${w === way ? " (your pick)" : ""}`, tone: t },
						{ text: v === undefined ? "Paste PRs" : times(v), mono: true, tone: t },
						{ text: b === undefined ? "Paste PRs" : times(b), mono: true, tone: t },
					];
				}),
			};

			// Waiting multiple against k, for the three ways, with 1 (one PR) as the line to beat.
			const ks = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32].filter((v) => v <= Math.max(16, k * 2));
			if (!ks.includes(k)) ks.push(k);
			ks.sort((p, q) => p - q);
			const lines3: Series[] = [
				{ label: "One after another", shape: "line", markers: true, points: ks.map((v) => Number(serial(v).toFixed(3))) },
				...(residuals ? [{ label: "Side by side", shape: "line" as const, markers: true, points: ks.map((v) => Number(parallel(v)!.toFixed(3))) }] : []),
				{ label: "In one sitting", shape: "line", markers: true, points: ks.map((v) => Number(sitting(v).toFixed(3))) },
			];
			charts.unshift({
				kind: "series",
				chart: {
					xLabel: "Split into k PRs",
					yLabel: "Waiting for a first review, against one PR",
					x: ks,
					series: lines3,
					thresholds: [{ y: 1, label: "one PR" }],
					annotations: [{ x: k, label: `${k} PRs` }],
				},
			});

			// What each way assumes, as prose under the numbers rather than a column in the comparison.
			const method: Output = {
				kind: "fields",
				role: "method",
				fields: [
					...(["serial", "parallel", "sitting"] as Way[]).map((w): Field => ({ label: WAY_NAME[w], value: WAY_RESTS_ON[w], group: "What each way assumes", mono: false })),
					{ label: "Measured", value: "Hours from ready for review to the first review by someone else. Not the time to merge.", group: "What it counts", mono: false },
				],
			};

			// For a PR description or a design doc, where a tab-separated table doesn't render.
			const md = [
				`**Splitting a change of ${lines} lines into ${pieces}** (${fitNote})`,
				"",
				"| Reviewed | If size drives the pickup | If size has no effect |",
				"|---|---|---|",
				...(["serial", "parallel", "sitting"] as Way[]).map((w) => {
					const v = onFit(w, k);
					const b = noEffect(w, k);
					return `| ${WAY_NAME[w]} | ${v === undefined ? "needs PRs" : times(v)} | ${b === undefined ? "needs PRs" : times(b)} |`;
				}),
				"",
				"Expected waiting for a first review, against one PR of the whole change. A correlation, not a cause. In one sitting assumes one reviewer takes every piece together.",
			].join("\n");

			const parts: Output[] = [
				comparison,
				// Plain text, not an answer: the caveat belongs beside the numbers, not louder than them.
				{ kind: "text", text: evidence },
				{ kind: "fields", role: "metrics", fields: metrics },
				...charts,
				method,
				{ kind: "code", lang: "markdown", source: md },
			];
			return { kind: "group", parts };
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
