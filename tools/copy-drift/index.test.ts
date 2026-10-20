/**
 * Properties of copy drift that single fixtures cannot pin.
 *
 *   pnpm test
 *
 *  - the ported matcher gives difflib's matching blocks, opcodes and ratio, on cases computed with Python's difflib;
 *  - renaming every identifier in a copy leaves "names set aside" at 100% and moves "as written";
 *  - the Python lexer drops f-string literal text and keeps each replacement field's tokens, as tokenize does in 3.12;
 *  - a commit before the younger copy existed is never counted, whichever listing it is in, and naming a later
 *    commit in "Count from" only ever lowers the counts;
 *  - the chart's last points are the field values, and every counted commit is in the table once;
 *  - CRLF and LF give the same result;
 *  - the language is read from the code, Python, JavaScript and the C family each recognised;
 *  - the result leads with the one-sided count, then the three counts as bars, then the one-sided commits newest
 *    first, then the current differences above the history.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Output } from "@toolbench/sdk";
import tool, {
	body,
	countChanges,
	detectLang,
	Matcher,
	parseDate,
	parseHistory,
	shape,
	similarity,
	tokens,
} from "./index.ts";

/** From Python 3.13: difflib.SequenceMatcher(None, a, b, autojunk=False), random strings, seed 7. */
const DIFFLIB = [
	{
		a: "daaacabaaddaba",
		b: "daacaaaddbba",
		ratio: 0.8461538461538461,
		blocks: [
			[0, 0, 1],
			[2, 1, 4],
			[7, 5, 4],
			[12, 10, 2],
			[14, 12, 0],
		],
	},
	{
		a: "abcabc",
		b: "cbacba",
		ratio: 0.5,
		blocks: [
			[0, 2, 1],
			[1, 4, 1],
			[3, 5, 1],
			[6, 6, 0],
		],
	},
	{ a: "", b: "", ratio: 1, blocks: [[0, 0, 0]] },
	{
		a: "aaaa",
		b: "aa",
		ratio: 0.6666666666666666,
		blocks: [
			[0, 0, 2],
			[4, 2, 0],
		],
	},
];

const parts = (out: Output) => (out.kind === "group" ? out.parts : [out]);
const field = (out: Output, label: string, group?: string) => {
	for (const p of parts(out)) {
		if (p.kind !== "fields") continue;
		const f = p.fields.find((x) => x.label === label && x.group === group);
		if (f) return f.value;
	}
	throw new Error(`no field ${label}`);
};

const A = `def fetch(url, tries=3):
    delay = 0.2
    for i in range(tries):
        res = get(url, timeout=5)
        if res.ok:
            return res
        sleep(delay)
        delay *= 2
    raise Failed(f"{url} after {tries}")
`;
const RENAMED = A.replace(/\bfetch\b/g, "pull")
	.replace(/\burl\b/g, "link")
	.replace(/\btries\b/g, "n")
	.replace(/\bdelay\b/g, "wait")
	.replace(/\bres\b/g, "r");

const input = (over: Record<string, string | number | boolean>) => ({
	a: A,
	b: RENAMED,
	historya: "",
	historyb: "",
	since: "",
	ignore: "",
	...over,
});

