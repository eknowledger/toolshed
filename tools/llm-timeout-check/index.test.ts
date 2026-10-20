/**
 * Properties of the LLM timeout check that single fixtures cannot pin.
 *
 *   pnpm test
 *
 *  - the read timeout never bounds a trickle: only max_tokens or an attempt deadline does;
 *  - an attempt deadline never makes anything longer;
 *  - the advice it gives, when followed, brings the silent and trickling shapes within the acceptable wait;
 *  - backoff doubles from 0.5 s and stops at 8 s, as the SDKs compute it before jitter;
 *  - the banner appears only over the reader's wait, the table is worst first, and each stack preset fills only what
 *    its SDK sets;
 *  - the chart leaves out the overloaded attempt, which is immediate, rather than drawing it at zero on a log axis.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Output } from "@toolbench/sdk";
import tool, { advice, backoffs, dur, shapes } from "./index.ts";

const base = { stack: "python", read: 600, retries: 2, deadline: 0, turns: 10, maxtokens: 4096, patience: 120 };
const run = (i: Partial<typeof base>) => tool.run({ ...base, ...i }) as Output;
/** The result's parts in order: the banner or the answer, the three failures, the chart, what it assumes. */
const parts = (i: Partial<typeof base>) => {
	const o = run(i);
	assert.equal(o.kind, "group");
	const [head, table, chart, method] = (o as Extract<Output, { kind: "group" }>).parts;
	assert.ok(
		head?.kind === "fields" && table?.kind === "table" && chart?.kind === "series" && method?.kind === "fields",
	);
	assert.deepEqual([table.role, method.role], ["comparison", "method"]);
	return { head, chart: chart.chart, table, method };
};

describe("llm-timeout-check", () => {
	it("a longer read timeout does not shorten or lengthen a trickle", () => {
		assert.equal(shapes({ ...base, read: 600 })[1]!.task, shapes({ ...base, read: 30 })[1]!.task);
		assert.match(shapes(base)[1]!.endedBy, /^Only max_tokens ends it/);
	});

	it("max_tokens bounds a trickle: doubling it doubles the trickle", () => {
		assert.equal(shapes({ ...base, maxtokens: 8192 })[1]!.task, 2 * shapes(base)[1]!.task);
	});

	it("an attempt deadline never makes a shape longer", () => {
		for (const deadline of [1, 5, 30, 600, 5000]) {
			const a = shapes(base);
			const b = shapes({ ...base, deadline });
			for (let n = 0; n < 3; n++) assert.ok(b[n]!.task <= a[n]!.task, `deadline ${deadline}, shape ${n}`);
		}
	});

	it("following the advice fits the acceptable wait", () => {
		for (const patience of [60, 120, 600]) {
			const i = { ...base, patience };
			const worst = shapes(i)[1]!;
			const a = advice(i, worst);
			const m = /attempt deadline of (\d+) s/.exec(a.text);
			assert.ok(m, a.text);
			const fixed = shapes({ ...i, deadline: Number(m![1]) });
			assert.ok(fixed[0]!.task <= patience && fixed[1]!.task <= patience, `patience ${patience}`);
		}
	});

	it("asks for fewer retries or turns when no deadline can fit", () => {
		// 10 turns of backoff alone take 15 s, so 30 s leaves under a second per attempt.
		assert.equal(
			advice({ ...base, patience: 30 }, shapes({ ...base, patience: 30 })[1]!).text,
			"Use fewer retries or turns, then set an attempt deadline.",
		);
	});

	it("within the wait, leads with a quiet answer and tones nothing", () => {
		const { head, table } = parts({ read: 10, retries: 1, deadline: 3, turns: 4, maxtokens: 1024, patience: 60 });
		assert.equal(head.role, "answer");
		assert.equal(head.fields[0]?.tone, undefined);
		for (const row of table.rows) assert.equal((row[3] as { tone?: string }).tone, undefined);
		assert.equal(advice({ ...base, patience: 60 }, shapes(base)[2]!).text, "It stops after 15 s, inside the wait.");
	});

	it("a read timeout shorter than the trickle's gap fires mid-stream and is not retried", () => {
		const t = shapes({ ...base, read: 0.4 })[1]!;
		assert.equal(t.call, 0.4);
		assert.match(t.endedBy, /mid-stream/);
	});

	it("backoff doubles from 0.5 s and stops at 8 s", () => {
		assert.deepEqual(backoffs(6), [0.5, 1, 2, 4, 8, 8]);
	});

	it("leaves the immediate refusal off the log axis instead of drawing a zero", () => {
		const { chart } = parts({});
		assert.equal(chart.series[0]?.points[2], null);
		assert.equal(chart.yScale, "log");
		assert.equal(chart.thresholds?.[0]?.y, 120);
	});

	it("over the wait, a one-field banner carries the worst case and the setting, and the table is worst first", () => {
		const { head, table } = parts({});
		assert.equal(head.role, "verdict");
		assert.deepEqual(
			head.fields.map((f) => [f.label, f.value, f.note, f.tone]),
			[["Over your 2 min wait", "Up to 5.7 h for one 10-turn task", "Set an attempt deadline of 3 s or less.", "bad"]],
		);
		assert.deepEqual(
			table.rows.map((r) => [r[0], r[4]]),
			[
				["Trickling", "max_tokens only"],
				["Silent", "read timeout, then retries"],
				["Overloaded", "retry limit"],
			],
		);
	});

	it("names a second setting when the worst case's does not cover another failure over the wait", () => {
		// 25 turns of backoff for 2 retries is 37.5 s, so a 30 s wait leaves no deadline that fits, and the refusals overrun too.
		const { head } = parts({ patience: 30, turns: 25 });
		assert.match(head.fields[0]!.note!, /Overloaded: use fewer retries or turns\.$/);
	});

	it("draws only the reader's wait as a threshold, not a fixed hour", () => {
		assert.deepEqual(
			parts({}).chart.thresholds?.map((x) => x.y),
			[120],
		);
	});

	it("each stack preset fills only what that SDK sets by default", () => {
		const manifest = JSON.parse(readFileSync(new URL("./tool.json", import.meta.url), "utf8")) as {
			inputs: { id: string; options?: { value: string; sets?: Record<string, number> }[] }[];
		};
		const stack = manifest.inputs.find((x) => x.id === "stack");
		const sets = Object.fromEntries((stack?.options ?? []).map((o) => [o.value, o.sets]));
		assert.deepEqual(sets, {
			python: { read: 600, retries: 2 },
			agents: { read: 600, retries: 2, turns: 10 },
			custom: undefined,
		});
	});

	it("names durations in the unit a person would use", () => {
		assert.deepEqual([dur(15), dur(918), dur(20480), dur(864000)], ["15 s", "15.3 min", "5.7 h", "10 days"]);
	});

	it("points at the input that is out of range", () => {
		assert.deepEqual(run({ retries: 1.5 }), {
			kind: "error",
			message: "Retries are a whole number.",
			input: "retries",
		});
		assert.deepEqual(run({ patience: 0 }), {
			kind: "error",
			message: "The wait is between 1 s and a day.",
			input: "patience",
		});
	});
});
