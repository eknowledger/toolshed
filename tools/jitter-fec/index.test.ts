/**
 * Properties of the jitter and FEC simulator.
 *
 *   pnpm test
 *
 * `cases.json` pins the samples. Because the network is random, what matters more is what holds on every run,
 * and these are the claims the tool makes:
 *
 *  - every frame is exactly one of played, recovered or concealed;
 *  - the same seed gives the same run, and a different seed a different one;
 *  - a copy never makes things worse, and reaching further back never recovers less;
 *  - more buffer never conceals more;
 *  - a copy that leaves after the frame's slot cannot help, so with no jitter and no buffer nothing is recovered;
 *  - over a long run the loss the network produces is the loss asked for.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Output } from "@toolbench/sdk";
import tool from "./index.ts";

type Values = { delay: number; jitter: number; buffer: number; loss: number; burst: number; protection: string; packets: number; seed: number };
const defaults: Values = { delay: 30, jitter: 10, buffer: 40, loss: 3, burst: 1, protection: "fec", packets: 3000, seed: 1 };

function run(values: Partial<Values>): Output[] {
	const out = tool.run({ ...defaults, ...values });
	assert.ok(!(out instanceof Promise), "this tool is synchronous");
	assert.equal(out.kind, "group");
	return out.kind === "group" ? out.parts : [];
}

/** The schemes chart's numbers, which are the whole run's outcomes per scheme, in the order none, fec, red1, red2. */
function concealedBySchemes(values: Partial<Values>): number[] {
	const part = chartOf(run(values), "Protection");
	return part.chart.series[1]?.points as number[];
}

const field = (parts: Output[], label: string) => {
	const fields = parts.flatMap((p) => (p.kind === "fields" ? p.fields : []));
	return fields.find((f) => f.label.startsWith(label))?.value ?? "";
};
/** The answer's share of made-up audio. */
const concealedOf = (parts: Output[]) => Number.parseFloat(field(parts, "Concealed"));
/**
 * A chart by its x axis, not its position: the incident raster is left out when the first five seconds have no
 * incident, so counting charts would land on the wrong one.
 */
function chartOf(parts: Output[], xLabel: string) {
	const part = parts.find((p) => p.kind === "series" && p.chart.xLabel.startsWith(xLabel));
	assert.ok(part?.kind === "series", `no chart "${xLabel}"`);
	return part;
}
const percent = (text: string) => Number.parseFloat(text);

