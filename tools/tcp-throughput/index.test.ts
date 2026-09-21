/**
 * Properties of the TCP throughput ceiling (plan.md V9.2 task 7).
 *
 *   pnpm test:tools
 *
 * `cases.json` pins values, derived independently from the published formulas. What a fixture cannot say is
 * that the two ceilings relate to each other the way the tool claims they do. These are the claims:
 *
 *  - the answer is the lower of the two, always;
 *  - **which one binds does not depend on round-trip time**, which is the interesting one and the one an
 *    earlier draft of this tool's own help text got wrong;
 *  - against loss they cross exactly once, which is where the diagnosis lives;
 *  - no loss means no loss ceiling, and the window becomes the only limit.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Output } from "@toolbench/sdk";
import tool from "./index.ts";

type Values = { mss: number; rtt: number; loss: number; window: number; sweep: string };
const defaults: Values = { mss: 1460, rtt: 80, loss: 0.1, window: 64, sweep: "loss" };

/*
 * ⚠️ Called with ONE argument, unlike the other tools' tests, and the type system insists.
 *
 * `satisfies Tool<Input>` keeps the literal's own signature rather than widening it to the interface's, so a
 * tool whose `run` declares only `(input)` cannot be handed a context: TS2554, "expected 1 arguments, but got
 * 2". That is correct here rather than a nuisance. This tool is a closed form with no loop whose length depends
 * on its input, so there is nothing to cancel and nothing to report progress on, and declaring a parameter it
 * ignores would advertise a capability it does not have.
 *
 * The fixture harness still passes a context at run time, which is harmless: JavaScript drops the extra
 * argument, and the harness is not type-checked against this literal.
 */
function run(values: Partial<Values>): Output[] {
	const out = tool.run({ ...defaults, ...values });
	assert.ok(!(out instanceof Promise), "this tool is synchronous; a Promise changes how a host must call it");
	assert.equal(out.kind, "group");
	return out.kind === "group" ? out.parts : [];
}

const value = (parts: Output[], label: string) => {
	for (const part of parts.filter((p): p is Extract<Output, { kind: "fields" }> => p.kind === "fields")) {
		const hit = part.fields.find((f) => f.label === label);
		if (hit) return hit.value;
	}
	throw new Error(`no field labelled "${label}"`);
};
/** "5.65 Mbit/s" and "226.18 Mbit/s" and "unbounded" all come back comparable, in bits per second. */
const rate = (text: string): number => {
	if (text === "unbounded") return Number.POSITIVE_INFINITY;
	const n = Number.parseFloat(text);
	if (text.includes("Gbit")) return n * 1e9;
	if (text.includes("Mbit")) return n * 1e6;
	if (text.includes("kbit")) return n * 1e3;
	return n;
};
const chartOf = (parts: Output[]) => {
	const part = parts.find((p): p is Extract<Output, { kind: "series" }> => p.kind === "series");
	assert.ok(part, "expected a series part");
	return part.chart;
};

describe("the answer is the lower of the two ceilings", () => {
	for (const [rtt, loss, window] of [
		[80, 0.1, 64],
		[250, 0.5, 4096],
		[2, 0.001, 64],
		[500, 2, 1024],
	] as const) {
		it(`${rtt}ms, ${loss}% loss, ${window}KB window`, () => {
			const parts = run({ rtt, loss, window });
			const ceiling = rate(value(parts, "Throughput ceiling"));
			const fromWindow = rate(value(parts, "Window allows"));
			const fromLoss = rate(value(parts, "Loss allows"));
			/*
			 * Compared with a tolerance, because each figure is rounded to two decimals before it is printed and
			 * the ceiling is the minimum of the unrounded pair. A tenth of a percent is far tighter than any
			 * formula error would be and loose enough to survive the rounding.
			 */
			const expected = Math.min(fromWindow, fromLoss);
			assert.ok(
				Math.abs(ceiling - expected) / expected < 0.001,
				`ceiling ${ceiling} is not the lower of ${fromWindow} and ${fromLoss}`,
			);
		});
	}
});

