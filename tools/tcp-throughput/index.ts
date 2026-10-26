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
import type { Field, Output, Series, Tool } from "@toolbench/sdk";

type Input = { mss: number; rtt: number; loss: number; window: number; link: number; sweep: string };

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

/** A share of the link, with as many places as it takes to say something other than 0%. */
function share(fraction: number): string {
	const pct = fraction * 100;
	if (pct >= 10) return `${pct.toFixed(0)}%`;
	if (pct >= 1) return `${pct.toFixed(1)}%`;
	return `${pct.toPrecision(2)}%`;
}

/** Loss in percent, to two significant figures and never in exponent form, which a reader cannot type back in. */
function lossText(pct: number): string {
	if (pct >= 1) return `${pct.toFixed(1)}%`;
	const places = Math.min(20, 1 - Math.floor(Math.log10(pct)));
	return `${pct.toFixed(places)}%`;
}

/** "one packet in 19,500" or "in 310 million": two significant figures, because the loss it stands for has two. */
function oneIn(pct: number): string {
	const n = 100 / pct;
	if (n >= 1e9) return `${Number((n / 1e9).toPrecision(2))} billion`;
	if (n >= 1e6) return `${Number((n / 1e6).toPrecision(2))} million`;
	return Number(n.toPrecision(2)).toLocaleString("en-US");
}

