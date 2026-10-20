/**
 * LLM timeout check: how long one agent task can take before anything in its settings stops it, for the three ways
 * a model call goes wrong, judged against how long the caller can wait.
 *
 *  - **Silent.** The provider accepts the connection and sends nothing. Each attempt lasts the read timeout (or the
 *    attempt deadline, if shorter), and the SDK retries, waiting its backoff between attempts: 0.5 s doubling to 8 s
 *    in the anthropic and openai Python SDKs, before jitter. Jitter only shortens a wait, so the worst case is the
 *    unshortened one.
 *  - **Trickling.** The provider answers 200 and streams slowly. The read timeout bounds each gap between tokens,
 *    not the call, so a stream that keeps sending runs until `max_tokens`, unless an attempt deadline cuts it. A cut
 *    attempt is a failure and is retried, the conservative reading. A gap longer than the read timeout fires it
 *    mid-stream, after the 200, where the anthropic SDK raises the transport's own ReadTimeout and does not retry.
 *  - **Overloaded.** The provider refuses at once with 429 or 529. Each retry waits the backoff.
 *
 * A task is up to `turns` calls, each at its worst case, which assumes the agent loop starts another turn after a
 * failed call, as many hand-written loops do. Fixed, and stated in the inputs: a trickle of 2 tokens a second, the
 * rate of the slow streams in the post this tool came from.
 *
 * The output leads with the worst case for one task, as a banner only when it is over the reader's wait, then the
 * three failures side by side, the chart, and what it assumes. The cost of the worst-case trickle comes last, for one
 * input size and one price, as a sense of scale. Whether a
 * provider bills an attempt that was cut off is not documented by any provider checked (Anthropic, OpenAI, AWS,
 * Google, on 2026-10-11), so it gives both bounds.
 */
import type { Cell, Output, Tool } from "@toolbench/sdk";

type Input = {
	/** Which SDK's defaults filled the form. The presets live in tool.json; the numbers below are what counts. */
	stack: string;
	read: number;
	retries: number;
	deadline: number;
	turns: number;
	maxtokens: number;
	patience: number;
};

class InputError extends Error {
	readonly input: string;
	constructor(message: string, input: string) {
		super(message);
		this.input = input;
	}
}

/** The anthropic and openai Python SDKs' backoff before jitter. */
export const BACKOFF = 0.5;
export const BACKOFF_MAX = 8;
/** The trickle's rate, tokens a second. */
export const TRICKLE = 2;
/** For the cost line only: input tokens per call, and Claude Opus 5.5's list prices on 2026-10-11, $ per million. */
export const INPUT_TOKENS = 4700;
export const PRICE_IN = 4;
export const PRICE_OUT = 20;

/** The waits before retries 1..n, before jitter. */
export function backoffs(retries: number): number[] {
	return Array.from({ length: retries }, (_, n) => Math.min(BACKOFF * 2 ** n, BACKOFF_MAX));
}

export type Shape = {
	name: "Silent" | "Trickling" | "Overloaded";
	/** One attempt, seconds; 0 when the refusal is immediate. */
	attempt: number;
	/** One call with its retries. */
	call: number;
	/** One task of up to `turns` calls. */
	task: number;
	/** What ends one call. */
	endedBy: string;
	/** The same, in a few words, for a table column: "max_tokens only", "retry limit". */
	stop: string;
	/** Output tokens one attempt streams. */
	streamed: number;
	/** Attempts per call that stream output. */
	attempts: number;
};

export function shapes(i: Input): Shape[] {
	const waits = backoffs(i.retries).reduce((a, b) => a + b, 0);
	const tries = i.retries + 1;
	const cut = i.deadline > 0 ? i.deadline : Number.POSITIVE_INFINITY;

	const hang = Math.min(i.read, cut);
	const silent: Shape = {
		name: "Silent",
		attempt: hang,
		call: tries * hang + waits,
		task: 0,
		endedBy:
			cut < i.read
				? "The attempt deadline ends each attempt, then the SDK retries."
				: "The read timeout ends each attempt, then the SDK retries.",
		stop: `${cut < i.read ? "attempt deadline" : "read timeout"}${i.retries ? ", then retries" : ""}`,
		streamed: 0,
		attempts: tries,
	};

	const full = i.maxtokens / TRICKLE;
	let trickle: Shape;
	if (1 / TRICKLE >= i.read) {
		trickle = {
			name: "Trickling",
			attempt: i.read,
			call: i.read,
			task: 0,
			endedBy: "The read timeout fires mid-stream, and the SDK does not retry it.",
			stop: "read timeout, not retried",
			streamed: 0,
			attempts: 1,
		};
	} else if (cut < full) {
		trickle = {
			name: "Trickling",
			attempt: cut,
			call: tries * cut + waits,
			task: 0,
			endedBy: "The attempt deadline cuts each attempt, then the SDK retries.",
			stop: `attempt deadline${i.retries ? ", then retries" : ""}`,
			streamed: Math.floor(cut * TRICKLE),
			attempts: tries,
		};
	} else {
		trickle = {
			name: "Trickling",
			attempt: full,
			call: full,
			task: 0,
			endedBy: "Only max_tokens ends it, because every token restarts the read timeout.",
			stop: "max_tokens only",
			streamed: i.maxtokens,
			attempts: 1,
		};
	}

	const overloaded: Shape = {
		name: "Overloaded",
		attempt: 0,
		call: waits,
		task: 0,
		endedBy: i.retries > 0 ? "The SDK gives up after its retries and their backoff." : "The first refusal ends it.",
		stop: i.retries > 0 ? "retry limit" : "first refusal",
		streamed: 0,
		attempts: 0,
	};

	return [silent, trickle, overloaded].map((s) => ({ ...s, task: s.call * i.turns }));
}

