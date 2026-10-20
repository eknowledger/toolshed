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
const impl: Tool<{ packet: string; view: string; arrival: string; clock: string }> = tool;
const ctx = { signal: new AbortController().signal, progress: () => {} };
/**
 * Run the tool and narrow the result.
 *
 * `Tool.run` may return a promise, so the interface widens to `Output | Promise<Output>`. Asserting it
 * is not one here narrows the type for every test below AND checks something worth checking: this tool
 * is declared `thread: "main"` with `card: "live"`, and both of those are only honest if it never awaits.
 */
const run = (packet: string, view = "all", arrival = "", clock = "0"): Output => {
	const out = impl.run({ packet, view, arrival, clock }, ctx);
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
	/*
	 * The feedback messages, each built by hand from the layout in its spec rather than captured, so each
	 * decode is checked against what was encoded. RFC 4585 6.2.1: PID 100 with BLP 0b101 asks for 100, 101, 103.
	 */
	nack: "81cd0003 7a3b9c5d 1f2e3d4c 00640005",
	// RFC 4585 6.3.1, inside the compound RFC 3550 requires: an empty RR, then a PLI with no FCI.
	rrPli: "80c90001 7a3b9c5d 81ce0002 7a3b9c5d 1f2e3d4c",
	// RFC 5104 4.3.1: media source 0, one FCI entry for 0x1F2E3D4C with command sequence 7.
	fir: "84ce0004 7a3b9c5d 00000000 1f2e3d4c 07000000",
	// draft-alvestrand-rmcat-remb-03 2.2: 1,500,000 bit/s is mantissa 187500 x 2^3, for one SSRC.
	remb: "8fce0005 7a3b9c5d 00000000 52454d42 010edc6c 1f2e3d4c",
	/*
	 * draft-holmer-rmcat-transport-wide-cc-extensions-01 3.1: base 100, 8 packets, reference time 1000 x 64 ms,
	 * feedback count 5. A run chunk of 5 small deltas (0x2005), a one-bit vector for the last 3, 1 0 1 (0xA800),
	 * then 7 one-byte deltas of 20, 20, 20, 21, 20, 22 and 19 ms, and one byte of padding.
	 */
	twcc: "8fcd0007 7a3b9c5d 1f2e3d4c 00640008 0003e805 2005a800 50505054 50584c00",
	// A two-bit vector (0xD800): small, large, not received. The large delta is -1 ms, 0xFFFC, so packet 2 arrives first.
	twccLarge: "8fcd0006 7a3b9c5d 1f2e3d4c 00010003 00000000 d80004ff fc000000",
	/*
	 * RFC 8888 3.1: one stream, 3 packets from 100. 0x8100 arrived 256/1024 s = 250 ms before the report, 0xE200
	 * arrived 500 ms before with ECN CE (11), 0x0000 never arrived; 16 bits of padding, then the report timestamp.
	 */
	ccfb: "8bcd0006 7a3b9c5d 1f2e3d4c 00640003 8100e200 00000000 d8f14ccc",
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
		const fields = out.parts.find((p) => p.id === "fields");
		assert.ok(fields?.kind === "fields");
		const groups = [...new Set(fields.fields.map((f) => f.group).filter((g) => g !== "Packet"))];
		assert.deepEqual(groups, ["SR #1", "SDES #2"], "reading the length as words rather than words-minus-one loses the second packet");
		const answer = out.parts[0];
		assert.ok(answer?.kind === "fields");
		assert.match(answer.fields[0]!.value, /: SR from 0x[0-9A-F]{8}, then SDES$/);
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
		const fields = out.parts.find((p) => p.id === "fields");
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
		const fields = out.parts.find((p) => p.id === "fields");
		assert.ok(fields?.kind === "fields");
		assert.match(String(fields.fields.find((f) => f.label === "Extension profile")?.note), /two-byte/);
	});

	it("an unknown profile says so rather than decoding it as one of the two", () => {
		// Profile 0xABCD is neither 0xBEDE nor 0x100x, so its contents are profile-specific.
		const out = run("9000002a000000a0deadbeefabcd000101020304", "fields");
		assert.equal(out.kind, "group");
		if (out.kind !== "group") return;
		const fields = out.parts.find((p) => p.id === "fields");
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
			const fields = out.parts.find((p) => p.id === "fields");
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
			const fields = out.parts.find((p) => p.id === "fields");
			assert.ok(fields?.kind === "fields");
			assert.equal(fields.fields.find((f) => f.label === "SSRC")?.value, expected, `${label} decoded a different SSRC`);
		});
	}
});

