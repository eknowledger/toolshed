/**
 * What happens to the people waiting when demand passes capacity for a while.
 *
 * A service has some workers and each request takes some time, so it can answer so many a second. For a
 * stretch, more than that arrive. Somebody has to hear "no"; the only questions are how many, which ones,
 * and whether they hear it quickly or after waiting for nothing. The answer depends far less on capacity
 * than on what the service does with the request that does not fit, and that is what this simulates.
 *
 * The model, in one place:
 *
 *  - **Arrivals** are Poisson: `base` a second, then `spike` a second for 60 s, then `base` again.
 *    One minute of normal traffic before the spike and three minutes after it, so recovery is visible.
 *  - **Service** is exponential with the given mean, on `workers` identical workers.
 *  - **Each attempt** waits up to `timeout` for an answer. Then the client gives up on it, and if it has
 *    retries left, sends another about 1 s later, spread +-50%.
 *  - **The person** gives up 10 s after first trying. "Answered" means a successful response
 *    inside that, which is the definition that still means something once retries are counted.
 *  - **Work is not cancelled.** A request whose client has given up is still served when its turn comes,
 *    unless the policy checks first. That is wasted work, and it is most of what an overloaded unbounded
 *    queue does.
 *
 * The policies are the ones the backpressure post compares: an unbounded queue, skip the abandoned, a bounded
 * queue, a bounded queue that puts orders first (1 request in 5 is an order), a CoDel-style queue timeout set as
 * each request arrives (Maurer, "Fail at Scale", ACM Queue 2015), and adaptive LIFO on top of it.
 *
 * ⚠️ This is the same simulation as `backpressure/shed_sim.py` in mainlog-code, event for event and draw for
 * draw: the same mulberry32 generator, seeded the same way, consumed in the same order, and the same
 * tie-break on simultaneous events. With the post's inputs it prints the post's numbers, and the fixtures
 * pin exactly those. A change to the event order here that is not made there is a bug, and the fixtures
 * are what will say so.
 *
 * ⚠️ Where it stops being true: exponential service has a light tail, and real ones are heavier, which
 * makes every policy worse. Real clients do not retry on a perfect schedule. And one queue in front of one
 * pool is the simplest possible service; a chain of them multiplies retries (see the retry tools).
 */
import type { Cell, Field, Output, Series, Tool } from "@toolbench/sdk";

type Input = {
	workers: number;
	service: number;
	base: number;
	spike: number;
	timeout: number;
	retries: number;
	policy: string;
};

/**
 * The model's other numbers, fixed rather than asked for. Each one changes the answer less than the seven inputs do,
 * and a form with twelve fields asks a reader to decide things they came here to have decided. The README says what
 * each is and why it has the value it has.
 */
type Params = Input & { duration: number; patience: number; backoff: number; bound: number; checkout: number };
const DURATION = 60;
const PATIENCE = 10;
const BACKOFF = 1;
const ORDER_SHARE = 20;
/**
 * The bound is derived, from the rule the backpressure post teaches: a bound sheds only if the work it holds is
 * shorter than the caller's timeout. A quarter of the timeout's worth leaves room for the service time and for
 * bursts, and it is 50 at the post's numbers (2 s x 100/s / 4).
 */
const BOUND_SHARE = 0.25;

class InputError extends Error {
	readonly input: string;

	constructor(message: string, input: string) {
		super(message);
		this.name = "InputError";
		this.input = input;
	}
}

const POLICIES: Record<string, string> = {
	fifo: "Unbounded queue",
	fifo_skip: "Skip the abandoned",
	bounded: "Bounded queue",
	priority: "Bounded, orders first",
	codel: "Queue timeout (CoDel)",
	lifo: "Newest first (LIFO + CoDel)",
};

/** Before the spike and after it. Fixed, so the timeline always has room to show a recovery or its absence. */
const BEFORE = 60;
const AFTER = 180;
/** Fail at Scale's M and N. Not inputs: the point of the policy is that it has two numbers and keeps them. */
const CODEL_TARGET = 0.005;
const CODEL_INTERVAL = 0.1;
const WINDOW = 10;
/** A run this large is minutes of a worker's time. Refused up front rather than left to the timeout. */
const MAX_ARRIVALS = 2_000_000;
const SEED = 1;

