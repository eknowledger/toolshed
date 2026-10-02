/**
 * Jitter, loss and the ways a receiver covers for them, over a few seconds of one voice stream.
 *
 * A frame leaves every 20 ms and must play at a fixed time: when it was sent, plus the one-way delay, plus the
 * jitter buffer. Each packet's trip gets a random extra delay on top of the fixed one, so some arrive after
 * their time and are as good as lost. Some are lost outright, at random or in bursts. What the listener hears
 * for each frame is one of three things:
 *
 *  - **played**: the packet itself arrived in time;
 *  - **recovered**: it did not, but a later packet carrying a copy of it did, in time for this frame's slot;
 *  - **concealed**: neither, so the decoder makes up 20 ms from the audio before.
 *
 * The copy comes from one of two schemes. **Opus in-band FEC** (RFC 7587 section 3.3) puts a lower-bitrate
 * re-encoding of frame n-1 inside packet n, so it reaches back one packet. **RED** (RFC 2198) carries whole
 * earlier frames as redundant blocks, here one or two of them, so it can bridge a burst of two.
 *
 * ⚠️ What it assumes, so the numbers are read as a model and not a measurement:
 *
 *  - every packet carries an FEC copy. Real Opus only re-encodes frames it judges important, so this is the
 *    best FEC can do, not what it does;
 *  - the extra delay per packet is exponential with the mean given, independent from packet to packet. Real
 *    queues correlate, which makes late packets bunch together, much like bursts of loss;
 *  - bursts follow a two-state Gilbert model: once in the lossy state, each next packet stays lost with
 *    probability 1 - 1/burst, so bursts average the length given;
 *  - the buffer is fixed. An adaptive one, as libwebrtc's is, would move it with the jitter it measures.
 *
 * Seeded, so the same inputs always give the same run, and a different seed is a different few seconds.
 */
import type { Field, Output, Series, Tool } from "@toolbench/sdk";

type Input = { delay: number; jitter: number; buffer: number; loss: number; burst: number; protection: string; packets: number; seed: number };

class InputError extends Error {
	readonly input: string;

	constructor(message: string, input: string) {
		super(message);
		this.name = "InputError";
		this.input = input;
	}
}

const FRAME_MS = 20;

/**
 * The arrivals chart shows the first five seconds; the numbers come from the whole run. A minute of packets is
 * what makes a percentage of a few percent settle: over five seconds one burst more or less moves it by half.
 */
const PLOTTED = 250;

/** How far back each scheme's copies reach: Opus FEC carries one earlier frame, RED as many as it is set to. */
const SCHEMES: { id: string; label: string; reach: number; cost: string }[] = [
	{ id: "none", label: "None", reach: 0, cost: "nothing extra sent" },
	/*
	 * Opus FEC and one RED copy reach back the same one packet, so they recover the same frames here. They
	 * differ in what the copy is and what it costs, which the readout says rather than the bars.
	 */
	{ id: "fec", label: "Opus FEC", reach: 1, cost: "a lower-bitrate copy, paid for inside the Opus bitrate" },
	{ id: "red1", label: "RED, 1 copy", reach: 1, cost: "a full copy, so about twice the audio bitrate" },
	{ id: "red2", label: "RED, 2 copies", reach: 2, cost: "two full copies, about three times the audio bitrate" },
];

