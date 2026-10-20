/**
 * Properties of the capacity planner (plan.md V9.2 task 1).
 *
 *   pnpm test:tools
 *
 * `cases.json` pins values: this rate and this service time need that many servers, with expectations
 * derived from the closed form using exact rational arithmetic. What a fixture cannot say is "the formula
 * is the right formula". These are the claims that make that checkable:
 *
 *  - the simulation converges on the closed form, which is the load-bearing one;
 *  - the curve is monotone and the search finds the first crossing, not merely a crossing;
 *  - the numerics survive the range where the textbook expression overflows.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Output } from "@toolbench/sdk";
import tool, { waitOver, waitPercentile } from "./index.ts";

type Values = { rate: number; service: number; target: number; limit: number; mode: string; trials: number };
const defaults: Values = { rate: 120, service: 45, target: 5, limit: 0, mode: "closed", trials: 200000 };

/*
 * `Ctx` is signal AND progress, so a bare `{ signal }` does not satisfy it. Worth the two words rather
 * than a cast: the progress callback is real API this tool calls, and a test that stubbed it away with
 * `as Ctx` would not notice if it started calling it wrongly.
 */
const ctx = { signal: new AbortController().signal, progress: () => {} };

/** Runs the tool and asserts it produced a group, which is what every non-error path returns. */
function run(values: Partial<Values>): Output[] {
	const out = tool.run({ ...defaults, ...values }, ctx);
	assert.ok(!(out instanceof Promise), "this tool is synchronous; a Promise here changes how the host must call it");
	assert.equal(out.kind, "group");
	return out.kind === "group" ? out.parts : [];
}

const fieldsOf = (parts: Output[], index = 0) => {
	const all = parts.filter((p): p is Extract<Output, { kind: "fields" }> => p.kind === "fields");
	const part = all[index];
	assert.ok(part, `expected a fields part at index ${index}`);
	return part.fields;
};
const value = (parts: Output[], label: string, group?: string) => {
	for (const part of parts.filter((p): p is Extract<Output, { kind: "fields" }> => p.kind === "fields")) {
		const hit = part.fields.find((f) => f.label === label && (group === undefined || f.group === group));
		if (hit) return hit.value;
	}
	throw new Error(`no field labelled "${label}"${group ? ` in group "${group}"` : ""}`);
};
const asPercent = (text: string) => Number.parseFloat(text.replace("%", ""));
const servers = (parts: Output[]) => Number.parseInt(value(parts, "Servers needed"), 10);
/** "7.4 ms", "352 µs", "1.2 s" or "0 ms", in milliseconds. */
const asMs = (text: string) =>
	text.endsWith("µs") ? Number.parseFloat(text) / 1000 : text.endsWith(" s") ? Number.parseFloat(text) * 1000 : Number.parseFloat(text);
/** The comparison table's row for `count` servers, as column label to cell text. */
const row = (parts: Output[], count: number) => {
	const table = parts.find((p): p is Extract<Output, { kind: "table" }> => p.kind === "table" && p.role === "comparison");
	assert.ok(table, "expected the comparison table");
	const hit = table.rows.find((r) => (typeof r[0] === "object" ? r[0].text : String(r[0])) === String(count));
	assert.ok(hit, `no row for ${count} servers`);
	return Object.fromEntries(table.columns.map((c, i) => {
		const cell = hit[i];
		return [c.label, typeof cell === "object" ? cell.text : String(cell)];
	}));
};
const chartOf = (parts: Output[]) => {
	const part = parts.find((p): p is Extract<Output, { kind: "series" }> => p.kind === "series");
	assert.ok(part, "expected a series part");
	return part.chart;
};

