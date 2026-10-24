/**
 * The claims a fixture pins at single points, held over a set of names: the pieces put back together are the
 * name, UTF-8 spends two bytes on every Arabic letter or mark and one on a space, and the six letters that never
 * join the next are never shown joined. Step 5 adds the abjad value, checked against values that are well known
 * and against the chart it is drawn from. Step 6 adds the count of arrangements, which must agree with the formula
 * it refuses to use, and must stop when the signal says so.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import type { Output } from "@toolbench/sdk";
import tool, { arrangementsByFormula, countArrangements } from "./index.ts";

const ctx = { signal: new AbortController().signal, progress() {} };


const NAMES = ["أحمد", "محمّد", "هناء", "عبد الرحمن", "رؤوف", "خالد بن الوليد", "فاطمة الزهراء"];

function parts(name: string): Output[] {
	const out = tool.run({ name, greeting: "ahlan", ya: true }, ctx);
	assert.equal(out.kind, "group", JSON.stringify(out));
	return out.kind === "group" ? out.parts : [];
}

it("the pieces, put back together, are the name without its spaces", () => {
	for (const name of NAMES) {
		const fields = parts(name)[1];
		assert.ok(fields?.kind === "fields");
		assert.equal(fields.fields[1]!.note!.split(" · ").join(""), name.replace(/\s/g, ""));
	}
});

it("two bytes for every Arabic letter or mark, one for every space", () => {
	for (const name of NAMES) {
		const bytes = parts(name)[4];
		assert.ok(bytes?.kind === "bytes");
		const spaces = name.split(" ").length - 1;
		assert.equal(bytes.bytes.length, 2 * (name.length - spaces) + spaces);
	}
});

it("ا د ذ ر ز و never join the letter after them", () => {
	for (const name of NAMES) {
		const table = parts(name)[3];
		assert.ok(table?.kind === "table");
		for (const row of table.rows) {
			if ("اأإآدذرزوؤ".includes(String(row[0])[0]!)) assert.equal(row.at(-1), "no", `${name}: ${row[0]}`);
		}
	}
});

it("abjad values that are well known: محمد 92, أحمد 53, علي 110", () => {
	for (const [name, value] of [["محمد", "92"], ["أحمد", "53"], ["علي", "110"]] as const) {
		const fields = parts(name)[1];
		assert.ok(fields?.kind === "fields");
		assert.equal(fields.fields[3]!.value, value);
	}
});

it("the abjad value is the chart's bars added up, and no letter is worth 0", () => {
	for (const name of NAMES) {
		const [, fields, chart] = parts(name);
		assert.ok(fields?.kind === "fields" && chart?.kind === "series");
		const bars = chart.chart.series[0]!.points as number[];
		assert.ok(bars.every((v) => v > 0), name);
		assert.equal(String(bars.reduce((a, b) => a + b, 0)), fields.fields[3]!.value);
	}
});

it("counting the arrangements one by one agrees with n! over the repeats", () => {
	for (const name of ["أحمد", "محمد", "ننن", "هناء", "عبد الرحمن", "لولو"]) {
		const chars = [...name.replace(/\s/g, "")];
		assert.equal(countArrangements(chars, ctx), arrangementsByFormula(chars), name);
	}
});

it("a run whose signal is already aborted stops at the first check, after 1,024 orders", () => {
	const controller = new AbortController();
	controller.abort();
	const chars = [..."عبدالرحمن"];
	assert.throws(() => countArrangements(chars, { signal: controller.signal, progress() {} }));
});