describe("which ceiling binds does not depend on distance", () => {
	/*
	 * ⚠️ The property this tool exists to teach, and the one its own help text got wrong first.
	 *
	 * Both ceilings carry `1 / RTT`: the window allows `window x 8 / RTT`, and loss allows
	 * `MSS x 8 x C / (RTT x sqrt(p))`. Divide one by the other and the RTT cancels, leaving
	 * `window x sqrt(p) / (MSS x C)`. So distance scales both answers identically and cannot change which one
	 * is smaller. A path that is window limited in a city is window limited across an ocean, just slower.
	 *
	 * The first draft claimed the crossing moved with the slider. It does not, and this is the test that would
	 * have caught the claim before it reached a reader.
	 */
	it("the binding limit is the same from 2ms to 1000ms", () => {
		const verdicts = [2, 10, 80, 250, 1000].map((rtt) => value(run({ rtt }), "What binds it"));
		assert.equal(new Set(verdicts).size, 1, `the verdict changed with distance: ${verdicts.join(", ")}`);
	});

	it("and the ratio between the two ceilings is identical at every distance", () => {
		const ratios = [2, 10, 80, 250, 1000].map((rtt) => {
			const parts = run({ rtt });
			return rate(value(parts, "Window allows")) / rate(value(parts, "Loss allows"));
		});
		for (const ratio of ratios) {
			assert.ok(Math.abs(ratio / (ratios[0] as number) - 1) < 0.002, `ratios differ across RTT: ${ratios.join(", ")}`);
		}
	});

	it("but both ceilings do fall with distance, in proportion", () => {
		// Ten times the distance, a tenth of the throughput. The damage is real even though the diagnosis is not.
		const near = rate(value(run({ rtt: 10 }), "Throughput ceiling"));
		const far = rate(value(run({ rtt: 100 }), "Throughput ceiling"));
		assert.ok(Math.abs(near / far - 10) < 0.02, `expected a tenfold drop, got ${(near / far).toFixed(3)}`);
	});
});

describe("against loss they cross once, and that is the diagnosis", () => {
	it("no loss means no loss ceiling, so the window is the only limit", () => {
		const parts = run({ loss: 0 });
		assert.equal(value(parts, "Loss allows"), "unbounded");
		assert.equal(value(parts, "What binds it"), "Receive window");
		assert.equal(value(parts, "Throughput ceiling"), value(parts, "Window allows"));
	});

	it("enough loss always takes over, however large the window", () => {
		// A 1 GB window cannot outrun 10% loss: sqrt(p) has no ceiling of its own to hit.
		assert.equal(value(run({ window: 1_048_576, loss: 10 }), "What binds it"), "Packet loss");
	});

	it("the verdict crosses from window to loss exactly once as loss rises", () => {
		const verdicts = [0, 0.001, 0.01, 0.05, 0.1, 0.5, 2, 10].map((loss) => value(run({ loss }), "What binds it"));
		const changes = verdicts.filter((v, i) => i > 0 && v !== verdicts[i - 1]).length;
		assert.equal(changes, 1, `expected one crossing, saw ${changes}: ${verdicts.join(" -> ")}`);
		assert.equal(verdicts[0], "Receive window");
		assert.equal(verdicts.at(-1), "Packet loss");
	});

	it("the loss ceiling follows the square root, not the rate", () => {
		// A hundred times the loss is ten times worse, not a hundred. This is the whole surprise.
		const low = rate(value(run({ loss: 0.01 }), "Loss allows"));
		const high = rate(value(run({ loss: 1 }), "Loss allows"));
		assert.ok(Math.abs(low / high - 10) < 0.02, `expected a factor of 10, got ${(low / high).toFixed(3)}`);
	});
});

describe("the shape of the output", () => {
	it("charts the sweep it was asked for, and annotates where the reader is", () => {
		const overLoss = chartOf(run({ sweep: "loss" }));
		assert.equal(overLoss.xUnit, "%");
		assert.deepEqual(overLoss.annotations, [{ x: 0.1, label: "0.10%" }]);

		const overRtt = chartOf(run({ sweep: "rtt" }));
		assert.equal(overRtt.xUnit, "ms");
		assert.deepEqual(overRtt.annotations, [{ x: 80, label: "80 ms" }]);
	});

	it("draws the window ceiling flat against loss and sloped against distance", () => {
		const windowAgainstLoss = chartOf(run({ sweep: "loss" })).series[0]?.points as number[];
		assert.equal(new Set(windowAgainstLoss).size, 1, "loss does not change what a window allows");

		const windowAgainstRtt = chartOf(run({ sweep: "rtt" })).series[0]?.points as number[];
		assert.ok(new Set(windowAgainstRtt).size > 1, "distance does change it");
	});

	it("leaves a gap rather than a zero where the loss ceiling is unbounded", () => {
		/*
		 * At zero loss the ceiling is infinite, which is not a number a chart can plot. `null` is a gap in the
		 * contract and a zero would draw a line to the floor, claiming the opposite of what is true.
		 */
		const lossLine = chartOf(run({ sweep: "loss" })).series[1]?.points as (number | null)[];
		assert.equal(lossLine[0], null, "the first point is zero loss, which has no finite ceiling");
		assert.ok((lossLine[1] as number) > 0);
	});

	it("names both lines with their unit, since they share an axis", () => {
		const chart = chartOf(run({}));
		assert.equal(chart.series.length, 2);
		assert.ok(chart.series.every((s) => s.unit === "Mbit/s"));
		// One axis, because both are bit rates: a second would imply they are not comparable, and comparing
		// them is the entire point.
		assert.ok(chart.series.every((s) => s.axis === undefined));
	});
});
