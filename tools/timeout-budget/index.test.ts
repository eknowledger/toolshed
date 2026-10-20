/**
 * Properties of the timeout budget checker.
 *
 *  - a chain whose timeouts shrink going down, with room for every retry, reports nothing wrong, and no banner;
 *  - lengthening a lower timeout past what its caller allows is exactly what it reports;
 *  - a missing timeout makes the worst case unbounded only when nothing above has one either;
 *  - the worst case never shrinks when a retry is added;
 *  - every fix it suggests, applied, makes that call's tries fit;
 *  - the chain it draws is one the runtime will draw, with the broken calls marked.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { graphProblem, type Output } from "@toolbench/sdk";
import tool from "./index.ts";

function run(chain: string, deadline = 2000, backoff = 25): Output[] {
	const out = tool.run({ chain, deadline, backoff });
	assert.ok(!(out instanceof Promise));
	assert.equal(out.kind, "group", JSON.stringify(out));
	return out.kind === "group" ? out.parts : [];
}
const field = (parts: Output[], label: string) => {
	const hit = parts.flatMap((p) => (p.kind === "fields" ? p.fields : [])).find((x) => x.label === label);
	assert.ok(hit, label);
	return hit.value;
};
const text = (c: unknown) => (typeof c === "object" && c !== null ? (c as { text: string }).text : String(c));
/** The failing-boundary table's rows as [call, allowed, needs, fit, set per-try to], or [] when every call fits. */
const failing = (parts: Output[]) => {
	const t = parts.find((p) => p.role === "comparison");
	return t && t.kind === "table" ? t.rows.map((r) => r.map(text)) : [];
};
/** The other changes, as [call, change], or [] when there are none. */
const others = (parts: Output[]) => {
	const t = parts.find((p) => p.kind === "table" && p.role === undefined && p.caption !== "Each call, top first, when the bottom hangs");
	return t && t.kind === "table" ? t.rows.map((r) => r.map(text)) : [];
};
/** The worst case, read back from the top row of the detail table. */
const worstOf = (parts: Output[]) => {
	const t = parts.find((p) => p.kind === "table" && p.caption === "Each call, top first, when the bottom hangs");
	assert.ok(t && t.kind === "table");
	return text(t.rows[0]![3]);
};
const seconds = (text: string) =>
	text === "unbounded"
		? Number.POSITIVE_INFINITY
		: text.endsWith(" ms")
			? Number.parseFloat(text) / 1000
			: Number.parseFloat(text);

describe("a chain that fits", () => {
	it("leads with the quiet answer, and lists no change at all", () => {
		const parts = run("a -> b 1s 1\nb -> c 400ms 1\nc -> d 150ms 1");
		assert.deepEqual(
			parts.map((p) => [p.kind, p.role]),
			[
				["fields", "answer"],
				["graph", undefined],
				["table", undefined],
				["fields", "method"],
			],
		);
		assert.equal(field(parts, "Worst case when the bottom hangs"), worstOf(parts));
		assert.deepEqual(failing(parts), []);
		assert.deepEqual(others(parts), []);
	});
});

describe("the caller's deadline", () => {
	it("is a banner only when the chain cannot finish inside it", () => {
		const over = run("a -> b none 1\nb -> c 500ms 2", 1000);
		assert.equal(over[0]?.role, "verdict");
		assert.equal(over[0]?.kind === "fields" ? over[0].fields[0]!.tone : undefined, "bad");
		// Fits the deadline, but c -> d's tries do not fit inside b -> c's: the table leads, with no banner.
		const under = run("a -> b 1s 1\nb -> c 400ms 1\nc -> d 300ms 1");
		assert.equal(under[0]?.role, "comparison");
		assert.ok(!under.some((p) => p.role === "verdict"));
	});

	it("counts a top call whose tries can't finish inside it", () => {
		// One try of a -> b can take 1.55 s, so 2 tries and a backoff are 3.13 s; the caller waits 1 s, so none of a's 2 tries finishes.
		const parts = run("a -> b none 1\nb -> c 500ms 2", 1000);
		assert.deepEqual(failing(parts), [["a -> b", "1.00 s", "3.13 s", "0/2", "487 ms or less"]]);
	});

	it("leaves a top call alone when it fits", () => {
		assert.deepEqual(failing(run("a -> b 1s 0\nb -> c 400ms 1", 2000)), []);
	});
});

