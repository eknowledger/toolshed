/**
 * Properties of retry amplification.
 *
 * `cases.json` pins the post's numbers. These pin the shape, which is the claim the tool exists to make:
 *
 *  - retry layers multiply, they do not add;
 *  - the average can never exceed the worst case, and with nothing failing it is exactly one call;
 *  - more failure never means fewer calls;
 *  - a budget caps every layer at 1 + budget, whatever the retry count;
 *  - every change offered lowers the worst case, the biggest cut comes first, and its number is the arithmetic
 *    run again with the change made;
 *  - the chain is one the runtime will draw, one node per service, and its bottom node carries the answer's count;
 *  - each Mesh preset fills the proxy retries its label names.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { graphProblem, type Output } from "@toolbench/sdk";
import tool, { bottomCalls } from "./index.ts";

type Values = { depth: number; mesh: number; app: number; client: number; fail: number; budget: string };
const d: Values = { depth: 3, mesh: 2, app: 0, client: 0, fail: 100, budget: "none" };

function run(values: Partial<Values>): Output[] {
	const out = tool.run({ ...d, ...values });
	assert.ok(!(out instanceof Promise));
	assert.equal(out.kind, "group", JSON.stringify(out));
	return out.kind === "group" ? out.parts : [];
}
/** The answer as the page shows it: "27 calls", "about 1.7 calls". */
const shown = (v: Partial<Values>) => {
	const key = run(v)[0];
	assert.ok(key?.kind === "fields" && key.role === "key");
	return key.fields[0]!.value;
};
/** The exact arithmetic behind it, which the page rounds once a budget or an average makes it fractional. */
const exact = (v: Partial<Values>) => {
	const x = { ...d, ...v };
	return bottomCalls(x.depth, x.mesh, x.app, x.client, x.fail / 100, x.budget === "none" ? null : Number(x.budget) / 100);
};
const worst = (v: Partial<Values>) => exact(v).worst;
const avg = (v: Partial<Values>) => exact(v).expected;
const formula = (v: Partial<Values>) => {
	const f = run(v)[1];
	assert.ok(f?.kind === "text" && f.role === "formula");
	return f.text;
};

describe("layers multiply", () => {
	it("code retries around proxy retries give the product per call, not the sum", () => {
		assert.match(formula({ app: 2 }), /^9 tries per call \(3 in the code, each through 3 in the proxy\)/);
		assert.equal(worst({ app: 2, depth: 1 }), 9);
	});

	it("the bottom sees attempts to the power of the depth", () => {
		for (let depth = 1; depth <= 6; depth++) {
			for (const mesh of [0, 1, 2, 3]) {
				assert.equal(worst({ depth, mesh }), (1 + mesh) ** depth);
				const n = (1 + mesh) ** depth;
				assert.equal(shown({ depth, mesh }), `${n.toLocaleString("en-US")} ${n === 1 ? "call" : "calls"}`);
			}
		}
	});

	it("a client retrying around the whole chain multiplies once more", () => {
		assert.equal(worst({ client: 2 }), 3 * 27);
	});
});

describe("the average", () => {
	it("is one call when nothing fails, and the worst case when everything does", () => {
		assert.equal(avg({ fail: 0, app: 1, client: 1 }), 1);
		assert.equal(avg({ fail: 100, app: 1 }), worst({ app: 1 }));
	});

	it("never falls as the failure share rises", () => {
		let last = 0;
		for (let fail = 0; fail <= 100; fail += 5) {
			const now = avg({ fail });
			assert.ok(now >= last, `${fail}%: ${now} after ${last}`);
			last = now;
		}
	});
});

describe("a budget", () => {
	it("caps each layer at 1 + budget, however many retries are configured", () => {
		for (const mesh of [1, 2, 5]) assert.ok(Math.abs(worst({ mesh, budget: "20" }) - 1.728) < 1e-12);
		assert.ok(Math.abs(worst({ budget: "10" }) - 1.331) < 1e-12);
	});

	it("shows a capped count to one decimal, because the cap is a model and not a measurement", () => {
		assert.equal(shown({ budget: "20" }), "about 1.7 calls");
		assert.equal(shown({ budget: "10" }), "about 1.3 calls");
	});

	it("leaves no retries alone when there are none", () => {
		assert.equal(worst({ mesh: 0, budget: "20" }), 1);
	});
});

describe("bad input", () => {
	it("names the input it refuses", () => {
		const out = tool.run({ ...d, mesh: -1 });
		assert.ok(!(out instanceof Promise));
		assert.equal(out.kind, "error");
		assert.equal(out.kind === "error" ? out.input : "", "mesh");
	});
});

