/**
 * Invariants a fixture cannot express.
 *
 * `cases.json` pins values: this packet has that sequence number. What it cannot say is "no highlight
 * ever points outside the packet", because that is a rule about every possible input rather than a fact
 * about one. Those rules are where a decoder actually goes wrong: an off-by-one in a length field
 * produces plausible output at the wrong offset, and a fixture written from the same misreading agrees
 * with it.
 *
 * Packets here are built from RFC 3550 field semantics, so a passing test means the parser recovers what
 * was encoded, not that it agrees with itself.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Output, Tool } from "@toolbench/sdk";
import tool from "./index.ts";

/*
 * ⚠️ Typed as `Tool`, not used as the exported literal.
 *
 * `index.ts` writes `run({ packet, view })` and ends with `satisfies Tool<Input>`. `satisfies` checks
 * against the interface but PRESERVES the literal's own type, so the export's `run` has arity 1, and
 * calling it with a `Ctx` the way the runtime does fails to compile against it. Going through the
 * interface both fixes that and is the honest thing: the runtime always passes a context, so a test
 * that could not would be testing a different call.
 */
const impl: Tool<{ packet: string; view: string; arrival: string }> = tool;
const ctx = { signal: new AbortController().signal, progress: () => {} };
/**
 * Run the tool and narrow the result.
 *
 * `Tool.run` may return a promise, so the interface widens to `Output | Promise<Output>`. Asserting it
 * is not one here narrows the type for every test below AND checks something worth checking: this tool
 * is declared `thread: "main"` with `card: "live"`, and both of those are only honest if it never awaits.
 */
const run = (packet: string, view = "all", arrival = ""): Output => {
	const out = impl.run({ packet, view, arrival }, ctx);
	assert.ok(!(out instanceof Promise), "the inspector must stay synchronous: it runs on the main thread as a live card");
	return out;
};

const PACKETS = {
	rtpMinimal: "8000002a000000a0deadbeefaabbccdd",
	rtpCsrcExt: "92e003e800015f9011223344aaaa0001aaaa0002bede0002103021aabb0000000102",
	rtpPadding: "a008000700001f40010203041122000003",
	// profile 0x1000 (two-byte form), 1 word of data: element ID 0x01, len 2, data 03 04.
	rtpTwoByteExt: "9000002a000000a0deadbeef1000000101020304",
	srSdes:
		"81c8000c11111111e8754700499602d20036ee8000001388000c3500222222221a000005000005dc00000028aabbccdd0000303981ca0006111111110111616c696365406578616d706c652e636f6d00",
	bye: "81cb0004111111110874656172646f776e000000",
	// RC=0: an RR with no report blocks. RC=1 would promise 24 bytes the length field denies.
	rr: "80c9000111111111",
	// Post 5's two packets, from rtcp_reports.py: Alice's SR + SDES, and the server's RR + SDES that answers it.
	aliceSr:
		"80 c8 00 06 1f 2e 3d 4c ee 69 d8 f0 40 00 00 00 00 02 ee 00 00 00 00 c8 00 00 3e 80 81 ca 00 06 1f 2e 3d 4c 01 10 4b 39 67 47 79 58 38 4f 41 4b 38 61 48 38 4d 79 00 00",
	serverRr:
		"81 c9 00 07 7a 3b 9c 5d 1f 2e 3d 4c 06 00 00 06 00 00 04 e1 00 00 00 82 d8 f0 40 00 00 00 fd 70 81 ca 00 06 7a 3b 9c 5d 01 10 73 2b 72 4e 4d 30 4d 37 4d 62 55 6c 49 31 45 44 00 00",
};

function bytesPart(packet: string) {
	const out = run(packet);
	assert.equal(out.kind, "group", `expected a group, got ${out.kind}`);
	if (out.kind !== "group") throw new Error("unreachable");
	const part = out.parts.find((p) => p.kind === "bytes");
	assert.ok(part, "every successful decode should include a bytes view");
	if (part?.kind !== "bytes") throw new Error("unreachable");
	return part;
}

describe("byte highlights stay inside the packet they describe", () => {
	for (const [name, packet] of Object.entries(PACKETS)) {
		it(name, () => {
			const view = bytesPart(packet);
			const length = view.bytes.length;
			assert.equal(length, packet.replace(/\s/g, "").length / 2, "the byte view must be the whole packet");
			for (const range of view.highlight ?? []) {
				assert.ok(range.at >= 0, `${range.label}: at is ${range.at}`);
				assert.ok(range.len > 0, `${range.label}: len is ${range.len}`);
				assert.ok(
					range.at + range.len <= length,
					`${range.label}: covers ${range.at}..${range.at + range.len} but the packet is ${length} bytes. An offset past the end means a length field was misread.`,
				);
				assert.ok(range.label.length > 0, "a highlight with no label tells a screen reader nothing");
			}
		});
	}
});