/** The arithmetic part, `id: "timing"`, present for any RTCP packet with an SR or a report block. */
function timing(packet: string, arrival = ""): { group?: string; label: string; value: string; note?: string; tone?: string }[] {
	const out = run(packet, "fields", arrival);
	assert.equal(out.kind, "group", `expected a group, got ${out.kind}`);
	if (out.kind !== "group") return [];
	const part = out.parts.find((p) => p.id === "timing");
	assert.ok(part, "an RTCP packet with an SR or a report block has its arithmetic as its own part");
	return part?.kind === "fields" ? part.fields : [];
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
			const fields = out.parts.find((p) => p.id === "fields");
			assert.ok(fields?.kind === "fields");
			const ntp = fields.fields.find((f) => f.group === "SR #1" && f.label === "NTP timestamp");
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

/** The parts of a decode, by the id each one carries. */
function partsOf(packet: string, arrival = "", clock = "0") {
	const out = run(packet, "fields", arrival, clock);
	assert.equal(out.kind, "group", `expected a group, got ${out.kind}`);
	return out.kind === "group" ? out.parts : [];
}

describe("the fraction lost is shown as the 8-bit value it is", () => {
	it("every value from 0 to 255 reads as n/256", () => {
		for (let n = 0; n < 256; n++) {
			const packet = `81c90007 11111111 22222222 ${n.toString(16).padStart(2, "0")}000000 00000000 00000000 00000000 00000000`;
			const table = partsOf(packet).find((p) => p.kind === "table" && p.role === "decoded");
			assert.ok(table?.kind === "table");
			const cell = table.rows[0]?.[1];
			assert.equal(typeof cell === "object" ? cell.text : cell, `${n}/256 = ${((n / 256) * 100).toFixed(2)}%`);
		}
	});
});

/** A field of the answer, the first part, by label. */
const answerField = (packet: string, label: string, clock = "0") => {
	const answer = partsOf(packet, "", clock)[0];
	assert.ok(answer?.kind === "fields" && answer.role === "answer");
	return answer.fields.find((f) => f.label === label);
};

describe("the answer comes first, then the tables, then the bytes, with no banner and no tiles", () => {
	for (const [name, packet] of Object.entries(PACKETS)) {
		it(name, () => {
			const parts = run(packet, "all");
			assert.ok(parts.kind === "group");
			const roles = parts.parts.map((p) => p.role ?? p.kind);
			assert.equal(roles[0], "answer", "the first part is what the packet is");
			const answer = parts.parts[0];
			assert.ok(answer?.kind === "fields" && answer.fields.length >= 1 && answer.fields.length <= 4, "one to four fields");
			assert.equal(answer.fields[0]?.label, "Packet");
			for (const gone of ["verdict", "stats", "actions"]) assert.ok(!roles.includes(gone), `no ${gone} part: ${roles.join(",")}`);
			const bytes = roles.indexOf("bytes");
			const lastTable = parts.parts.findLastIndex((p) => p.kind === "table");
			if (lastTable >= 0) assert.ok(lastTable < bytes, `the report or feedback table comes before the bytes: ${roles.join(",")}`);
		});
	}
});

describe("a NACK names every packet it asks for", () => {
	it("each set bit i of BLP is PID + i + 1", () => {
		for (let bit = 0; bit < 16; bit++) {
			const blp = (1 << bit).toString(16).padStart(4, "0");
			const fields = partsOf(`81cd0003 7a3b9c5d 1f2e3d4c 03e8${blp}`).find((p) => p.id === "fields");
			assert.ok(fields?.kind === "fields");
			assert.equal(fields.fields.find((f) => f.group === "NACK #1" && f.label === "NACK entry 1")?.value, `2 packets lost: 1000, ${1000 + bit + 1}`);
		}
	});

	it("wraps past 65535, as sequence numbers do", () => {
		assert.equal(answerField("81cd0003 7a3b9c5d 1f2e3d4c ffff0003", "Asks again for")?.value, "3 packets: 65535, 0 and 1");
	});

	it("lists every entry of a NACK with several", () => {
		assert.equal(answerField("81cd0004 7a3b9c5d 1f2e3d4c 00640000 00c80001", "Asks again for")?.value, "3 packets: 100, 200 and 201");
	});
});

describe("REMB's bitrate is the mantissa times two to the exponent", () => {
	it("recovers the bitrate it was built from", () => {
		for (const [exponent, mantissa, shown] of [
			[0, 64000, "64.0 kbit/s"],
			[3, 187500, "1.50 Mbit/s"],
			[10, 262143, "268.43 Mbit/s"],
		] as const) {
			const b5 = ((exponent << 2) | (mantissa >> 16)).toString(16).padStart(2, "0");
			const rest = (mantissa & 0xffff).toString(16).padStart(4, "0");
			const fields = partsOf(`8fce0005 7a3b9c5d 00000000 52454d42 01${b5}${rest} 1f2e3d4c`).find((p) => p.id === "fields");
			assert.ok(fields?.kind === "fields");
			const field = fields.fields.find((f) => f.group === "REMB #1" && f.label === "Bitrate");
			assert.equal(field?.value, shown);
			assert.equal(field?.note, `mantissa ${mantissa} x 2^${exponent} = ${mantissa * 2 ** exponent} bit/s`);
		}
	});

	it("an FMT 15 payload feedback without the REMB identifier is not read as one", () => {
		assert.equal(answerField("8fce0003 7a3b9c5d 00000000 41424344", "Packet")?.value, "RTCP, 16 bytes: AFB");
		assert.equal(answerField("8fce0003 7a3b9c5d 00000000 41424344", "Bandwidth estimate"), undefined);
	});
});

describe("TWCC is decoded down to each packet's arrival", () => {
	const table = (packet: string) => {
		const part = partsOf(packet).find((p) => p.id === "twcc-1");
		assert.ok(part?.kind === "table");
		return part.rows.map((row) => row.map((c) => (typeof c === "object" ? c.text : String(c))));
	};

	it("reads a run chunk, a one-bit vector and one-byte deltas", () => {
		assert.deepEqual(table(PACKETS.twcc), [
			["100", "arrived", "20.00 ms", "20.00 ms"],
			["101", "arrived", "20.00 ms", "40.00 ms"],
			["102", "arrived", "20.00 ms", "60.00 ms"],
			["103", "arrived", "21.00 ms", "81.00 ms"],
			["104", "arrived", "20.00 ms", "101.00 ms"],
			["105", "arrived", "22.00 ms", "123.00 ms"],
			["106", "lost", "", ""],
			["107", "arrived", "19.00 ms", "142.00 ms"],
		]);
	});

	it("stops at the status count, not at the end of the last chunk", () => {
		// The vector holds 14 statuses and only 3 are packets; reading them all would invent 11 lost packets.
		assert.equal(table(PACKETS.twcc).length, 8);
	});

	it("reads a two-bit vector and a signed two-byte delta", () => {
		assert.deepEqual(table(PACKETS.twccLarge), [
			["1", "arrived", "1.00 ms", "1.00 ms"],
			["2", "arrived, large delta", "-1.00 ms", "0.00 ms"],
			["3", "lost", "", ""],
		]);
	});

	it("reads the draft's own one-bit vector example the way its example says", () => {
		/*
		 * Section 3.1.4's prose says a one-bit 0 is "packet received", but its Example 1, 0x9F1C, reads 0 as not
		 * received, and libwebrtc does too. The example wins: 1 lost, 5 arrived, 3 lost, 3 arrived, 2 lost.
		 */
		const rows = table("8fcd0007 7a3b9c5d 1f2e3d4c 0000000e 00000000 9f1c0000 00000000 00000000");
		assert.equal(rows.map((r) => (r[1] === "lost" ? "N" : "R")).join(""), "NRRRRRNNNRRRNN");
	});

	it("draws lost packets as gaps, not as zeros", () => {
		const chart = partsOf(PACKETS.twcc).find((p) => p.kind === "series" && p.id === "twcc-chart-1");
		assert.ok(chart?.kind === "series");
		assert.deepEqual(chart.chart.series[0]?.points, [0, 20, 40, 61, 81, 103, null, 122]);
	});

	it("refuses deltas that run past the message", () => {
		// The same message with its last word cut and the length lowered to match: 7 deltas no longer fit.
		const out = run("8fcd0006 7a3b9c5d 1f2e3d4c 00640008 0003e805 2005a800 50505054");
		assert.equal(out.kind, "error");
	});
});

describe("a compound that does not start with a report is in the answer", () => {
	it("PLI then RR is called out as droppable, the one tone a protocol rule earns", () => {
		const field = answerField("81ce0002 7a3b9c5d 1f2e3d4c 80c90001 7a3b9c5d", "Compound order");
		assert.equal(field?.tone, "bad");
		assert.match(String(field?.note), /RFC 3550 6\.1/);
		assert.equal(answerField(PACKETS.rrPli, "Compound order"), undefined, "RR then PLI is in order");
	});
});

describe("RFC 8888 feedback is decoded too", () => {
	it("reads R, ECN and the arrival offset in 1/1024 s", () => {
		const part = partsOf(PACKETS.ccfb).find((p) => p.id === "ccfb-1");
		assert.ok(part?.kind === "table");
		assert.deepEqual(
			part.rows.map((row) => row.map((c) => (typeof c === "object" ? c.text : String(c))).slice(1)),
			[
				["100", "arrived", "250.00 ms"],
				["101", "arrived, marked congested (ECN CE)", "500.00 ms"],
				["102", "lost", ""],
			],
		);
	});

	it("an ECN congestion mark is something to act on", () => {
		assert.match(String(answerField(PACKETS.ccfb, "Marked congested")?.note), /ECN CE/);
	});
});

describe("the clock rate turns RTP time into seconds", () => {
	it("is asked for, not assumed", () => {
		const fields = partsOf(PACKETS.rtpMinimal).find((p) => p.id === "fields");
		assert.ok(fields?.kind === "fields");
		assert.match(String(fields.fields.find((f) => f.label === "Timestamp")?.note), /not in the packet/);
	});

	it("reads a timestamp at the rate given", () => {
		// The voice packet's timestamp is 9600: 0.2 s of 48 kHz audio, or 1.2 s at 8 kHz.
		for (const [clock, shown] of [["48000", "0.200 s at 48 kHz"], ["8000", "1.200 s at 8 kHz"]] as const) {
			const fields = partsOf("806f03f2000025801f2e3d4c", "", clock).find((p) => p.id === "fields");
			assert.ok(fields?.kind === "fields");
			assert.ok(String(fields.fields.find((f) => f.label === "Timestamp")?.note).startsWith(shown), clock);
		}
	});

	it("reads the report block's jitter in ms, as the README says: 130 units at 48 kHz is 2.708 ms", () => {
		const table = partsOf(PACKETS.serverRr, "", "48000").find((p) => p.kind === "table" && p.role === "decoded");
		assert.ok(table?.kind === "table");
		const cell = table.rows[0]?.[3];
		assert.equal(typeof cell === "object" ? cell.text : cell, "130 = 2.708 ms");
	});
});

describe("a dump's text column is not bytes", () => {
	const ssrc = (packet: string) => {
		const fields = partsOf(packet).find((p) => p.id === "fields");
		assert.ok(fields?.kind === "fields");
		return { ssrc: fields.fields.find((f) => f.label === "SSRC")?.value, payload: fields.fields.find((f) => f.label === "Payload")?.value };
	};
	const want = { ssrc: "0x1F2E3D4C", payload: "4 bytes" };
	for (const [label, dump] of [
		// The text column holds "=L" and "%", which were refused as "not hex", and the letters a to f, which were read as bytes.
		["Wireshark's Copy as Hex Dump", "0000   80 6f 03 f2 00 00 25 80 1f 2e 3d 4c de ad be ef   .o....%...=L...."],
		["tcpdump -X, in four-digit groups", "0x0000:  806f 03f2 0000 2580 1f2e 3d4c dead beef  .o....%...=L...."],
		["xxd", "00000000: 806f 03f2 0000 2580 1f2e 3d4c dead beef  .o....%...=L...."],
		["hexdump -C, with its gap in the middle", "00000000  80 6f 03 f2 00 00 25 80  1f 2e 3d 4c de ad be ef  |.o....%...=L....|"],
		["a short last line whose text is all hex letters", "0000   80 6f 03 f2 00 00 25 80 1f 2e 3d 4c   .o....%...=L\n000c   de ad be ef                                       dead"],
	] as const) {
		it(label, () => assert.deepEqual(ssrc(dump), want));
	}
});

describe("a whole frame's headers are stripped, and only a whole frame's", () => {
	// Ethernet (type 0x0800), IPv4 (IHL 5, protocol 17), UDP 50004 to 54321 with length 24, then the 16-byte RTP packet.
	const rtp = "806f03f2000025801f2e3d4cdeadbeef";
	const ipv4 = `450000 2c1c464000 4011c64b c0a8012a c000020a c354d431 00180000 ${rtp}`;
	const ether = `0242ac110002 0242ac110003 0800 ${ipv4}`;
	const ipv6 = `60000000 00181140 ${"00".repeat(32)} c354d431 00180000 ${rtp}`;
	for (const [label, packet, layers] of [
		["an Ethernet frame", ether, "Ethernet, IPv4 and UDP headers"],
		["an IPv4 packet", ipv4, "IPv4 and UDP headers"],
		["an IPv6 packet", ipv6, "IPv6 and UDP headers"],
		["a VLAN-tagged frame", `0242ac110002 0242ac110003 8100 0064 0800 ${ipv4}`, "Ethernet, IPv4 and UDP headers"],
	] as const) {
		it(label, () => {
			const fields = partsOf(packet).find((p) => p.id === "fields");
			assert.ok(fields?.kind === "fields");
			assert.equal(fields.fields.find((f) => f.label === "Stripped first")?.value, layers);
			assert.equal(fields.fields.find((f) => f.label === "SSRC")?.value, "0x1F2E3D4C");
		});
	}

	it("leaves an IP packet that is not UDP alone, and says it is not RTP", () => {
		// Protocol 6 is TCP: nothing is stripped, and 0x45 is version 1, which RTP never is.
		assert.equal(run(`45000028 00004000 4006 0000 c0a8012a c000020a ${"00".repeat(20)}`).kind, "error");
	});
});

describe("no size chart", () => {
	it("draws a chart only for TWCC, whose arrival times are a shape; one stacked bar of sizes said nothing the answer does not", () => {
		for (const [name, packet] of Object.entries(PACKETS)) {
			const charts = partsOf(packet).filter((p) => p.kind === "series");
			assert.ok(charts.every((p) => (p.id ?? "").startsWith("twcc-chart")), name);
		}
	});
});