describe("what to change", () => {
	const inputs: Partial<Values>[] = [{}, { app: 2 }, { client: 2, depth: 4, mesh: 1 }, { fail: 50 }, { budget: "20" }, { mesh: 0 }];
	const cells = (v: Partial<Values>) => {
		const t = run(v).find((p) => p.role === "comparison");
		assert.ok(t && t.kind === "table");
		return t.rows.map((r) => String(typeof r[1] === "object" ? r[1].text : r[1]));
	};
	const actions = (v: Partial<Values>) =>
		cells(v).map((text) => Number.parseFloat(text.replace(/^about /, "").replace(/,/g, "")));

	it("every change leaves fewer calls at the bottom, biggest cut first", () => {
		for (const v of inputs) {
			if (worst(v) <= 2) continue;
			const after = actions(v);
			for (const a of after) assert.ok(a < worst(v), `${JSON.stringify(v)}: ${a} is not under ${worst(v)}`);
			assert.deepEqual([...after].sort((a, b) => a - b), after);
		}
	});

	it("each number is the tool run again with that change made", () => {
		const [budgeted, topOnly, oneLayer] = cells({ app: 2 });
		const bare = (text: string) => text.replace(/ calls?$/, "");
		assert.equal(budgeted, bare(shown({ app: 2, budget: "20" })));
		assert.equal(topOnly, bare(shown({ app: 2, depth: 1 })));
		assert.equal(oneLayer, bare(shown({ app: 0 })));
	});

	it("offers no changes when nothing retries, rather than a row saying so", () => {
		assert.equal(run({ mesh: 0 }).find((p) => p.role === "comparison"), undefined);
	});
});

describe("the chain", () => {
	it("is drawable, one node per service, and its bottom node carries the answer's count", () => {
		for (const v of [{}, { app: 2 }, { client: 3 }, { depth: 12, mesh: 10, app: 10 }, { budget: "10" }] as Partial<Values>[]) {
			const g = run(v).find((p) => p.kind === "graph");
			assert.ok(g && g.kind === "graph");
			assert.equal(graphProblem(g.graph), undefined);
			const depth = v.depth ?? d.depth;
			assert.equal(g.graph.nodes.length, depth + 2, "the user, then every service once");
			assert.equal(g.graph.nodes.find((n) => n.id === `s${depth}`)?.note, shown(v));
		}
	});

	it("labels every hop with what it multiplies by", () => {
		const g = run({}).find((p) => p.kind === "graph");
		assert.ok(g && g.kind === "graph");
		assert.deepEqual(
			g.graph.edges.map((e) => e.label ?? ""),
			["", "x3", "x3", "x3"],
		);
	});
});

describe("the order", () => {
	it("leads with the number and its arithmetic, then the chain, then the changes, and says the number once", () => {
		const parts = run({});
		assert.deepEqual(
			parts.map((p) => `${p.kind}${p.role ? `:${p.role}` : ""}`),
			["fields:key", "text:formula", "graph", "table:comparison", "fields:method"],
		);
		assert.ok(parts.every((p) => p.kind !== "fields" || p.fields.every((f) => f.tone === undefined)), "a count is not a verdict");
	});
});

describe("the Mesh presets", () => {
	type Option = { value: string; label: string; sets?: { mesh: number } };
	const manifest = JSON.parse(readFileSync(new URL("./tool.json", import.meta.url), "utf8"));
	const options: Option[] = manifest.inputs.find((i: { id: string }) => i.id === "platform").options;
	const preset = (value: string) => options.find((o) => o.value === value)?.sets?.mesh;

	it("fill the defaults the documentation gives: Istio 2, Linkerd 1 once turned on, none 0", () => {
		assert.equal(preset("istio"), 2);
		assert.equal(preset("linkerd"), 1);
		assert.equal(preset("none"), 0);
		assert.equal(preset("custom"), undefined, "Custom leaves the number as typed");
	});

	it("each label names the number it fills, so the select never says one thing and does another", () => {
		for (const o of options) if (o.sets) assert.match(o.label, o.sets.mesh === 0 ? /no proxy retries/ : new RegExp(`${o.sets.mesh} retr`));
	});

	it("give 27, 8 and 1 calls at the bottom of three calls while it is down", () => {
		assert.equal(worst({ mesh: preset("istio") }), 27);
		assert.equal(worst({ mesh: preset("linkerd") }), 8);
		assert.equal(worst({ mesh: preset("none") }), 1);
	});
});