describe("highlights do not overlap", () => {
	/*
	 * Overlap is the signature of a double-counted field: a parser that advances by the wrong amount
	 * marks the same bytes twice and still lists a plausible value for each.
	 *
	 * The RTP marker bit is the one legitimate exception, since it shares byte 1 with the payload type,
	 * so single-byte ranges at the same offset are allowed.
	 */
	for (const [name, packet] of Object.entries(PACKETS)) {
		it(name, () => {
			const ranges = [...(bytesPart(packet).highlight ?? [])].sort((a, b) => a.at - b.at || a.len - b.len);
			for (let i = 1; i < ranges.length; i++) {
				const previous = ranges[i - 1]!;
				const current = ranges[i]!;
				if (previous.at === current.at && previous.len === 1 && current.len === 1) continue; // bit fields
				assert.ok(
					current.at >= previous.at + previous.len,
					`"${previous.label}" (${previous.at}+${previous.len}) overlaps "${current.label}" (${current.at}+${current.len})`,
				);
			}
		});
	}
});

describe("the RTCP length field is honoured, not the packet end", () => {
	it("finds both sub-packets of a compound, which needs words-minus-one", () => {
		const out = run(PACKETS.srSdes, "fields");
		assert.equal(out.kind, "group");
		if (out.kind !== "group") return;
		const fields = out.parts.find((p) => p.kind === "fields");
		assert.ok(fields?.kind === "fields");
		const count = fields.fields.find((f) => f.label === "Sub-packets");
		assert.equal(count?.value, "2", "reading the length as words rather than words-minus-one loses the second packet");
		assert.match(String(count?.note), /SR \+ SDES/);
	});

	it("a trailing byte after the last sub-packet is a truncation, not silence", () => {
		// The length field claims 4 words; appending one byte makes the compound inconsistent.
		const out = run(`${PACKETS.rr}ff`);
		assert.equal(out.kind, "error", "an inconsistent compound must be reported");
		if (out.kind === "error") assert.match(out.message, /Truncated|RTCP common header/);
	});
});

describe("padding is subtracted from the payload, not added to it", () => {
	it("reports 2 payload bytes for a packet whose last 3 are padding", () => {
		const out = run(PACKETS.rtpPadding, "fields");
		assert.equal(out.kind, "group");
		if (out.kind !== "group") return;
		const fields = out.parts.find((p) => p.kind === "fields");
		assert.ok(fields?.kind === "fields");
		assert.equal(fields.fields.find((f) => f.label === "Payload")?.value, "2 bytes");
		assert.equal(fields.fields.find((f) => f.label === "Padding")?.value, "3 bytes");
	});

	it("refuses a padding count that does not fit", () => {
		// P set, and the final byte claims 200 padding bytes in a 17-byte packet.
		const out = run("a008000700001f4001020304112200 00c8".replace(/\s/g, ""));
		assert.equal(out.kind, "error");
		if (out.kind === "error") assert.match(out.message, /padding/i);
	});
});

describe("both RFC 8285 extension forms are decoded, and neither is guessed", () => {
	it("the one-byte form encodes length as len-1", () => {
		const out = run(PACKETS.rtpCsrcExt, "fields");
		assert.equal(out.kind, "group");
		if (out.kind !== "group") return;
		const table = out.parts.find((p) => p.kind === "table");
		assert.ok(table?.kind === "table");
		// 0x10 is ID 1 with len nibble 0, which means ONE byte, not zero.
		assert.deepEqual(table.rows[0]?.map((c) => (typeof c === "object" ? c.text : String(c))), ["1", "1", "24", "30"]);
	});

	it("the two-byte form encodes length directly", () => {
		const out = run(PACKETS.rtpTwoByteExt, "fields");
		assert.equal(out.kind, "group");
		if (out.kind !== "group") return;
		const fields = out.parts.find((p) => p.kind === "fields");
		assert.ok(fields?.kind === "fields");
		assert.match(String(fields.fields.find((f) => f.label === "Extension profile")?.note), /two-byte/);
	});

	it("an unknown profile says so rather than decoding it as one of the two", () => {
		// Profile 0xABCD is neither 0xBEDE nor 0x100x, so its contents are profile-specific.
		const out = run("9000002a000000a0deadbeefabcd000101020304", "fields");
		assert.equal(out.kind, "group");
		if (out.kind !== "group") return;
		const fields = out.parts.find((p) => p.kind === "fields");
		assert.ok(fields?.kind === "fields");
		assert.match(String(fields.fields.find((f) => f.label === "Extension profile")?.note), /profile-specific/);
		assert.ok(
			fields.fields.some((f) => f.label === "Extension data"),
			"an undecodable extension should still be shown as a span, so its bytes are accounted for",
		);
	});
});

