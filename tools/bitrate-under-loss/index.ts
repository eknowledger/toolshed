/**
 * Bitrate under loss: a voice sender that learns about loss only from RTCP receiver reports, and runs the
 * loss-based rule of Google Congestion Control on each one.
 *
 * The model is post 5's demo, `backoff_sim.py`, ported line for line, and the fixtures are its output:
 *
 *  - the rule is draft-ietf-rmcat-gcc-02 section 6, once per report, on the report's 8-bit fraction: above 10%
 *    the rate becomes rate x (1 - 0.5p), from 2% to 10% it holds, below 2% it grows 5%;
 *  - the rate is the wire rate. Opus gets what is left after 40 B of IPv4, UDP and RTP per packet, and is held
 *    between 6 kb/s, its floor (RFC 6716 section 2.1.1), and the ceiling the app asked for;
 *  - the network is one bottleneck with no queue: whatever is sent above capacity is lost, 1 - capacity / rate,
 *    compounded with any loss that happens whatever the rate, such as a weak radio link.
 *
 * Nothing is random, so the same inputs always give the same run. Section 7 of the draft says this is the half
 * to run when the receiver sends only receiver reports; the delay-based half, and libwebrtc's own code, which
 * ramps up by time rather than per report, are not modelled.
 */
import type { Cell, Field, Output, Series, Tool } from "@toolbench/sdk";

type Input = { interval: string; scenario: string; capacity: number; loss: number; frame: string; ceiling: number };

class InputError extends Error {
	readonly input: string;
	constructor(message: string, input: string) {
		super(message);
		this.input = input;
	}
}

const HEADER_BYTES = 40;
const OPUS_MIN = 6;
/** The model advances 20 ms at a time: one packet at 20 ms frames, a fraction of one at 40 or 60. */
const STEP_MS = 20;
const STEP = STEP_MS / 1000;
const SECONDS = 120;
/** When the loss stops in both scenarios, which is where recovery is timed from. */
const CLEARS = 60;

export type Model = { frameMs: number; opusMax: number };
export type Scenario = {
	name: string;
	onset: number;
	capacity: (t: number) => number;
	randomLoss: (t: number) => number;
};
export type Report = {
	t: number;
	capacity: number;
	wire: number;
	opus: number;
	loss: number;
	reported: number;
	action: string;
};

export const headers = (m: Model) => (HEADER_BYTES * 8 * (1000 / m.frameMs)) / 1000;
const wireMin = (m: Model) => OPUS_MIN + headers(m);
const wireMax = (m: Model) => m.opusMax + headers(m);

export function scenario(name: string, squeezeKbps: number, radioLoss: number): Scenario {
	return name === "squeeze"
		? { name, onset: 30, capacity: (t) => (t >= 30 && t < 60 ? squeezeKbps : 100), randomLoss: () => 0 }
		: {
				name,
				onset: 20,
				capacity: () => 100,
				randomLoss: (t) => (t >= 20 && t < 40 ? 0.05 : t >= 40 && t < 60 ? radioLoss : 0),
			};
}

/** draft-ietf-rmcat-gcc-02 section 6, then held inside what the codec can do. */
export function rule(m: Model, rate: number, p: number): [number, string] {
	let next: number;
	let why: string;
	if (p > 0.1) [next, why] = [rate * (1 - 0.5 * p), "decrease"];
	else if (p >= 0.02) [next, why] = [rate, "hold"];
	else [next, why] = [rate * 1.05, "increase"];
	if (next >= wireMax(m)) return [wireMax(m), why === "increase" ? "ceiling" : why];
	if (next <= wireMin(m)) return [wireMin(m), "floor"];
	return [next, why];
}

/**
 * Every report of one run, the start state first, and the packets lost over the whole run.
 *
 * ⚠️ The order of every floating-point operation is the demo's, on purpose: the reported fraction is a floor,
 * so a last-bit difference in the expected loss can move it by one 256th and change what the rule does.
 */