/** The one setting that brings this shape under the acceptable wait, or that it already fits. */
export function advice(i: Input, s: Shape): { text: string; ok: boolean } {
	if (s.task <= i.patience) return { text: `It stops after ${dur(s.task)}, inside the wait.`, ok: true };
	if (s.name === "Overloaded") return { text: "Use fewer retries or turns.", ok: false };
	const waits = backoffs(i.retries).reduce((a, b) => a + b, 0);
	const perAttempt = (i.patience - waits * i.turns) / ((i.retries + 1) * i.turns);
	if (perAttempt >= 1) return { text: `Set an attempt deadline of ${dur(Math.floor(perAttempt))} or less.`, ok: false };
	return { text: "Use fewer retries or turns, then set an attempt deadline.", ok: false };
}

/** 4 s, 2.5 min, 3 h, 28.4 days: the unit a person would say it in. */
export function dur(s: number): string {
	if (s < 60) return `${trim(s)} s`;
	if (s < 3600) return `${trim(s / 60)} min`;
	if (s < 86400 * 2) return `${trim(s / 3600)} h`;
	return `${trim(s / 86400)} days`;
}
const trim = (x: number) => (Math.abs(x - Math.round(x)) < 0.05 ? Math.round(x).toString() : x.toFixed(1));
const int = (x: number) => Math.round(x).toLocaleString("en-US");
const money = (x: number) => (x === 0 ? "$0" : x < 0.01 ? "under $0.01" : `$${x.toFixed(2)}`);
const price = (input: number, output: number) => (input * PRICE_IN + output * PRICE_OUT) / 1e6;

/** Who causes each worst case, as the verdict says it. */
const WHO: Record<Shape["name"], string> = {
	Silent: "A model that sends nothing",
	Trickling: "A model that trickles its answer",
	Overloaded: "A model that refuses every call",
};
const RANGES: [Exclude<keyof Input, "stack">, number, number, string][] = [
	["read", 0.1, 86400, "The read timeout is between 0.1 s and a day."],
	["retries", 0, 20, "Retries are between 0 and 20."],
	["deadline", 0, 86400, "The attempt deadline is between 0 (none) and a day."],
	["turns", 1, 1000, "Turns are between 1 and 1,000."],
	["maxtokens", 1, 1000000, "max_tokens is between 1 and 1,000,000."],
	["patience", 1, 86400, "The wait is between 1 s and a day."],
];