describe("RTP and RTCP are dispatched, not assumed", () => {
	const cases: [string, string, string][] = [
		["an RTP packet with payload type 0", PACKETS.rtpMinimal, "RTP"],
		["payload type 96, which is dynamic", PACKETS.rtpCsrcExt, "RTP"],
		["SR, type 200", PACKETS.srSdes, "RTCP"],
		["RR, type 201", PACKETS.rr, "RTCP"],
		["BYE, type 203", PACKETS.bye, "RTCP"],
	];
	for (const [label, packet, expected] of cases) {
		it(`${label} is ${expected}`, () => {
			const out = run(packet, "fields");
			assert.equal(out.kind, "group");
			if (out.kind !== "group") return;
			const fields = out.parts.find((p) => p.kind === "fields");
			assert.ok(fields?.kind === "fields");
			assert.equal(fields.fields.find((f) => f.label === "Protocol")?.value, expected);
		});
	}
});

describe("hex is read the way people actually paste it", () => {
	const expected = "0xDEADBEEF";
	const variants: [string, string][] = [
		["one run", "8000002a000000a0deadbeefaabbccdd"],
		["spaced bytes", "80 00 00 2a 00 00 00 a0 de ad be ef aa bb cc dd"],
		["colon separated", "80:00:00:2a:00:00:00:a0:de:ad:be:ef:aa:bb:cc:dd"],
		["upper case", "8000002A000000A0DEADBEEFAABBCCDD"],
		["0x prefixed", "0x80 0x00 0x00 0x2a 0x00 0x00 0x00 0xa0 0xde 0xad 0xbe 0xef 0xaa 0xbb 0xcc 0xdd"],
		["a Wireshark-style dump with line offsets", "0000  80 00 00 2a 00 00 00 a0\n0008  de ad be ef aa bb cc dd"],
	];
	for (const [label, packet] of variants) {
		it(label, () => {
			const out = run(packet, "fields");
			assert.equal(out.kind, "group", `${label} should decode`);
			if (out.kind !== "group") return;
			const fields = out.parts.find((p) => p.kind === "fields");
			assert.ok(fields?.kind === "fields");
			assert.equal(fields.fields.find((f) => f.label === "SSRC")?.value, expected, `${label} decoded a different SSRC`);
		});
	}
});

/** The arithmetic part: the second `fields` output, present for any RTCP packet with an SR or a report block. */
function timing(packet: string, arrival = ""): { group?: string; label: string; value: string; note?: string; tone?: string }[] {
	const out = run(packet, "fields", arrival);
	assert.equal(out.kind, "group", `expected a group, got ${out.kind}`);
	if (out.kind !== "group") return [];
	const parts = out.parts.filter((p) => p.kind === "fields");
	assert.equal(parts.length, 2, "the field list, then the arithmetic");
	return parts[1]?.kind === "fields" ? parts[1].fields : [];
}

/** An RR with one report block whose LSR and DLSR are given, every other field zero or a placeholder SSRC. */
const rrWith = (lsr: number, dlsr: number) =>
	`81c90007 11111111 22222222 00000000 00000000 00000000 ${lsr.toString(16).padStart(8, "0")} ${dlsr.toString(16).padStart(8, "0")}`;
const short = (x: number) => `${(x >>> 16).toString(16).padStart(4, "0")}:${(x & 0xffff).toString(16).padStart(4, "0")}`;