/** mulberry32. The Python simulation implements the same function bit for bit. */
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

function exponential(next: () => number, mean: number): number {
	return -Math.log(1 - next()) * mean;
}

type Attempt = {
	user: number;
	checkout: boolean;
	t0: number;
	tries: number;
	gaveUp: boolean;
	finished: boolean;
	refused: boolean;
	limit: number;
};

type User = { first: number; checkout: boolean; outcome: string; latency: number; attempts: number };

type Kind = 0 | 1 | 2 | 3; // arrive, timeout, rejected, done
type Event = { t: number; seq: number; kind: Kind; a: Attempt };

/**
 * A binary min-heap on (time, sequence). The sequence number makes the order total, which is what makes it
 * the same order as Python's heapq: two events at the same instant come out in the order they were pushed.
 */
class Heap {
	private items: Event[] = [];

	get size(): number {
		return this.items.length;
	}

	private less(i: number, j: number): boolean {
		const a = this.items[i]!;
		const b = this.items[j]!;
		return a.t < b.t || (a.t === b.t && a.seq < b.seq);
	}

	push(e: Event): void {
		const items = this.items;
		items.push(e);
		let i = items.length - 1;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (!this.less(i, parent)) break;
			[items[i], items[parent]] = [items[parent]!, items[i]!];
			i = parent;
		}
	}

	pop(): Event {
		const items = this.items;
		const top = items[0]!;
		const last = items.pop()!;
		if (items.length > 0) {
			items[0] = last;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				const r = l + 1;
				let m = i;
				if (l < items.length && this.less(l, m)) m = l;
				if (r < items.length && this.less(r, m)) m = r;
				if (m === i) break;
				[items[i], items[m]] = [items[m]!, items[i]!];
				i = m;
			}
		}
		return top;
	}
}

/**
 * A queue that can be taken from either end and, rarely, from the middle. An array with a moving head,
 * because `shift()` on a long array is linear and an unbounded queue in overload is exactly a long array.
 */
class Line {
	private items: Attempt[] = [];
	private head = 0;

	get length(): number {
		return this.items.length - this.head;
	}

	push(a: Attempt): void {
		this.items.push(a);
	}

	shift(): Attempt {
		const a = this.items[this.head]!;
		this.head++;
		if (this.head > 4096 && this.head * 2 > this.items.length) {
			this.items = this.items.slice(this.head);
			this.head = 0;
		}
		return a;
	}

	pop(): Attempt {
		return this.items.pop()!;
	}

	/** The newest price preview, removed; null if every queued request is an order. */
	takeNewestBrowse(): Attempt | null {
		for (let i = this.items.length - 1; i >= this.head; i--) {
			const a = this.items[i]!;
			if (!a.checkout) {
				this.items.splice(i, 1);
				return a;
			}
		}
		return null;
	}
}

type Run = {
	users: User[];
	wasted: number;
	useful: number;
	windows: number[];
	end: number;
	spikeStart: number;
	spikeEnd: number;
};

