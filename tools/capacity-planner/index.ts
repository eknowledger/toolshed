/**
 * How many servers do you need?
 *
 * The question behind every capacity review: requests arrive at some rate, each takes some time, and
 * somebody wants to know how many workers, threads, connections or agents to run. The usual answer is
 * utilisation, "keep it under 80%", which is not an answer at all: 80% of two servers and 80% of two
 * hundred behave nothing alike. What actually decides it is queueing, and the closed form for that has
 * been known since 1917.
 *
 * This computes Erlang C for an M/M/c queue: Poisson arrivals, exponential service times, c identical
 * servers, first come first served, no balking and an unbounded queue. It reports the probability an
 * arrival has to wait at all, the mean time it waits, and the smallest c that meets a target, and it
 * draws the curve so the shape is visible. The shape is the point. Wait does not rise linearly with
 * load; it is flat and then it is a cliff, and the cliff moves as c changes.
 *
 * A simulate mode runs a seeded Monte Carlo of the same queue and reports what fraction of arrivals
 * waited, which is there to disagree with the formula if the formula is wrong.
 *
 * ⚠️ Where the model stops being true, because a capacity number that quietly assumes the wrong world
 * is worse than no number:
 *
 *  - **Exponential service times.** Real service times have a tail. A heavier tail queues worse than
 *    this predicts, so treat the answer as a floor rather than a forecast.
 *  - **Poisson arrivals.** Bursty traffic, retries and thundering herds all violate this, and all of
 *    them make it worse rather than better.
 *  - **Identical servers, no setup cost.** No cold starts, no autoscaling lag, no cache warmth.
 *  - **An unbounded queue.** A real system sheds load, and shedding changes the arrival process.
 *
 * References: Erlang (1917) for the loss formula; Cooper, *Introduction to Queueing Theory*, for the
 * recursion used here and for the M/M/c waiting-time result.
 */
import type { Cell, Field, Output, Series, Tool } from "@toolbench/sdk";

type Input = { rate: number; service: number; target: number; mode: string; trials: number };

/**
 * Named so the error path can say which input was wrong rather than "invalid input".
 *
 * ⚠️ The field is declared and assigned rather than written as a constructor parameter property. A
 * parameter property emits code, so it is not erasable, and `src/tools/tsconfig.json` sets
 * `erasableSyntaxOnly` for exactly this reason: tools are run by stripping types, and the failure arrives
 * as "TypeScript parameter property is not supported in strip-only mode" from the test runner rather than
 * from the compiler.
 */
class InputError extends Error {
	readonly input: string;

	constructor(message: string, input: string) {
		super(message);
		this.name = "InputError";
		this.input = input;
	}
}

/**
 * Erlang B, by the recursion rather than the textbook ratio.
 *
 * ⚠️ The plan for this tool said to compute Erlang C "in log space so it does not overflow". Log space
 * solves the overflow, and this solves it better: the recursion never forms `A^c` or `c!` at all, so
 * there is nothing to overflow and no `lgamma` or log-sum-exp to get subtly wrong. The direct form,
 * `B = (A^c / c!) / Σ(A^k / k!)`, overflows `A^c` around c = 170 for any interesting A, which is well
 * inside the range a real capacity question lands in.
 *
 *   B(0) = 1
 *   B(n) = A·B(n−1) / (n + A·B(n−1))
 *
 * Every intermediate value is a probability in [0, 1], and the loop is O(c) with one division per step.
 */
function erlangB(load: number, servers: number): number {
	let b = 1;
	for (let n = 1; n <= servers; n++) b = (load * b) / (n + load * b);
	return b;
}

/**
 * Erlang C: the probability an arrival waits, given `servers` servers and `load` erlangs of offered work.
 *
 * Undefined at and above saturation, and that is not a rounding concern: at `servers <= load` the queue
 * grows without bound and "probability of waiting" tends to 1 while the mean wait tends to infinity. The
 * caller is expected to have excluded that range; returning 1 here would look like an answer.
 */
function erlangC(load: number, servers: number): number {
	if (servers <= load) return 1;
	const b = erlangB(load, servers);
	const utilisation = load / servers;
	return b / (1 - utilisation * (1 - b));
}

/** Mean seconds an arrival spends waiting, not counting its own service. */
function meanWaitSeconds(load: number, servers: number, serviceSeconds: number): number {
	if (servers <= load) return Number.POSITIVE_INFINITY;
	return (erlangC(load, servers) * serviceSeconds) / (servers - load);
}

/**
 * mulberry32, seeded from a constant.
 *
 * ⚠️ The seed is fixed and that is a contract requirement, not laziness: `pure` means a function of the
 * declared inputs, with "no randomness that is not seeded". `Math.random()` here would make every
 * fixture unreproducible and the build-time seed different on every build.
 */
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

