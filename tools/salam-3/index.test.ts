/**
 * The claims a fixture pins at single points, held over a set of names: the pieces put back together are the
 * name, UTF-8 spends two bytes on every Arabic letter or mark and one on a space, and the six letters that never
 * join the next are never shown joined.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import type { Output } from "@toolbench/sdk";
import tool from "./index.ts";

const NAMES = ["أحمد", "محمّد", "هناء", "عبد الرحمن", "رؤوف", "خالد بن الوليد", "فاطمة الزهراء"];

function parts(name: string): Output[] {
	const out = tool.run({ name, greeting: "ahlan", ya: true });
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
		const bytes = parts(name)[3];
		assert.ok(bytes?.kind === "bytes");
		const spaces = name.split(" ").length - 1;
		assert.equal(bytes.bytes.length, 2 * (name.length - spaces) + spaces);
	}
});

it("ا د ذ ر ز و never join the letter after them", () => {
	for (const name of NAMES) {
		const table = parts(name)[2];
		assert.ok(table?.kind === "table");
		for (const row of table.rows) {
			if ("اأإآدذرزوؤ".includes(String(row[0])[0]!)) assert.equal(row.at(-1), "no", `${name}: ${row[0]}`);
		}
	}
});
