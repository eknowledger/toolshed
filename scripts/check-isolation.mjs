#!/usr/bin/env node
/**
 * A tool may not reach outside its own directory.
 *
 *   node scripts/check-isolation.mjs
 *
 * This is the check that keeps a tool a standalone artifact rather than a file that happens to live here.
 * A tool that imports `../shared/math.ts` cannot be read, copied, or reviewed on its own, and a host that
 * vendors one directory would get something that does not compile.
 *
 * Allowed:
 *   - `node:*` builtins
 *   - `@toolbench/sdk` (types only, erased at run time)
 *   - `./something` within the same directory
 *
 * Refused: anything else, including a relative path that climbs (`../`), a bare package name, and a URL.
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";

const ALLOWED_BARE = new Set(["@toolbench/sdk"]);
const IMPORT = /^\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']|^\s*import\s*\(\s*["']([^"']+)["']/gm;

const problems = [];
const tools = (await readdir("tools", { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);

for (const id of tools) {
	for (const file of (await readdir(`tools/${id}`)).filter((f) => f.endsWith(".ts"))) {
		const source = readFileSync(`tools/${id}/${file}`, "utf8");
		for (const match of source.matchAll(IMPORT)) {
			const spec = match[1] ?? match[2];
			if (!spec) continue;
			const ok =
				spec.startsWith("node:") ||
				ALLOWED_BARE.has(spec) ||
				(spec.startsWith("./") && !spec.slice(2).includes("/"));
			if (!ok) problems.push({ file: `tools/${id}/${file}`, spec });
		}
	}
}

if (problems.length > 0) {
	console.error("\nA tool reached outside its own directory:\n");
	for (const p of problems) console.error(`  ${p.file}  ->  ${p.spec}`);
	console.error("\nA tool must be readable, copyable and reviewable on its own. Allowed imports are");
	console.error("node: builtins, @toolbench/sdk, and files in the same directory.\n");
	process.exit(1);
}

console.log(`[isolation] ${tools.length} tools, none reaching outside its own directory`);
