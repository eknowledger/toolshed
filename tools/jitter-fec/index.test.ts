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
	const part = run(values)[4];
	assert.ok(part?.kind === "series");
	return part.chart.series[1]?.points as number[];
}

const field = (parts: Output[], label: string) => {
	const fields = parts[0]?.kind === "fields" ? parts[0].fields : [];
	return fields.find((f) => f.label.startsWith(label))?.value ?? "";
};
const percent = (text: string) => Number.parseFloat(text);

describe("jitter-fec", () => {
	it("accounts for every frame once", () => {
		for (const seed of [1, 2, 3]) {
			for (const protection of ["none", "fec", "red2"]) {
				const parts = run({ seed, protection, burst: 2 });
				const played = percent(field(parts, "Played"));
				const concealed = percent(field(parts, "Concealed"));
				const recovered = protection === "none" ? 0 : percent(field(parts, "Recovered"));
				assert.ok(Math.abs(played + concealed + recovered - 100) < 0.2, `${seed} ${protection}: ${played} + ${concealed} + ${recovered}`);
			}
		}
	});

	it("repeats a seed exactly, and changes with it", () => {
		assert.deepEqual(run({ seed: 7 }), run({ seed: 7 }));
		assert.notDeepEqual(run({ seed: 7 })[2], run({ seed: 8 })[2]);
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
			const part = run(values)[3];
			assert.ok(part?.kind === "series");
			for (const series of part.chart.series) {
				const points = series.points as number[];
				for (let i = 1; i < points.length; i++) assert.ok((points[i] ?? 0) <= (points[i - 1] ?? 0), `${JSON.stringify(values)} ${series.label} at ${i * 10} ms: ${points.join(", ")}`);
			}
		}
	});

	it("recovers nothing when the copy can only arrive after the frame's slot", () => {
		// No jitter and no buffer: packet n+1 arrives exactly 20 ms after frame n's slot, so its copy is always late.
		const parts = run({ jitter: 0, buffer: 0, loss: 5 });
		assert.equal(field(parts, "Recovered"), "0%");
		// And 20 ms of buffer is exactly enough for it.
		assert.equal(field(run({ jitter: 0, buffer: 20, loss: 5 }), "Concealed").startsWith("0"), true);
	});

	it("draws every one of the first 250 frames in the hearing strip, once", () => {
		const part = run({ burst: 3 })[1];
		assert.ok(part?.kind === "series");
		const cells = part.chart.series.flatMap((s) => (s.x ?? []).map((x, i) => `${s.points[i]}:${x}`));
		assert.equal(cells.length, 250);
		assert.equal(new Set(cells).size, 250);
	});

	it("produces the loss asked for, over a long run", () => {
		for (const burst of [1, 3]) {
			const did = field(run({ packets: 6000, loss: 5, burst, jitter: 0 }), "What the network did");
			assert.ok(Math.abs(percent(did) - 5) < 1.5, `burst ${burst}: ${did}`);
		}
	});
});
