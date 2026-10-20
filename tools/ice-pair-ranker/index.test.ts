/**
 * Properties of the ICE pair ranker that single fixtures cannot pin.
 *
 *   pnpm test
 *
 *  - the pair formula is RFC 8445's, checked against hand-worked values;
 *  - swapping the controlling side changes a pair's priority by at most the (G>D?1:0) term when G and D swap;
 *  - every local reflexive candidate whose base is known is pruned against that base's pair, and nothing else is;
 *  - candidates only pair within an address family, except mDNS names, which pair with either;
 *  - the same candidates give the same checklist whichever way they were pasted: lines, a whole SDP, candidate JSON,
 *    or getStats();
 *  - past 100 pairs the lowest are dropped, as RFC 8445 section 6.1.2.5 says.
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
const BOB = ["a=candidate:1 1 udp 2130706431 10.0.0.8 61000 typ host", "a=candidate:2 1 udp 1694498815 198.51.100.77 40100 typ srflx raddr 10.0.0.8 rport 61000"].join(
	"\n",
);

function parts(local: string, remote: string, controlling = "local"): Output[] {
	const out = tool.run({ local, remote, controlling }) as Output;
	assert.equal(out.kind, "group", out.kind === "error" ? out.message : "");
	return out.kind === "group" ? out.parts : [];
}

const text = (c: unknown) => (typeof c === "object" && c !== null && "text" in c ? String((c as { text: unknown }).text) : String(c));

/** The computed check order: #, local, remote, route, priority. */
function rows(local: string, remote: string, controlling = "local"): string[][] {
	const table = parts(local, remote, controlling).find((p) => p.id === "order");
	assert.ok(table?.kind === "table");
	return table.rows.map((r) => r.map(text));
}

/** The pairs dropped from it: local, sent from, remote, same as. Empty when nothing was dropped. */
function pruned(local: string, remote: string, controlling = "local"): string[][] {
	const table = parts(local, remote, controlling).find((p) => p.id === "pruned");
	return table?.kind === "table" ? table.rows.map((r) => r.map(text)) : [];
}

