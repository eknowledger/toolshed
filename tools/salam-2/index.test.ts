/**
 * What the fixtures pin as single cases, held over every option: each greeting reaches the text, يا appears
 * exactly when the toggle is on, and any character outside the Arabic letters is refused with its position.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import tool from "./index.ts";

const manifest = JSON.parse(readFileSync(new URL("./tool.json", import.meta.url), "utf8"));
const greetings: string[] = manifest.inputs[1].options.map((o: { value: string }) => o.value);

it("every greeting in the select produces a greeting, with and without يا", () => {
	for (const greeting of greetings) {
		for (const ya of [true, false]) {
			const out = tool.run({ name: "أحمد", greeting, ya });
			assert.equal(out.kind, "text");
			if (out.kind !== "text") return;
			assert.ok(out.text.endsWith(" أحمد"));
			assert.equal(out.text.includes(" يا "), ya);
		}
	}
});

it("refuses anything that is not an Arabic letter, a mark or a space, and says where", () => {
	for (const [name, at] of [["أحمد1", 4], ["ali", 0], ["أحمد!", 4]] as const) {
		const out = tool.run({ name, greeting: "ahlan", ya: true });
		assert.equal(out.kind, "error");
		if (out.kind === "error") assert.equal(out.at, at);
	}
});
