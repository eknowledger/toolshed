/**
 * Properties of the fan-out formulas a fixture cannot pin:
 *
 *  - the closed form agrees with a direct simulation of requests made of independent calls, which is the claim the
 *    whole tool rests on, for one kind of call and for a mix of dependencies;
 *  - the per-call percentile, run forwards, gives back the target;
 *  - more calls never make fewer requests slow, and never let each call be slow more often;
 *  - the forgiving ways of writing an input read the same as the plain ones.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Output, Tool } from "@toolbench/sdk";
import tool from "./index.ts";

type Input = { calls: number; slow: string; target: string; dependencies: string };
const impl: Tool<Input> = tool;
const ctx = { signal: new AbortController().signal, progress: () => {} };
const base: Input = { calls: 20, slow: "0.5%", target: "p99", dependencies: "" };

function parts(over: Partial<Input>): Output[] {
	const out = impl.run({ ...base, ...over }, ctx) as Output;
	assert.equal(out.kind, "group", JSON.stringify(out));
	return out.kind === "group" ? out.parts : [];
}
function byRole(over: Partial<Input>, role: string) {
	const p = parts(over).find((x) => x.role === role);
	assert.ok(p, `no part with role ${role}`);
	return p;
}
/** The headline share, as a number of percent. */
function hit(over: Partial<Input>): number {
	const p = byRole(over, "key");
	return p.kind === "fields" ? Number.parseFloat(p.fields[0]!.value.replace(/[>%]/g, "")) : Number.NaN;
}
/** The percentile each call needs, read out of the answer sentence. */
function needed(over: Partial<Input>): number {
	const p = byRole(over, "answer");
	const m = p.kind === "text" ? /needs p(\d+(?:\.\d+)?)/.exec(p.text) : null;
	assert.ok(m, "no per-call percentile in the answer");
	return Number(m[1]);
}

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

/** The share of simulated requests with at least one slow call, and the formula's, within four standard errors. */
function agrees(deps: [calls: number, slowPercent: number][], seed: number) {
	const next = rng(seed);
	const requests = 40000;
	let slow = 0;
	for (let r = 0; r < requests; r++) {
		let any = false;
		for (const [n, q] of deps) for (let c = 0; c < n; c++) if (next() < q / 100) any = true;
		if (any) slow++;
	}
	const simulated = (100 * slow) / requests;
	const formula =
		deps.length === 1
			? hit({ calls: deps[0]![0], slow: `${deps[0]![1]}%` })
			: hit({ dependencies: deps.map(([n, q], i) => `d${i} ${n} ${q}%`).join("\n") });
	const se = 100 * Math.sqrt(((formula / 100) * (1 - formula / 100)) / requests);
	assert.ok(Math.abs(simulated - formula) < 4 * se + 0.05, `simulated ${simulated}%, formula ${formula}%`);
}

describe("the formula agrees with simulated requests", () => {
	for (const [calls, slow] of [
		[5, 2],
		[20, 0.5],
		[100, 1],
	] as const) {
		it(`${calls} calls, ${slow}% slow`, () => agrees([[calls, slow]], calls * 31 + slow * 7));
	}

	it("the checkout's twelve dependencies, each called its own number of times", () =>
		agrees(
			[
				[1, 0.1],
				[20, 0.5],
				[1, 1],
				[1, 0.2],
				[1, 2],
				[1, 0.5],
				[1, 1],
				[1, 0.1],
				[2, 0.5],
				[1, 0.3],
				[1, 1],
				[3, 0.1],
			],
			1234,
		));

	it("the per-call percentile, simulated as the slowest of 20 uniform calls, holds the request's p99", () => {
		const next = rng(99);
		const requests = Array.from({ length: 40001 }, () => {
			let worst = 0;
			for (let c = 0; c < 20; c++) worst = Math.max(worst, next());
			return worst;
		}).sort((a, b) => a - b);
		const p99 = 100 * requests[39600]!;
		assert.ok(Math.abs(p99 - needed({ calls: 20 })) < 0.01, `simulated p${p99.toFixed(3)}`);
	});
});

