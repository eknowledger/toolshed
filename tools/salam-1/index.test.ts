/**
 * The one property step 1 has: whatever the name, the greeting is أهلاً يا followed by it, unchanged.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import tool from "./index.ts";

it("puts the name after the greeting, as typed", () => {
	for (const name of ["أحمد", "فاطمة", "عبد الرحمن"]) {
		assert.deepEqual(tool.run({ name }), { kind: "text", text: `أهلاً يا ${name}` });
	}
});