/** An exponential draw with the given mean. `1 - u` because `u` can be exactly 0 and log(0) is not. */
function exponential(next: () => number, mean: number): number {
	return -Math.log(1 - next()) * mean;
}

/**
 * A discrete-event simulation of the same M/M/c queue, to be checked against the formula.
 *
 * Exact rather than time-stepped: each arrival is assigned to the server that frees up first, so the
 * wait is `max(0, earliestFree - arrival)` and no time quantum is involved. FCFS with c identical
 * servers makes "earliest free" the correct discipline.
 *
 * ⚠️ The first tenth is discarded. Every server is idle at t = 0, so the opening arrivals never wait and
 * would drag the estimate below the steady-state answer, which is exactly the direction that would make
 * a wrong formula look right.
 *
 * ⚠️ `signal` is checked and `progress` reported every 4096 arrivals. This tool declares
 * `thread: "worker"` because trials go to two million, where the loop is comfortably long enough to freeze
 * a page; a worker the runtime cannot interrupt is only half a boundary, and one that gives no sign of
 * life for a second looks broken.
 */
function simulate(
	arrivalsPerSecond: number,
	serviceSeconds: number,
	servers: number,
	trials: number,
	signal: AbortSignal | undefined,
	report: ((fraction: number) => void) | undefined,
): { waitedFraction: number; meanWaitSeconds: number; counted: number } {
	const next = rng(0x5eed);
	const freeAt = new Float64Array(servers);
	const warmup = Math.floor(trials / 10);
	let clock = 0;
	let waited = 0;
	let waitTotal = 0;
	let counted = 0;

	for (let i = 0; i < trials; i++) {
		if ((i & 0xfff) === 0) {
			signal?.throwIfAborted();
			report?.(i / trials);
		}

		clock += exponential(next, 1 / arrivalsPerSecond);

		let earliest = 0;
		for (let s = 1; s < servers; s++) if (freeAt[s]! < freeAt[earliest]!) earliest = s;

		const start = Math.max(clock, freeAt[earliest]!);
		const wait = start - clock;
		if (i >= warmup) {
			counted++;
			waitTotal += wait;
			if (wait > 0) waited++;
		}
		freeAt[earliest] = start + exponential(next, serviceSeconds);
	}

	return {
		waitedFraction: counted > 0 ? waited / counted : 0,
		meanWaitSeconds: counted > 0 ? waitTotal / counted : 0,
		counted,
	};
}

/** Rounded to a fixed number of places, as a string, so a fixture pins a value rather than a float. */
const fixed = (value: number, places: number): string => value.toFixed(places);
const percent = (fraction: number): string => `${(fraction * 100).toFixed(2)}%`;

/** Milliseconds, at a precision that stays useful from microseconds to minutes. */
function millis(seconds: number): string {
	if (!Number.isFinite(seconds)) return "unbounded";
	const ms = seconds * 1000;
	if (ms >= 10000) return `${(ms / 1000).toFixed(1)} s`;
	if (ms >= 1) return `${ms.toFixed(1)} ms`;
	return `${(ms * 1000).toFixed(0)} µs`;
}

