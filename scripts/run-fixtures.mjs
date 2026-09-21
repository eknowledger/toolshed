#!/usr/bin/env node
/**
 * Every tool's manifest and fixtures, through the SDK's own harness.
 *
 *   node scripts/run-fixtures.mjs
 *
 * `checkToolDirectory` is the contract test the framework ships: it validates the manifest against the
 * current contract version, checks that every declared output kind is exercised by a fixture, runs each
 * fixture and compares the result, and runs every `samples` entry to be sure a button a reader will press
 * first does not throw.
 *
 * ⚠️ It takes `describe`/`it` rather than importing a runner, so the same file works under `node:test`,
 * Vitest, or anything else with that shape. Here they are shims that collect and report, because the output
 * of a contract failure needs to name the tool and the field, and a bare runner's diff does not.
 */
import { checkToolDirectory } from "@toolbench/sdk/fixtures";

let pass = 0;
const fails = [];
const collected = [];
let suite = "";

const describe = (name, fn) => {
	suite = name;
	fn();
};
const it = (name, fn) => collected.push({ suite, name, fn });

/*
 * One call for the whole directory, not one per tool: the harness scans for tools itself and fails if it
 * finds none, which is the assertion that stops an empty directory reporting a clean run.
 *
 * `maxMs` is stated rather than left to the default, because it is a claim about what a reader's browser
 * will spend: a main-thread tool has nothing to interrupt it, so a fixture taking 200ms takes 200ms of
 * their main thread too, and the tool belongs in a worker.
 */
checkToolDirectory(new URL("../tools/", import.meta.url), { describe, it, maxMs: 50 });

let last = null;
for (const test of collected) {
	if (test.suite !== last) {
		console.log(`\n${test.suite}:`);
		last = test.suite;
	}
	try {
		await test.fn();
		pass++;
		console.log(`  ok   ${test.name}`);
	} catch (error) {
		fails.push(`${test.suite}: ${test.name}`);
		console.log(`  FAIL ${test.name} — ${error instanceof Error ? error.message : String(error)}`);
	}
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
	console.log(fails.map((f) => `  ${f}`).join("\n"));
	process.exit(1);
}
