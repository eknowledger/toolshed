/**
 * Properties of the state-machine-analyzer tool that single fixtures cannot pin.
 *
 *   pnpm test
 *
 *  - the booking sample with every cell decided is booking.py's table, all 119 cells, and the first drawing is its
 *    TRANSITIONS and nothing else;
 *  - the order blocks are written in never changes a cell, and neither do indentation, spacing or blank lines;
 *  - the narrower rule wins, and two equally narrow rules that disagree leave the cell open as a conflict;
 *  - "anything else" decides only what nothing else did;
 *  - the grid, the markdown, the skeleton and the headline agree on which cells are open, and the markdown is the
 *    grid, row for row, except that a reject keeps its word there;
 *  - every outcome reads in words, and only undecided, disputed and deferred cells carry a warning tone;
 *  - the graph draws one arrow per pair of states that a move joins, and nothing for an outcome that stays put;
 *  - the result leads with one coverage line, then the grid with the least-decided events on top, then the graph.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { graphProblem, type Output } from "@toolbench/sdk";
import tool, { key, type Machine, mainPath, mark, parse, skeleton } from "./index.ts";

const manifest = JSON.parse(readFileSync(new URL("./tool.json", import.meta.url), "utf8")) as {
	samples: { label: string; input: { machine: string } }[];
};
const sample = (label: string) => {
	const s = manifest.samples.find((x) => x.label === label);
	assert.ok(s, label);
	return s.input.machine;
};

/** Each cell as booking.py's table() names it: the next state for a move, else the kind. "(resume)" is back. */
const said = (m: Machine) =>
	new Map(
		[...m.cells].map(([k, o]) => [
			k,
			o === null ? null : o.kind === "move" ? o.to : o.kind === "back" ? "(resume)" : o.kind,
		]),
	);

/** Copied from booking.table() in mainlog-code/agent-state-machines, one word per event in EVENTS order. */
const EVENTS =
	"slots_complete slots_missing slot_free none_free user_yes user_no committed unknown refused paid sent send_failed told user_revises slot_gone model_unavailable model_back".split(
		" ",
	);
const BOOKING: Record<string, string> = {
	gather:
		"search stay reject reject reject reject report reject reject report report reject reject stay stay degraded stay",
	search:
		"reject reject confirm gather reject reject report reject reject report report reject reject gather stay stay stay",
	confirm:
		"reject reject reject reject book gather report reject reject report report reject reject gather search stay stay",
	book: "reject reject reject reject reject reject stay stay gather notify report reject reject defer defer stay stay",
	notify:
		"reject reject reject reject reject reject report reject reject report done report reject defer report degraded stay",
	report: "reject reject reject reject reject reject stay reject reject stay stay reject done defer stay stay stay",
	degraded:
		"reject reject reject reject reject reject report reject reject report report reject stay defer defer stay (resume)",
};
/** booking.py's TRANSITIONS, with a move to the same state written as stay, as table() counts it. */
const DRAWN: Record<string, string> = {
	"gather slots_complete": "search",
	"gather slots_missing": "stay",
	"search slot_free": "confirm",
	"search none_free": "gather",
	"confirm user_yes": "book",
	"confirm user_no": "gather",
	"book committed": "stay",
	"book unknown": "stay",
	"book refused": "gather",
	"book paid": "notify",
	"notify sent": "done",
	"notify send_failed": "report",
	"report told": "done",
};