export function simulate(s: Scenario, interval: number, m: Model): { reports: Report[]; lost: number } {
	const h = headers(m);
	let rate = wireMax(m);
	const reports: Report[] = [
		{ t: 0, capacity: s.capacity(0), wire: rate, opus: rate - h, loss: 0, reported: 0, action: "start" },
	];
	let sent = 0;
	let lost = 0;
	let total = 0;
	// Sent and lost are expected counts, not whole packets, so a 60 ms frame sends a third of a packet per step.
	const perStep = STEP_MS / m.frameMs;
	const stepsPerReport = Math.round(interval / STEP);
	const steps = Math.round(SECONDS / STEP);
	for (let k = 1; k <= steps; k++) {
		const t = k * STEP;
		const mid = t - STEP / 2;
		const over = Math.max(0, 1 - s.capacity(mid) / rate);
		const p = 1 - (1 - over) * (1 - s.randomLoss(mid));
		sent += perStep;
		lost += p * perStep;
		total += p * perStep;
		if (k % stepsPerReport === 0) {
			// RFC 3550 appendix A.3: (lost << 8) / expected, truncated, here on the model's expected counts.
			const fraction = Math.floor((lost * 256) / sent);
			let action: string;
			[rate, action] = rule(m, rate, fraction / 256);
			reports.push({
				t,
				capacity: s.capacity(mid),
				wire: rate,
				opus: rate - h,
				loss: lost / sent,
				reported: fraction,
				action,
			});
			sent = 0;
			lost = 0;
		}
	}
	return { reports, lost: total };
}

/** The state in force at time t: the last report at or before it. */
export const at = (reports: Report[], t: number) => reports.filter((r) => r.t <= t + 1e-9).at(-1)!;

/**
 * x to d decimals, rounding an exact tie to even, as Python's format does. toFixed rounds a tie up, and ties are
 * common here: 16/256 is exactly 6.25%, which the demo prints as 6.2% and toFixed as 6.3%.
 */
export function fixed(x: number, d: number): string {
	const long = x.toFixed(Math.min(100, d + 30));
	const [whole = "", frac = ""] = long.split(".");
	const kept = frac.slice(0, d);
	const rest = frac.slice(d);
	const tie = /^50*$/.test(rest);
	const base = d === 0 ? whole : `${whole}.${kept}`;
	const last = Number((d === 0 ? whole : kept).at(-1) ?? "0");
	if (rest[0] === undefined || rest[0] < "5" || (tie && last % 2 === 0)) return base;
	return (Number(base) + (x < 0 ? -1 : 1) * 10 ** -d).toFixed(d);
}

/** 16 for a whole number, 5.33 otherwise, as the demo prints rates and header overheads. */
const num = (x: number) => (Math.abs(x - Math.round(x)) < 1e-9 ? fixed(x, 0) : fixed(x, 2));
const pct = (n: number, d: number) => `${fixed((n / 256) * 100, d)}%`;
const tone = (n: number) => (n / 256 > 0.1 ? ("bad" as const) : n / 256 >= 0.02 ? ("warn" as const) : undefined);

const INTERVALS = ["5", "2", "1"];
const FRAMES = ["20", "40", "60"];