describe("the simulation agrees with the formula", () => {
	/*
	 * ⚠️ This is the test that would catch a wrong formula, and it is worth being precise about why.
	 *
	 * A fixture derived from Erlang C proves the code computes Erlang C. It cannot prove Erlang C describes
	 * an M/M/c queue, because the same misreading of the formula would go into both. The simulation shares
	 * no code with it: exponential draws, servers with free-at times, and a count of who waited. If the two
	 * agree across a range of loads, both are almost certainly right.
	 *
	 * The tolerance is sampling error, not a fudge. At 200k arrivals the standard error on a proportion
	 * near 0.05 is about sqrt(0.05 x 0.95 / 180000) which is 0.05 percentage points, so half a point is
	 * roughly ten sigma and a formula that was wrong by any interesting amount cannot hide inside it.
	 */
	for (const [rate, service, target] of [
		[120, 45, 5],
		[10, 100, 10],
		[500, 20, 1],
		[40, 200, 20],
	] as const) {
		it(`${rate}/s of ${service}ms work, ${target}% target`, () => {
			const parts = run({ rate, service, target, mode: "simulate", trials: 200000 });
			const formula = asPercent(value(parts, "Chance of waiting", "Formula"));
			const simulated = asPercent(value(parts, "Chance of waiting", "Simulated"));
			assert.ok(
				Math.abs(formula - simulated) < 0.5,
				`formula says ${formula}% and the simulation says ${simulated}%, which is further apart than sampling error explains`,
			);
		});
	}

	it("the mean wait agrees too, which is the harder of the two", () => {
		/*
		 * A proportion is forgiving; a mean is not. The mean wait is an average over a distribution with a
		 * long tail, so it converges more slowly and a systematic error in the formula shows up here first.
		 * Compared as a ratio because the absolute values are sub-millisecond.
		 */
		const parts = run({ rate: 40, service: 200, target: 20, mode: "simulate", trials: 400000 });
		const parse = (text: string) => (text.endsWith("µs") ? Number.parseFloat(text) / 1000 : Number.parseFloat(text));
		const formula = parse(value(parts, "Mean wait", "Formula"));
		const simulated = parse(value(parts, "Mean wait", "Simulated"));
		assert.ok(
			Math.abs(simulated / formula - 1) < 0.1,
			`formula ${formula}ms vs simulated ${simulated}ms, a ratio of ${(simulated / formula).toFixed(3)}`,
		);
	});
});

describe("the search finds the first crossing", () => {
	it("the answer meets the target and one fewer server does not", () => {
		const parts = run({});
		const chosen = servers(parts);
		const chart = chartOf(parts);
		const at = (servers: number) => {
			const index = chart.x.indexOf(servers);
			assert.notEqual(index, -1, `${servers} is not on the chart`);
			return chart.series[0]?.points[index] as number;
		};
		assert.ok(at(chosen) <= 5, `${chosen} servers gives ${at(chosen)}%, which does not meet the 5% target`);
		assert.ok(at(chosen - 1) > 5, `${chosen - 1} servers already gives ${at(chosen - 1)}%, so the search overshot`);
	});

	it("the chance of waiting falls monotonically as servers are added", () => {
		// Erlang C is decreasing in c. If it is not, the recursion has gone wrong somewhere.
		const chart = chartOf(run({}));
		const points = chart.series[0]?.points as number[];
		for (let i = 1; i < points.length; i++) {
			assert.ok(
				(points[i] as number) <= (points[i - 1] as number),
				`waiting rose from ${points[i - 1]}% to ${points[i]}% when a server was added`,
			);
		}
	});

	it("the stability floor is above the offered load, never equal to it", () => {
		// At c = A the queue is unstable, so the floor has to be strictly greater. An integer load is the
		// case that gets this wrong: 10/s of 100ms is exactly 1 erlang, and one server is not enough.
		const parts = run({ rate: 10, service: 100 });
		assert.equal(value(parts, "Offered load"), "1.00 erlangs");
		assert.equal(value(parts, "Fewest that keep up"), "2");
	});
});

describe("the numerics hold where the textbook expression does not", () => {
	it("survives a load whose direct Erlang B would overflow", () => {
		/*
		 * 4000 erlangs needs a few thousand servers, and the direct form computes A^c / c! on the way. Both
		 * overflow to Infinity long before c = 4000, giving Infinity/Infinity and NaN. The recursion carries
		 * a probability the whole way, so this is only a loop.
		 */
		const parts = run({ rate: 20000, service: 200, target: 1 });
		const chosen = servers(parts);
		assert.ok(Number.isFinite(chosen) && chosen > 4000, `expected something over 4000 servers, got ${chosen}`);
		const waiting = asPercent(row(parts, chosen)["Wait at all"]!);
		assert.ok(Number.isFinite(waiting) && waiting <= 1, `chance of waiting came out as ${waiting}`);
	});

	it("a load far below one server still queues", () => {
		// The intuition this exists to correct: less than one erlang does not mean nobody waits, because
		// arrivals are random and collide. One server at 0.8 erlangs makes four arrivals in five wait.
		const parts = run({ rate: 1, service: 800, target: 20 });
		assert.equal(value(parts, "Offered load"), "0.80 erlangs");
		assert.ok(servers(parts) > 1);
	});
});

