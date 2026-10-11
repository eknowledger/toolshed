/**
 * Properties of the STUN decoder that a single fixture cannot pin.
 *
 *   pnpm test
 *
 *  - every address round-trips: XOR it the way RFC 8489 says, decode it, get it back, for IPv4 and IPv6;
 *  - the class bits are interleaved with the method's, so 0x0101 is a Binding success and 0x0113 an Allocate error;
 *  - flipping any byte of a message with a FINGERPRINT makes the FINGERPRINT fail, or the message fail to parse;
 *  - MESSAGE-INTEGRITY verifies only with the right password.
 *
 * The samples' own bytes were made by aioice, so passing them is agreement with an independent implementation, and
 * the hand-written CRC-32, SHA-1 and HMAC are held to their published test vectors as well.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Output } from "@toolbench/sdk";
import tool, { crc32, hmacSha1, sha1 } from "./index.ts";

const CHECK =
	"000100482112a4428f1e2d3c4b5a69788796a5b400060009737276373a616c6365000000002400046effffff802a00081d2c3b4a596877860025000000080014af2e7f7fee8a3d03b3149db5176cad7455e8d93880280004839f5505";

function fields(message: string, password = ""): Map<string, { value: string; tone?: string; note?: string }> {
	const out = tool.run({ message, password, view: "fields" }) as Output;
	assert.equal(out.kind, "group");
	const part = out.kind === "group" ? out.parts[0] : undefined;
	assert.ok(part?.kind === "fields");
	return new Map(part.fields.map((f) => [f.label, f]));
}

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
	it("computes SHA-1, HMAC-SHA1 and CRC-32 as their standards' test vectors say", () => {
		// FIPS 180-2 appendix A.1 and A.2.
		assert.equal(hexOf(sha1(enc("abc"))), "a9993e364706816aba3e25717850c26c9cd0d89d");
		assert.equal(hexOf(sha1(enc("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))), "84983e441c3bd26ebaae4aa1f95129e5e54670f1");
		// RFC 2202 section 3, test cases 1 and 2.
		assert.equal(hexOf(hmacSha1(new Uint8Array(20).fill(0x0b), enc("Hi There"))), "b617318655057264e28bc0b6fb378c8ef146be00");
		assert.equal(hexOf(hmacSha1(enc("Jefe"), enc("what do ya want for nothing?"))), "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79");
		// The standard CRC-32 check value.
		assert.equal(crc32(enc("123456789")), 0xcbf43926);
	});

	it("round-trips XOR-MAPPED-ADDRESS for IPv4 and IPv6", () => {
		const txid = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
		assert.equal(fields(xorMapped([192, 0, 2, 10], 54321, txid)).get("XOR-MAPPED-ADDRESS")?.value, "192.0.2.10:54321");
		assert.equal(fields(xorMapped([198, 51, 100, 20], 3478, txid)).get("XOR-MAPPED-ADDRESS")?.value, "198.51.100.20:3478");
		const v6 = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
		assert.equal(fields(xorMapped(v6, 443, txid)).get("XOR-MAPPED-ADDRESS")?.value, "[2001:db8:0:0:0:0:0:1]:443");
	});

	it("reads the interleaved class bits", () => {
		assert.equal(fields("010100002112a442000000000000000000000000").get("Message")?.value, "Binding success response");
		assert.equal(fields("011300002112a442000000000000000000000000").get("Message")?.value, "Allocate error response");
		assert.equal(fields("001100002112a442000000000000000000000000").get("Message")?.value, "Binding indication");
	});

	it("catches a flipped byte anywhere before the FINGERPRINT", () => {
		const bytes = CHECK.match(/../g) ?? [];
		for (let i = 0; i < bytes.length - 8; i++) {
			const flipped = [...bytes];
			flipped[i] = ((Number.parseInt(flipped[i]!, 16) ^ 0x01) & 0xff).toString(16).padStart(2, "0");
			const out = tool.run({ message: flipped.join(""), password: "", view: "fields" }) as Output;
			if (out.kind === "error") continue; // the header itself broke, which is also caught
			const part = out.kind === "group" ? out.parts[0] : undefined;
			const fp = part?.kind === "fields" ? part.fields.find((f) => f.label === "FINGERPRINT") : undefined;
			// Byte 2 and 3 are the length; a changed length moves where FINGERPRINT is read, so it may not parse as one.
			if (fp) assert.equal(fp.tone, "bad", `byte ${i} flipped and the FINGERPRINT still matched`);
		}
	});

	it("verifies MESSAGE-INTEGRITY only with the right password", () => {
		assert.equal(fields(CHECK, "server+password+24+chars").get("MESSAGE-INTEGRITY")?.tone, "good");
		assert.equal(fields(CHECK, "server+password+24+chars!").get("MESSAGE-INTEGRITY")?.tone, "bad");
		assert.match(fields(CHECK).get("MESSAGE-INTEGRITY")?.note ?? "", /give the password/);
	});
});