describe("jitter-fec", () => {
	it("accounts for every frame once", () => {
		for (const seed of [1, 2, 3]) {
			for (const protection of ["none", "fec", "red2"]) {
				const parts = run({ seed, protection, burst: 2 });
				const played = percent(field(parts, "Played"));
				const concealed = concealedOf(parts);
				const recovered = percent(field(parts, "Rebuilt"));
				assert.ok(Math.abs(played + concealed + recovered - 100) < 0.2, `${seed} ${protection}: ${played} + ${concealed} + ${recovered}`);
			}
		}
	});

	it("repeats a seed exactly, and changes with it", () => {
		assert.deepEqual(run({ seed: 7 }), run({ seed: 7 }));
		assert.notDeepEqual(chartOf(run({ seed: 7 }), "Packet"), chartOf(run({ seed: 8 }), "Packet"));
	});

	it("never conceals more with a copy, or with a copy reaching further back", () => {
		for (const seed of [1, 2, 3, 4, 5]) {
			for (const burst of [1, 3]) {
				for (const buffer of [20, 40, 80]) {
					const [none, fec, red1, red2] = concealedBySchemes({ seed, burst, buffer }) as [number, number, number, number];
					assert.ok(fec <= none && red1 === fec && red2 <= red1, `seed ${seed}, burst ${burst}, buffer ${buffer}: ${none}/${fec}/${red1}/${red2}`);
				}
			}
		}
	});

	it("never conceals more with more buffer", () => {
		// Every sample's network, because a rounding slip once showed only on the jittery one.
		for (const values of [{}, { burst: 3 }, { jitter: 30, loss: 1 }, { burst: 3, protection: "red2" }, { protection: "none" }]) {
			const part = chartOf(run(values), "Jitter buffer");
			for (const series of part.chart.series) {
				const points = series.points as number[];
				for (let i = 1; i < points.length; i++) assert.ok((points[i] ?? 0) <= (points[i - 1] ?? 0), `${JSON.stringify(values)} ${series.label} at ${i * 10} ms: ${points.join(", ")}`);
			}
		}
	});

	it("recovers nothing when the copy can only arrive after the frame's slot", () => {
		// No jitter and no buffer: packet n+1 arrives exactly 20 ms after frame n's slot, so its copy is always late.
		const parts = run({ jitter: 0, buffer: 0, loss: 5 });
		assert.equal(field(parts, "Rebuilt"), "0%");
		// And 20 ms of buffer is exactly enough for it.
		assert.ok(concealedOf(run({ jitter: 0, buffer: 20, loss: 5 })) < 1);
	});

	it("draws every incident of the first 250 frames in the hearing strip, once, and no played frame", () => {
		for (const values of [{}, { burst: 3 }, { jitter: 30, loss: 1 }]) {
			const parts = run(values);
			const part = chartOf(parts, "Frame within the second");
			const cells = part.chart.series.flatMap((s) => (s.x ?? []).map((x, i) => `${s.points[i]}:${x}`));
			assert.equal(new Set(cells).size, cells.length, "no frame drawn twice");
			assert.ok(part.chart.series.every((s) => s.label !== "Played"), "played frames are not drawn");
			// Every frame in the window that missed its slot, and nothing else: count them from the packets chart.
			const trips = chartOf(parts, "Packet");
			const late = trips.chart.series.find((s) => s.label === "Too late")?.points.filter((p) => p !== null).length ?? 0;
			const onTime = trips.chart.series.find((s) => s.label === "On time")?.points.filter((p) => p !== null).length ?? 0;
			assert.equal(cells.length, 250 - onTime, `${JSON.stringify(values)}: ${late} late, ${onTime} on time`);
			// The x axis spans the whole second, whichever frames went wrong.
			assert.deepEqual(part.chart.x, [1, 50]);
		}
	});

	it("leaves the strip out when nothing went wrong in the first five seconds", () => {
		const parts = run({ loss: 0, jitter: 0 });
		assert.ok(!parts.some((p) => p.kind === "series" && p.chart.xLabel.startsWith("Frame within")));
	});

	it("produces the loss asked for, over a long run", () => {
		for (const burst of [1, 3]) {
			const did = field(run({ packets: 6000, loss: 5, burst, jitter: 0 }), "Lost by the network");
			assert.ok(Math.abs(percent(did) - 5) < 1.5, `burst ${burst}: ${did}`);
		}
	});

	it("leads with the answer and the buffer trade, never a banner, and every change it suggests does what it says", () => {
		for (const values of [{}, { burst: 3 }, { jitter: 30, loss: 1 }, { burst: 3, protection: "red2", buffer: 80 }, { loss: 20, burst: 5, jitter: 80 }]) {
			const parts = run(values);
			assert.equal(parts[0]?.role, "answer");
			assert.deepEqual(parts[0]?.kind === "fields" && parts[0].fields.map((f) => f.label), ["Concealed", "Longest gap", "Playout delay"]);
			assert.ok(parts[1]?.kind === "series" && parts[1].chart.xLabel === "Jitter buffer", "the buffer trade is second");
			assert.ok(!parts.some((p) => p.role === "verdict" || p.role === "stats"));
			// Nothing in the result is coloured by the tool's own 1% line.
			const tones = parts.flatMap((p) => (p.kind === "fields" ? p.fields.map((f) => f.tone) : p.kind === "table" ? p.rows.flat().map((c) => (typeof c === "object" ? c.tone : undefined)) : []));
			assert.ok(tones.every((t) => t === undefined), JSON.stringify(values));
			const actions = parts.find((p) => p.role === "actions");
			if (!actions || actions.kind !== "table") continue;
			for (const row of actions.rows) {
				const change = String(row[0]);
				const after = Number.parseFloat(typeof row[1] === "object" ? row[1].text : String(row[1]));
				const depth = /(\d+) ms buffer|buffer to (\d+) ms/.exec(change);
				const buffer = depth ? Number(depth[1] ?? depth[2]) : (values as { buffer?: number }).buffer ?? defaults.buffer;
				const scheme = /RED, 2 copies/.test(change) ? "red2" : /RED, 1 copy/.test(change) ? "red1" : /None/.test(change) ? "none" : /Opus FEC/.test(change) ? "fec" : undefined;
				const replay = run({ ...values, buffer, ...(scheme ? { protection: scheme } : {}) });
				assert.equal(concealedOf(replay), after, `${JSON.stringify(values)}: "${change}" says ${after}%`);
			}
		}
	});
});