function simulate(p: Params, policy: string, signal?: AbortSignal): Run {
	const arrivals = rng(SEED);
	const service = rng(SEED + 1);
	const backoffs = rng(SEED + 2);
	const meanService = p.service / 1000;
	const spikeStart = BEFORE;
	const spikeEnd = BEFORE + p.duration;
	const end = spikeEnd + AFTER;

	const heap = new Heap();
	let seq = 0;
	const push = (t: number, kind: Kind, a: Attempt) => {
		seq++;
		heap.push({ t, seq, kind, a });
	};
	const attempt = (user: number, checkout: boolean, t0: number, tries: number): Attempt => ({
		user,
		checkout,
		t0,
		tries,
		gaveUp: false,
		finished: false,
		refused: false,
		limit: 0,
	});

	const users: User[] = [];
	let t = 0;
	for (;;) {
		const rate = spikeStart <= t && t < spikeEnd ? p.spike : p.base;
		t += exponential(arrivals, 1 / rate);
		if (t >= end) break;
		const checkout = arrivals() < p.checkout / 100;
		users.push({ first: t, checkout, outcome: "", latency: Number.NaN, attempts: 0 });
		push(t, 0, attempt(users.length - 1, checkout, t, 0));
	}

	const queue = new Line();
	const rejects = new Line();
	let busy = 0;
	let lastEmpty = 0;
	let wasted = 0;
	let useful = 0;
	const rejectCost = 0;

	const settle = (a: Attempt, outcome: string, now: number) => {
		const u = users[a.user]!;
		if (a.tries < p.retries) {
			const at = now + p.backoff * (0.5 + backoffs());
			if (at < u.first + p.patience) {
				push(at, 0, attempt(a.user, a.checkout, at, a.tries + 1));
				return;
			}
		}
		u.outcome = outcome;
	};
	const refuse = (a: Attempt, now: number) => {
		a.refused = true;
		settle(a, "refused", now);
	};
	const fullReject = (a: Attempt, now: number) => {
		if (rejectCost > 0) rejects.push(a);
		else refuse(a, now);
	};
	const start = (now: number) => {
		while (busy < p.workers && (rejects.length > 0 || queue.length > 0)) {
			if (rejects.length > 0) {
				const a = rejects.shift();
				busy++;
				push(now + rejectCost, 2, a);
				continue;
			}
			const congested = now - lastEmpty > CODEL_INTERVAL;
			const a = policy === "lifo" && congested ? queue.pop() : queue.shift();
			if (policy === "codel" || policy === "lifo") {
				// The limit set when it arrived, enforced as a worker picks it up.
				if (now - a.t0 > a.limit) {
					if (!a.gaveUp) refuse(a, now);
					continue;
				}
			}
			if (policy === "fifo_skip" && a.gaveUp) continue;
			busy++;
			push(now + exponential(service, meanService), 3, a);
		}
		if (queue.length === 0) lastEmpty = now;
	};

	let processed = 0;
	while (heap.size > 0) {
		if ((++processed & 0xffff) === 0) signal?.throwIfAborted();
		const { t: now, kind, a } = heap.pop();
		if (kind === 0) {
			users[a.user]!.attempts++;
			push(a.t0 + p.timeout, 1, a);
			const bounded = policy === "bounded" || policy === "priority";
			if (bounded && queue.length >= p.bound) {
				if (policy === "priority" && a.checkout) {
					const victim = queue.takeNewestBrowse();
					if (victim) {
						fullReject(victim, now);
					} else {
						fullReject(a, now);
						start(now);
						continue;
					}
				} else {
					fullReject(a, now);
					start(now);
					continue;
				}
			}
			if (policy === "codel" || policy === "lifo") {
				// Fail at Scale's onNewRequest: M if the queue has not been empty for the last N, otherwise N,
				// decided from the queue as this request finds it.
				if (queue.length === 0) lastEmpty = now;
				a.limit = now - lastEmpty > CODEL_INTERVAL ? CODEL_TARGET : CODEL_INTERVAL;
			}
			queue.push(a);
			start(now);
		} else if (kind === 1) {
			if (a.finished || a.refused) continue;
			a.gaveUp = true;
			settle(a, "timed_out", now);
		} else if (kind === 2) {
			busy--;
			if (!a.gaveUp) refuse(a, now);
			start(now);
		} else {
			busy--;
			if (a.gaveUp) {
				wasted++;
			} else {
				a.finished = true;
				useful++;
				const u = users[a.user]!;
				if (now - u.first <= p.patience) {
					u.outcome = "answered";
					u.latency = now - u.first;
				} else {
					u.outcome = "late";
				}
			}
			start(now);
		}
	}

	const windows: number[] = [];
	for (let w = 0; w < end - 1e-9; w += WINDOW) {
		let n = 0;
		let ok = 0;
		for (const u of users) {
			if (w <= u.first && u.first < w + WINDOW) {
				n++;
				if (u.outcome === "answered") ok++;
			}
		}
		windows.push((100 * ok) / Math.max(1, n));
	}
	return { users, wasted, useful, windows, end, spikeStart, spikeEnd };
}

