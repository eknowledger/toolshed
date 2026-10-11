/**
 * Properties of the ICE pair ranker that single fixtures cannot pin.
 *
 *   pnpm test
 *
 *  - the pair formula is RFC 8445's, checked against hand-worked values;
 *  - swapping the controlling side changes a pair's priority by at most the (G>D?1:0) term when G and D swap;
 *  - every local reflexive candidate whose base is known is pruned against that base's pair, and nothing else is;
 *  - candidates only pair within an address family, except mDNS names, which pair with either.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Output } from "@toolbench/sdk";
import tool from "./index.ts";

const ALICE = [
	"a=candidate:1 1 udp 2130706431 192.168.1.42 50004 typ host",
	"a=candidate:2 1 udp 1694498815 192.0.2.10 54321 typ srflx raddr 192.168.1.42 rport 50004",
	"a=candidate:3 1 udp 16777215 198.51.100.50 49152 typ relay raddr 192.0.2.10 rport 54321",
].join("\n");
const SERVER = "a=candidate:1 1 udp 2130706431 198.51.100.20 50004 typ host";
const BOB = [
	"a=candidate:1 1 udp 2130706431 10.0.0.8 61000 typ host",
	"a=candidate:2 1 udp 1694498815 198.51.100.77 40100 typ srflx raddr 10.0.0.8 rport 61000",
].join("\n");

function rows(local: string, remote: string, controlling = "local"): string[][] {
	const out = tool.run({ local, remote, controlling }) as Output;
	assert.equal(out.kind, "group");
	const table = out.kind === "group" ? out.parts.find((p) => p.kind === "table") : undefined;
	assert.ok(table?.kind === "table");
	return table.rows.map((r) => r.map((c) => (typeof c === "object" && c !== null && "text" in c ? String(c.text) : String(c))));
}

describe("ice-pair-ranker", () => {
	it("prices pairs as RFC 8445 section 6.1.2.3 does", () => {
		const r = rows(ALICE, SERVER);
		// G = 2130706431 (Alice host), D = 2130706431: 2^32*G + 2*G + 0.
		assert.equal(r[0]![4], String(2n ** 32n * 2130706431n + 2n * 2130706431n));
		// G = 1694498815 (srflx) < D: 2^32*G + 2*D + 0.
		assert.equal(r[1]![4], String(2n ** 32n * 1694498815n + 2n * 2130706431n));
	});

	it("changes a priority only by the tiebreak bit when the controlling side swaps", () => {
		const a = rows(ALICE, BOB, "local").map((r) => BigInt(r[4]!));
		const b = rows(ALICE, BOB, "remote").map((r) => BigInt(r[4]!));
		const sa = [...a].sort();
		const sb = [...b].sort();
		sa.forEach((x, i) => assert.ok(x - sb[i]! <= 1n && sb[i]! - x <= 1n, `${x} vs ${sb[i]}`));
	});

	it("prunes each local reflexive pair against its base's, and nothing else", () => {
		const r = rows(ALICE, BOB);
		const pruned = r.filter((x) => x[0] === "pruned");
		assert.equal(pruned.length, 2, "Alice's srflx against Bob's two candidates");
		assert.ok(pruned.every((x) => x[1]!.startsWith("srflx")));
		assert.ok(r.filter((x) => x[0] !== "pruned").every((x) => !x[1]!.startsWith("srflx")));
	});

	it("pairs within a family, and mDNS names with either", () => {
		const v6 = "a=candidate:1 1 udp 2130706431 2001:db8::42 50004 typ host";
		assert.equal((tool.run({ local: v6, remote: SERVER, controlling: "local" }) as Output).kind, "error");
		const mdns = "a=candidate:1 1 udp 2130706431 7f3c1b2e-4d5a-4b6c-8d7e-9f0a1b2c3d4e.local 50004 typ host";
		assert.equal(rows(mdns, SERVER).length, 1);
	});
});
