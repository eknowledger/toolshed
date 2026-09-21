/**
 * Why a fast link is slow.
 *
 * Somebody provisions a 1 Gb/s circuit between two continents, copies a file, and gets 6 Mb/s. Nothing is
 * broken. A single TCP connection has two ceilings that have nothing to do with the link rate, and on a long
 * path the lower one is usually far below what was paid for.
 *
 * **The window ceiling.** A sender may have at most one window of unacknowledged data in flight, so it can
 * send a window and then must wait a full round trip for the acknowledgement: `window / RTT`. This is why a
 * 64 KB window, the largest TCP could express before window scaling, caps a 80 ms path at about 6.5 Mb/s
 * however fat the pipe is.
 *
 * **The loss ceiling.** Congestion control reads loss as a signal to slow down, so a steady loss rate holds
 * throughput at roughly `MSS / (RTT x sqrt(p))`. The square root is the part that surprises people: a
 * hundredth of a percent of loss is not a hundredth of a problem. It is also why loss and distance compound
 * rather than add.
 *
 * The answer is the lower of the two, and which one binds is the whole diagnosis: a window ceiling is fixed
 * by configuration, a loss ceiling is fixed by finding the loss.
 *
 * ⚠️ Where this stops being true, because a ceiling quoted without its assumptions is worse than no number:
 *
 *  - **One connection.** Ten parallel streams see roughly ten times this. Half of what a CDN does is turn one
 *    long path into many short ones.
 *  - **Reno-shaped congestion control.** The sqrt(p) law is the classic AIMD result. CUBIC and BBR do better
 *    on long paths, BBR markedly so, because it models the path rather than reacting to loss.
 *  - **Steady, random loss.** Loss that arrives in bursts, or from a shallow buffer rather than congestion,
 *    behaves differently.
 *  - **A ceiling, not a prediction.** The real transfer is at or below this, never above.
 *
 * References: Mathis, Semke, Mahdavi & Ott, "The macroscopic behavior of the TCP congestion avoidance
 * algorithm" (1997), for the sqrt(p) form and the sqrt(3/2) constant; RFC 7323 for window scaling.
 */
import type { Cell, Field, Output, Series, Tool } from "@toolbench/sdk";

type Input = { mss: number; rtt: number; loss: number; window: number; sweep: string };

/** Named so the error path can say which input was wrong rather than "invalid input". */
class InputError extends Error {
	readonly input: string;

	constructor(message: string, input: string) {
		super(message);
		this.name = "InputError";
		this.input = input;
	}
}

/**
 * The constant in the Mathis equation, `sqrt(3/2)`.
 *
 * It comes from integrating the sawtooth a Reno-shaped sender traces: halve the window on loss, grow by one
 * segment per round trip, and the average of that shape against the loss interval leaves this factor. Quoted
 * as 1.22 in most places; kept symbolic here so nobody has to trust a rounded number.
 */
const MATHIS_C = Math.sqrt(1.5);

/** Bits per second a window allows: one window in flight, then a full round trip of waiting. */
function windowCeiling(windowBytes: number, rttSeconds: number): number {
	return (windowBytes * 8) / rttSeconds;
}

/**
 * Bits per second a steady loss rate allows.
 *
 * Infinite at zero loss, and that is the honest answer rather than an edge case to paper over: with no loss a
 * Reno sender has nothing telling it to stop growing, so the window becomes the only ceiling. The caller
 * takes the minimum, so infinity resolves to the window ceiling on its own.
 */
function lossCeiling(mssBytes: number, rttSeconds: number, loss: number): number {
	if (loss <= 0) return Number.POSITIVE_INFINITY;
	return (mssBytes * 8 * MATHIS_C) / (rttSeconds * Math.sqrt(loss));
}

/** Bits per second, at a precision that stays useful from a modem to a backbone. */
function bitrate(bitsPerSecond: number): string {
	if (!Number.isFinite(bitsPerSecond)) return "unbounded";
	if (bitsPerSecond >= 1e9) return `${(bitsPerSecond / 1e9).toFixed(2)} Gbit/s`;
	if (bitsPerSecond >= 1e6) return `${(bitsPerSecond / 1e6).toFixed(2)} Mbit/s`;
	if (bitsPerSecond >= 1e3) return `${(bitsPerSecond / 1e3).toFixed(1)} kbit/s`;
	return `${bitsPerSecond.toFixed(0)} bit/s`;
}