type Summary = {
	answered: number;
	refused: number;
	timedOut: number;
	p50: number;
	p99: number;
	checkout: number;
	tries: number;
	wasted: number;
	recovered: number | null;
};

function share(users: User[], outcome: string | string[]): number {
	const want = Array.isArray(outcome) ? outcome : [outcome];
	return (100 * users.filter((u) => want.includes(u.outcome)).length) / Math.max(1, users.length);
}

function summarise(r: Run): Summary {
	const spike = r.users.filter((u) => r.spikeStart <= u.first && u.first < r.spikeEnd);
	const lat = spike
		.filter((u) => u.outcome === "answered")
		.map((u) => u.latency)
		.sort((a, b) => a - b);
	const pct = (q: number) => (lat.length ? lat[Math.floor(q * (lat.length - 1))]! * 1000 : Number.NaN);
	let recovered: number | null = null;
	for (let i = 0; i < r.windows.length; i++) {
		const s = i * WINDOW;
		if (s < r.spikeEnd) continue;
		if (r.windows.slice(i).every((w) => w >= 90)) {
			recovered = s - r.spikeEnd;
			break;
		}
	}
	return {
		answered: share(spike, "answered"),
		refused: share(spike, "refused"),
		timedOut: share(spike, ["timed_out", "late"]),
		p50: pct(0.5),
		p99: pct(0.99),
		checkout: share(
			spike.filter((u) => u.checkout),
			"answered",
		),
		tries: spike.reduce((n, u) => n + u.attempts, 0) / Math.max(1, spike.length),
		wasted: r.wasted,
		recovered,
	};
}

const one = (v: number) => `${v.toFixed(1)}%`;
const ms = (v: number) => (Number.isFinite(v) ? `${v.toFixed(0)} ms` : "none answered");
const recoveryText = (s: Summary, after: number) =>
	s.recovered === null ? `not within ${after} s` : s.recovered === 0 ? "at once" : `${s.recovered} s`;

/** Tries that fit in a person's patience: each one waits out the timeout, then the backoff, before the next. */
function triesInPatience(retries: number, timeout: number): number {
	return Math.min(1 + retries, Math.floor((PATIENCE - 1e-9) / (timeout + BACKOFF)) + 1);
}