describe("copy-drift", () => {
	it("matches difflib's blocks and ratio", () => {
		for (const c of DIFFLIB) {
			const m = new Matcher([...c.a], [...c.b]);
			assert.deepEqual(m.blocks(), c.blocks, `${c.a} / ${c.b}`);
			assert.equal(m.ratio(), c.ratio, `${c.a} / ${c.b}`);
		}
	});

	it("produces opcodes that rebuild b from a", () => {
		for (const c of DIFFLIB) {
			const a = [...c.a];
			const b = [...c.b];
			const rebuilt = new Matcher(a, b)
				.opcodes()
				.flatMap((op) => (op.tag === "equal" ? a.slice(op.i1, op.i2) : b.slice(op.j1, op.j2)));
			assert.equal(rebuilt.join(""), c.b);
		}
	});

	it("sets names aside: a renamed copy is 100% alike, and less so as written", () => {
		const out = tool.run(input({}));
		assert.equal(field(out, "Alike, names set aside"), "100%");
		assert.notEqual(field(out, "Alike, as written"), "100%");
		assert.equal(similarity(shape(A, "python"), shape(RENAMED, "python")), 1);
	});

	it("lexes f-strings the way Python 3.12's tokenize does", () => {
		// tokenize: FSTRING_START, '{', NAME b, '!', NAME r, ':', FSTRING_MIDDLE, '{', NAME w, '}', '}', ... '{', NAME d, '=', '}'
		assert.deepEqual(shape(`x = f"a{b!r:>{w}} {{c}} {d=}" + rb'q'`, "python"), [
			"ID",
			"=",
			"{",
			"ID",
			"!",
			"ID",
			":",
			"{",
			"ID",
			"}",
			"}",
			"{",
			"ID",
			"=",
			"}",
			"+",
			"STR",
		]);
		assert.deepEqual(shape("if a != b: pass", "python"), ["if", "ID", "!=", "ID", ":", "pass"]);
	});

	it("compares bodies, leaving out the signature and the docstring", () => {
		const t = body(tokens('def f(a, b=(1, 2)) -> int:\n    """Doc."""\n    return a\n', "python"), "python");
		assert.deepEqual(
			t.map((x) => x.shape),
			["return", "ID"],
		);
		const js = body(tokens("function f(a = {}) { return a; }", "js"), "js");
		assert.deepEqual(
			js.map((x) => x.shape),
			["return", "ID", ";"],
		);
	});

	it("never counts a commit from before both copies existed, and a later count-from only lowers the counts", () => {
		const a =
			"0000001 2020-01-01T00:00:00Z make A\n0000002 2020-02-01T00:00:00Z change A alone\n0000004 2020-04-01T00:00:00Z both\n0000005 2020-05-01T00:00:00Z only A\n";
		const b =
			"0000003 2020-03-01T00:00:00Z make B\n0000004 2020-04-01T00:00:00Z both\n0000006 2020-06-01T00:00:00Z only B\n";
		const c = countChanges(parseHistory(a, "historya"), parseHistory(b, "historyb"), "", []);
		assert.equal(c.since.sha, "0000003");
		assert.deepEqual(
			[c.together, c.onlyA, c.onlyB].map((xs) => xs.map((x) => x.sha)),
			[["0000004"], ["0000005"], ["0000006"]],
		);
		assert.equal(c.before, 3);
		const later = countChanges(parseHistory(a, "historya"), parseHistory(b, "historyb"), "2020-04-15", []);
		assert.ok(
			later.together.length <= c.together.length &&
				later.onlyA.length <= c.onlyA.length &&
				later.onlyB.length <= c.onlyB.length,
		);
		assert.deepEqual(
			later.onlyA.map((x) => x.sha),
			["0000005"],
		);
	});

	it("reads git's default log format and its dates", () => {
		const log =
			"commit 4b5a92e88e03443c2619f0905d756b159f9f0222\nAuthor: someone <a@b>\nDate:   Wed Apr 12 16:53:12 2023 +0200\n\n    set logging request lines to INFO level\n\ndiff --git a/x b/x\n";
		const [c] = parseHistory(log, "historya");
		assert.equal(c?.sha, "4b5a92e88e03443c2619f0905d756b159f9f0222");
		assert.equal(c?.ts, Date.UTC(2023, 3, 12, 14, 53, 12) / 1000);
		assert.equal(c?.subject, "set logging request lines to INFO level");
		assert.equal(parseDate("2023-04-12T14:53:12Z"), parseDate("2023-04-12T16:53:12+02:00"));
		assert.equal(parseDate("2023-04-12 16:53:12 +0200"), parseDate("2023-04-12T14:53:12Z"));
	});

	it("ends the chart at the field values, and lists every counted commit once", () => {
		const a =
			"0000001 2020-01-01T00:00:00Z make A\n0000004 2020-04-01T00:00:00Z both\n0000005 2020-05-01T00:00:00Z only A\n0000007 2020-07-01T00:00:00Z both again\n";
		const b =
			"0000003 2020-03-01T00:00:00Z make B\n0000004 2020-04-01T00:00:00Z both\n0000006 2020-06-01T00:00:00Z only B\n0000007 2020-07-01T00:00:00Z both again\n";
		const out = tool.run(input({ historya: a, historyb: b }));
		const chart = parts(out).find((p) => p.kind === "series" && p.chart.id === "drift");
		assert.ok(chart?.kind === "series");
		const last = chart.chart.series.map((s) => s.points[s.points.length - 1]);
		assert.deepEqual(last, [2, 1, 1]);
		const bars = parts(out).find((p) => p.kind === "series" && p.chart.x[0] === "Both");
		assert.ok(bars?.kind === "series");
		assert.deepEqual(bars.chart.series[0]!.points, [2, 1, 1]);
		const table = parts(out).find((p) => p.kind === "table" && p.caption?.startsWith("Every counted"));
		assert.ok(table?.kind === "table");
		assert.equal(table.rows.length, 4);
		assert.equal(chart.chart.x.length, 4);
	});

	it("gives the same answer for CRLF and LF", () => {
		const a = "0000001 2020-01-01T00:00:00Z make A\n0000004 2020-04-01T00:00:00Z both\n";
		const b = "0000003 2020-03-01T00:00:00Z make B\n0000004 2020-04-01T00:00:00Z both\n";
		const crlf = (s: string) => s.replace(/\n/g, "\r\n");
		assert.deepEqual(
			tool.run(input({ historya: a, historyb: b })),
			tool.run(input({ a: crlf(A), b: crlf(RENAMED), historya: crlf(a), historyb: crlf(b) })),
		);
	});

	it("reads the language from the code", () => {
		assert.equal(detectLang(A), "python");
		assert.equal(detectLang("async def f(x):\n    return await g(x)\n"), "python");
		assert.equal(detectLang("export const f = (x) => x + 1;"), "js");
		assert.equal(detectLang("function f(a) { return a === 1; }"), "js");
		assert.equal(detectLang("func f(n int) error {\n\treturn nil\n}"), "c");
		assert.equal(detectLang("fn f(n: u32) -> u32 { n }"), "c");
		assert.equal(detectLang("public static int f(int n) { return n; }"), "c");
		assert.equal(detectLang("int f(int n) { return n; }"), "c");
	});

	it("leads with the one-sided count, then the bars, the one-sided commits newest first, and the code above the history", () => {
		const a =
			"0000001 2020-01-01T00:00:00Z make A\n0000004 2020-04-01T00:00:00Z both\n0000005 2020-05-01T00:00:00Z only A\n0000007 2020-07-01T00:00:00Z both again\n";
		const b =
			"0000003 2020-03-01T00:00:00Z make B\n0000004 2020-04-01T00:00:00Z both\n0000006 2020-06-01T00:00:00Z only B: fix __init__\n0000007 2020-07-01T00:00:00Z both again\n";
		const ps = parts(
			tool.run(input({ a: A, b: A.replace("sleep(delay)", "sleep(delay + 1)"), historya: a, historyb: b })),
		);
		assert.deepEqual(
			ps.map((p) => [p.kind, p.role]),
			[
				["fields", "answer"],
				["series", undefined],
				["table", "actions"],
				["table", undefined],
				["fields", "metrics"],
				["series", undefined],
				["table", undefined],
				["fields", "method"],
			],
		);
		assert.ok(
			!ps.some((p) => p.role === "verdict" || p.role === "stats" || p.kind === "code"),
			"no banner, tiles or checklist",
		);
		const lead = ps[0];
		assert.ok(lead?.kind === "fields" && lead.fields.length === 1 && lead.fields[0]!.tone === undefined);
		assert.match(lead.fields[0]!.value, /^Too early to tell: 2 of 4 commits changed only one copy/);
		const actions = ps[2];
		assert.ok(actions?.kind === "table");
		assert.deepEqual(
			actions.rows.map((r) => (r[1] as { text: string }).text),
			["0000006", "0000005"],
		);
		const diff = ps[3];
		assert.ok(diff?.kind === "table" && diff.caption?.startsWith("Current differences"));
	});

	it("with no history, leads with likeness alone, then the code, and draws no history parts", () => {
		const ps = parts(tool.run(input({})));
		assert.deepEqual(
			ps.map((p) => [p.kind, p.role]),
			[
				["fields", "answer"],
				["table", undefined],
				["fields", "metrics"],
				["fields", "method"],
			],
		);
	});
});