export default {
	run(raw: Input) {
		try {
			const i = { ...raw };
			for (const [k, lo, hi, msg] of RANGES) {
				const v = Number(i[k]);
				if (!(v >= lo && v <= hi)) throw new InputError(msg, k);
				i[k] = v;
			}
			if (!Number.isInteger(i.retries)) throw new InputError("Retries are a whole number.", "retries");
			if (!Number.isInteger(i.turns)) throw new InputError("Turns are a whole number.", "turns");

			const sh = shapes(i);
			const worst = sh.reduce((a, s) => (s.task > a.task ? s : a));
			const over = worst.task > i.patience;
			const turns = `${i.turns} turn${i.turns === 1 ? "" : "s"}`;

			/*
			 * ⚠️ A banner only when the task can outlast the wait the reader typed: that limit is theirs, so its tone is
			 * earned. It carries the worst case and the one setting that bounds it, and nothing else; the table under it
			 * says which failure and why. Within the wait, the same line is the quiet answer.
			 */
			const fix = advice(i, worst);
			/* A failure the worst case's setting does not fix gets its own clause, so no row over the wait goes unanswered. */
			const also = sh
				.filter((s) => s.task > i.patience && advice(i, s).text !== fix.text)
				.map((s) => ` ${s.name}: ${advice(i, s).text.charAt(0).toLowerCase()}${advice(i, s).text.slice(1)}`);
			const head: Output = over
				? {
						kind: "fields",
						role: "verdict",
						fields: [
							{
								label: `Over your ${dur(i.patience)} wait`,
								role: "verdict",
								value: `Up to ${dur(worst.task)} for one ${i.turns}-turn task`,
								note: `${fix.text}${also.join("")}`,
								tone: "bad",
							},
						],
					}
				: {
						kind: "fields",
						role: "answer",
						fields: [
							{
								label: "Worst case for one task",
								value: dur(worst.task),
								note: `${WHO[worst.name]} can keep a ${i.turns}-turn task running this long, inside the ${dur(i.patience)} you can wait.`,
							},
						],
					};

			/*
			 * The three failures side by side, worst first; a stable sort keeps silent ahead of trickling on a tie. One
			 * attempt, one call with its retries, one task, and what stops it in a few words, so the columns fit a phone.
			 * Only the task column is toned, and only against the reader's wait.
			 */
			const rows: Cell[][] = [...sh]
				.sort((a, b) => b.task - a.task)
				.map((s) => [
					s.name,
					{ text: s.attempt > 0 ? dur(s.attempt) : "0 s", mono: true },
					{ text: dur(s.call), mono: true },
					{ text: dur(s.task), mono: true, ...(s.task > i.patience ? { tone: "bad" as const } : {}) },
					s.stop,
				]);
			const matrix: Output = {
				kind: "table",
				role: "comparison",
				caption: `Each failure, for one task of up to ${turns}, worst first`,
				columns: [
					{ label: "Failure" },
					{ label: "Attempt", align: "end", mono: true },
					{ label: "Call", align: "end", mono: true },
					{ label: "Task", align: "end", mono: true },
					{ label: "Stopped by" },
				],
				rows,
			};

			const tr = sh[1]!;
			const finished = tr.streamed === i.maxtokens && tr.attempts === 1;
			const billed = tr.streamed > 0 ? i.turns : 0;
			const low = finished ? price(i.turns * INPUT_TOKENS, i.turns * i.maxtokens) : 0;
			const high = price(billed * tr.attempts * INPUT_TOKENS, billed * tr.attempts * tr.streamed);
			const basis = `${i.turns} call${i.turns === 1 ? "" : "s"} of ${int(INPUT_TOKENS)} input tokens, at $${PRICE_IN} and $${PRICE_OUT} per million tokens, Claude Opus 5.5's list prices on 2026-10-11.`;
			/* What the numbers assume, and the cost as a sense of scale, last and quiet. */
			const method: Output = {
				kind: "fields",
				role: "method",
				fields: [
					{
						label: "Assumes",
						value: `A trickle of ${TRICKLE} tokens a second, and a loop that starts another turn after a failed call.`,
					},
					{
						label: "Cost of the worst-case trickle",
						value: low === high ? money(low) : `${money(low)} to ${money(high)}`,
						note:
							low === high
								? basis
								: `${basis} The higher figure also bills the attempts that were cut off. No provider says whether it does.`,
					},
				],
			};

			const pt = (v: number) => (v > 0 ? v : null);
			const chart: Output = {
				kind: "series",
				chart: {
					xLabel: "Failure",
					yLabel: "Worst case",
					yUnit: "s",
					yScale: "log",
					x: sh.map((s) => s.name),
					series: [
						{
							label: "One attempt",
							shape: "points",
							points: sh.map((s) => pt(s.attempt)),
							notes: sh.map((s) => (s.attempt > 0 ? dur(s.attempt) : "refused at once")),
						},
						{
							label: "One call, with retries",
							shape: "points",
							points: sh.map((s) => pt(s.call)),
							notes: sh.map((s) => dur(s.call)),
						},
						{
							label: `One task, ${turns}`,
							shape: "points",
							points: sh.map((s) => pt(s.task)),
							notes: sh.map((s) => dur(s.task)),
						},
					],
					/* The reader's wait, and nothing else: a fixed one-hour line was a threshold nobody set. */
					thresholds: [{ y: i.patience, label: `you can wait ${dur(i.patience)}`, tone: "bad" }],
				},
			};

			return { kind: "group", parts: [head, matrix, chart, method] };
		} catch (error) {
			if (error instanceof InputError) return { kind: "error", message: error.message, input: error.input };
			throw error;
		}
	},
} satisfies Tool<Input>;