export default {
	run(input: Input, ctx) {
		try {
			const positive: [keyof Input, string][] = [
				["workers", "Workers"],
				["service", "Service time"],
				["base", "Normal rate"],
				["spike", "Spike rate"],
				["timeout", "Timeout"],
			];
			for (const [key, label] of positive) {
				if (!(Number(input[key]) > 0)) throw new InputError(`${label} must be greater than zero.`, key);
			}
			if (!Number.isInteger(input.workers)) throw new InputError("Workers must be a whole number.", "workers");
			if (!(Number.isInteger(input.retries) && input.retries >= 0)) {
				throw new InputError("Retries must be a whole number, zero or more.", "retries");
			}
			if (!(input.policy in POLICIES)) throw new InputError("Unknown policy.", "policy");
			const capacity = input.workers / (input.service / 1000);
			const p: Params = {
				...input,
				duration: DURATION,
				patience: PATIENCE,
				backoff: BACKOFF,
				checkout: ORDER_SHARE,
				bound: Math.max(1, Math.round(BOUND_SHARE * input.timeout * capacity)),
			};
			const expected = (BEFORE + AFTER) * p.base + p.duration * p.spike;
			if (expected * (1 + p.retries) > MAX_ARRIVALS) {
				throw new InputError(
					`That is about ${Math.round(expected * (1 + p.retries)).toLocaleString("en-US")} attempts to simulate, over the ${MAX_ARRIVALS.toLocaleString("en-US")} this runs in a page. Scale the rates and the workers down together: the shares depend on their ratio.`,
					"spike",
				);
			}

			const run = simulate(p, p.policy, ctx?.signal);
			const s = summarise(run);
			const bounded = p.policy === "bounded" || p.policy === "priority";
			const timed = p.policy === "codel" || p.policy === "lifo";
			/*
			 * Could a spike leave it stuck? Two conditions, said as numbers. First, can the queue hold people past their
			 * timeout? An unbounded queue can; the derived bound and the queue timeout can't, unless the timeout is
			 * shorter than the queue timeout's 100 ms. Second, once everyone times out, every person sends all the tries
			 * that fit in their patience: if the normal rate times those tries is at least capacity, the queue can't drain.
			 * Near 1 the simulation's randomness decides, so within 15% of it the answer is "borderline".
			 *
			 * This is a property of the service, not of this run, which is why "This run" says separately what happened.
			 */
			const tries = triesInPatience(p.retries, p.timeout);
			const holdsPastTimeout = bounded ? p.bound / capacity >= p.timeout : timed ? p.timeout <= CODEL_INTERVAL : true;
			const stuckLoad = p.base * tries;
			const ratio = stuckLoad / capacity;
			/*
			 * The same question as a sentence with its numbers, not a yes or no: the reader sees the two rates being
			 * compared, and the note says what follows from them. Every note says "a spike can" or "cannot leave it stuck",
			 * or that chance decides, so the conclusion is always in words.
			 */
			const rate = (v: number) => `${Number(v.toFixed(1))}/s`;
			const borderline = Math.abs(ratio - 1) <= 0.15;
			let could: Field;
			if (p.base >= capacity) {
				could = {
					label: "Normal traffic",
					value: `${rate(p.base)} against ${rate(capacity)}`,
					tone: "bad",
					note: "Overloaded without a spike: the normal rate alone is at or over capacity.",
				};
			} else if (!holdsPastTimeout) {
				const wait = timed ? CODEL_INTERVAL * 1000 : Math.round((p.bound / capacity) * 1000);
				could = {
					label: "Longest wait in the queue",
					value: `${wait} ms`,
					note: timed
						? `The queue timeout, under the ${p.timeout} s timeout, so a spike cannot leave it stuck.`
						: `The bound, ${p.bound}, is that much work: under the ${p.timeout} s timeout, so a spike cannot leave it stuck.`,
				};
			} else {
				could = {
					label: "Once everyone times out",
					value: `${rate(stuckLoad)} of tries against ${rate(capacity)}`,
					...(ratio >= 1 && !borderline ? { tone: "bad" as const } : {}),
					note: `${p.base}/s times ${tries} ${tries === 1 ? "try" : "tries"} within ${PATIENCE} s. ${
						borderline
							? "Within 15% of capacity, so chance decides whether a spike leaves it stuck."
							: ratio >= 1
								? "Retries alone fill it, so a spike can leave it stuck."
								: "It drains, so a spike cannot leave it stuck."
					}`,
				};
			}
			const stuck = s.recovered === null && ratio >= 1 && holdsPastTimeout;
			const thisRun: Field =
				s.recovered === 0
					? { label: "This run", value: "recovered at once" }
					: s.recovered !== null
						? { label: "This run", value: `recovered ${s.recovered} s after the spike` }
						: stuck
							? { label: "This run", value: "stuck to the end", tone: "bad", note: `Still failing ${AFTER} s after the spike.` }
							: { label: "This run", value: "still draining at the end", note: `The backlog outlasted the ${AFTER} s after the spike.` };

			/*
			 * The service's numbers and the run's tail, quietly, at the end. The shares and the median are in the
			 * comparison, so they are not repeated.
			 */
			const metrics: Field[] = [
				{ label: "Capacity", value: `${capacity.toFixed(1)}/s`, note: `${p.workers} workers at ${p.service} ms each` },
				{ label: "Spike against capacity", value: `${((p.spike / capacity) * 100).toFixed(0)}%`, note: `${p.spike}/s for ${p.duration} s` },
				{ label: "Answered, p99", value: ms(s.p99), note: "From the first try, retries included" },
				{ label: "Orders answered", value: one(s.checkout), note: `${ORDER_SHARE}% of requests are orders` },
				{ label: "Tries per person", value: s.tries.toFixed(2) },
			];

			const xs = run.windows.map((_, i) => i * WINDOW);
			const answered: Series = {
				label: POLICIES[p.policy]!,
				unit: "%",
				shape: "step",
				points: run.windows.map((w) => Number(w.toFixed(1))),
			};

			/*
			 * Every policy at the same numbers, because the reason to run this is the comparison: same capacity, same
			 * spike, and the share answered moves from a few percent to two thirds with nothing but the policy. The
			 * reader's policy first and named as theirs, in words, since being current is not a judgement.
			 */
			const others = new Map<string, Summary>();
			for (const name of Object.keys(POLICIES)) {
				others.set(name, name === p.policy ? s : summarise(simulate(p, name, ctx?.signal)));
			}
			const order = [p.policy, ...Object.keys(POLICIES).filter((name) => name !== p.policy)];
			// "Queue timeout (CoDel, yours)", not "(CoDel) (yours)".
			const named = (name: string) => {
				const label = POLICIES[name]!;
				if (name !== p.policy) return label;
				return label.endsWith(")") ? `${label.slice(0, -1)}, yours)` : `${label} (yours)`;
			};
			const rounded = (v: number) => Number(v.toFixed(1));
			/*
			 * What happened to everyone who arrived during the spike, one bar per policy: answered in time, told no at
			 * once, or kept waiting for nothing. The three add up to everyone, so the bars are the same length and the
			 * split is the whole comparison.
			 */
			const outcomes: Output = {
				kind: "series",
				chart: {
					xLabel: "Policy",
					yLabel: "People who arrived during the spike",
					yUnit: "%",
					x: order.map(named),
					orientation: "horizontal",
					series: [
						{ label: "Answered in time", unit: "%", shape: "bar", stack: "people", points: order.map((n) => rounded(others.get(n)!.answered)) },
						/*
						 * Series colours follow order: blue, orange, green. Waiting for nothing is the failure, so it is
						 * second and takes orange; a fast no is the outcome a policy chooses on purpose, and takes green.
						 */
						{ label: "Waited for nothing", unit: "%", shape: "bar", stack: "people", points: order.map((n) => rounded(others.get(n)!.timedOut)) },
						{ label: "Refused at once", unit: "%", shape: "bar", stack: "people", points: order.map((n) => rounded(others.get(n)!.refused)) },
					],
				},
			};
			const rows: Cell[][] = order.map((name) => {
				const o = others.get(name)!;
				const recovery = o.recovered === null ? `over ${AFTER} s` : recoveryText(o, AFTER);
				return [named(name), one(o.answered), ms(o.p50), recovery, o.wasted.toLocaleString("en-US")];
			});

			const actions = whatToChange(p, s, others, { capacity, ratio, holdsPastTimeout, stuck, stuckLoad, tries });

			/*
			 * The comparison first, as bars and then as numbers; then how this policy recovered; then whether a spike can
			 * leave the service stuck, beside what this run did; then what to change, when there is something; then the
			 * service's own numbers.
			 */
			const parts: Output[] = [
				outcomes,
				{
					kind: "table",
					role: "comparison",
					// Short headers, because a comparison keeps its columns on a phone; the caption says what the last two are.
					caption: "Every policy at these numbers. Recovery: until every 10 s answers 90% again. Wasted: served after the client gave up",
					columns: [
						{ label: "Policy" },
						{ label: "Answered", align: "end", mono: true },
						{ label: "p50", align: "end", mono: true },
						{ label: "Recovery", align: "end", mono: true },
						{ label: "Wasted", align: "end", mono: true },
					],
					rows,
				},
				{
					kind: "series",
					chart: {
						xLabel: "First tried at",
						xUnit: "s",
						yLabel: "Answered",
						yUnit: "%",
						x: xs,
						series: [answered],
						annotations: [
							{ x: run.spikeStart, label: "spike" },
							{ x: run.spikeEnd, label: "spike ends" },
						],
						// What "back to normal" means in the table: every 10 s from here on answers 90% or more.
						thresholds: [{ y: 90, label: "90%, back to normal" }],
					},
				},
				{ kind: "fields", fields: [could, thisRun] },
				...(actions.length > 0
					? [
							{
								kind: "table" as const,
								role: "actions",
								caption: "What to change, the worst problem first",
								columns: [{ label: "Change" }, { label: "What it does at these numbers" }],
								rows: actions,
							},
						]
					: []),
				{ kind: "fields", role: "metrics", fields: metrics },
			];
			return { kind: "group", parts };
		} catch (error) {
			if (error instanceof InputError) return { kind: "error", message: error.message, input: error.input };
			throw error;
		}
	},
} satisfies Tool<Input>;