export default {
	run(input: Input) {
		try {
			const { mss, rtt, loss, window, link, sweep } = input;

			if (!(mss > 0)) throw new InputError("Segment size must be greater than zero.", "mss");
			if (!(rtt > 0)) throw new InputError("Round-trip time must be greater than zero.", "rtt");
			if (!(loss >= 0 && loss < 100)) throw new InputError("Loss must be from 0 up to but not including 100 percent.", "loss");
			if (!(window > 0)) throw new InputError("Receive window must be greater than zero.", "window");
			if (!(link > 0)) throw new InputError("Link speed must be greater than zero.", "link");

			const rttSeconds = rtt / 1000;
			const windowBytes = window * 1024;
			const lossFraction = loss / 100;

			const fromWindow = windowCeiling(windowBytes, rttSeconds);
			const fromLoss = lossCeiling(mss, rttSeconds, lossFraction);
			const ceiling = Math.min(fromWindow, fromLoss);
			const binding = fromLoss < fromWindow ? "loss" : "window";

			/*
			 * The link is not a third ceiling of the connection: it is what the reader paid for. It sits in the same table
			 * because the question is which of the three a transfer meets first, and the answer is read down one column.
			 * On a tie the link goes first, since a connection that can reach the link speed fills it.
			 */
			const linkBits = link * 1e6;
			const fills = ceiling >= linkBits;
			type Limit = { id: "loss" | "window" | "link"; name: string; bits: number };
			const order = { link: 0, [binding]: 1 } as Record<string, number>;
			const limits: Limit[] = [
				{ id: "loss" as const, name: "Packet loss", bits: fromLoss },
				{ id: "window" as const, name: "Receive window", bits: fromWindow },
				{ id: "link" as const, name: "Link", bits: linkBits },
			].sort((a, b) => a.bits - b.bits || (order[a.id] ?? 2) - (order[b.id] ?? 2));
			/* Past the link, the limit after it is no limit at all: nothing a connection does can beat the link. */
			const status = fills ? ["Sets the limit", "", ""] : ["Sets the limit", "Next", ""];

			/*
			 * What fixing a limit buys, solved from the same formulas: the window that reaches a rate is its
			 * bandwidth-delay product, and the loss that reaches it is Mathis solved for p, `(MSS x 8 x C / (RTT x rate))^2`.
			 *
			 * ⚠️ Each fix is sized to the NEXT limit, not to the link. Fixing loss on the defaults buys 6.55 Mbit/s, not a
			 * gigabit, because the 64 KB window binds a whisker above where loss did; an earlier version listed "fix the
			 * loss" and "raise the window" as separate rows and buried that.
			 */
			const lossFor = (bits: number) => ((mss * 8 * MATHIS_C) / (rttSeconds * bits)) ** 2 * 100;
			const windowFor = (bits: number) => (bits * rttSeconds) / 8;
			const fix = (l: Limit, bits: number) =>
				l.id === "loss" ? `Cut loss below ${lossText(lossFor(bits))}` : `Raise the window to ${bytes(windowFor(bits))}`;
			const changes: Field[] = [];
			if (!fills) {
				const [first, second] = limits as [Limit, Limit, Limit];
				if (second.id === "link") {
					changes.push({ label: fix(first, linkBits), value: bitrate(linkBits), note: "Then the link is the limit." });
				} else {
					changes.push({
						label: fix(first, second.bits),
						value: bitrate(second.bits),
						note: `Then the ${second.id === "loss" ? "packet loss" : "receive window"} is the limit.`,
					});
					const lossForLink = lossFor(linkBits);
					changes.push({
						label: "To fill the link",
						value: bitrate(linkBits),
						note: `A window of at least ${bytes(windowFor(linkBits))}, and loss below ${lossText(lossForLink)}, about one packet in ${oneIn(lossForLink)}.`,
					});
				}
			}

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

			const method = "How this was worked out";
			const parts: Output[] = [
				/*
				 * ⚠️ The answer is the table's caption, so the first part is both the sentence and its evidence. A card
				 * shows the first part, and "5.65 Mbit/s" without the 6.55 beside it hides that fixing loss alone barely
				 * helps. No tone: a model ceiling in red reads like a measured incident.
				 */
				{
					kind: "table",
					role: "comparison",
					caption: fills
						? `One connection can fill the ${bitrate(linkBits)} link`
						: `One connection tops out at ${bitrate(ceiling)}, ${share(ceiling / linkBits)} of the link`,
					columns: [
						{ label: "Limit", wrap: "prose", rowHeader: true },
						{ label: "Ceiling", align: "end", mono: true, wrap: "none" },
						{ label: "Status", wrap: "prose" },
					],
					rows: limits.map((l, i) => [l.name, { text: bitrate(l.bits), mono: true }, status[i] ?? ""]),
				},
				...(changes.length ? [{ kind: "fields" as const, role: "answer", fields: changes }] : []),
				{
					kind: "series",
					chart: {
						xLabel: overRtt ? "Round-trip time" : "Packet loss",
						xUnit: overRtt ? "ms" : "%",
						yLabel: "Throughput ceiling",
						yUnit: "Mbit/s",
						x: xs,
						series: [windowSeries, lossSeries],
						/*
						 * Log, because the two ceilings are often orders of magnitude apart: on a linear axis a 134 Mbit/s
						 * window line flattened a 0.8 Mbit/s loss line onto zero, and the binding one was the invisible one.
						 */
						yScale: "log",
						thresholds: [{ y: link, label: `Link, ${bitrate(linkBits)}` }],
						annotations: [
							{
								x: overRtt ? rtt : loss,
								label: overRtt ? `${fixed(rtt, 0)} ms` : `${fixed(loss, 2)}%`,
							},
						],
					},
				},
				{
					kind: "fields",
					role: "method",
					fields: [
						{
							group: method,
							label: "Receive window",
							value: `${bytes(windowBytes)} per ${rtt} ms round trip`,
							note: "One window in flight, then a full round trip waiting for its acknowledgement: window / RTT.",
						},
						{
							group: method,
							label: "Packet loss",
							value: `${loss}% with ${mss} B segments`,
							note:
								loss === 0
									? "With no loss, nothing tells the sender to slow down, so the window is the only limit."
									: "MSS x 1.22 / (RTT x sqrt(loss)), Mathis et al.: a Reno-style sender that halves its window on every loss. CUBIC and BBR do better on long paths.",
						},
					],
				},
			];
			return { kind: "group", parts };
		} catch (error) {
			if (error instanceof InputError) return { kind: "error", message: error.message, input: error.input };
			throw error;
		}
	},
} satisfies Tool<Input>;
