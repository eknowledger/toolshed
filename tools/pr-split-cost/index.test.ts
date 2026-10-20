/**
 * Properties of the split rule a fixture cannot pin:
 *
 *  - the fit recovers a known elasticity through heavy scatter;
 *  - one after another is k^(1-e) exactly, and matches summing k simulated pickups of k-times-smaller PRs;
 *  - side by side sits between one sitting (no scatter) and one after another, for real-looking scatter;
 *  - the same input always gives the same output, because every draw is seeded;
 *  - the comparison comes first, the fit's weakness right under it, and in one sitting is never coloured as good news,
 *    because it rests on an assumption.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Output, Tool } from "@toolbench/sdk";
import tool from "./index.ts";

type Input = { pairs: string; source: string; elasticity: number; lines: number; split: number; review: string };
const impl: Tool<Input> = tool;
const ctx = { signal: new AbortController().signal, progress: () => {} };
const base: Input = { pairs: "", source: "fit", elasticity: 0.25, lines: 800, split: 8, review: "serial" };

function run(input: Partial<Input>): Output[] {
	const out = impl.run({ ...base, ...input }, ctx) as Output;
	assert.equal(out.kind, "group", out.kind === "error" ? out.message : "");
	return out.kind === "group" ? out.parts : [];
}
const value = (parts: Output[], prefix: string) => {
	for (const p of parts) if (p.kind === "fields") for (const f of p.fields) if (f.label.startsWith(prefix)) return f.value;
	throw new Error(`no field ${prefix}`);
};
const times = (v: string) => Number.parseFloat(v);
/** The fitted multiple for the way the reader picked: the comparison row marked as theirs. */
const picked = (parts: Output[]) => {
	const table = parts.find((p) => p.role === "comparison");
	assert.ok(table?.kind === "table");
	const row = table.rows.find((r) => (r[0] as { text: string }).text.endsWith("(your pick)"));
	assert.ok(row, "a row marked as the pick");
	return (row[1] as { text: string }).text;
};

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const gauss = (next: () => number) => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());

/** PRs with wait = 2 x size^e x lognormal scatter of the given spread, sizes 1 to about 3,000 lines. */
function prs(e: number, spread: number, n: number, seed: number): string {
	const next = rng(seed);
	return Array.from({ length: n }, () => {
		const size = Math.round(Math.exp(next() * 8)) + 1;
		return `${size},${(2 * size ** e * Math.exp(spread * gauss(next))).toFixed(3)}`;
	}).join("\n");
}

describe("the fit", () => {
	for (const e of [0.2, 0.45]) {
		it(`recovers e = ${e} from 1,500 noisy PRs, and its range contains it`, () => {
			const parts = run({ pairs: prs(e, 1.5, 1500, 11) });
			assert.ok(Math.abs(Number(value(parts, "Elasticity")) - e) < 0.06);
		});
	}
});

describe("the three ways", () => {
	const pairs = prs(0.3, 1.5, 1500, 4);
	it("one after another is exactly k^(1-e) of the fitted e", () => {
		for (const split of [2, 5, 8]) {
			const parts = run({ pairs, split });
			const e = Number(value(parts, "Elasticity"));
			assert.ok(Math.abs(times(picked(parts)) - split ** (1 - e)) < 0.011);
		}
	});

	it("side by side lies between one sitting and one after another, with real scatter", () => {
		for (const split of [2, 4, 8, 16]) {
			const serial = times(picked(run({ pairs, split, review: "serial" })));
			const side = times(picked(run({ pairs, split, review: "parallel" })));
			const sitting = times(picked(run({ pairs, split, review: "sitting" })));
			assert.ok(sitting < side && side < serial, `k=${split}: ${sitting} < ${side} < ${serial}`);
		}
	});

	it("the serial rule matches summing simulated pickups of the pieces", () => {
		// Draw waits from the model the data came from: k pieces of S/k, summed, against one PR of S.
		const next = rng(9);
		const e = 0.3;
		const k = 8;
		let one = 0;
		let pieces = 0;
		for (let i = 0; i < 40000; i++) {
			one += 2 * 800 ** e * Math.exp(0.8 * gauss(next));
			for (let j = 0; j < k; j++) pieces += 2 * (800 / k) ** e * Math.exp(0.8 * gauss(next));
		}
		assert.ok(Math.abs(pieces / one - k ** (1 - e)) < 0.08, `${pieces / one} vs ${k ** (1 - e)}`);
	});

	it("is deterministic", () => {
		const a = JSON.stringify(run({ pairs, review: "parallel" }));
		assert.equal(JSON.stringify(run({ pairs, review: "parallel" })), a);
	});
});

describe("the result's shape", () => {
	const pairs = prs(0.3, 1.5, 400, 5);
	it("leads with the comparison, then how weak the fit is, then its numbers, with no banner or tiles", () => {
		const parts = run({ pairs });
		assert.deepEqual(
			parts.slice(0, 3).map((p) => p.role),
			["comparison", undefined, "metrics"],
		);
		assert.ok(!parts.some((p) => p.role === "verdict" || p.role === "stats"));
		const evidence = parts[1]!;
		assert.ok(evidence.kind === "text" && /variation in wait across 400 PRs/.test(evidence.text));
	});

	it("orders the comparison slowest first", () => {
		const table = run({ pairs, split: 6 })[0]!;
		assert.ok(table.kind === "table");
		const multiples = table.rows.map((r) => times((r[1] as { text: string }).text));
		assert.deepEqual([...multiples].sort((p, q) => q - p), multiples);
	});

	it("never shows in one sitting as good, though it is the smallest wait", () => {
		const parts = run({ pairs, review: "sitting" });
		const table = parts[0]!;
		assert.ok(table.kind === "table");
		const sitting = table.rows.find((r) => (r[0] as { text: string }).text.startsWith("In one sitting"))!;
		for (const c of sitting) assert.equal((c as { tone?: string }).tone, "muted");
		for (const p of parts) {
			if (p.kind === "fields") for (const f of p.fields) assert.notEqual(f.tone, "good", f.label);
			if (p.kind === "table") for (const row of p.rows) for (const c of row) assert.ok(typeof c !== "object" || c.tone !== "good");
		}
	});
});