/** The fewest whole workers whose capacity is over `rate` at this service time. */
const workersFor = (rate: number, service: number) => Math.floor((rate * service) / 1000) + 1;

/**
 * What to change, worst first: a service overloaded without a spike, then one a spike can leave stuck, then a better
 * policy at the same capacity, then capacity for the spike itself. Every number is from this run or the comparison
 * runs, never a promise about a run that was not made: "more workers" says the fewest that put capacity over the rate,
 * and leaves sizing them for a wait target to the capacity planner.
 */
function whatToChange(
	p: Params,
	s: Summary,
	others: Map<string, Summary>,
	k: { capacity: number; ratio: number; holdsPastTimeout: boolean; stuck: boolean; stuckLoad: number; tries: number },
): Cell[][] {
	const rows: Cell[][] = [];
	if (p.base >= k.capacity) {
		rows.push([
			{ text: "Add workers: the normal traffic alone is more than the service can answer." },
			{
				text: `${workersFor(p.base, p.service)} workers is the fewest whose capacity is over the normal ${p.base}/s. Today's ${p.workers} answer ${k.capacity.toFixed(1)}/s.`,
			},
		]);
	} else if (k.holdsPastTimeout && k.ratio >= 0.85) {
		/* The most retries that keep the load once everyone times out clear of the borderline band. */
		let fit = -1;
		for (let r = 0; r <= 10; r++) {
			if (p.base * triesInPatience(r, p.timeout) < k.capacity / 1.15) fit = r;
		}
		rows.push([
			{
				text:
					fit < 0
						? "Bound the queue, or add a queue timeout, so nothing waits past the client's timeout."
						: fit === 0
							? "Do not retry, or bound the queue so nothing waits past the timeout."
							: `Retry at most ${fit === 1 ? "once" : `${fit} times`}, or bound the queue so nothing waits past the timeout.`,
			},
			{
				text: `When everyone is timing out, each person sends ${k.tries} ${k.tries === 1 ? "try" : "tries"} in ${PATIENCE} s: ${p.base}/s times ${k.tries} is ${Number(k.stuckLoad.toFixed(1))}/s against ${Number(k.capacity.toFixed(1))}/s, so the queue ${k.ratio >= 1 ? "cannot" : "may not be able to"} drain${k.stuck ? ". In this run it did not" : ""}.`,
			},
		]);
	}
	let best: string | null = null;
	for (const [name, o] of others) {
		if (name === p.policy) continue;
		const b = best ? others.get(best)! : null;
		if (!b || o.answered > b.answered + 0.05 || (Math.abs(o.answered - b.answered) <= 0.05 && o.timedOut < b.timedOut)) best = name;
	}
	const b = best ? others.get(best)! : null;
	if (best && b && (b.answered >= s.answered + 5 || (s.timedOut > 0.5 && b.timedOut <= s.timedOut - 5 && b.answered >= s.answered))) {
		rows.push([
			{ text: `Switch to ${POLICIES[best]!.toLowerCase().replace("codel", "CoDel").replace("lifo", "LIFO")}.` },
			{
				text: `${one(b.answered)} answered instead of ${one(s.answered)}, and ${one(b.timedOut)} wait for nothing instead of ${one(s.timedOut)}. Back to normal: ${recoveryText(b, AFTER)}.`,
			},
		]);
	}
	if (p.spike > k.capacity && p.base < k.capacity) {
		rows.push([
			{ text: rows.length ? "Or add workers for the spike." : "Add workers for the spike." },
			{
				text: `${workersFor(p.spike, p.service)} workers is the fewest whose capacity is over the ${p.spike}/s spike. The capacity planner sizes them for a wait target.`,
			},
		]);
	}
	return rows;
}