export default {
	run(input: Input, ctx) {
		try {
			const { rate, service, target, mode, trials } = input;

			if (!(rate > 0)) throw new InputError("Arrival rate must be greater than zero.", "rate");
			if (!(service > 0)) throw new InputError("Service time must be greater than zero.", "service");
			if (!(target > 0 && target < 100)) {
				throw new InputError("Target must be between 0 and 100 percent, exclusive.", "target");
			}

			const serviceSeconds = service / 1000;
			/*
			 * Offered load in erlangs: the number of servers that would be busy if none ever queued. This is
			 * the one number the whole answer turns on, and it is why "requests per second" alone can never
			 * size anything: 100/s of 10ms work and 10/s of 100ms work are the same erlang.
			 */
			const load = rate * serviceSeconds;

			/* Below this the queue is unstable however patient anyone is. Strictly greater than the load. */
			const minimumServers = Math.floor(load) + 1;

			const targetFraction = target / 100;
			let chosen = minimumServers;
			/*
			 * A bound rather than a while(true). Erlang C falls monotonically in c, so a target above zero is
			 * always reachable, but "always" here rests on floating point: at very small targets C underflows
			 * to 0 and the loop would already have stopped. The cap keeps a pathological input from spinning.
			 */
			const searchLimit = minimumServers + 10000;
			while (chosen < searchLimit && erlangC(load, chosen) > targetFraction) chosen++;

			const chosenC = erlangC(load, chosen);
			const chosenWait = meanWaitSeconds(load, chosen, serviceSeconds);

			const fields: Field[] = [
				{ label: "Offered load", value: `${fixed(load, 2)} erlangs`, note: `${rate}/s x ${service} ms` },
				{ label: "Minimum servers", value: String(minimumServers), note: "below this the queue is unstable" },
				{
					label: `Servers for ${fixed(target, 2)}% wait`,
					value: String(chosen),
					tone: chosen > minimumServers ? "good" : "warn",
					...(chosen === minimumServers ? { note: "the stability floor already meets it" } : {}),
				},
				{ label: "Utilisation there", value: percent(load / chosen) },
				{ label: "Chance of waiting", value: percent(chosenC) },
				{ label: "Mean wait", value: millis(chosenWait), note: "queueing only, excluding service" },
			];

			/*
			 * The curve, from the stability floor to a little past the answer. Two series on two axes,
			 * because the pair is the insight: the chance of waiting collapses while the mean wait collapses
			 * faster, and one axis cannot show a percentage and a duration honestly.
			 */
			const span = Math.max(6, Math.ceil((chosen - minimumServers) * 1.6));
			const xs: number[] = [];
			for (let c = minimumServers; c <= minimumServers + span; c++) xs.push(c);

			const waitChance: Series = {
				label: "Chance of waiting",
				unit: "%",
				shape: "line",
				points: xs.map((c) => Number((erlangC(load, c) * 100).toFixed(3))),
			};
			const waitTime: Series = {
				label: "Mean wait",
				unit: "ms",
				shape: "line",
				axis: "right",
				points: xs.map((c) => Number((meanWaitSeconds(load, c, serviceSeconds) * 1000).toFixed(3))),
			};

			const rows: Cell[][] = xs
				.filter((c) => Math.abs(c - chosen) <= 2)
				.map((c) => [
					{ text: String(c), mono: true },
					{ text: percent(load / c), mono: true },
					{ text: percent(erlangC(load, c)), mono: true, ...(c === chosen ? { tone: "good" as const } : {}) },
					{ text: millis(meanWaitSeconds(load, c, serviceSeconds)), mono: true },
				]);

			/*
			 * ⚠️ The fields come FIRST, and the order decides what a card shows.
			 *
			 * A compact card renders the first part and counts the rest, so the first part is the card. This led
			 * with the chart for a while, which put a 390px picture on the landing page before the reader had
			 * asked for anything and made the card the tallest thing on the page.
			 *
			 * The answer leads instead: "11 servers" is what someone wants from a capacity planner, and it is
			 * also what fits a card. The curve is the better half of the explanation, and it belongs where there
			 * is room for it, which is the tool's own page after a run.
			 */
			const parts: Output[] = [
				{ kind: "fields", fields },
				{
					kind: "series",
					chart: {
						xLabel: "Servers",
						yLabel: "Chance of waiting",
						yUnit: "%",
						yLabelRight: "Mean wait (ms)",
						x: xs,
						series: [waitChance, waitTime],
						annotations: [{ x: chosen, label: `${chosen} servers` }],
					},
				},
				{
					kind: "table",
					caption: "Either side of the answer, because the step between two counts is the decision",
					columns: [
						{ label: "Servers", mono: true },
						{ label: "Utilisation", align: "end", mono: true },
						{ label: "Chance of waiting", align: "end", mono: true },
						{ label: "Mean wait", align: "end", mono: true },
					],
					rows,
				},
			];

			if (mode === "simulate") {
				if (!(trials >= 1000)) throw new InputError("Simulating needs at least 1000 trials.", "trials");
				const sim = simulate(
					rate,
					serviceSeconds,
					chosen,
					Math.round(trials),
					ctx?.signal,
					ctx ? (fraction) => ctx.progress(fraction) : undefined,
				);
				/*
				 * Reported beside the formula rather than instead of it. The interesting case is disagreement:
				 * if these two diverge by more than sampling error, one of them is wrong, and the fixtures for
				 * this tool exist to notice that.
				 */
				/*
				 * ⚠️ `group`, not a label suffixed with a space to dodge a collision.
				 *
				 * The first version had "Formula says" and "Formula says " as two labels, which is the sort of
				 * thing that works until somebody trims a string. `Field.group` exists for exactly this: the
				 * same quantity reported two ways is the normal case, and the SDK keys a field by group AND
				 * label so the two no longer collide.
				 */
				parts.push({
					kind: "fields",
					fields: [
						{ group: "Simulated", label: "Chance of waiting", value: percent(sim.waitedFraction), note: `${sim.counted} arrivals after warmup` },
						{ group: "Simulated", label: "Mean wait", value: millis(sim.meanWaitSeconds) },
						{ group: "Formula", label: "Chance of waiting", value: percent(chosenC) },
						{ group: "Formula", label: "Mean wait", value: millis(chosenWait) },
					],
				});
			}

			return { kind: "group", parts };
		} catch (error) {
			if (error instanceof InputError) return { kind: "error", message: error.message, input: error.input };
			throw error;
		}
	},
} satisfies Tool<Input>;
