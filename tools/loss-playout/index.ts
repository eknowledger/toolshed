/**
 * One lost voice frame, over UDP and over TCP.
 *
 * A voice call sends a small frame every 20 ms, and the receiver plays each one at a fixed time: when it was
 * sent, plus the trip, plus a jitter buffer. A frame that is not there by then is useless, however correct it
 * is when it finally turns up. So the question for a lost frame is not whether it is recovered but which
 * frames still make their playout deadline, and that is where the two transports differ.
 *
 * **UDP** loses the frame and carries on. The decoder conceals one frame's worth of audio and every later
 * frame plays on time. The cost of one loss is one frame.
 *
 * **TCP** recovers the frame, and delivers in order: nothing after the gap reaches the application until the
 * resent copy does. Every frame queued behind it is held and then released at once, and each one whose
 * deadline passed while it waited is as lost to the listener as if the network had dropped it. The cost of
 * one loss is every frame whose deadline falls before the repair, which is the point of the tool.
 *
 * Two ways the resend happens:
 *
 *  - **Fast retransmit** (RFC 5681 section 3.2): each frame after the gap draws a duplicate ACK, and the third
 *    one triggers the resend. That needs three frames to follow the loss, so it cannot fire near the end of a
 *    talk spurt.
 *  - **The retransmission timer** (RFC 6298): with nothing to draw duplicate ACKs, the sender waits out the
 *    timer. 200 ms is Linux's default minimum; the RFC recommends 1 s.
 *
 * ⚠️ Where this stops being true: no jitter, one loss, no congestion window effects, no RACK (which current
 * Linux uses and which can resend sooner than three duplicate ACKs), and the timer is started from the lost
 * frame's own send time rather than restarted by later ACKs. Each of those would make the TCP numbers worse
 * or better by a few frames, not change which transport a live voice stream wants.
 */
import type { Cell, Field, Output, Series, Tool } from "@toolbench/sdk";

type Input = { frame: string; delay: number; buffer: number; lost: number; rto: number; frames: number };

/** Named so the error path can say which input was wrong rather than "invalid input". */
class InputError extends Error {
	readonly input: string;

	constructor(message: string, input: string) {
		super(message);
		this.name = "InputError";
		this.input = input;
	}
}

/** Codec frame sizes in common use: Opus runs 10 to 60, G.711 over RTP is usually 20. */
const FRAME_SIZES = [10, 20, 40, 60];

/** Duplicate ACKs that trigger a resend without waiting for the timer, per RFC 5681. */
const DUP_ACKS = 3;

/** Frame number to the time the application gets it, or null when it never does. */
type Delivery = (number | null)[];

type Transport = {
	label: string;
	delivered: Delivery;
	missed: number[];
	/** When the resent copy reaches the receiver and releases the queue. Absent for UDP, which never resends. */
	repaired?: number;
};

