/**
 * Properties of the overload simulator.
 *
 * `cases.json` pins the post's numbers, which came from the Python version first. What a fixture cannot say is
 * that the model has the right shape. These are the claims that make that checkable:
 *
 *  - every person ends in exactly one outcome, so the three shares add up;
 *  - the derived bound never makes anybody wait for nothing;
 *  - whether a spike can leave it stuck, and "This run", agree with what the simulation does, including near the
 *    boundary and when the service is overloaded without a spike;
 *  - orders first changes who is answered, not how many;
 *  - the comparison comes first, and every change it suggests is backed by a run at the same numbers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Output } from "@toolbench/sdk";
import tool from "./index.ts";

type Values = { workers: number; service: number; base: number; spike: number; timeout: number; retries: number; policy: string };
const shop: Values = { workers: 8, service: 80, base: 70, spike: 150, timeout: 2, retries: 0, policy: "fifo" };
const ctx = { signal: new AbortController().signal, progress: () => {} };

function run(values: Partial<Values>): Output[] {
	const out = tool.run({ ...shop, ...values }, ctx);
	assert.ok(!(out instanceof Promise));
	assert.equal(out.kind, "group", JSON.stringify(out));
	return out.kind === "group" ? out.parts : [];
}
const value = (parts: Output[], label: string): string => {
	const hit = parts.flatMap((p) => (p.kind === "fields" ? p.fields : [])).find((f) => f.label === label);
	assert.ok(hit, `no field "${label}"`);
	return hit.value;
};
const percent = (text: string) => Number.parseFloat(text);

/** The outcome bars: per policy, in the chart's order, the three shares. The reader's policy is the first bar. */
function outcomes(parts: Output[]): Map<string, { answered: number; refused: number; waited: number }> {
	const chart = parts[0];
	assert.ok(chart?.kind === "series" && chart.chart.xLabel === "Policy", "the outcome bars come first");
	const by = (label: string) => chart.chart.series.find((s) => s.label === label)?.points as number[];
	const [answered, refused, waited] = [by("Answered in time"), by("Refused at once"), by("Waited for nothing")];
	assert.deepEqual(
		chart.chart.series.map((s) => s.label),
		["Answered in time", "Waited for nothing", "Refused at once"],
		"the failure takes the second colour, orange, never the third, green",
	);
	return new Map(chart.chart.x.map((x, i) => [String(x).replace(/ \(yours\)$|, yours\)$/, (m) => (m.startsWith(",") ? ")" : "")), { answered: answered![i]!, refused: refused![i]!, waited: waited![i]! }]));
}
const yours = (parts: Output[]) => [...outcomes(parts).values()][0]!;

/**
 * Whether a spike can leave it stuck, as the note says it: "yes", "no", "borderline", or "overloaded". The field's
 * label changes with the case, so it is found as the first field of the part that holds "This run".
 */
function could(parts: Output[]): string {
	const part = parts.find((p) => p.kind === "fields" && p.fields.some((f) => f.label === "This run"));
	assert.ok(part?.kind === "fields");
	const note = part.fields[0]?.note ?? "";
	if (/^Overloaded without a spike/.test(note)) return "overloaded";
	if (/chance decides/.test(note)) return "borderline";
	if (/a spike can leave it stuck/.test(note)) return "yes";
	if (/a spike cannot leave it stuck/.test(note)) return "no";
	throw new Error(`no conclusion in "${note}"`);
}

describe("the outcomes", () => {
	it("add up to everyone, for every policy", () => {
		for (const policy of ["fifo", "fifo_skip", "bounded", "priority", "codel", "lifo"]) {
			for (const retries of [0, 3]) {
				const parts = run({ policy, retries });
				for (const [name, o] of outcomes(parts)) {
					const sum = o.answered + o.refused + o.waited;
					assert.ok(Math.abs(sum - 100) <= 0.15, `${policy}, ${retries} retries, ${name}: ${sum}`);
				}
			}
		}
	});

	it("are the same on every run of the same input", () => {
		assert.deepEqual(run({ policy: "lifo", retries: 1 }), run({ policy: "lifo", retries: 1 }));
	});
});

describe("the derived bound", () => {
	it("never makes anyone wait for nothing", () => {
		for (const spike of [120, 150, 300]) {
			for (const timeout of [1, 2, 4]) {
				assert.equal(yours(run({ policy: "bounded", spike, timeout })).waited, 0, `${spike}/s, ${timeout} s`);
			}
		}
	});
});

