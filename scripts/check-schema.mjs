#!/usr/bin/env node
/**
 * The JSON Schema and the SDK must agree about every manifest here.
 *
 *   node scripts/check-schema.mjs
 *
 * ⚠️ **The schema is an editor aid, not the authority.** `@toolbench/sdk`'s `validate()` is, and it checks
 * things a schema cannot express: a sample naming an input that does not exist, a sample value outside that
 * input's own min and max, a `select` default that is not one of its options, `card: "live"` on a retired
 * tool. The schema exists so an editor underlines a typo while it is being typed.
 *
 * Two authorities that can disagree is worse than one, so this is the check that keeps them honest:
 *
 *  1. every manifest here passes the schema;
 *  2. every manifest here passes the SDK;
 *  3. and a deliberately broken copy is rejected by **both**, which is what proves the schema is actually
 *     being applied rather than accepting anything.
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
/*
 * ⚠️ `ajv/dist/2020`, not `ajv`. The default export speaks draft-07 and refuses a 2020-12 schema with
 * "no schema with key or ref …/2020-12/schema", which reads like a network problem and is not one.
 */
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import { upgradeManifest, validateManifest } from "@toolbench/sdk";

const schema = JSON.parse(readFileSync("schema/tool.schema.json", "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

let pass = 0;
const fails = [];
const ck = (name, ok, detail = "") => {
	if (ok) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fails.push(name);
		console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
};

const tools = (await readdir("tools", { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);

console.log("\nschema and SDK agree:");
for (const id of tools) {
	const raw = JSON.parse(readFileSync(`tools/${id}/tool.json`, "utf8"));
	ck(`${id} passes the schema`, validate(raw), ajv.errorsText(validate.errors, { separator: "; " }));
	let sdkError = "";
	try {
		validateManifest(upgradeManifest(raw));
	} catch (error) {
		sdkError = error instanceof Error ? error.message : String(error);
	}
	ck(`${id} passes the SDK`, sdkError === "", sdkError);
	ck(`${id}'s directory name is its id`, raw.id === id, `id is "${raw.id}"`);
}

/*
 * The negative case, because a schema with a typo in it accepts everything and looks like it is working. A
 * number input with no `max` is invalid under both authorities, so both must say so.
 */
console.log("\nboth reject a broken manifest:");
{
	const raw = JSON.parse(readFileSync(`tools/${tools[0]}/tool.json`, "utf8"));
	const broken = structuredClone(raw);
	const number = broken.inputs.find((i) => i.type === "number");
	if (!number) {
		console.log("  --   skipped: no tool here has a number input to break");
	} else {
		delete number.max;
		ck("the schema rejects a number input with no max", !validate(broken), "the schema accepted it");
		let sdkRejected = false;
		try {
			validateManifest(upgradeManifest(broken));
		} catch {
			sdkRejected = true;
		}
		ck("the SDK rejects it too", sdkRejected, "the SDK accepted it");
	}
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
	console.log(fails.map((f) => `  ${f}`).join("\n"));
	process.exit(1);
}