describe("the shape of the output", () => {
	it("draws one measure on one axis, so the target line belongs to the curve it crosses", () => {
		// Two axes once put a target meant for the percentage across a curve in milliseconds.
		const chart = chartOf(run({}));
		assert.equal(chart.series.length, 1);
		assert.equal(chart.yLabelRight, undefined);
		assert.equal(chart.thresholds?.[0]?.y, 5);
	});

	it("the table compares one fewer, the answer and one more, and only the misses are toned", () => {
		const parts = run({});
		const table = parts.find((p): p is Extract<Output, { kind: "table" }> => p.kind === "table");
		assert.ok(table);
		assert.deepEqual(
			table.rows.map((r) => (typeof r[0] === "object" ? r[0].text : r[0])),
			["10", "11", "12"],
		);
		assert.equal(row(parts, 10)["Your 5% target"], "Misses");
		assert.equal(row(parts, 11)["Your 5% target"], "Fewest that meet it");
		const toned = table.rows.flat().filter((c) => typeof c === "object" && c.tone);
		assert.equal(toned.length, 1, "only the row that misses the reader's target carries a tone");
	});

	it("annotates the answer on the chart", () => {
		const parts = run({});
		const chosen = servers(parts);
		const chart = chartOf(parts);
		assert.deepEqual(chart.annotations, [{ x: chosen, label: `${chosen} servers` }]);
	});

	it("simulating adds a part and changes nothing in the first one", () => {
		const plain = run({});
		const simulated = run({ mode: "simulate", trials: 20000 });
		assert.equal(simulated.length, plain.length + 1);
		assert.deepEqual(fieldsOf(simulated, 0), fieldsOf(plain, 0));
	});

	it("honours an already-aborted signal rather than running to completion", () => {
		// The reason this tool declares a worker: at two million trials the loop is long enough to matter,
		// so the runtime has to be able to stop it.
		const controller = new AbortController();
		controller.abort();
		assert.throws(
			() => tool.run({ ...defaults, mode: "simulate", trials: 2000000 }, { signal: controller.signal, progress: () => {} }),
			/abort/i,
		);
	});
});

describe("the wait limit and the percentiles", () => {
	it("a limit can only lower the count, never raise it", () => {
		// Waiting longer than T is a subset of waiting at all, so a target on it is never harder to meet.
		for (const [rate, service, target] of [[120, 45, 5], [500, 20, 1], [1, 800, 20], [40, 200, 20]] as const) {
			const any = servers(run({ rate, service, target }));
			for (const limit of [1, 10, 100, 1000]) {
				const over = servers(run({ rate, service, target, limit }));
				assert.ok(over <= any, `${rate}/s, ${service} ms, ${limit} ms limit: ${over} servers against ${any} for no wait`);
			}
		}
	});

	it("the share waiting past the p99 is 1%, read back through the tail", () => {
		// Invert the tail and put the answer back into it: the round trip has to land on the share asked for.
		for (const [load, c, service] of [[1, 3, 0.1], [0.8, 3, 0.8], [5.4, 10, 0.045], [10, 11, 0.02]] as const) {
			for (const p of [0.95, 0.99]) {
				const t = waitPercentile(load, c, service, p);
				if (t === 0) assert.ok(waitOver(load, c, service, 0) <= 1 - p, `a zero p${p * 100} needs that many never to wait`);
				else assert.ok(Math.abs(waitOver(load, c, service, t) - (1 - p)) < 1e-12, `${load} erlangs on ${c}: p${p * 100}`);
			}
		}
	});

	it("p95 never exceeds p99, and p99 is zero when that many never wait", () => {
		for (const [rate, service, target] of [[120, 45, 5], [10, 100, 10], [1, 800, 20], [500, 20, 1]] as const) {
			const parts = run({ rate, service, target });
			const chosen = servers(parts);
			const load = (rate * service) / 1000;
			assert.ok(waitPercentile(load, chosen, service / 1000, 0.95) <= waitPercentile(load, chosen, service / 1000, 0.99));
			for (const c of [chosen - 1, chosen, chosen + 1]) {
				if (c <= load) continue;
				const p99 = asMs(row(parts, c)["p99 wait"]!);
				const waiting = asPercent(row(parts, c)["Wait at all"]!);
				if (waiting <= 1) assert.equal(p99, 0, `${waiting}% wait with ${c}, so 99% do not, and p99 must be zero`);
			}
		}
	});

	it("the simulation agrees on the share waiting past the limit", () => {
		const parts = run({ rate: 500, service: 20, target: 1, limit: 10, mode: "simulate", trials: 400000 });
		const formula = asPercent(value(parts, "Waits over 10 ms", "Formula"));
		const simulated = asPercent(value(parts, "Waits over 10 ms", "Simulated"));
		assert.ok(Math.abs(formula - simulated) < 0.3, `formula ${formula}% against simulated ${simulated}%`);
	});

	it("leads with one key number and its arithmetic, and ends with the method", () => {
		const parts = run({});
		assert.equal(parts[0]?.role, "key");
		assert.equal(fieldsOf(parts, 0).length, 1);
		assert.equal(parts[0]?.kind === "fields" && parts[0].fields[0]?.tone, undefined, "a size is not a pass or a fail");
		assert.equal(parts[1]?.role, "formula");
		assert.equal(parts.at(-1)?.role, "method");
		assert.ok(!parts.some((p) => p.role === "verdict" || p.role === "stats"));
	});

	it("the mean wait is kept, in the method notes", () => {
		assert.equal(value(run({}), "Mean wait", "How this was worked out"), "203 µs");
	});
});