describe("could a spike leave it stuck, and did it", () => {
	it("yes, and it is: the shop with 3 retries", () => {
		const parts = run({ retries: 3 });
		assert.equal(could(parts), "yes");
		assert.equal(value(parts, "This run"), "stuck to the end");
	});

	it("yes, but this spike was below capacity, so this run recovered at once", () => {
		const parts = run({ retries: 1, spike: 50 });
		assert.equal(could(parts), "yes");
		assert.equal(value(parts, "This run"), "recovered at once");
	});

	it("counts only the tries that fit in a person's patience", () => {
		// A 9 s timeout leaves room for one try in 10 s, so 3 retries change nothing: 70/s against 100/s.
		const parts = run({ retries: 3, timeout: 9 });
		assert.equal(could(parts), "no");
		assert.notEqual(value(parts, "This run"), "stuck to the end");
	});

	it("says still draining, not stuck, when the backlog simply outlasts the run", () => {
		assert.equal(value(run({ spike: 200, timeout: 4 }), "This run"), "still draining at the end");
	});

	it("calls the boundary borderline rather than yes or no", () => {
		assert.equal(could(run({ retries: 1, base: 48 })), "borderline");
		assert.equal(could(run({ retries: 1, base: 50 })), "borderline");
	});

	it("checks the normal rate against capacity first", () => {
		// 5 workers at 80 ms is 62.5/s, under the normal 70/s.
		assert.equal(could(run({ policy: "bounded", workers: 5 })), "overloaded");
	});

	it("says no for the bounded policies and the queue timeout, however many retries", () => {
		for (const policy of ["bounded", "priority", "codel", "lifo"]) {
			const parts = run({ policy, retries: 5 });
			assert.equal(could(parts), "no", policy);
			assert.equal(value(parts, "This run"), "recovered at once", policy);
		}
	});
});

describe("orders first", () => {
	it("answers every order without changing the total by more than a point", () => {
		const plain = run({ policy: "bounded" });
		const first = run({ policy: "priority" });
		assert.equal(value(first, "Orders answered"), "100.0%");
		const a = yours(plain).answered;
		const b = yours(first).answered;
		assert.ok(Math.abs(a - b) <= 1, `${a} against ${b}`);
	});
});

describe("the comparison", () => {
	it("has a row per policy, the reader's first and named as theirs, and the table agrees with the bars", () => {
		const parts = run({ policy: "codel" });
		const table = parts[1];
		assert.ok(table?.kind === "table" && table.role === "comparison");
		assert.equal(table.rows.length, 6);
		assert.equal(table.rows[0]?.[0], "Queue timeout (CoDel, yours)");
		assert.ok(table.rows.flat().every((c) => typeof c !== "object"), "no cell is toned: being current is not a judgement");
		const bars = [...outcomes(parts).values()];
		table.rows.forEach((row, i) => assert.equal(percent(String(row[1])), bars[i]!.answered));
	});

	it("pins the post's numbers for every policy at the shop's sale", () => {
		// From backpressure/shed_sim.py, the same simulation event for event: answered, refused at once, waited for nothing.
		const want: Record<string, [number, number, number]> = {
			"Unbounded queue": [8.4, 0, 91.6],
			"Skip the abandoned": [19.5, 0, 80.5],
			"Bounded queue": [67.1, 32.9, 0],
			"Bounded, orders first": [67.1, 32.9, 0],
			"Queue timeout (CoDel)": [64.4, 35.6, 0],
			"Newest first (LIFO + CoDel)": [64.3, 35.7, 0],
		};
		const got = outcomes(run({}));
		for (const [name, [answered, refused, waited]] of Object.entries(want)) assert.deepEqual(got.get(name), { answered, refused, waited }, name);
	});
});

describe("the order and what to change", () => {
	const actions = (parts: Output[]) => {
		const t = parts.find((p) => p.role === "actions");
		assert.ok(t && t.kind === "table");
		return t.rows.map((r) => r.map((c) => (typeof c === "object" ? c.text : String(c))));
	};

	it("leads with the comparison, never a banner or a row of stat tiles", () => {
		const parts = run({});
		assert.deepEqual(
			parts.map((p) => `${p.kind}${p.role ? `:${p.role}` : ""}`),
			["series", "table:comparison", "series", "fields", "table:actions", "fields:metrics"],
		);
		assert.ok(!parts.some((p) => p.role === "verdict" || p.role === "stats"));
	});

	it("suggests a policy only with the numbers that policy got in the comparison", () => {
		const parts = run({});
		const row = actions(parts).find((r) => r[0]!.startsWith("Switch to"));
		assert.ok(row);
		const bounded = outcomes(parts).get("Bounded queue")!;
		assert.ok(row[1]!.startsWith(`${bounded.answered.toFixed(1)}% answered`), row[1]);
		assert.ok(row[1]!.includes(`${bounded.waited.toFixed(1)}% wait for nothing`), row[1]);
	});

	it("says to retry less exactly when a spike could leave it stuck", () => {
		for (const v of [{ retries: 3 }, { retries: 1, spike: 50 }, { retries: 3, timeout: 9 }, { policy: "bounded", retries: 5 }]) {
			const parts = run(v);
			const verdict = could(parts);
			const retryRow = (parts.some((p) => p.role === "actions") ? actions(parts) : []).some((r) => /^(Do not retry|Retry at most)/.test(r[0]!));
			assert.equal(retryRow, verdict === "yes" || verdict === "borderline", JSON.stringify(v));
		}
	});

	it("leaves out what to change when there is nothing to change", () => {
		assert.ok(!run({ policy: "lifo", spike: 70 }).some((p) => p.role === "actions"));
	});
});