/** Mulberry32: small, fast, and the same sequence in every JavaScript engine for the same seed. */
function random(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

type Packet = { sent: number; arrives: number | null };

/**
 * One run's packets: their send times, and when each arrives or that it never does. Delays and losses are drawn
 * once, so changing the buffer or the protection replays the same network rather than a new one.
 */
function network(input: Input): Packet[] {
	const next = random(input.seed);
	const loss = input.loss / 100;
	// Gilbert: leave the lossy state with probability 1/burst, enter it at the rate that gives the loss rate asked.
	const leave = 1 / input.burst;
	const enter = loss >= 1 ? 1 : (leave * loss) / (1 - loss);
	let lossy = next() < loss;
	const out: Packet[] = [];
	for (let n = 1; n <= input.packets; n++) {
		if (n > 1) lossy = lossy ? next() >= leave : next() < enter;
		const extra = -input.jitter * Math.log(1 - next());
		const sent = n * FRAME_MS;
		out.push({ sent, arrives: lossy ? null : Math.round((sent + input.delay + extra) * 10) / 10 });
	}
	return out;
}

type Outcome = "played" | "recovered" | "concealed";

/** What the listener gets for each frame, given the buffer and how far back the copies reach. */
function outcomes(packets: Packet[], delay: number, buffer: number, reach: number): Outcome[] {
	return packets.map((p, i) => {
		const deadline = p.sent + delay + buffer;
		if (p.arrives !== null && p.arrives <= deadline) return "played";
		for (let k = 1; k <= reach; k++) {
			const later = packets[i + k];
			if (later?.arrives !== null && later?.arrives !== undefined && later.arrives <= deadline) return "recovered";
		}
		return "concealed";
	});
}

const pct = (count: number, of: number) => Math.round((count / of) * 1000) / 10;
const count = (list: Outcome[], what: Outcome) => list.filter((o) => o === what).length;

/**
 * Shares to one decimal that always add up, so every scheme's bar on one network has the same height, which is
 * the point of drawing them side by side. Concealed is rounded from its own count and recovered takes the
 * remainder, not the other way round: concealment is what the buffer chart plots, and rounding it second let
 * a deeper buffer appear to conceal 0.1% more.
 */
function shares(list: Outcome[]): { played: number; recovered: number; concealed: number } {
	const missed = pct(list.length - count(list, "played"), list.length);
	const concealed = pct(count(list, "concealed"), list.length);
	return { played: Math.round((100 - missed) * 10) / 10, recovered: Math.round((missed - concealed) * 10) / 10, concealed };
}

/** The longest run of concealed frames, which is what a listener notices: one 20 ms gap is a click, ten are a dropout. */
function longestGap(list: Outcome[]): number {
	let longest = 0;
	let run = 0;
	for (const o of list) {
		run = o === "concealed" ? run + 1 : 0;
		longest = Math.max(longest, run);
	}
	return longest;
}

export default {
	run(input: Input) {
		try {
			const { delay, jitter, buffer, loss, burst, packets: total, seed } = input;
			if (!(delay >= 0)) throw new InputError("One-way delay cannot be negative.", "delay");
			if (!(jitter >= 0)) throw new InputError("Jitter cannot be negative.", "jitter");
			if (!(buffer >= 0)) throw new InputError("The jitter buffer cannot be negative.", "buffer");
			if (!(loss >= 0 && loss < 100)) throw new InputError("Loss must be at least 0% and below 100%.", "loss");
			if (!(burst >= 1)) throw new InputError("Bursts average at least one packet: 1 means losses are independent.", "burst");
			if (!(Number.isInteger(total) && total >= 10 && total <= 6000)) throw new InputError("Packets must be a whole number from 10 to 6,000.", "packets");
			if (!Number.isInteger(seed)) throw new InputError("The seed must be a whole number.", "seed");
			const scheme = SCHEMES.find((s) => s.id === input.protection);
			if (!scheme) throw new InputError(`Protection must be one of ${SCHEMES.map((s) => s.id).join(", ")}.`, "protection");

			const packets = network(input);
			const here = outcomes(packets, delay, buffer, scheme.reach);
			const lost = packets.filter((p) => p.arrives === null).length;
			const late = packets.filter((p) => p.arrives !== null && p.arrives > p.sent + delay + buffer).length;
			const played = count(here, "played");
			const recovered = count(here, "recovered");
			const concealed = count(here, "concealed");
			const gap = longestGap(here);

			const share = shares(here);
			const fields: Field[] = [
				{ label: "Played on time", value: `${share.played}%`, note: `${played} of ${total} frames` },
				{
					label: "Concealed",
					value: `${share.concealed}%`,
					note: `${concealed} frames, ${concealed * FRAME_MS} ms of made-up audio`,
					tone: share.concealed >= 5 ? "bad" : share.concealed >= 1 ? "warn" : "normal",
				},
				{
					label: `Recovered by ${scheme.id === "none" ? "a copy" : scheme.label}`,
					value: scheme.id === "none" ? "nothing to recover from" : `${share.recovered}%`,
					note: scheme.id === "none" ? "no copies are sent" : `${recovered} frames that would otherwise be concealed`,
				},
				{ label: "Longest gap", value: `${gap * FRAME_MS} ms`, note: gap > 1 ? `${gap} frames in a row concealed` : gap === 1 ? "single frames only" : "none" },
				{ label: "What the network did", value: `${pct(lost, total)}% lost, ${pct(late, total)}% late`, note: `late means after ${delay + buffer} ms, the one-way delay plus the buffer` },
				{ label: "Delay the buffer adds", value: `${buffer} ms`, note: "to every frame, whether it needed it or not" },
			];

			/*
			 * What Alice hears: the first five seconds as she gets them, one dot per 20 ms frame, a row per second.
			 * Three outcomes are three categories, not three amounts, so they are three point series, each with its
			 * own colour, marker and legend entry, rather than a heatmap whose key would show them as 0, 1 and 2.
			 */
			const perSecond = 1000 / FRAME_MS;
			const label: Record<Outcome, string> = { played: "Played", recovered: "Rebuilt from a copy", concealed: "Made up by the decoder" };
			// Made-up frames first, so the problem takes the strongest colour and the ordinary frames the quietest.
			const hears = (["concealed", "recovered", "played"] as Outcome[]).map((kind): Series => {
				const at = here.slice(0, PLOTTED).flatMap((o, i) => (o === kind ? [i] : []));
				return {
					label: label[kind],
					shape: "points",
					x: at.map((i) => (i % perSecond) + 1),
					points: at.map((i) => Math.floor(i / perSecond) + 1),
					notes: at.map((i) => `frame ${i + 1}, at ${((i * FRAME_MS) / 1000).toFixed(2)} s: ${label[kind].toLowerCase()}`),
				};
			});
			const strip: Output = {
				kind: "series",
				chart: {
					xLabel: "Frame within the second",
					yLabel: "Second",
					x: [],
					series: hears,
					readout: { mode: "point" },
				},
			};

			/*
			 * C: every packet's trip against the time it had. Two point series, on time and too late, so the colour
			 * and the legend both say which side of the rule a packet fell; lost packets have no trip to plot.
			 */
			const shown = packets.slice(0, PLOTTED);
			const numbers = shown.map((_, i) => i + 1);
			const trip = (p: Packet) => (p.arrives === null ? null : Math.round((p.arrives - p.sent) * 10) / 10);
			const onTime = shown.map((p) => (p.arrives !== null && p.arrives <= p.sent + delay + buffer ? trip(p) : null));
			const tooLate = shown.map((p) => (p.arrives !== null && p.arrives > p.sent + delay + buffer ? trip(p) : null));
			const arrivals: Output = {
				kind: "series",
				chart: {
					xLabel: total > PLOTTED ? `Packet, the first ${PLOTTED} of ${total}` : "Packet",
					yLabel: "Trip",
					yUnit: "ms",
					x: numbers,
					series: [
						{ label: "On time", unit: "ms", shape: "points", points: onTime },
						{ label: "Too late", unit: "ms", shape: "points", points: tooLate },
					],
					thresholds: [{ y: delay + buffer, label: `plays at ${delay + buffer} ms`, tone: "warn" }],
					readout: { mode: "point" },
				},
			};

			/*
			 * D: the buffer's trade, over the same packets. More buffer catches more late packets and adds that much
			 * delay to every frame. Two lines: what arrives too late, and what is still concealed after the copies.
			 */
			const depths = Array.from({ length: 21 }, (_, i) => i * 10);
			const lateAt = depths.map((b) => pct(packets.filter((p) => p.arrives !== null && p.arrives > p.sent + delay + b).length, total));
			const concealedAt = depths.map((b) => shares(outcomes(packets, delay, b, scheme.reach)).concealed);
			const trade: Output = {
				kind: "series",
				chart: {
					xLabel: "Jitter buffer",
					xUnit: "ms",
					yLabel: "Frames",
					yUnit: "%",
					x: depths,
					/*
					 * Log, because the trade spans orders of magnitude: with no buffer nearly every packet is late,
					 * and the decisions are made down where it is a few percent or less. A share of zero cannot sit on
					 * a log axis; the runtime leaves those points out and the data table says so.
					 */
					yScale: "log",
					series: [
						{ label: "Arrive too late", unit: "%", shape: "line", markers: true, points: lateAt },
						{ label: scheme.id === "none" ? "Concealed" : `Concealed, with ${scheme.label}`, unit: "%", shape: "line", markers: true, points: concealedAt },
					],
					annotations: depths.includes(buffer) ? [{ x: buffer, label: "this run" }] : [],
				},
			};

			/*
			 * E: what each scheme buys on this run's network, at this buffer. Only the frames that did not arrive in
			 * time, split into recovered and concealed, so the bars are the size of the problem and not 95% "played".
			 */
			const byScheme = SCHEMES.map((s) => outcomes(packets, delay, buffer, s.reach));
			const schemes: Output = {
				kind: "series",
				chart: {
					xLabel: "Protection",
					yLabel: "Frames that missed their slot",
					yUnit: "%",
					x: SCHEMES.map((s) => (s.id === scheme.id ? `${s.label} (this run)` : s.label)),
					series: [
						{ label: "Recovered from a copy", unit: "%", shape: "bar", stack: "missed", points: byScheme.map((o) => shares(o).recovered) },
						{ label: "Concealed", unit: "%", shape: "bar", stack: "missed", points: byScheme.map((o) => shares(o).concealed) },
					] satisfies Series[],
					readout: { titles: SCHEMES.map((s, i) => `${s.label}: ${s.cost}; longest gap ${longestGap(byScheme[i] ?? []) * FRAME_MS} ms`) },
				},
			};

			return { kind: "group", parts: [{ kind: "fields", fields }, strip, arrivals, trade, schemes] };
		} catch (error) {
			if (error instanceof InputError) return { kind: "error", message: error.message, input: error.input };
			throw error;
		}
	},
} satisfies Tool<Input>;
