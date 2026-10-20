/**
 * Properties of the STUN decoder that a single fixture cannot pin.
 *
 *   pnpm test
 *
 *  - every address round-trips: XOR it the way RFC 8489 says, decode it, get it back, for IPv4 and IPv6;
 *  - the class bits are interleaved with the method's, so 0x0101 is a Binding success and 0x0113 an Allocate error;
 *  - flipping any byte of a message with a FINGERPRINT makes the FINGERPRINT fail, or the message fail to parse;
 *  - MESSAGE-INTEGRITY verifies only with the right password, short-term and long-term;
 *  - the same bytes read the same however they were copied: a stream, a C array, a Wireshark, xxd or hexdump dump;
 *  - a captured frame's headers are skipped, and nothing else is.
 *
 * The samples' own bytes were made by aioice and RFC 5769, so passing them is agreement with independent
 * implementations, and the hand-written CRC-32, MD5, SHA-1, SHA-256 and HMACs are held to their published test
 * vectors as well.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Output } from "@toolbench/sdk";
import tool, { crc32, hmacSha1, hmacSha256, md5, saslprep, sha1, sha256 } from "./index.ts";

const CHECK =
	"000100482112a4428f1e2d3c4b5a69788796a5b400060009737276373a616c6365000000002400046effffff802a00081d2c3b4a596877860025000000080014af2e7f7fee8a3d03b3149db5176cad7455e8d93880280004839f5505";
/** RFC 5769 section 2.4: long-term credentials. */
const LONG_TERM =
	"000100602112a44278ad3433c6ad72c029da412e00060012e3839ee38388e383aae38383e382afe382b900000015001c662f2f3439396b39353464364f4c33346f4c39465354767936347341" +
	"0014000b6578616d706c652e6f72670000080014f67024656dd64a3e02b8e0712e85c9a28ca89666";

type Run = { message: string; password?: string; username?: string; realm?: string };

function parts(input: Run): Output[] {
	const out = tool.run({ password: "", username: "", realm: "", view: "fields", ...input }) as Output;
	assert.equal(out.kind, "group", out.kind === "error" ? out.message : "");
	return out.kind === "group" ? out.parts : [];
}

/**
 * The attribute table, as name to value, tone and meaning. `ok` is whether a check matched: a match is not toned,
 * since only a failure is something to act on, so it is read from the meaning.
 */
function attrs(input: Run): Map<string, { value: string; tone?: string; note: string; ok: boolean }> {
	const table = parts(input).find((p) => p.kind === "table" && p.role === "decoded");
	assert.ok(table?.kind === "table");
	return new Map(
		table.rows.map((r) => {
			const v = r[2] as { text: string; tone?: string };
			const note = String(r[3]);
			return [String(r[1]), { value: v.text, ...(v.tone ? { tone: v.tone } : {}), note, ok: /^It matches/.test(note) && v.tone === undefined }];
		}),
	);
}

/** The answer's Message field: the method and class, with the type in its note. */
const message = (input: Run) => {
	const first = parts(input)[0];
	assert.ok(first?.kind === "fields" && first.role === "answer" && first.fields[0]?.label === "Message");
	return first.fields[0]!;
};

/** The header and input fields, last. */
const method = (input: Run) => {
	const last = parts(input).at(-1);
	assert.ok(last?.kind === "fields" && last.role === "method");
	return new Map(last.fields.map((f) => [f.label, f.value]));
};

const hx = (b: number[]) => b.map((x) => x.toString(16).padStart(2, "0")).join("");

function xorMapped(ip: number[], port: number, txid: number[]): string {
	const cookie = [0x21, 0x12, 0xa4, 0x42];
	const mask = ip.length === 4 ? cookie : [...cookie, ...txid];
	const xport = port ^ 0x2112;
	const family = ip.length === 4 ? 1 : 2;
	const value = [0, family, xport >> 8, xport & 0xff, ...ip.map((b, i) => b ^ mask[i]!)];
	const attr = [0x00, 0x20, 0, value.length, ...value];
	return hx([0x01, 0x01, 0, attr.length, ...cookie, ...txid, ...attr]);
}