export default {
	run(input: Input) {
		try {
			if (!INTERVALS.includes(String(input.interval)))
				throw new InputError("Reports come every 5, 2 or 1 s.", "interval");
			if (input.scenario !== "squeeze" && input.scenario !== "radio")
				throw new InputError("The network is the squeeze or the radio link.", "scenario");
			const capacity = Number(input.capacity);
			if (!(capacity >= 10 && capacity <= 100))
				throw new InputError("The squeeze narrows the path to between 10 and 100 kb/s.", "capacity");
			const loss = Number(input.loss);
			if (!(loss >= 0 && loss <= 50))
				throw new InputError("The radio link's second loss is between 0% and 50%.", "loss");
			if (!FRAMES.includes(String(input.frame))) throw new InputError("Frames are 20, 40 or 60 ms.", "frame");
			const ceiling = Number(input.ceiling);
			if (!(ceiling >= OPUS_MIN && ceiling <= 64))
				throw new InputError(
					"The Opus ceiling is between 6 kb/s, its floor (RFC 6716 section 2.1.1), and 64 kb/s.",
					"ceiling",
				);

			const interval = Number(input.interval);
			const m: Model = { frameMs: Number(input.frame), opusMax: ceiling };
			const s = scenario(input.scenario, capacity, loss / 100);
			const { reports, lost } = simulate(s, interval, m);
			const h = headers(m);
			const pps = 1000 / m.frameMs;
			const squeeze = s.name === "squeeze";

			const first = reports.find((r) => r.t > s.onset && (r.action === "decrease" || r.action === "floor"));
			const low = reports.reduce((a, b) => (b.opus < a.opus ? b : a));
			const end = at(reports, CLEARS);
			const back = reports.find((r) => r.t > CLEARS && r.opus >= m.opusMax - 1e-9);
			const neverLeft = low.opus >= m.opusMax - 1e-9;
			const atFloor = low.opus <= OPUS_MIN + 1e-9;

			const fields: Field[] = [
				first
					? {
							label: "First back-off",
							value: `${fixed(first.t - s.onset, 0)} s after the ${squeeze ? "path narrowed" : "loss began"}`,
							note: `at ${fixed(first.t, 0)} s, on ${first.reported}/256 = ${pct(first.reported, 1)} reported loss`,
						}
					: { label: "First back-off", value: "never", note: "no report carried more than 10% loss" },
				{ label: "Packets lost", value: fixed(lost, 0), note: `over ${SECONDS} s, at ${num(pps)} packets a second` },
				{
					label: "Lowest Opus",
					value: `${fixed(low.opus, 1)} kb/s`,
					note: neverLeft
						? "the ceiling, throughout"
						: atFloor
							? `first at ${fixed(low.t, 0)} s: the Opus floor`
							: `first at ${fixed(low.t, 0)} s`,
					...(atFloor ? { tone: "bad" as const } : {}),
				},
				{
					label: `At ${CLEARS} s, as the loss stops`,
					value: `${fixed(end.wire, 1)} kb/s on the wire`,
					note: `${fixed(end.opus, 1)} kb/s of Opus, ${end.reported}/256 = ${pct(end.reported, 1)} reported loss${squeeze ? `, into a ${num(capacity)} kb/s path` : ""}`,
					...(tone(end.reported) ? { tone: "warn" as const } : {}),
				},
				neverLeft
					? { label: "Back at the ceiling", value: "never left it", note: `${num(m.opusMax)} kb/s of Opus throughout` }
					: back
						? {
								label: "Back at the ceiling",
								value: `${fixed(back.t - CLEARS, 0)} s after the loss stopped`,
								note: `${num(m.opusMax)} kb/s of Opus again at ${fixed(back.t, 0)} s`,
							}
						: {
								label: "Back at the ceiling",
								value: `not by ${SECONDS} s`,
								note: `still ${fixed(reports.at(-1)!.opus, 1)} kb/s of Opus at the end`,
								tone: "warn",
							},
				{
					label: "Header overhead",
					value: `${num(h)} kb/s`,
					note: `40 B on each of ${num(pps)} packets a second: ${num(wireMin(m))} to ${num(wireMax(m))} kb/s on the wire`,
				},
			];

			/*
			 * The rates are state that changes only when a report arrives, so they are steps: a sloped line between two
			 * reports would draw a gradual change the sender never made. Capacity is a step too, for the same reason,
			 * and is drawn only for the squeeze, because the radio link's 100 kb/s says nothing and flattens the rest.
			 */
			const seconds = Array.from({ length: SECONDS + 1 }, (_, t) => t);
			const state = seconds.map((t) => at(reports, t));
			const two = (x: number) => Number(fixed(x, 2));
			const rateSeries: Series[] = [
				{ label: "On the wire", unit: "kb/s", shape: "step", points: state.map((r) => two(r.wire)) },
				{ label: "Opus", unit: "kb/s", shape: "step", points: state.map((r) => two(r.opus)) },
			];
			if (squeeze)
				rateSeries.push({
					label: "Path capacity",
					unit: "kb/s",
					shape: "step",
					points: seconds.map((t) => s.capacity(t ? t - 0.01 : 0)),
				});
			const events = squeeze
				? [
						{ x: 30, label: `path narrows to ${num(capacity)} kb/s` },
						{ x: 60, label: "path opens" },
					]
				: [
						{ x: 20, label: "5% loss" },
						{ x: 40, label: `${num(loss)}% loss` },
						{ x: 60, label: "loss stops" },
					];
			const rates: Output = {
				kind: "series",
				chart: {
					id: "rate",
					xLabel: "Time",
					xUnit: "s",
					yLabel: "Rate",
					yUnit: "kb/s",
					x: seconds,
					series: rateSeries,
					thresholds: [{ y: OPUS_MIN, label: "Opus floor, 6 kb/s", tone: "warn" }],
					// The first back-off is a field, not an annotation: it lands a report or two after a phase change, and two
					// labels a few seconds apart print over each other.
					annotations: events,
					readout: {
						titles: state.map((r, t) =>
							r.action === "start"
								? `${t} s, before the first report`
								: `${t} s, after the report at ${fixed(r.t, 0)} s: ${r.action}`,
						),
					},
				},
			};

			/*
			 * What each report said, as bars, because each is one separate measurement over its own interval and nothing
			 * exists between two of them. The rule's two thresholds are drawn on it, so which side of 2% and 10% a
			 * report fell on, and so what the sender did, can be read off the chart.
			 */
			const sent = reports.slice(1);
			const losses: Output = {
				kind: "series",
				chart: {
					id: "loss",
					xLabel: "Report at",
					xUnit: "s",
					yLabel: "Reported loss",
					yUnit: "%",
					x: sent.map((r) => r.t),
					series: [
						{
							label: "Reported loss",
							unit: "%",
							shape: "bar",
							points: sent.map((r) => two((r.reported / 256) * 100)),
							notes: sent.map((r) => `${r.reported}/256 = ${pct(r.reported, 2)}: ${r.action}`),
						},
					],
					thresholds: [
						{ y: 2, label: "2%: below it, grow 5%", tone: "good" },
						{ y: 10, label: "10%: above it, cut by half the loss", tone: "bad" },
					],
					readout: { highlightTable: true },
				},
			};

			const rows: Cell[][] = sent.map((r) => {
				const t = tone(r.reported);
				return [
					{ text: fixed(r.t, 0), mono: true },
					{ text: fixed(r.capacity, 0), mono: true },
					{ text: `${r.reported}/256`, mono: true },
					{ text: pct(r.reported, 2), mono: true, ...(t ? { tone: t } : {}) },
					r.action,
					{ text: fixed(r.opus, 2), mono: true },
					{ text: fixed(r.wire, 2), mono: true },
				];
			});
			const table: Output = {
				kind: "table",
				caption: `Every report, one every ${interval} s: the loss it carried, what the rule did, and the rate after`,
				columns: [
					{ label: "Report at, s", align: "end", mono: true },
					{ label: "Path, kb/s", align: "end", mono: true },
					{ label: "Fraction lost", align: "end", mono: true },
					{ label: "Loss", align: "end", mono: true },
					{ label: "Rule" },
					{ label: "Opus after, kb/s", align: "end", mono: true },
					{ label: "Wire after, kb/s", align: "end", mono: true },
				],
				rows,
				link: { chart: "loss", keys: sent.map((r) => r.t) },
			};

			return { kind: "group", parts: [{ kind: "fields", fields }, rates, losses, table] };
		} catch (error) {
			if (error instanceof InputError) return { kind: "error", message: error.message, input: error.input };
			throw error;
		}
	},
} satisfies Tool<Input>;
