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

type Values = { mss: number; rtt: number; loss: number; window: number; link: number; sweep: string };
const defaults: Values = { mss: 1460, rtt: 80, loss: 0.1, window: 64, link: 1000, sweep: "loss" };

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

const text = (cell: unknown) => (typeof cell === "object" && cell !== null ? (cell as { text: string }).text : String(cell));
const limitsOf = (parts: Output[]) => {
	const table = parts[0];
	assert.ok(table?.kind === "table" && table.role === "comparison", "the limits table comes first");
	return table;
};
/**
 * What the reader reads, by what they would call it: a limit's ceiling from the table, "Throughput ceiling" from
 * the caption that answers the question, and "What binds it" from the row marked as setting the limit.
 */
const value = (parts: Output[], label: string): string => {
	const table = limitsOf(parts);
	if (label === "Throughput ceiling") {
		const hit = / at (.+?), /.exec(table.caption ?? "");
		assert.ok(hit, `the caption gives no ceiling: ${table.caption}`);
		return hit[1]!;
	}
	if (label === "What binds it") return text(table.rows.find((r) => text(r[2]) === "Sets the limit")?.[0]);
	const name = { "Window allows": "Receive window", "Loss allows": "Packet loss", Link: "Link" }[label];
	const row = table.rows.find((r) => text(r[0]) === name);
	assert.ok(row, `no limit called "${label}"`);
	return text(row[1]);
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

describe("the answer and what fixing it buys", () => {
	it("leads with the limits side by side, then what fixing them buys, then the curve", () => {
		const parts = run({});
		assert.deepEqual(
			parts.map((p) => `${p.kind}${p.role ? `:${p.role}` : ""}`),
			["table:comparison", "fields:answer", "series", "fields:method"],
		);
	});

	it("says one connection fills the link only when both ceilings clear it, and offers no changes then", () => {
		const filled = run({ rtt: 2, loss: 0, window: 4096, link: 100 });
		assert.equal(limitsOf(filled).caption, "One connection can fill the 100.00 Mbit/s link");
		assert.equal(value(filled, "What binds it"), "Link");
		assert.ok(!filled.some((p) => p.role === "answer"), "nothing to change is not a row");
		assert.match(limitsOf(run({ link: 10 })).caption ?? "", /^One connection tops out at 5\.65 Mbit\/s/);
	});

	it("carries no tone, because a modelled ceiling is not a measured fault", () => {
		const parts = run({});
		const cells = limitsOf(parts).rows.flat();
		assert.ok(cells.every((c) => typeof c !== "object" || !("tone" in c)));
		assert.ok(parts.every((p) => p.kind !== "fields" || p.fields.every((f) => f.tone === undefined)));
	});

	it("sizes the first fix to the next limit, so fixing loss on the defaults buys only the window's 6.55", () => {
		const changes = run({})[1];
		assert.ok(changes?.kind === "fields");
		assert.equal(changes.fields[0]?.value, value(run({}), "Window allows"));
		assert.match(changes.fields[0]?.label ?? "", /^Cut loss below/);
		assert.equal(changes.fields[1]?.label, "To fill the link");
	});

	it("asks for a loss rate that, put back in, fills the link exactly", () => {
		/*
		 * The action solves Mathis for p. Running the tool at that loss, with a window big enough not to bind, must
		 * give a loss ceiling of the link speed, to the rounding of the printed percentage.
		 */
		for (const [rtt, link] of [
			[80, 1000],
			[250, 100],
			[10, 10000],
		] as const) {
			const changes = run({ rtt, link, window: 1_048_576 })[1];
			assert.ok(changes?.kind === "fields");
			const pct = Number(/below ([\d.e-]+)%/.exec(changes.fields[0]?.label ?? "")?.[1]);
			const reached = rate(value(run({ rtt, link, window: 1_048_576, loss: pct }), "Loss allows"));
			// Two significant figures of p is up to 2.5% in p, so 1.3% in the rate, which sqrt halves.
			assert.ok(Math.abs(reached / (link * 1e6) - 1) < 0.015, `${rtt} ms, ${link} Mbit/s: ${pct}% gives ${reached}`);
		}
	});
});