describe("the NTP timestamp is seconds and a binary fraction", () => {
	/*
	 * Version 1.1 printed the 32-bit fraction as an integer after a decimal point, so a quarter of a second,
	 * 0x40000000, read as .1073741824. These pin the fix at the fractions where a wrong reading is obvious.
	 */
	const sr = (frac: string) => `80c80006 11111111 e8754700 ${frac} 00000000 00000000 00000000`;
	const cases: [string, string, string][] = [
		["00000000", "3900000000.000000 s", "2023-08-02T21:20:00.000Z"],
		["40000000", "3900000000.250000 s", "2023-08-02T21:20:00.250Z"],
		["80000000", "3900000000.500000 s", "2023-08-02T21:20:00.500Z"],
		// 1 - 2^-32 rounds to a whole second at six places, so it carries; the date truncates, as a clock reading does.
		["ffffffff", "3900000001.000000 s", "2023-08-02T21:20:00.999Z"],
	];
	for (const [frac, value, date] of cases) {
		it(`0x${frac}`, () => {
			const out = run(sr(frac), "fields");
			assert.equal(out.kind, "group");
			if (out.kind !== "group") return;
			const fields = out.parts.find((p) => p.kind === "fields");
			assert.ok(fields?.kind === "fields");
			const ntp = fields.fields.find((f) => f.label === "#1 NTP timestamp");
			assert.equal(ntp?.value, value);
			assert.equal(ntp?.note, date);
		});
	}

	it("echoes the SR's middle 32 bits as the LSR its answer carries", () => {
		// Alice's SR says 0xD8F04000; the server's RR, which answers it, carries the same 32 bits as LSR.
		const middle = timing(PACKETS.aliceSr).find((f) => f.label === "Middle 32 bits");
		assert.equal(middle?.value, "0xD8F04000");
		const lsr = timing(PACKETS.serverRr).find((f) => f.label === "LSR");
		assert.equal(lsr?.value, "0xD8F0:4000");
	});
});

describe("the round trip is A - LSR - DLSR, modulo 2^32", () => {
	it("recovers the round trip it was built from, whatever the clock reads", () => {
		// A = LSR + DLSR + rtt by construction, so the tool must give back rtt. LSR near the top of the 32-bit range
		// makes A wrap past zero, which the RFC's modular arithmetic has to survive.
		for (const lsr of [0x00010000, 0xd8f04000, 0xffff8000]) {
			for (const [dlsr, rtt, shown] of [
				[0x0000fd70, 3932, "59.998 ms"],
				[0x00010000, 0x8000, "500.000 ms"],
				[0x00054000, 0x62000, "6.125 s"],
			] as const) {
				const arrival = (lsr + dlsr + rtt) >>> 0;
				const field = timing(rrWith(lsr, dlsr), short(arrival)).find((f) => f.label === "Round trip");
				assert.equal(field?.value, shown, `LSR ${short(lsr)}, DLSR ${short(dlsr)}, A ${short(arrival)}`);
				assert.match(String(field?.note), new RegExp(`= ${rtt} / 65536 s$`));
			}
		}
	});

	it("calls an A earlier than LSR + DLSR negative rather than reporting 18 hours", () => {
		// A equal to LSR leaves -DLSR, which modulo 2^32 is just under 65536 s: a clock problem, not a long trip.
		const field = timing(PACKETS.serverRr, "d8f0:4000").find((f) => f.label === "Round trip");
		assert.equal(field?.value, "negative");
		assert.equal(field?.tone, "bad");
	});

	it("does not invent a round trip when no SR has been answered", () => {
		// RFC 3550 6.4.1: "If no SR has been received yet, the field is set to zero."
		const fields = timing(rrWith(0, 0), "d8f1:4ccc");
		assert.equal(fields.find((f) => f.label === "LSR")?.value, "0");
		assert.equal(fields.find((f) => f.label === "Round trip")?.value, "none");
		assert.equal(fields.filter((f) => f.label === "Round trip").length, 1, "and does not also claim there is no report block");
	});

	it("times an SR's report blocks too, since they carry the same LSR and DLSR", () => {
		// The default packet's block: LSR 0xAABBCCDD, DLSR 12345. A = LSR + DLSR + 3932 gives the same 59.998 ms.
		const arrival = (0xaabbccdd + 12345 + 3932) >>> 0;
		const field = timing(PACKETS.srSdes, short(arrival)).find((f) => f.label === "Round trip");
		assert.equal(field?.value, "59.998 ms");
	});

	it("says so when A is given for a packet with no report block", () => {
		const field = timing(PACKETS.aliceSr, "d8f1:4ccc").find((f) => f.label === "Round trip");
		assert.equal(field?.value, "no report block");
	});

	it("reads A the ways RFC 3550 and a log write it", () => {
		for (const arrival of ["d8f14ccc", "0xd8f1:4ccc", "D8F1:4CCC", "d8f1 4ccc", " 0xd8f14ccc "]) {
			assert.equal(timing(PACKETS.serverRr, arrival).find((f) => f.label === "Round trip")?.value, "59.998 ms", arrival);
		}
	});
});

describe("the fraction lost is shown as the 8-bit value it is", () => {
	it("every value from 0 to 255 reads as n/256", () => {
		for (let n = 0; n < 256; n++) {
			const packet = `81c90007 11111111 22222222 ${n.toString(16).padStart(2, "0")}000000 00000000 00000000 00000000 00000000`;
			const field = timing(packet).find((f) => f.label === "Fraction lost");
			assert.equal(field?.value, `${n}/256 = ${((n / 256) * 100).toFixed(2)}%`);
		}
	});
});
