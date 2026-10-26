/**
 * Do a call chain's timeouts and retries fit inside each other?
 *
 * Every call in a chain has a per-try timeout and some retries, usually chosen by different people at different
 * times: one in the service's code, one in a client library, one by the mesh's defaults. Nothing checks that they
 * agree. The failure they produce is quiet: a caller gives up on a try while the service it called is still
 * retrying further down, so those retries are work that nobody is waiting for, on a system that is already in
 * trouble.
 *
 * The worst case this checks is the bottom service hanging: it accepts a request and never answers. Then each try
 * at the bottom runs to its timeout, the call above sees a failure only after all of them, and so on up. It lists
 * each call whose tries do not fit inside one try of its caller, with the per-try timeout that would make them fit,
 * then the chain, then how long each call can take and how many of its tries fit above it.
 *
 * ⚠️ It assumes every layer retries a try that timed out. Envoy only does that if `retry_on` names gateway-error,
 * 5xx or reset, and Istio's default names none of them, so with the defaults a timed-out try is not retried at all.
 * Set a per-try timeout and leave retryOn alone, and you get the timeout without the retry.
 *
 * The same arithmetic as `service-mesh/timeout_budget.py` in mainlog-code; the fixtures are its output.
 */
import type { Cell, GraphEdge, GraphNode, Output, Tool } from "@toolbench/sdk";

type Input = { chain: string; deadline: number; backoff: number };

class InputError extends Error {
	readonly input: string;

	constructor(message: string, input: string) {
		super(message);
		this.name = "InputError";
		this.input = input;
	}
}

type Call = { caller: string; callee: string; timeout: number; retries: number };

function parse(text: string): Call[] {
	const calls: Call[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.split("#")[0]!.trim();
		if (!line) continue;
		const m = /^(.+?)\s+(none|[\d.]+\s*(?:ms|s)?)\s+(\d+)$/.exec(line);
		if (!m)
			throw new InputError(`Cannot read "${raw.trim()}": expected "caller -> callee  timeout  retries".`, "chain");
		const [, name, t, r] = m as unknown as [string, string, string, string];
		const ends = name.split(/\s*(?:->|→)\s*/);
		if (ends.length !== 2 || !ends[0] || !ends[1])
			throw new InputError(`"${name.trim()}" should be "caller -> callee".`, "chain");
		let timeout: number;
		if (t === "none") timeout = Number.POSITIVE_INFINITY;
		else if (t.endsWith("ms")) timeout = Number.parseFloat(t) / 1000;
		else if (t.endsWith("s")) timeout = Number.parseFloat(t);
		else timeout = Number.parseFloat(t) / 1000;
		if (!(timeout > 0))
			throw new InputError(`The timeout in "${raw.trim()}" must be more than zero, or none.`, "chain");
		calls.push({ caller: ends[0].trim(), callee: ends[1].trim(), timeout, retries: Number(r) });
	}
	if (calls.length === 0) throw new InputError("Give at least one call, one per line, top first.", "chain");
	if (calls.length > 20) throw new InputError("At most 20 calls.", "chain");
	for (let i = 1; i < calls.length; i++) {
		if (calls[i]!.caller !== calls[i - 1]!.callee) {
			throw new InputError(
				`Line ${i + 1} starts at ${calls[i]!.caller}, but line ${i} ends at ${calls[i - 1]!.callee}. Each call should be made by the service the line above called.`,
				"chain",
			);
		}
	}
	return calls;
}

function fmt(s: number): string {
	if (!Number.isFinite(s)) return "unbounded";
	return s < 1 ? `${(s * 1000).toFixed(0)} ms` : `${s.toFixed(2)} s`;
}