describe("ice-pair-ranker", () => {
	it("prices pairs as RFC 8445 section 6.1.2.3 does", () => {
		const r = rows(ALICE, SERVER);
		// G = 2130706431 (Alice host), D = 2130706431: 2^32*G + 2*G + 0.
		assert.equal(r[0]![4], String(2n ** 32n * 2130706431n + 2n * 2130706431n));
		// G = 16777215 (relay) < D: 2^32*G + 2*D + 0.
		assert.equal(r[1]![4], String(2n ** 32n * 16777215n + 2n * 2130706431n));
		assert.equal(r[1]![3], "TURN", "a pair with a relay on either side goes through TURN");
	});

	it("changes a priority only by the tiebreak bit when the controlling side swaps", () => {
		const a = rows(ALICE, BOB, "local").map((r) => BigInt(r[4]!));
		const b = rows(ALICE, BOB, "remote").map((r) => BigInt(r[4]!));
		const sa = [...a].sort();
		const sb = [...b].sort();
		sa.forEach((x, i) => assert.ok(x - sb[i]! <= 1n && sb[i]! - x <= 1n, `${x} vs ${sb[i]}`));
	});

	it("prunes each local reflexive pair against its base's, and nothing else", () => {
		const dropped = pruned(ALICE, BOB);
		assert.equal(dropped.length, 2, "Alice's srflx against Bob's two candidates");
		assert.ok(dropped.every((x) => x[0]!.startsWith("srflx")));
		// Each names the address it is really sent from, the base, and the check it duplicates.
		assert.ok(dropped.every((x) => x[1] === "192.168.1.42:50004" && /^#\d+$/.test(x[3]!)), JSON.stringify(dropped));
		assert.ok(rows(ALICE, BOB).every((x) => !x[1]!.startsWith("srflx")));
	});

	it("pairs within a family, and mDNS names with either", () => {
		const v6 = "a=candidate:1 1 udp 2130706431 2001:db8::42 50004 typ host";
		assert.equal((tool.run({ local: v6, remote: SERVER, controlling: "local" }) as Output).kind, "error");
		const mdns = "a=candidate:1 1 udp 2130706431 7f3c1b2e-4d5a-4b6c-8d7e-9f0a1b2c3d4e.local 50004 typ host";
		assert.equal(rows(mdns, SERVER).length, 1);
	});

	it("gives the same checklist however the candidates were pasted", () => {
		const expected = rows(ALICE, BOB);
		const lines = ALICE.split("\n");
		const sdp = ["v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0", "m=audio 9 UDP/TLS/RTP/SAVPF 111", "a=mid:0", "a=ice-ufrag:alce", ...lines, "a=end-of-candidates"].join(
			"\r\n",
		);
		const json = JSON.stringify(lines.map((l, i) => ({ candidate: l.slice(2), sdpMid: "0", sdpMLineIndex: 0, usernameFragment: `u${i}` })));
		// Two m-sections without BUNDLE repeat every candidate; each is still counted once.
		const twice = `${sdp}\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\n${lines.join("\r\n")}`;
		for (const [name, local] of Object.entries({ sdp, json, twice })) {
			assert.deepEqual(rows(local, BOB), expected, name);
			assert.deepEqual(pruned(local, BOB), pruned(ALICE, BOB), name);
		}

		const stat = (type: string, line: string, id: string) => {
			const [foundation, , protocol, priority, address, port, , candidateType, , raddr, , rport] = line.slice(12).split(" ");
			return {
				id,
				type,
				foundation,
				protocol,
				priority: Number(priority),
				address,
				port: Number(port),
				candidateType,
				...(raddr ? { relatedAddress: raddr, relatedPort: Number(rport) } : {}),
			};
		};
		const report = [
			{ id: "T01", type: "transport" },
			...lines.map((l, i) => stat("local-candidate", l, `L${i}`)),
			...BOB.split("\n").map((l, i) => stat("remote-candidate", l, `R${i}`)),
		];
		assert.deepEqual(rows(JSON.stringify(report), ""), expected, "getStats() as a list, both sides from one paste");
		const keyed = Object.fromEntries(report.map((r) => [r.id, r]));
		assert.deepEqual(rows(JSON.stringify(keyed), ""), expected, "getStats() keyed by id");
	});

	it("drops the lowest pairs past 100", () => {
		const many = (n: number, base: string) => Array.from({ length: n }, (_, i) => `a=candidate:${i} 1 udp ${2130706431 - i * 256} ${base}.${i + 1} ${50000 + i} typ host`).join("\n");
		const r = rows(many(11, "192.168.1"), many(10, "10.0.0"));
		assert.equal(r.length, 100);
		const over = pruned(many(11, "192.168.1"), many(10, "10.0.0"));
		assert.equal(over.length, 10);
		assert.ok(over.every((x) => x[3] === "over 100"));
		assert.equal(r.at(-1)![0], "100");
		const findings = parts(many(11, "192.168.1"), many(10, "10.0.0")).find((p) => p.role === "findings");
		assert.ok(findings?.kind === "table" && findings.rows.some((row) => text(row[1]).includes("more than the 100")));
	});

	it("leads with the ranked list, then a warning if there is one, with no banner and no tiles", () => {
		const roles = (local: string, remote: string) => parts(local, remote).map((p) => p.role ?? p.kind);
		// Two private hosts and no relay: the warning comes straight after the list.
		assert.deepEqual(roles(ALICE.split("\n")[0]!, BOB.split("\n")[0]!), ["comparison", "findings", "method"]);
		// Nothing to warn about: the pruned pair comes next, and one remote candidate draws no grid.
		assert.deepEqual(roles(ALICE, SERVER), ["comparison", "decoded", "method"]);
		// Both sides with two or more: the grid is drawn.
		assert.ok(roles(ALICE, BOB).includes("heatmap"));
	});
});