/** "5", "19 and 20", "5 to 12", joined when a run breaks, so the note reads the way a person would say it. */
function frameList(frames: number[]): string {
	const runs: [number, number][] = [];
	for (const n of frames) {
		const last = runs.at(-1);
		if (last && n === last[1] + 1) last[1] = n;
		else runs.push([n, n]);
	}
	return runs
		.map(([a, b]) => (a === b ? `${a}` : b === a + 1 ? `${a} and ${b}` : `${a} to ${b}`))
		.join(", ");
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

export default {
	run(input: Input) {
		try {
			const frameMs = Number(input.frame);
			const { delay: oneWay, buffer, lost, rto, frames } = input;

			if (!FRAME_SIZES.includes(frameMs)) throw new InputError(`Frame size must be one of ${FRAME_SIZES.join(", ")} ms.`, "frame");
			if (!(oneWay >= 0)) throw new InputError("One-way delay cannot be negative.", "delay");
			if (!(buffer >= 0)) throw new InputError("Jitter buffer cannot be negative.", "buffer");
			if (!(Number.isInteger(frames) && frames >= 1)) throw new InputError("Frames must be a whole number, at least 1.", "frames");
			if (!(Number.isInteger(lost) && lost >= 1)) throw new InputError("The lost frame must be a whole frame number, at least 1.", "lost");
			if (lost > frames) throw new InputError(`Frame ${lost} is never sent: the run has ${frames} frames.`, "lost");
			/*
			 * A timer shorter than the round trip fires before any acknowledgement could have come back, so it
			 * would resend frames that were never lost. Real TCP cannot get there: RFC 6298 builds the timer from
			 * the measured round trip, so it is always at least that long.
			 */
			if (!(rto >= 2 * oneWay)) {
				throw new InputError(
					`A retransmission timer shorter than the round trip fires before any ACK could return: at ${oneWay} ms each way it must be at least ${2 * oneWay} ms.`,
					"rto",
				);
			}

			const numbers = Array.from({ length: frames }, (_, i) => i + 1);
			const sent = (n: number) => n * frameMs;
			const arrives = (n: number) => sent(n) + oneWay;
			const deadline = (n: number) => sent(n) + oneWay + buffer;
			const missedIn = (delivered: Delivery) =>
				numbers.filter((n) => {
					const t = delivered[n - 1];
					return t === null || t === undefined || t > deadline(n);
				});

			/*
			 * In-order delivery is the whole mechanism: a frame after the gap can arrive in time and still be held,
			 * because the application only ever sees the stream up to the first hole. So each later frame goes up
			 * at whichever is later, its own arrival or the repair.
			 */
			const tcp = (label: string, resendAt: number): Transport => {
				const repaired = resendAt + oneWay;
				const delivered = numbers.map((n) => (n < lost ? arrives(n) : Math.max(arrives(n), repaired)));
				return { label, delivered, missed: missedIn(delivered), repaired };
			};

			const udpDelivered = numbers.map((n) => (n === lost ? null : arrives(n)));
			const udp: Transport = { label: "UDP", delivered: udpDelivered, missed: missedIn(udpDelivered) };

			const timerAt = sent(lost) + rto;
			const canFastRetransmit = lost + DUP_ACKS <= frames;
			// The third frame after the gap arrives, and its duplicate ACK spends one more trip getting back.
			const thirdDupAck = canFastRetransmit ? sent(lost + DUP_ACKS) + 2 * oneWay : null;
			/*
			 * The timer is running whether or not duplicate ACKs come, so the resend is whichever fires first. With
			 * 60 ms frames the third duplicate ACK can be slower than a 200 ms timer, and showing it as the later
			 * of the two would describe a sender that does not exist.
			 */
			const fastAt = thirdDupAck === null ? timerAt : Math.min(thirdDupAck, timerAt);
			const fast = tcp("TCP, fast retransmit", fastAt);
			const timeout = tcp(`TCP, ${rto} ms timeout`, timerAt);
			const transports = [udp, fast, timeout];

			const headline = (t: Transport): Field => {
				const count = t.missed.length;
				if (count === 0) {
					return {
						label: t.label,
						value: "nothing concealed",
						note: `the resend arrived at ${t.repaired} ms, in time for frame ${lost}`,
						tone: "good",
					};
				}
				const which = `${plural(count, "frame")}: ${frameList(t.missed)}`;
				return {
					label: t.label,
					value: `${count * frameMs} ms concealed`,
					note: t.repaired === undefined ? `${which}, never delivered` : `${which}, released at ${t.repaired} ms`,
					tone: count > 1 ? "warn" : "normal",
				};
			};

			let fastNote: string;
			if (thirdDupAck === null) {
				const after = frames - lost;
				const follow = after === 0 ? "no frame follows" : `only ${plural(after, "frame")} ${after === 1 ? "follows" : "follow"}`;
				fastNote = `cannot fire: ${follow} the loss and ${DUP_ACKS} are needed, so the timer resends`;
			} else if (thirdDupAck > timerAt) {
				fastNote = `the timer fires first: the third duplicate ACK would reach the sender at ${thirdDupAck} ms`;
			} else {
				fastNote = `the third duplicate ACK, drawn by frame ${lost + DUP_ACKS}, reaches the sender`;
			}

			const fields: Field[] = [
				...transports.map(headline),
				{
					label: `Frame ${lost} plays at`,
					value: `${deadline(lost)} ms`,
					note: `sent at ${sent(lost)}, arrives at ${arrives(lost)}, then ${buffer} ms of buffer`,
				},
				{ label: "Fast retransmit resends at", value: `${fastAt} ms`, note: fastNote },
				{ label: "Timeout resends at", value: `${timerAt} ms`, note: `${rto} ms after frame ${lost} was sent` },
			];

			/*
			 * Delivery time against frame number, beside the deadline. A frame plays when its point is on or below
			 * the deadline line. The TCP lines run flat from the loss to where they meet their own arrival times
			 * again: that flat stretch is the queue being held, and everything on it above the deadline is audio
			 * the listener never hears.
			 */
			const line = (label: string, points: (number | null)[]): Series => ({ label, unit: "ms", shape: "line", points });
			const chart = {
				/*
				 * Linked to the per-frame table below, both ways: pointing at a frame lights its row, and pointing
				 * at a row moves the readout to that frame. The chart's own data table lights too, once opened.
				 */
				id: "playout",
				readout: { highlightTable: true },
				xLabel: "Frame",
				yLabel: "Time",
				yUnit: "ms",
				x: numbers,
				/*
				 * Markers on the transports, not on the deadline: frames are separate events, so each delivery is
				 * a point and the line through them only guides the eye. The markers also keep UDP findable on
				 * frames 1 to 4, where all three transports deliver at the same moment and their lines coincide.
				 * The deadline is a rule, a line is exactly what it is.
				 */
				series: [line("Playout deadline", numbers.map(deadline)), ...transports.map((t) => ({ ...line(t.label, t.delivered), markers: true }))],
				annotations: [{ x: lost, label: `frame ${lost} lost` }],
			};

			const cell = (n: number, t: number | null | undefined): Cell => {
				if (t === null || t === undefined) return { text: "lost", mono: true, tone: "bad" };
				return t > deadline(n) ? { text: `${t} ms, late`, mono: true, tone: "warn" } : { text: `${t} ms, on time`, mono: true };
			};
			const rows: Cell[][] = numbers.map((n) => [n, sent(n), deadline(n), ...transports.map((t) => cell(n, t.delivered[n - 1]))]);

			const parts: Output[] = [
				{ kind: "fields", fields },
				{ kind: "series", chart },
				{
					kind: "table",
					caption: "Every frame: when the application gets it, against when it has to play",
					columns: [
						{ label: "Frame", align: "end", mono: true },
						{ label: "Sent (ms)", align: "end", mono: true },
						{ label: "Play by (ms)", align: "end", mono: true },
						...transports.map((t) => ({ label: t.label, align: "end" as const, mono: true })),
					],
					rows,
					link: { chart: "playout", keys: numbers },
				},
			];

			return { kind: "group", parts };
		} catch (error) {
			if (error instanceof InputError) return { kind: "error", message: error.message, input: error.input };
			throw error;
		}
	},
} satisfies Tool<Input>;