export default {
	run(input: Input) {
		try {
			const calls = parse(String(input.chain ?? ""));
			const deadline = Number(input.deadline) / 1000;
			const backoff = Number(input.backoff) / 1000;
			if (!(deadline > 0)) throw new InputError("The deadline must be more than zero.", "deadline");
			if (!(backoff >= 0)) throw new InputError("The backoff cannot be negative.", "backoff");

			/* Worst case per call, from the bottom up: each try lasts its timeout or until the call below has failed. */
			const worst = new Array<number>(calls.length).fill(0);
			let below = Number.POSITIVE_INFINITY;
			for (let i = calls.length - 1; i >= 0; i--) {
				const c = calls[i]!;
				const oneTry = Math.min(c.timeout, below);
				worst[i] = (1 + c.retries) * oneTry + c.retries * backoff;
				below = worst[i]!;
			}

			/* How many of the callee's tries finish inside one of the caller's. */
			const fit: (number | null)[] = calls.map((outer, i) => {
				const inner = calls[i + 1];
				if (!inner) return null;
				const innerTry = Math.min(inner.timeout, i + 2 < calls.length ? worst[i + 2]! : Number.POSITIVE_INFINITY);
				if (!Number.isFinite(outer.timeout)) return 1 + inner.retries;
				if (!Number.isFinite(innerTry)) return 0;
				return Math.min(1 + inner.retries, Math.floor((outer.timeout + backoff) / (innerTry + backoff) + 1e-9));
			});

			/*
			 * The top call is checked against the deadline as if the deadline were one try of a call above it: the
			 * app's own timeout is the first layer of the budget, and a top call that can't finish inside it wastes
			 * every try it makes.
			 */
			const topTry = Math.min(calls[0]!.timeout, calls.length > 1 ? worst[1]! : Number.POSITIVE_INFINITY);
			const topFit = Number.isFinite(topTry)
				? Math.min(1 + calls[0]!.retries, Math.floor((deadline + backoff) / (topTry + backoff) + 1e-9))
				: 0;

			let attempts = 1;
			for (const c of calls) attempts *= 1 + c.retries;
			const top = worst[0]!;
			const tries = (i: number) => 1 + calls[i]!.retries;
			const name = (c: Call) => `${c.caller} -> ${c.callee}`;
			/* `broken[i]`: call i's tries do not all fit inside one try of the call above it, or the deadline for the top. */
			const broken = calls.map((_, i) => (i === 0 ? topFit < tries(0) : (fit[i - 1] ?? tries(i)) < tries(i)));
			const fitOf = (i: number) => (i === 0 ? topFit : fit[i - 1]!);

			/*
			 * The failing boundaries, one row per call whose tries do not all fit inside one try of the call above it,
			 * or inside the deadline for the top call. Each row is the call itself, so the timeout to set and the
			 * numbers that say why are on the same row. The old detail table put "1 of 3" on checkout -> pricing while
			 * its fix named pricing -> inventory, because it showed each call's callee rather than the call.
			 */
			const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
			const retriesFix = (f: number) => (f <= 1 ? "do not retry it" : `retry it at most ${plural(f - 1, "time", "times")}`);
			const failing: Cell[][] = [];
			const others: Cell[][] = [];
			/* Calls whose row already says what timeout to set, so a "set a timeout" row would only repeat it. */
			const timedFix = new Set<number>();
			const order = calls.map((_, i) => i).filter((i) => broken[i]);
			/* The deadline first, then the rest top down: a fix above changes what fits below. */
			for (const i of order) {
				const c = calls[i]!;
				const f = fitOf(i);
				const room = i === 0 ? deadline : calls[i - 1]!.timeout;
				const maxTry = (room - c.retries * backoff) / tries(i);
				if (maxTry > 0) timedFix.add(i);
				const tone = i === 0 || f === 0 ? ("bad" as const) : ("warn" as const);
				failing.push([
					{ text: name(c), mono: true },
					{ text: fmt(room), mono: true },
					{ text: fmt(worst[i]!), mono: true },
					{ text: `${f}/${tries(i)}`, mono: true, tone },
					{ text: maxTry > 0 ? `${fmt(Math.floor(maxTry * 1000) / 1000)} or less` : "no timeout fits", mono: true },
				]);
				/* The other ways out, which the table's last column does not already say. */
				const ways = [
					...(f >= 1 ? [retriesFix(f)] : []),
					...(!Number.isFinite(worst[i]!)
						? []
						: i === 0
							? [`let the caller wait at least ${fmt(worst[0]!)}`]
							: [`give ${name(calls[i - 1]!)} at least ${fmt(worst[i]!)} per try`]),
				];
				if (ways.length) {
					const said = ways.join(", or ");
					others.push([{ text: name(c), mono: true }, { text: `Or ${said}.` }]);
				}
			}
			calls.forEach((c, i) => {
				if (Number.isFinite(c.timeout) || timedFix.has(i)) return;
				others.push([
					{ text: name(c), mono: true },
					{ text: `Set a per-try timeout. With none, a hung ${c.callee} holds the call until something above gives up.` },
				]);
			});
			/* Back into chain order, so the rows read top down whichever kind each one is. */
			const at = (r: Cell[]) => calls.findIndex((c) => name(c) === (r[0] as { text: string }).text);
			others.sort((x, y) => at(x) - at(y));

			const fitsDeadline = top <= deadline;
			const parts: Output[] = [];
			/*
			 * ⚠️ A banner only when the chain cannot finish inside the deadline the reader typed. That is the one result
			 * here a limit the reader supplied decides; anything else leads with the table, or with the quiet answer
			 * when every retry fits.
			 */
			if (!fitsDeadline)
				parts.push({
					kind: "fields",
					role: "verdict",
					fields: [
						{
							label: "When the bottom hangs",
							role: "verdict",
							mono: false,
							tone: "bad",
							value: Number.isFinite(top)
								? `Can take ${fmt(top)}; the caller gives up after ${fmt(deadline)}`
								: `Nothing bounds it; the caller gives up after ${fmt(deadline)}`,
						},
					],
				});
			if (failing.length)
				parts.push({
					kind: "table",
					role: "comparison",
					caption:
						failing.length === 1
							? "1 call cannot finish its tries inside its caller's time"
							: `${failing.length} calls cannot finish their tries inside their caller's time`,
					columns: [
						{ label: "Call", wrap: "none", rowHeader: true },
						{ label: "Allowed", align: "end", mono: true, wrap: "none" },
						{ label: "Needs", align: "end", mono: true, wrap: "none" },
						{ label: "Fit", align: "end", mono: true, wrap: "none" },
						{ label: "Set per-try to", align: "end", mono: true, wrap: "none" },
					],
					rows: failing,
				});
			else
				parts.push({
					kind: "fields",
					role: "answer",
					fields: [
						{
							label: "Worst case when the bottom hangs",
							value: fmt(top),
							note: `Inside the caller's ${fmt(deadline)}, and every call's tries fit inside one try of the call above.`,
						},
					],
				});
			if (others.length)
				parts.push({
					kind: "table",
					caption: failing.length ? "Other changes. Fix the top one first, then run again." : "Changes",
					columns: [
						{ label: "Call", wrap: "none", rowHeader: true },
						{ label: "Change", wrap: "prose" },
					],
					rows: others,
				});
			parts.push(chainGraph(calls, worst, broken, deadline), {
				kind: "table",
				caption: "Each call, top first, when the bottom hangs",
				columns: [
					{ label: "Call", wrap: "none", rowHeader: true },
					{ label: "Per try", align: "end", mono: true, wrap: "none" },
					{ label: "Tries", align: "end", mono: true, wrap: "none" },
					{ label: "Worst case", align: "end", mono: true, wrap: "none" },
					{ label: "Fit above", align: "end", mono: true, wrap: "none" },
				],
				rows: calls.map((c, i) => [
					{ text: name(c) },
					{
						text: Number.isFinite(c.timeout) ? fmt(c.timeout) : "none",
						mono: true,
						...(Number.isFinite(c.timeout) ? {} : { tone: "warn" as const }),
					},
					{ text: String(tries(i)), mono: true },
					{ text: fmt(worst[i]!), mono: true },
					{ text: `${fitOf(i)}/${tries(i)}`, mono: true, ...(broken[i] ? { tone: "bad" as const } : {}) },
				]),
			});
			/*
			 * What the check assumes, last and quiet. The product of everyone's tries is a different failure, the bottom
			 * answering fast with an error, so it is here as a caveat rather than beside the answer.
			 */
			parts.push({
				kind: "fields",
				role: "method",
				fields: [
					{ label: "Assumes", value: "The bottom hangs, and every layer retries a try that timed out.", mono: false },
					{ label: "Backoff", value: `${fmt(backoff)} between tries` },
					{
						label: "If the bottom fails fast instead",
						value: `${plural(attempts, "try reaches", "tries reach")} it, when every layer retries the error.`,
						mono: false,
						note: "Istio's defaults do not retry an HTTP 503.",
					},
				],
			});
			return { kind: "group", parts };
		} catch (error) {
			if (error instanceof InputError) return { kind: "error", message: error.message, input: error.input };
			throw error;
		}
	},
} satisfies Tool<Input>;