/** Bytes, for a window or a bandwidth-delay product. */
function bytes(value: number): string {
	if (!Number.isFinite(value)) return "unbounded";
	if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
	if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${Math.round(value)} B`;
}

/** Rounded to a fixed number of places, as a string, so a fixture pins a value rather than a float. */
const fixed = (value: number, places: number): string => value.toFixed(places);

export default {
	run(input: Input) {
		try {
			const { mss, rtt, loss, window, sweep } = input;

			if (!(mss > 0)) throw new InputError("Segment size must be greater than zero.", "mss");
			if (!(rtt > 0)) throw new InputError("Round-trip time must be greater than zero.", "rtt");
			if (!(loss >= 0 && loss < 100)) throw new InputError("Loss must be from 0 up to but not including 100 percent.", "loss");
			if (!(window > 0)) throw new InputError("Receive window must be greater than zero.", "window");

			const rttSeconds = rtt / 1000;
			const windowBytes = window * 1024;
			const lossFraction = loss / 100;

			const fromWindow = windowCeiling(windowBytes, rttSeconds);
			const fromLoss = lossCeiling(mss, rttSeconds, lossFraction);
			const ceiling = Math.min(fromWindow, fromLoss);
			const binding = fromLoss < fromWindow ? "loss" : "window";

			/*
			 * The window a sender would need to reach the OTHER ceiling. When loss binds, this is what the
			 * window would have to be for loss to stay the only limit; when the window binds, it is the answer
			 * to "how big should I set it", which is the bandwidth-delay product.
			 */
			const windowToMatch = (Number.isFinite(fromLoss) ? fromLoss : fromWindow) * rttSeconds / 8;

			const fields: Field[] = [
				{
					label: "Throughput ceiling",
					value: bitrate(ceiling),
					note: `one connection, ${binding} limited`,
					tone: binding === "loss" ? "warn" : "normal",
				},
				{ label: "What binds it", value: binding === "loss" ? "Packet loss" : "Receive window" },
				{ label: "Window allows", value: bitrate(fromWindow), note: `${bytes(windowBytes)} in flight per ${fixed(rtt, 2)} ms` },
				{
					label: "Loss allows",
					value: bitrate(fromLoss),
					note: loss === 0 ? "no loss, so nothing tells the sender to stop" : `at ${fixed(loss, 4)}% loss`,
				},
				{ label: "Window to lift that limit", value: bytes(windowToMatch), note: "the bandwidth-delay product at the other ceiling" },
				{ label: "Data in flight at the ceiling", value: bytes((ceiling * rttSeconds) / 8) },
			];

			/*
			 * The two ceilings across a sweep, on one axis because both are bit rates.
			 *
			 * ⚠️ They cross only against LOSS, and an earlier version of this comment claimed otherwise. Both
			 * ceilings are proportional to 1/RTT, so their ratio is `window x sqrt(p) / (MSS x C)` with no RTT
			 * in it at all: sweeping distance divides both by the same number and never changes which one
			 * binds. Against loss the window ceiling is flat and the loss ceiling falls as sqrt(p), so there is
			 * one crossing and it is the whole diagnosis. The invariant tests pin both halves of that.
			 */
			const overRtt = sweep !== "loss";
			const xs: number[] = [];
			if (overRtt) {
				for (let i = 1; i <= 24; i++) xs.push(Number((rtt * (i / 6)).toFixed(3)));
			} else {
				for (let i = 0; i <= 24; i++) xs.push(Number((i * 0.05).toFixed(3)));
			}

			const mbit = (bitsPerSecond: number): number | null =>
				Number.isFinite(bitsPerSecond) ? Number((bitsPerSecond / 1e6).toFixed(4)) : null;

			const windowSeries: Series = {
				label: "Window allows",
				unit: "Mbit/s",
				shape: "line",
				points: xs.map((x) => mbit(windowCeiling(windowBytes, (overRtt ? x : rtt) / 1000))),
			};
			const lossSeries: Series = {
				label: "Loss allows",
				unit: "Mbit/s",
				shape: "line",
				points: xs.map((x) => mbit(lossCeiling(mss, (overRtt ? x : rtt) / 1000, (overRtt ? loss : x) / 100))),
			};

			const rows: Cell[][] = xs
				.filter((x) => Math.abs(x - (overRtt ? rtt : loss)) <= (overRtt ? rtt / 3 : 0.12))
				.slice(0, 5)
				.map((x) => {
					const w = windowCeiling(windowBytes, (overRtt ? x : rtt) / 1000);
					const l = lossCeiling(mss, (overRtt ? x : rtt) / 1000, (overRtt ? loss : x) / 100);
					const lower = Math.min(w, l);
					return [
						{ text: overRtt ? `${fixed(x, 1)} ms` : `${fixed(x, 2)}%`, mono: true },
						{ text: bitrate(w), mono: true },
						{ text: bitrate(l), mono: true },
						/*
						 * ⚠️ The assertion goes on each branch, not on the conditional. `as const` on a ternary is
						 * TS1355: it only applies to a literal, and the error names the assertion rather than the
						 * shape, so it reads like the tone value is wrong when the placement is.
						 */
						{ text: bitrate(lower), mono: true, tone: l < w ? ("warn" as const) : ("good" as const) },
					];
				});

			const parts: Output[] = [
				{ kind: "fields", fields },
				{
					kind: "series",
					chart: {
						xLabel: overRtt ? "Round-trip time" : "Packet loss",
						xUnit: overRtt ? "ms" : "%",
						yLabel: "Throughput ceiling",
						yUnit: "Mbit/s",
						x: xs,
						series: [windowSeries, lossSeries],
						annotations: [
							{
								x: overRtt ? rtt : loss,
								label: overRtt ? `${fixed(rtt, 0)} ms` : `${fixed(loss, 2)}%`,
							},
						],
					},
				},
				{
					kind: "table",
					caption: "Either side of the current value, because the shape near it is what decides the fix",
					columns: [
						{ label: overRtt ? "RTT" : "Loss", mono: true },
						{ label: "Window allows", align: "end", mono: true },
						{ label: "Loss allows", align: "end", mono: true },
						{ label: "Ceiling", align: "end", mono: true },
					],
					rows,
				},
			];

			return { kind: "group", parts };
		} catch (error) {
			if (error instanceof InputError) return { kind: "error", message: error.message, input: error.input };
			throw error;
		}
	},
} satisfies Tool<Input>;