describe("backwards and forwards agree", () => {
	for (const [calls, target] of [
		[20, "p99"],
		[100, "p99.9"],
		[7, "p90"],
	] as const) {
		it(`${calls} calls at the needed percentile give back ${target}`, () => {
			const need = needed({ calls, target });
			const back = hit({ calls, target, slow: `p${need}` });
			const allowed = 100 - Number(target.slice(1));
			// The needed percentile is rounded for display, so allow the rounding to show in the third figure.
			assert.ok(Math.abs(back - allowed) / allowed < 0.02, `${back}% against ${allowed}%`);
		});
	}
});

describe("shape", () => {
	it("more calls never make fewer requests slow, or let each call be slow more often", () => {
		let lastHit = -1;
		let lastP = -1;
		for (const calls of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144]) {
			const h = hit({ calls, slow: "0.3%" });
			const p = needed({ calls });
			assert.ok(h >= lastHit, `${calls} calls: ${h}% after ${lastHit}%`);
			assert.ok(p >= lastP, `${calls} calls: p${p} after p${lastP}`);
			lastHit = h;
			lastP = p;
		}
	});

	it("another dependency never makes fewer requests slow", () => {
		assert.ok(hit({ dependencies: "a 10 1%\nb 0.1%" }) >= hit({ calls: 10, slow: "1%" }));
	});

	it("splitting one dependency's calls over two lines with the same share changes nothing", () => {
		assert.equal(hit({ dependencies: "a 20 0.4%\nb 5 0.4%" }), hit({ calls: 25, slow: "0.4%" }));
	});

	it("the one to fix first is the one that slows the most requests on its own, not the one with the worst share", () => {
		const table = parts({ dependencies: "shipping 1 2%\npricing 6 0.5%" }).find((p) => p.kind === "table");
		assert.ok(table && table.kind === "table");
		assert.equal(table.rows[0]![0], "pricing");
	});

	it("the fix-first table stays short however many dependencies there are", () => {
		const many = Array.from({ length: 30 }, (_, i) => `d${i} 1 ${(i + 1) / 10}%`).join("\n");
		const table = parts({ dependencies: many }).find((p) => p.kind === "table");
		assert.ok(table && table.kind === "table");
		assert.equal(table.rows.length, 5);
	});

	it("leads with the number, then its arithmetic, then the answer, and ends with the method", () => {
		for (const over of [{}, { dependencies: "a 3 1%\nb 1 2%" }]) {
			const roles = parts(over).map((p) => p.role);
			assert.deepEqual(roles.slice(0, 3), ["key", "formula", "answer"]);
			assert.equal(roles.at(-1), "method");
		}
	});
});

describe("forgiving input", () => {
	it("a percentile reads as the share over it", () => {
		assert.equal(hit({ slow: "p99" }), hit({ slow: "1%" }));
		assert.equal(hit({ slow: "P99.9" }), hit({ slow: "0.1" }));
	});

	it("the long form, the short form and a comma-separated line read the same", () => {
		const long = hit({ dependencies: "pricing: 20 calls, 0.5%\nads: 1 call, 5%" });
		assert.equal(hit({ dependencies: "pricing 20 0.5%\nads 1 5%" }), long);
		assert.equal(hit({ dependencies: "pricing 20 0.5%, ads 5%" }), long);
		assert.equal(hit({ dependencies: "pricing 20x 0.5%; ads p95" }), long);
	});

	it("a digit inside a name is not a count", () => {
		const table = parts({ dependencies: "s3 2 1%\nec2 metadata 0.5%" }).find((p) => p.kind === "table");
		assert.ok(table && table.kind === "table");
		assert.deepEqual(
			table.rows.map((r) => [r[0], typeof r[1] === "object" ? r[1].text : r[1]]),
			[
				["s3", "2"],
				["ec2 metadata", "1"],
			],
		);
	});

	it("an empty or comment-only list falls back to the inputs above it", () => {
		assert.equal(hit({ dependencies: "  \n# nothing yet\n" }), hit({}));
	});
});