/**
 * The chain top to bottom, from whatever calls the top to the service that hangs. Each arrow is one call with its
 * per-try timeout and tries; each service says how long its own calls can take when the bottom hangs. A call whose
 * tries do not fit inside the try above it is drawn red and thick, and the first of them, the deadline's if that is
 * broken, is highlighted.
 */
function chainGraph(calls: Call[], worst: number[], broken: boolean[], deadline: number): Output {
	const nodes: GraphNode[] = [{ id: "caller", label: "Caller", note: `waits ${fmt(deadline)}`, shape: "pill" }];
	const edges: GraphEdge[] = [{ from: "caller", to: "n0", line: "dotted" }];
	const services = [calls[0]!.caller, ...calls.map((c) => c.callee)];
	services.forEach((s, j) => {
		const bottom = j === calls.length;
		nodes.push({
			id: `n${j}`,
			label: s,
			note: bottom
				? "hangs"
				: Number.isFinite(worst[j]!)
					? `its calls take up to ${fmt(worst[j]!)}`
					: "its calls can wait forever",
			...(bottom ? { tone: "warn" as const } : broken[j] ? { tone: "bad" as const } : {}),
		});
	});
	calls.forEach((c, i) => {
		const timed = Number.isFinite(c.timeout);
		edges.push({
			from: `n${i}`,
			to: `n${i + 1}`,
			label: `${timed ? `${fmt(c.timeout)} per try` : "no timeout"}, ${1 + c.retries} ${c.retries === 0 ? "try" : "tries"}`,
			...(broken[i] ? { tone: "bad" as const, width: "thick" as const } : !timed ? { tone: "warn" as const } : {}),
			...(timed ? {} : { line: "dashed" as const }),
		});
	});
	const first = broken.indexOf(true);
	return {
		kind: "graph",
		graph: {
			label: "The chain when the bottom hangs, with each call's per-try timeout and tries",
			layout: "layered",
			/* Top to bottom, as the chain is written: a phone has room for a column of five boxes, not a row. */
			direction: "TB",
			nodes,
			edges,
			...(first >= 0 ? { highlight: [`n${first}`, `n${first + 1}`] } : {}),
		},
	};
}