describe("a lower timeout that is too long", () => {
	it("is reported, and only it, on its own row", () => {
		const parts = run("a -> b 1s 1\nb -> c 400ms 1\nc -> d 300ms 1");
		assert.deepEqual(failing(parts), [["c -> d", "400 ms", "625 ms", "1/2", "187 ms or less"]]);
		assert.deepEqual(others(parts), [["c -> d", "Or do not retry it, or give b -> c at least 625 ms per try."]]);
	});

	it("is marked on the same call in the detail table, not on its caller", () => {
		const parts = run("frontend -> checkout none 2\ncheckout -> pricing 1s 2\npricing -> inventory 500ms 2");
		const t = parts.find((p) => p.kind === "table" && p.caption === "Each call, top first, when the bottom hangs");
		assert.ok(t && t.kind === "table");
		const bad = t.rows.filter((r) => (r[4] as { tone?: string }).tone === "bad").map((r) => text(r[0]));
		assert.deepEqual(bad, failing(parts).map((r) => r[0]));
	});
});

describe("no timeout", () => {
	it("leaves the worst case unbounded when nothing above sets one", () => {
		assert.equal(worstOf(run("a -> b none 0\nb -> c none 0")), "unbounded");
	});

	it("is bounded by the nearest timeout above it", () => {
		assert.equal(worstOf(run("a -> b 1s 0\nb -> c none 2")), "1.00 s");
	});
});

describe("retries", () => {
	it("never shorten the worst case", () => {
		let last = 0;
		for (let r = 0; r <= 5; r++) {
			const now = seconds(worstOf(run(`a -> b 1s ${r}\nb -> c 300ms 1`)));
			assert.ok(now >= last, `${r} retries: ${now} after ${last}`);
			last = now;
		}
	});

	it("multiply at the bottom", () => {
		assert.equal(
			field(run("a -> b none 2\nb -> c 1s 2\nc -> d 500ms 2"), "If the bottom fails fast instead"),
			"27 tries reach it, when every layer retries the error.",
		);
	});
});

describe("the fixes", () => {
	const chains = [
		"frontend -> checkout none 2\ncheckout -> pricing 1s 2\npricing -> inventory 500ms 2",
		"a -> b 1s 1\nb -> c 400ms 1\nc -> d 300ms 1",
		"a -> b 2s 3\nb -> c 1s 4",
	];
	it("a suggested per-try timeout, put in its place, makes that call fit", () => {
		for (const chain of chains) {
			const lines = chain.split("\n");
			for (const [call, , , , set] of failing(run(chain))) {
				const m = /^(\d[\d.]* m?s) or less$/.exec(set!);
				if (!m) continue;
				const i = lines.findIndex((l) => l.startsWith(`${call!.split(" -> ")[0]} ->`));
				const fixed = lines.map((l, j) => (j === i ? l.replace(/\s(none|[\d.]+m?s)\s/, ` ${m[1]!.replace(" ", "")} `) : l));
				const after = failing(run(fixed.join("\n")));
				assert.ok(!after.some((r) => r[0] === call), `${call} still broken after ${m[1]}`);
			}
		}
	});
	it("says nothing it has already said: no row of the other changes repeats the timeout to set", () => {
		for (const chain of chains) for (const [, change] of others(run(chain))) assert.doesNotMatch(change!, /per-try timeout of/);
	});
});

describe("the chain it draws", () => {
	it("is drawable, marks every broken call, and highlights the first", () => {
		const parts = run("frontend -> checkout none 2\ncheckout -> pricing 1s 2\npricing -> inventory 500ms 2");
		const g = parts.find((p) => p.kind === "graph");
		assert.ok(g && g.kind === "graph");
		assert.equal(graphProblem(g.graph), undefined);
		const bad = g.graph.edges.filter((e) => e.tone === "bad").map((e) => `${e.from}>${e.to}`);
		assert.deepEqual(bad, ["n0>n1", "n2>n3"]);
		assert.deepEqual(g.graph.highlight, ["n0", "n1"]);
	});

	it("highlights nothing when everything fits", () => {
		const g = run("a -> b 1s 1\nb -> c 400ms 1\nc -> d 150ms 1").find((p) => p.kind === "graph");
		assert.ok(g && g.kind === "graph");
		assert.equal(g.graph.highlight, undefined);
		assert.equal(g.graph.edges.filter((e) => e.tone === "bad").length, 0);
	});
});