/** A machine's text cut into its blocks: each header with the rules beneath it. */
const blocks = (text: string) => {
	const out: string[][] = [];
	for (const line of text.split("\n")) {
		const body = line.replace(/#.*$/, "").trim();
		if (!body) continue;
		if (body.endsWith(":") || /^events\s*:/i.test(body) || !out.length) out.push([line]);
		else out.at(-1)?.push(line);
	}
	return out;
};

const parts = (o: Output) => {
	assert.equal(o.kind, "group");
	return (o as Extract<Output, { kind: "group" }>).parts;
};

describe("state-machine-analyzer", () => {
	it("decides the booking exactly as booking.py does, all 119 cells", () => {
		const m = parse(sample("Booking, all cells decided"));
		assert.deepEqual(m.states, Object.keys(BOOKING));
		assert.deepEqual(m.events, EVENTS);
		const got = said(m);
		for (const [s, row] of Object.entries(BOOKING))
			for (const [i, want] of row.split(" ").entries())
				assert.equal(got.get(key(s, EVENTS[i] as string)), want, `${s} on ${EVENTS[i]}`);
	});

	it("draws the first booking as booking.py's TRANSITIONS and leaves every other cell open", () => {
		const m = parse(sample("Booking, first draft"));
		assert.deepEqual(m.states, Object.keys(BOOKING));
		assert.deepEqual(m.events, EVENTS);
		for (const [k, v] of said(m)) assert.equal(v, DRAWN[k.replace("\u0000", " ")] ?? null, k);
	});

	it("gives the same cells whatever order the blocks are written in", () => {
		for (const label of manifest.samples.map((s) => s.label)) {
			const text = sample(label);
			const bs = blocks(text);
			const want = said(parse(text));
			let seed = 7;
			const next = () => {
				seed = (seed * 48271) % 2147483647;
				return seed;
			};
			for (let n = 0; n < 20; n++) {
				// Fisher-Yates with a fixed seed: a different order every round, the same rounds every run.
				const shuffled = [...bs];
				for (let i = shuffled.length - 1; i > 0; i--) {
					const j = next() % (i + 1);
					[shuffled[i], shuffled[j]] = [shuffled[j] as string[], shuffled[i] as string[]];
				}
				const m = parse(shuffled.map((b) => b.join("\n")).join("\n"));
				const got = said(m);
				for (const [k, v] of want) assert.equal(got.get(k), v, `${label}: ${k}`);
			}
		}
	});

	it("ignores indentation, spacing and blank lines", () => {
		for (const label of manifest.samples.map((s) => s.label)) {
			const text = sample(label);
			const loose = text
				.split("\n")
				.map(
					(l) =>
						`\t ${l
							.trim()
							.replace(/\s*->\s*/, "   ->  ")
							.replace(/,\s*/g, " ,  ")}  `,
				)
				.join("\n\n");
			assert.deepEqual(said(parse(loose)), said(parse(text)), label);
		}
	});

	it("lets the narrower rule win, and leaves a tie that disagrees open", () => {
		const base = "a:\n x -> b\nb:\n x -> a\nevery state:\n x -> reject\n y -> stay";
		const m = parse(base);
		assert.equal(m.cells.get(key("a", "x"))?.to, "b", "a's own header beats every state");
		assert.equal(m.cells.get(key("a", "y"))?.kind, "stay");
		const pair = parse(`${base}\na, b:\n y -> defer`);
		assert.equal(pair.cells.get(key("a", "y"))?.kind, "defer", "a block of two beats every state");
		const tie = parse(`${base}\na:\n x -> reject`);
		assert.equal(tie.cells.get(key("a", "x")), null);
		assert.deepEqual(
			tie.conflicts.map((c) => [c.state, c.event, c.rules.map((r) => r.line)]),
			[["a", "x", [2, 9]]],
		);
		const same = parse(`${base}\na:\n x -> b`);
		assert.equal(same.conflicts.length, 0, "saying the same thing twice is not a conflict");
	});

	it("lets anything else decide only what nothing else did", () => {
		for (const label of manifest.samples.map((s) => s.label)) {
			const text = sample(label);
			if (/anything else/.test(text)) continue;
			const before = parse(text);
			const after = parse(`${text}\nevery state:\n  anything else -> ignore`);
			const open = new Set(before.conflicts.map((c) => key(c.state, c.event)));
			for (const [k, o] of before.cells) {
				const now = after.cells.get(k);
				if (o) assert.deepEqual(now, o, k);
				else if (open.has(k)) assert.equal(now, null, `${k} stays a conflict`);
				else assert.equal(now?.kind, "ignore", k);
			}
		}
	});

	it("counts a move to the same state as stay", () => {
		assert.equal(parse("a:\n x -> a").cells.get(key("a", "x"))?.kind, "stay");
	});

	it("agrees with itself: the grid's ?s, the markdown's, the skeleton's Nones and the headline's count", () => {
		for (const label of manifest.samples.map((s) => s.label)) {
			const text = sample(label);
			const m = parse(text);
			const disputed = new Map(m.conflicts.map((c) => [key(c.state, c.event), c.rules.length]));
			const out = parts(tool.run({ machine: text, also: "pytest" }));
			const head = out.find((p) => p.role === "answer");
			const grid = out.find((p) => p.kind === "table");
			assert.ok(head?.kind === "fields" && grid?.kind === "table");
			const open = [...m.cells.values()].filter((o) => o === null).length;
			assert.equal(head.fields.find((f) => f.label === "Undecided")?.value, String(open), label);
			const text2 = (c: unknown) => (typeof c === "object" && c !== null ? (c as { text: string }).text : String(c));
			const flagged = grid.rows.flatMap((r) => r.slice(1)).filter((c) => /^(\?|\d+ rules)$/.test(text2(c)));
			assert.equal(flagged.length, open, label);
			const rowOf = (e: string) => grid.rows.findIndex((r) => text2(r[0]) === e);
			for (const e of m.events)
				for (const [c, s] of m.states.entries()) {
					const r = rowOf(e);
					const want = mark(m.cells.get(key(s, e)) ?? null, disputed.get(key(s, e)));
					assert.deepEqual(grid.rows[r]?.[c + 1], want, `${label}: ${s} on ${e}`);
				}
			const cases = skeleton(m)
				.split("\n")
				.filter((l) => /^ {4}\(/.test(l));
			assert.equal(cases.length, m.states.length * m.events.length, label);
			assert.equal(cases.filter((l) => /, None\),/.test(l)).length, open, label);
			const code = out.at(-1);
			assert.ok(code?.kind === "code" && code.source === skeleton(m));

			const md = parts(tool.run({ machine: text, also: "markdown" })).at(-1);
			assert.ok(md?.kind === "code" && md.lang === "markdown", label);
			const lines = md.source.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| ---"));
			assert.equal(lines.length, m.events.length + 1, `${label}: a header and one line per event`);
			for (const [r, line] of lines.slice(1).entries())
				assert.deepEqual(
					line.slice(2, -2).split(" | "),
					grid.rows[r]?.map(text2).map((t) => (t === "✕" ? "✕ reject" : t)),
					`${label}: markdown row ${r} is the grid's row, with each reject in words`,
				);
		}
	});

	it("marks every outcome in words, and only the cells that need attention in a warning tone", () => {
		const m = parse(
			"a:\n w -> b\n x -> stay\n y -> defer\n z -> reject\nb:\n w -> ignore\n x -> back\n y -> a\n y -> b",
		);
		const got = m.states.flatMap((s) =>
			m.events.map((e) =>
				mark(m.cells.get(key(s, e)) ?? null, m.conflicts.find((c) => c.state === s && c.event === e)?.rules.length),
			),
		);
		assert.deepEqual(got, [
			{ text: "→ b", tone: "good" },
			{ text: "stay" },
			{ text: "defer", tone: "warn" },
			{ text: "✕", tone: "muted" },
			{ text: "ignore" },
			{ text: "↩ back", tone: "good" },
			{ text: "2 rules", tone: "bad" },
			{ text: "?", tone: "bad" },
		]);
	});

	it("leads with the coverage line, then the grid, then the graph", () => {
		for (const label of manifest.samples.map((s) => s.label)) {
			const out = parts(tool.run({ machine: sample(label), also: "none" }));
			assert.deepEqual(
				out.slice(0, 3).map((p) => [p.kind, p.role]),
				[
					["fields", "answer"],
					["table", "matrix"],
					["graph", undefined],
				],
				label,
			);
			const v = out[0];
			assert.ok(v?.kind === "fields" && v.fields[0]?.label === "Decided", label);
		}
	});

	it("puts the least-decided events on top, ties in the order they were written", () => {
		const text2 = (c: unknown) => (typeof c === "object" && c !== null ? (c as { text: string }).text : String(c));
		for (const label of manifest.samples.map((s) => s.label)) {
			const m = parse(sample(label));
			const grid = parts(tool.run({ machine: sample(label), also: "none" })).find((p) => p.role === "matrix");
			assert.ok(grid?.kind === "table", label);
			const order = grid.rows.map((r) => text2(r[0]));
			const open = (e: string) => m.states.filter((s) => !m.cells.get(key(s, e))).length;
			const want = [...m.events].sort((a, b) => open(b) - open(a) || m.events.indexOf(a) - m.events.indexOf(b));
			assert.deepEqual(order, want, label);
		}
		const first = parts(tool.run({ machine: sample("Booking, first draft"), also: "none" })).find(
			(p) => p.role === "matrix",
		);
		assert.ok(first?.kind === "table");
		assert.deepEqual(
			first.rows.slice(0, 4).map((r) => text2(r[0])),
			["user_revises", "slot_gone", "model_unavailable", "model_back"],
		);
	});

	it("draws every move as an arrow, and stays, rejects and the rest as nothing", () => {
		for (const label of manifest.samples.map((s) => s.label)) {
			const m = parse(sample(label));
			const g = parts(tool.run({ machine: sample(label), also: "none" })).find((p) => p.kind === "graph");
			assert.ok(g?.kind === "graph", label);
			assert.equal(graphProblem(g.graph), undefined, label);
			const pairs = new Set<string>();
			for (const s of m.states)
				for (const e of m.events) {
					const o = m.cells.get(key(s, e));
					if (o?.kind === "move") pairs.add(`${s} ${o.to}`);
				}
			const solid = g.graph.edges.filter((e) => e.line !== "dashed").map((e) => `${e.from} ${e.to}`);
			assert.deepEqual(new Set(solid), pairs, label);
			assert.equal(solid.length, pairs.size, `${label}: one arrow per pair`);
			assert.ok(
				g.graph.edges.every((e) => e.from !== e.to),
				`${label}: no self-loops`,
			);
		}
	});

	it("tones the state that can't be reached or left, and follows the written happy path", () => {
		const m = parse(sample("Booking, first draft"));
		assert.deepEqual(mainPath(m), ["gather", "search", "confirm", "book", "notify", "done"]);
		const g = parts(tool.run({ machine: sample("Booking, first draft"), also: "none" })).find(
			(p) => p.kind === "graph",
		);
		assert.ok(g?.kind === "graph");
		const degraded = g.graph.nodes.find((n) => n.id === "degraded");
		assert.deepEqual([degraded?.tone, degraded?.note], ["warn", "can't be reached or left"]);
		assert.deepEqual(g.graph.highlight, mainPath(m));
		// The decided booking's back returns to the two states that move into degraded, drawn dashed.
		const decided = parts(tool.run({ machine: sample("Booking, all cells decided"), also: "none" })).find(
			(p) => p.kind === "graph",
		);
		assert.ok(decided?.kind === "graph");
		assert.deepEqual(
			decided.graph.edges.filter((e) => e.line === "dashed").map((e) => `${e.from} ${e.to}`),
			["degraded gather", "degraded notify"],
		);
	});

	it("names the line at fault", () => {
		for (const [text, line] of [
			["a:\n x -> b\n\n  y ->", 4],
			["a:\n x -> b\nb\n", 3],
			["a:\n x y -> b", 2],
			["a:\n x -> b\nevery state except:\n y -> a", 3],
			["a:\n x -> b c", 2],
		] as const) {
			const out = tool.run({ machine: text, also: "none" });
			assert.equal(out.kind, "error", text);
			if (out.kind === "error") assert.match(out.message, new RegExp(`^Line ${line}: `), text);
		}
	});
});
