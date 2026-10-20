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
 * Seeded, so the same inputs always give the same run, and a different seed is a different few seconds. That is
 * also what makes the advice honest: every change it suggests is the same minute of network replayed with that change.
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

/**
 * The line the advice aims at, as a share of frames the decoder makes up. The tool's own choice, not a standard,
 * which is why it is drawn on the buffer chart and never used to colour a result.
 */
const CLEAN = 1;

/** How far back each scheme's copies reach: Opus FEC carries one earlier frame, RED as many as it is set to. */
const SCHEMES: { id: string; label: string; reach: number; cost: string }[] = [
	{ id: "none", label: "None", reach: 0, cost: "nothing extra sent" },
	/*
	 * Opus FEC and one RED copy reach back the same one packet, so they recover the same frames here. They
	 * differ in what the copy is and what it costs, which the protection table says in words.
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

/** A stretch of audio: "400 ms", "9.1 s". */
const span = (ms: number) => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10} s`);

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
			const playsAt = delay + buffer;

			/*
			 * The buffer sweep, done once and read three times: by the advice, by the chart, and by the annotation. In
			 * steps of 10 ms from 0 to 200, or further when the run's own buffer is deeper, with the run's own depth
			 * added when it is not a multiple of 10, so "this run" is always a point on the line.
			 */
			const top = Math.max(200, Math.ceil(buffer / 10) * 10);
			const depths = [...new Set([...Array.from({ length: top / 10 + 1 }, (_, i) => i * 10), buffer])].sort((x, y) => x - y);
			const concealedAt = depths.map((b) => shares(outcomes(packets, delay, b, scheme.reach)).concealed);
			const enough = depths.find((_, i) => (concealedAt[i] ?? 100) < CLEAN);

			/*
			 * The answer: how much was made up, the longest stretch of it, and what the buffer costs every frame. No tone,
			 * because the only line it could be judged against is one this tool chose, and the buffer chart draws that.
			 */
			const answer: Output = {
				kind: "fields",
				role: "answer",
				fields: [
					{
						label: "Concealed",
						value: `${share.concealed}%`,
						note: concealed === 0 ? `Nothing made up in ${span(total * FRAME_MS)}` : `${span(concealed * FRAME_MS)} made up in ${span(total * FRAME_MS)}`,
					},
					{
						label: "Longest gap",
						value: `${gap * FRAME_MS} ms`,
						note: gap > 1 ? `${gap} frames in a row were made up.` : gap === 1 ? "Only single frames were made up." : "No frame was made up.",
					},
					{
						label: "Playout delay",
						value: `${playsAt} ms`,
						note: buffer === 0 ? "No buffer: all of it is the trip" : `${buffer} ms of it is the buffer`,
					},
				],
			};

			/*
			 * What to change, from the same network replayed: the shallowest buffer that brings made-up audio under 1%
			 * with this protection, and every other protection that would make up less at this buffer. Each row is a
			 * replay, not a rule of thumb, and they are sorted by what they leave made up, least first.
			 */
			type Advice = { change: string; after: number; delay: string; cost: string };
			const advice: Advice[] = [];
			const costOf = (s: (typeof SCHEMES)[number]) => `${s.cost.charAt(0).toUpperCase()}${s.cost.slice(1)}.`;
			const shift = (to: number) =>
				to > buffer ? `${to - buffer} ms more on every frame` : to < buffer ? `${buffer - to} ms less on every frame` : "No change";
			for (const other of SCHEMES) {
				const same = other.id === scheme.id;
				const sweep = same ? concealedAt : depths.map((b) => shares(outcomes(packets, delay, b, other.reach)).concealed);
				// The shallowest buffer that gets this protection under 1%, and what it does at this run's buffer.
				const at = depths.findIndex((_, i) => (sweep[i] ?? 100) < CLEAN);
				const here = sweep[depths.indexOf(buffer)] ?? 100;
				const to = at === -1 ? undefined : depths[at];
				if (to !== undefined && to !== buffer && (to > buffer ? share.concealed >= CLEAN : true)) {
					const move = to > buffer ? `Raise the buffer to ${to} ms` : `Lower the buffer to ${to} ms`;
					advice.push({
						change: same ? move : `${move} and switch to ${other.label}`,
						after: sweep[at] ?? 0,
						delay: shift(to),
						cost: same ? (to < buffer ? "Nothing extra sent, and the conversation is quicker." : "Nothing extra sent.") : costOf(other),
					});
				}
				if (!same && here < share.concealed && (to === undefined || to >= buffer)) {
					advice.push({ change: `Switch to ${other.label}`, after: here, delay: "No change", cost: costOf(other) });
				}
			}
			/*
			 * Opus FEC and one RED copy reach back the same packet, so at the same buffer they rebuild the same frames.
			 * SCHEMES is in order of cost, so keeping the first of two rows with the same delay and the same result keeps
			 * the cheaper one, and the table never recommends paying twice the bitrate for nothing.
			 */
			const seen = new Set<string>();
			const distinct = advice.filter((x) => {
				const key = `${x.delay}|${x.after}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
			distinct.sort((x, y) => x.after - y.after);
			/*
			 * When nothing reaches 1%, the reader still needs to know how far the settings can go: the least made-up audio
			 * any protection reaches at any buffer swept, cheapest and shallowest first among equals.
			 */
			if (distinct.length === 0 && share.concealed >= CLEAN) {
				let best = { after: share.concealed, depth: buffer, at: scheme };
				for (const other of SCHEMES) {
					for (const b of depths) {
						const after = shares(outcomes(packets, delay, b, other.reach)).concealed;
						if (after < best.after) best = { after, depth: b, at: other };
					}
				}
				distinct.push(
					best.after < share.concealed
						? {
								change: `The most these settings reach: a ${best.depth} ms buffer with ${best.at.label}`,
								after: best.after,
								delay: shift(best.depth),
								cost: best.at.id === scheme.id ? "Nothing extra sent." : costOf(best.at),
							}
						: { change: "Nothing tried here makes up less", after: share.concealed, delay: "No change", cost: "The network has to improve." },
				);
			}
			const actions: Output = {
				kind: "table",
				role: "actions",
				caption:
					distinct.every((x) => x.after >= CLEAN)
						? `No buffer up to ${top} ms gets made-up audio under 1% with any protection on this network. It is ${share.concealed}% now.`
						: `What to change, each tried on this same minute of network. Made-up audio is ${share.concealed}% now.`,
				columns: [{ label: "Change" }, { label: "Made-up audio after", align: "end", mono: true }, { label: "Delay" }, { label: "What it costs" }],
				rows: distinct.map((a) => [a.change, { text: `${a.after}%`, mono: true }, a.delay, a.cost]),
			};

			/*
			 * Where the frames went, quietly, under the comparison. The longest gap and the buffer's delay are in the answer,
			 * so they are not said again here.
			 */
			const metrics: Field[] = [
				{ label: "Played on time", value: `${share.played}%`, note: `${played} of ${total} frames` },
				{ label: "Rebuilt from a copy", value: `${share.recovered}%`, note: scheme.id === "none" ? "No copies are sent" : `${recovered} frames` },
				{ label: "Lost by the network", value: `${pct(lost, total)}%`, note: `${lost} packets` },
				{ label: "Arrived too late", value: `${pct(late, total)}%`, note: late === 0 ? `None after ${playsAt} ms` : `${late} packets, after ${playsAt} ms` },
			];

			/*
			 * What Alice hears: the first five seconds, a row per second and a column per 20 ms frame, with only the
			 * incidents drawn. Played frames are left out: at 95% of the minute they gave the ordinary case far more ink
			 * than the frames that went wrong, so a run of made-up frames is now the only thing in its row.
			 *
			 * Two categories, two point series, each with its own colour and marker, rather than a heatmap whose key would
			 * show them as amounts. A series with no points in the window is left out, so the key names only what is drawn.
			 */
			const perSecond = 1000 / FRAME_MS;
			const window = here.slice(0, PLOTTED);
			const label: Record<Exclude<Outcome, "played">, string> = { concealed: "Made up by the decoder", recovered: "Rebuilt from a copy" };
			// Made-up frames first, so the problem takes the strongest colour.
			const incidents = (["concealed", "recovered"] as const).flatMap((kind): Series[] => {
				const at = window.flatMap((o, i) => (o === kind ? [i] : []));
				if (at.length === 0) return [];
				return [
					{
						label: label[kind],
						shape: "points",
						x: at.map((i) => (i % perSecond) + 1),
						points: at.map((i) => Math.floor(i / perSecond) + 1),
						notes: at.map((i) => `frame ${i + 1}, at ${((i * FRAME_MS) / 1000).toFixed(2)} s: ${label[kind].toLowerCase()}`),
					},
				];
			});
			const seconds = Math.ceil(window.length / perSecond);
			const strip: Output | null =
				incidents.length === 0
					? null
					: {
							kind: "series",
							chart: {
								xLabel: "Frame within the second",
								yLabel: seconds > 1 ? `Second, the first ${seconds}` : "Second",
								/*
								 * The series carry their own x. These two hold the x axis to the whole second, frame 1 to 50, which
								 * the incidents alone would not: without them a second whose only gap is at frame 12 draws frame 12
								 * at the edge.
								 */
								x: [1, Math.min(perSecond, window.length)],
								series: incidents,
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
			const lateAt = depths.map((b) => pct(packets.filter((p) => p.arrives !== null && p.arrives > p.sent + delay + b).length, total));
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
					/*
					 * Both marks the decision needs: where this run sits, and the shallowest buffer that gets under the
					 * line. When they are the same depth, one mark says both rather than two labels colliding.
					 */
					annotations:
						enough === buffer
							? [{ x: buffer, label: "this run, the shallowest under 1%" }]
							: [{ x: buffer, label: "this run" }, ...(enough !== undefined ? [{ x: enough, label: "shallowest under 1%" }] : [])],
					thresholds: [{ y: CLEAN, label: "1% made up", tone: "warn" }],
				},
			};

			/*
			 * E: what each scheme buys on this run's network, at this buffer. A table rather than bars, because it is what a
			 * reader compares digit by digit, and bars of the same two columns only repeated it: what each recovers, what it
			 * still leaves made up, its longest gap, and what it costs on the wire. The run's own scheme is named in words
			 * rather than coloured, since being the current choice is not a judgement on it.
			 */
			const byScheme = SCHEMES.map((s) => outcomes(packets, delay, buffer, s.reach));
			const protection: Output = {
				kind: "table",
				role: "comparison",
				caption: `Protection, at a ${buffer} ms buffer`,
				columns: [
					{ label: "Protection" },
					{ label: "Recovered", align: "end", mono: true },
					{ label: "Concealed", align: "end", mono: true },
					{ label: "Longest gap", align: "end", mono: true },
					// Words, not a measurement: start-aligned, so on a phone it falls under the row's name as a note.
					{ label: "What it sends" },
				],
				rows: SCHEMES.map((s, i) => {
					const o = byScheme[i] ?? [];
					return [s.id === scheme.id ? `${s.label} (this run)` : s.label, `${shares(o).recovered}%`, `${shares(o).concealed}%`, `${longestGap(o) * FRAME_MS} ms`, costOf(s)];
				}),
			};

			return {
				kind: "group",
				/*
				 * The answer, then the buffer trade it turns on, then what to change when there is something to change,
				 * then the protections side by side and the counts behind them. The pictures of individual frames and
				 * packets come after, as the evidence: they show the first five seconds, and the numbers are the minute.
				 */
				parts: [
					answer,
					trade,
					...(distinct.length > 0 || share.concealed >= CLEAN ? [actions] : []),
					protection,
					{ kind: "fields", role: "metrics", fields: metrics },
					...(strip ? [strip] : []),
					arrivals,
				],
			};
		} catch (error) {
			if (error instanceof InputError) return { kind: "error", message: error.message, input: error.input };
			throw error;
		}
	},
} satisfies Tool<Input>;
