/**
 * Properties of the loss and playout simulator.
 *
 *   pnpm test
 *
 * `cases.json` pins single inputs, worked by hand from the model. What a fixture cannot say is how the three
 * transports relate to each other across every input, and those relations are what the tool claims:
 *
 *  - UDP always misses exactly the one lost frame;
 *  - TCP only ever beats UDP by missing nothing at all, which happens when the repair lands by the lost
 *    frame's own deadline;
 *  - more buffer never costs a frame;
 *  - nothing before the loss is ever touched;
 *  - waiting for the timer is never better than fast retransmit.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Output } from "@toolbench/sdk";
import tool from "./index.ts";

type Values = { frame: string; delay: number; buffer: number; lost: number; rto: number; frames: number };
const defaults: Values = { frame: "20", delay: 30, buffer: 40, lost: 5, rto: 200, frames: 20 };

/*
 * One argument, as in tcp-throughput: the tool is a short loop bounded by a 50-frame maximum, so it takes no
 * context, and `satisfies Tool<Input>` keeps that one-parameter signature.
 */
function run(values: Partial<Values>): Output[] {
	const out = tool.run({ ...defaults, ...values });
	assert.ok(!(out instanceof Promise), "this tool is synchronous; a Promise changes how a host must call it");
	assert.equal(out.kind, "group");
	return out.kind === "group" ? out.parts : [];
}

const tableOf = (parts: Output[]) => {
	const part = parts.find((p): p is Extract<Output, { kind: "table" }> => p.kind === "table");
	assert.ok(part, "expected a table part");
	return part;
};
const chartOf = (parts: Output[]) => {
	const part = parts.find((p): p is Extract<Output, { kind: "series" }> => p.kind === "series");
	assert.ok(part, "expected a series part");
	return part.chart;
};

/** Frames each transport misses, read from the table so the test sees what a reader sees. Columns 3 to 5. */
function missed(values: Partial<Values>): { udp: number[]; fast: number[]; timeout: number[] } {
	const { rows } = tableOf(run(values));
	const late = (col: number) =>
		rows
			.filter((row) => {
				const cell = row[col];
				const text = typeof cell === "object" ? cell.text : String(cell);
				return text === "lost" || text.endsWith("late");
			})
			.map((row) => row[0] as number);
	return { udp: late(3), fast: late(4), timeout: late(5) };
}

/** A spread of paths, from a LAN to a satellite hop, with losses early, mid-run and at the very end. */
const grid: Partial<Values>[] = [];
for (const frame of ["10", "20", "40", "60"]) {
	for (const delay of [0, 10, 30, 80, 250]) {
		for (const buffer of [0, 40, 120, 300]) {
			for (const lost of [1, 5, 18, 20]) {
				for (const rto of [200, 1000]) grid.push({ frame, delay, buffer, lost, rto: Math.max(rto, 2 * delay) });
			}
		}
	}
}

describe("UDP", () => {
	it("misses exactly the lost frame, whatever the path", () => {
		for (const values of grid) assert.deepEqual(missed(values).udp, [values.lost], JSON.stringify(values));
	});
});

describe("TCP against UDP", () => {
	it("misses at least as many frames as UDP, unless it misses none", () => {
		/*
		 * The claim as first written was "TCP never misses fewer than UDP", and the "Bigger buffer" sample
		 * disproves it: with 120 ms of buffer fast retransmit misses nothing while UDP still misses one. So the
		 * honest property is narrower. TCP either recovers the frame in time, and loses nothing, or it does not,
		 * and then it loses the lost frame plus whatever queued behind it.
		 */
		for (const values of grid) {
			const m = missed(values);
			for (const tcp of [m.fast, m.timeout]) {
				assert.ok(tcp.length === 0 || tcp.length >= m.udp.length, JSON.stringify(values));
				if (tcp.length > 0) assert.equal(tcp[0], values.lost, "a TCP miss always starts at the lost frame");
			}
		}
	});

	it("and the misses are one unbroken run, because the held frames are released together", () => {
		for (const values of grid) {
			for (const tcp of [missed(values).fast, missed(values).timeout]) {
				tcp.forEach((n, i) => i > 0 && assert.equal(n, (tcp[i - 1] as number) + 1, JSON.stringify(values)));
			}
		}
	});
});

describe("the buffer", () => {
	it("never costs a frame when it grows", () => {
		for (const values of grid.filter((v) => v.buffer === 0)) {
			let previous = Number.POSITIVE_INFINITY;
			for (const buffer of [0, 20, 40, 80, 120, 200, 400]) {
				const m = missed({ ...values, buffer });
				const total = m.fast.length + m.timeout.length;
				assert.ok(total <= previous, `${JSON.stringify(values)} at ${buffer} ms missed more than with less buffer`);
				previous = total;
			}
		}
	});
});

describe("frames before the loss", () => {
	it("are never missed by any transport", () => {
		for (const values of grid) {
			const m = missed(values);
			for (const n of [...m.udp, ...m.fast, ...m.timeout]) assert.ok(n >= (values.lost as number), JSON.stringify(values));
		}
	});
});

describe("fast retransmit against the timer", () => {
	it("the timer never beats fast retransmit", () => {
		for (const values of grid) {
			const m = missed(values);
			assert.ok(m.timeout.length >= m.fast.length, JSON.stringify(values));
		}
	});

	it("and when fewer than three frames follow the loss, the two are the same", () => {
		for (const values of grid.filter((v) => (v.lost as number) > 17)) {
			const m = missed(values);
			assert.deepEqual(m.fast, m.timeout, JSON.stringify(values));
		}
	});
});

describe("the chart", () => {
	it("draws the lost frame as a gap on the UDP line, not a zero", () => {
		const chart = chartOf(run({}));
		const udp = chart.series.find((s) => s.label === "UDP");
		assert.equal(udp?.points[4], null);
	});

	it("runs the TCP lines flat at the release time across the held frames", () => {
		// The shape the chart exists to show: frames 5 to 11 all go up at 250 ms, because 11 is the first to arrive then.
		const fast = chartOf(run({})).series.find((s) => s.label === "TCP, fast retransmit");
		assert.deepEqual(fast?.points.slice(4, 11), [250, 250, 250, 250, 250, 250, 250]);
		assert.equal(fast?.points[11], 270, "frame 12 arrives after the release and goes up on its own");
	});

	it("puts every line on one axis in milliseconds, since they are compared against each other", () => {
		const chart = chartOf(run({}));
		assert.equal(chart.series.length, 4);
		assert.ok(chart.series.every((s) => s.unit === "ms" && s.axis === undefined));
	});
});