const enc = (s: string) => new TextEncoder().encode(s);
const hexOf = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("stun-decoder", () => {
	it("computes CRC-32, MD5, SHA-1, SHA-256 and the HMACs as their standards' test vectors say", () => {
		// FIPS 180-2 appendix A.1 and A.2, and appendix B.1 and B.2 for SHA-256.
		assert.equal(hexOf(sha1(enc("abc"))), "a9993e364706816aba3e25717850c26c9cd0d89d");
		assert.equal(hexOf(sha1(enc("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))), "84983e441c3bd26ebaae4aa1f95129e5e54670f1");
		assert.equal(hexOf(sha256(enc("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		assert.equal(hexOf(sha256(enc("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
		// RFC 1321 appendix A.5.
		assert.equal(hexOf(md5(enc(""))), "d41d8cd98f00b204e9800998ecf8427e");
		assert.equal(hexOf(md5(enc("abc"))), "900150983cd24fb0d6963f7d28e17f72");
		assert.equal(hexOf(md5(enc("12345678901234567890123456789012345678901234567890123456789012345678901234567890"))), "57edf4a22be3c955ac49da2e2107b67a");
		// RFC 2202 section 3, and RFC 4231 section 4.3, test case 2 of each.
		assert.equal(hexOf(hmacSha1(new Uint8Array(20).fill(0x0b), enc("Hi There"))), "b617318655057264e28bc0b6fb378c8ef146be00");
		assert.equal(hexOf(hmacSha1(enc("Jefe"), enc("what do ya want for nothing?"))), "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79");
		assert.equal(hexOf(hmacSha256(enc("Jefe"), enc("what do ya want for nothing?"))), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
		assert.equal(crc32(enc("123456789")), 0xcbf43926);
	});

	it("round-trips XOR-MAPPED-ADDRESS for IPv4 and IPv6", () => {
		const txid = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
		assert.equal(attrs({ message: xorMapped([192, 0, 2, 10], 54321, txid) }).get("XOR-MAPPED-ADDRESS")?.value, "192.0.2.10:54321");
		assert.equal(attrs({ message: xorMapped([198, 51, 100, 20], 3478, txid) }).get("XOR-MAPPED-ADDRESS")?.value, "198.51.100.20:3478");
		const v6 = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
		assert.equal(attrs({ message: xorMapped(v6, 443, txid) }).get("XOR-MAPPED-ADDRESS")?.value, "[2001:db8:0:0:0:0:0:1]:443");
	});

	it("reads the interleaved class bits", () => {
		assert.match(message({ message: "010100002112a442000000000000000000000000" }).value, /^Binding success response/);
		assert.match(message({ message: "011300002112a442000000000000000000000000" }).value, /^Allocate error response/);
		assert.match(message({ message: "001100002112a442000000000000000000000000" }).value, /^Binding indication/);
		assert.equal(method({ message: "011300002112a442000000000000000000000000" }).get("Message type"), "0x0113");
	});

	it("catches a flipped byte anywhere before the FINGERPRINT, and says so first", () => {
		const bytes = CHECK.match(/../g) ?? [];
		for (let i = 0; i < bytes.length - 8; i++) {
			const flipped = [...bytes];
			flipped[i] = ((Number.parseInt(flipped[i]!, 16) ^ 0x01) & 0xff).toString(16).padStart(2, "0");
			const out = tool.run({ message: flipped.join(""), password: "", username: "", realm: "", view: "fields" }) as Output;
			if (out.kind === "error") continue; // the header itself broke, which is also caught
			const table = out.kind === "group" ? out.parts.find((p) => p.kind === "table" && p.role === "decoded") : undefined;
			const fp = table?.kind === "table" ? table.rows.find((r) => r[1] === "FINGERPRINT") : undefined;
			// Bytes 2 and 3 are the length; a changed length moves where FINGERPRINT is read, so it may not parse as one.
			if (!fp) continue;
			assert.equal((fp[2] as { tone?: string }).tone, "bad", `byte ${i} flipped and the FINGERPRINT still matched`);
			const first = out.kind === "group" ? out.parts[0] : undefined;
			const integrity = first?.kind === "fields" ? first.fields.find((f) => f.label === "Integrity") : undefined;
			assert.equal(integrity?.tone, "bad", `byte ${i} flipped and the answer's integrity is not bad`);
		}
	});

	it("verifies short-term MESSAGE-INTEGRITY only with the right password", () => {
		assert.equal(attrs({ message: CHECK, password: "server+password+24+chars" }).get("MESSAGE-INTEGRITY")?.ok, true);
		assert.equal(attrs({ message: CHECK, password: "server+password+24+chars!" }).get("MESSAGE-INTEGRITY")?.tone, "bad");
		assert.match(attrs({ message: CHECK }).get("MESSAGE-INTEGRITY")?.note ?? "", /Enter the password/);
	});

	it("verifies long-term MESSAGE-INTEGRITY with MD5 of username:realm:password, after SASLprep", () => {
		assert.equal(saslprep("The­MªtrⅨ"), "TheMatrIX");
		assert.equal(attrs({ message: LONG_TERM, password: "TheMatrIX" }).get("MESSAGE-INTEGRITY")?.ok, true);
		assert.equal(attrs({ message: LONG_TERM, password: "The­MªtrⅨ" }).get("MESSAGE-INTEGRITY")?.ok, true);
		assert.equal(attrs({ message: LONG_TERM, password: "TheMatrix" }).get("MESSAGE-INTEGRITY")?.tone, "bad");
		assert.match(attrs({ message: LONG_TERM, password: "TheMatrIX" }).get("MESSAGE-INTEGRITY")?.note ?? "", /MD5 of/);
	});

	it("takes the username and realm from the reader when a response does not carry them", () => {
		// A success response signed with the long-term key: no USERNAME, no REALM, as a TURN server sends it.
		const txid = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
		const body = [0x00, 0x08, 0x00, 0x14, ...new Array(20).fill(0)];
		const msg = new Uint8Array([0x01, 0x03, 0, body.length, 0x21, 0x12, 0xa4, 0x42, ...txid, ...body]);
		msg.set(hmacSha1(md5(enc("alice:example.org:secret")), msg.slice(0, 20)), 24);
		const message = hexOf(msg);
		assert.equal(attrs({ message, password: "secret" }).get("MESSAGE-INTEGRITY")?.tone, "bad", "without a realm it is tried as short-term");
		assert.match(attrs({ message, password: "secret", realm: "example.org" }).get("MESSAGE-INTEGRITY")?.note ?? "", /Enter the username/);
		assert.equal(attrs({ message, password: "secret", realm: "example.org", username: "alice" }).get("MESSAGE-INTEGRITY")?.ok, true);
	});

	it("reads the same bytes however they were copied", () => {
		const frame = [
			"0000   02 00 5e 10 00 02 02 00 5e 10 00 01 08 00 45 00   ..^.....^.....E.",
			"0010   00 3c 1c 46 40 00 39 11 39 51 c6 33 64 14 c0 a8   .<.F@.9.9Q.3d...",
			"0020   01 2a 0d 96 c3 54 00 28 4f 3a 01 01 00 0c 21 12   .*...T.(O:....!.",
			"0030   a4 42 b7 e7 a7 01 bc 5c a4 93 5d 33 93 47 00 20   .B.....\\..]3.G. ",
			"0040   00 08 00 01 f5 23 e1 12 a6 48                     .....#...H",
		].join("\n");
		const bytes = frame.split("\n").flatMap((l) => l.slice(7, 54).trim().split(" "));
		const lines = (fmt: (o: number, chunk: string[]) => string) =>
			Array.from({ length: Math.ceil(bytes.length / 16) }, (_, i) => fmt(i * 16, bytes.slice(i * 16, i * 16 + 16))).join("\n");
		const ascii = (c: string[]) =>
			c
				.map((b) => Number.parseInt(b, 16))
				.map((n) => (n >= 32 && n < 127 ? String.fromCharCode(n) : "."))
				.join("");
		const quads = (c: string[]) => (c.join("").match(/.{1,4}/g) ?? []).join(" ").padEnd(39);
		const forms = {
			wireshark: frame,
			stream: bytes.join(""),
			colons: bytes.join(":"),
			"C array": bytes.map((b) => `0x${b}`).join(", "),
			escaped: bytes.map((b) => `\\x${b}`).join(""),
			xxd: lines((o, c) => `${o.toString(16).padStart(8, "0")}: ${quads(c)}  ${ascii(c)}`),
			"hexdump -C": lines((o, c) => `${`${o.toString(16).padStart(8, "0")}  ${c.slice(0, 8).join(" ")}  ${c.slice(8).join(" ")}`.padEnd(60)}|${ascii(c)}|`),
			"tcpdump -X": lines((o, c) => `\t0x${o.toString(16).padStart(4, "0")}:  ${quads(c)}  ${ascii(c)}`),
		};
		for (const [name, message] of Object.entries(forms)) {
			assert.equal(attrs({ message }).get("XOR-MAPPED-ADDRESS")?.value, "192.0.2.10:54321", name);
			assert.equal(method({ message }).get("Skipped before it"), "42 bytes", name);
		}
	});

	it("does not skip anything in a message that starts at byte 0", () => {
		assert.equal(method({ message: CHECK }).get("Skipped before it"), undefined);
		// A wrong length at byte 0 is reported against that message, not hidden by finding another.
		const out = tool.run({ message: "0001 0008 2112a442 b7e7a701 bc5ca493 5d339347", password: "", username: "", realm: "", view: "all" }) as Output;
		assert.equal(out.kind, "error");
	});

	it("leads with the answer, then what to fix, then the decode, with no banner and no tiles", () => {
		const roles = (input: Run) => parts(input).map((p) => p.role ?? p.kind);
		assert.deepEqual(roles({ message: CHECK }), ["answer", "findings", "decoded", "method"]);
		assert.deepEqual(roles({ message: CHECK, password: "server+password+24+chars" }), ["answer", "decoded", "method"]);
		// A bare request has no attributes, so no empty table.
		assert.deepEqual(roles({ message: "000100002112a442b7e7a701bc5ca4935d339347" }), ["answer", "method"]);
		// A success response is a message class, not a pass: nothing in the answer is toned unless a check failed.
		const answer = parts({ message: CHECK, password: "server+password+24+chars" })[0];
		assert.ok(answer?.kind === "fields" && answer.fields.every((f) => f.tone === undefined));
	});
});
