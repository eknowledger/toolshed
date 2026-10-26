/**
 * An RTP and RTCP packet inspector.
 *
 * Every free browser decoder for this either shows a flat field list with no relation to the bytes, or
 * requires a pcap. This one takes the hex you copied out of Wireshark or a log and shows the header
 * fields, the report blocks, and the bytes themselves with each field marked in place, so "the
 * extension header is here" is something you can see rather than infer.
 *
 * Scope: the RTP fixed header with CSRCs, both RFC 8285 extension forms, padding, and the RTCP types
 * that carry the information anyone actually debugs with: SR, RR, SDES, BYE and APP, including compound
 * packets, and the feedback messages a WebRTC call sends: generic NACK, PLI, FIR, REMB and transport-wide
 * congestion control feedback (TWCC), each decoded down to the sequence numbers and times it carries.
 *
 * The result leads with what the packet is and what it asks for, then the report blocks or feedback as a
 * table, then the bytes, and only then the field list, because a reader pasting a packet wants "a NACK for
 * packets 100, 101 and 103" or "26/256 lost on 0x22222222" before they want byte 13.
 *
 * For a report block it also does the arithmetic RFC 3550 section 6.4.1 describes: the 8-bit fraction as n/256,
 * LSR and DLSR as seconds, and, given the time the report arrived, the round trip A - LSR - DLSR.
 *
 * References: RFC 3550 (RTP/RTCP), RFC 8285 (header extensions), RFC 3551 (payload types), RFC 4585
 * (feedback, NACK and PLI), RFC 5104 (FIR), draft-alvestrand-rmcat-remb-03 (REMB) and
 * draft-holmer-rmcat-transport-wide-cc-extensions-01 (TWCC).
 */
import type { ByteRange, Cell, Field, Output, Tool } from "@toolbench/sdk";

type Input = { packet: string; view: string; arrival: string; clock: string };

/** A parsed span, kept so the fields, the table and the byte highlights all agree on one source. */
interface Span {
	at: number;
	len: number;
	label: string;
	value: string;
	note?: string;
	tone?: "good" | "warn" | "bad";
	/**
	 * Whether this span gets a highlight in the byte view.
	 *
	 * ⚠️ Not every field does, and that is the whole point. A fully decoded packet has a span for every
	 * byte, so marking them all turns the dump into one solid block: the renderer gives every range the
	 * same colour, adjacent ranges merge, and a highlight that covers everything distinguishes nothing.
	 *
	 * So the byte view marks the values someone is actually hunting for in a hex dump: identifiers,
	 * variable-length text, padding, the payload boundary. Fixed-position header fields are already in
	 * the field list beside it, at a fixed offset anyone can count to.
	 */
	mark?: boolean;
	/** False for a span the field list leaves out, because a table already says it: a whole report block. */
	list?: boolean;
}

/** One part of the packet: a header region, the payload, or an RTCP sub-packet. Gives the RTP answer its sizes. */
interface Segment {
	label: string;
	len: number;
}

class ParseError extends Error {
	readonly at: number | undefined;
	readonly len: number | undefined;
	constructor(message: string, at?: number, len?: number) {
		super(message);
		this.at = at;
		this.len = len;
	}
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Read hex, tolerantly. People paste from Wireshark ("0000   80 e0 00 2a ...   ..*"), from tcpdump -X or xxd
 * ("0x0000:  80e0 002a  ..*"), from hexdump -C ("00000000  80 e0 |..*|"), from a log ("80:e0:00:2a"), or as one
 * run of digits.
 *
 * ⚠️ A dump line's offset and its text column are both NOT bytes, and both used to be a problem. The offset decodes a
 * different packet if read as data. The text column is worse: its punctuation was refused as "not hex", and its
 * letters a to f were silently read as bytes. So on a line that starts with an offset, only the hex before the text
 * column is read. The column starts at a `|`, at a gap of three spaces or more, at a gap of two after four-digit
 * groups (tcpdump and xxd), at the first word that is not hex, or after 16 bytes, which every one of these prints
 * per line.
 */
function readHex(text: string): Uint8Array {
	const pieces = text.split(/\r?\n/).map((line) => {
		const offset = /^\s*(?:0x)?[0-9a-f]{4,8}(?::\s*|\s\s+)/i.exec(line);
		if (!offset) return line;
		let bytes = 0;
		let groupLen = 0;
		const kept: string[] = [];
		for (const match of line.slice(offset[0].length).matchAll(/(\s*)(\S+)/g)) {
			const gap = match[1]!.length;
			const token = match[2]!.replace(/^0x/i, "");
			if (kept.length > 0 && (gap >= 3 || (gap >= 2 && groupLen >= 4))) break;
			if (!/^(?:[0-9a-f]{2})+$/i.test(token) || bytes + token.length / 2 > 16) break;
			kept.push(token);
			bytes += token.length / 2;
			groupLen = token.length;
		}
		return kept.join(" ");
	});
	const withoutPrefixes = pieces.join(" ").replace(/0x/gi, "");
	/*
	 * ⚠️ Reject stray characters rather than filtering them out.
	 *
	 * Stripping everything non-hex is tempting and wrong: "hello there" then yields e, e, e and the
	 * tool complains about an odd digit count, which sends the reader looking at their packet instead
	 * of at their paste. Anything that is not a hex digit or a recognised separator is named.
	 */
	const strays = [...new Set(withoutPrefixes.replace(/[0-9a-f\s:,.\-|]/gi, ""))];
	if (strays.length > 0) {
		throw new ParseError(
			`Not hex: found ${strays.map((c) => `"${c}"`).join(", ")}. Expected hex digits, optionally separated by spaces, colons or commas.`,
		);
	}
	const cleaned = withoutPrefixes.replace(/[^0-9a-f]/gi, "");
	if (cleaned.length === 0) throw new ParseError("No hex digits found. Paste a packet as hex.");
	if (cleaned.length % 2 !== 0) {
		throw new ParseError(`Odd number of hex digits (${cleaned.length}); a byte needs two.`);
	}
	const bytes = new Uint8Array(cleaned.length / 2);
	for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
	return bytes;
}

/**
 * Wireshark copies the whole frame, so a pasted RTP packet often arrives behind an Ethernet, IP and UDP header. Those
 * are stripped, but only when the whole chain checks out: an Ethernet type of IPv4 or IPv6 (behind one VLAN tag at
 * most), an IP header that says UDP, and a UDP length that fits what was pasted. RTP and RTCP are version 2, so their
 * first byte is 0x80 to 0xBF and can never be read as an IPv4 (0x4_) or IPv6 (0x6_) header.
 */
function stripFrame(bytes: Uint8Array): { inner: Uint8Array; stripped: string[]; ports?: [number, number] } {
	const ip = (at: number, layers: string[]) => {
		const version = (bytes[at] ?? 0) >> 4;
		let udp: number;
		if (version === 4) {
			const ihl = (bytes[at]! & 0x0f) * 4;
			if (ihl < 20 || bytes[at + 9] !== 17) return null;
			udp = at + ihl;
			layers.push("IPv4");
		} else if (version === 6) {
			if (bytes[at + 6] !== 17) return null;
			udp = at + 40;
			layers.push("IPv6");
		} else return null;
		if (udp + 8 > bytes.length) return null;
		const length = u16(bytes, udp + 4);
		// Ethernet pads a short frame to 60 bytes, so the UDP length may be shorter than the paste, never longer.
		if (length < 8 || udp + length > bytes.length) return null;
		layers.push("UDP");
		return { inner: bytes.slice(udp + 8, udp + length), stripped: layers, ports: [u16(bytes, udp), u16(bytes, udp + 2)] as [number, number] };
	};
	const direct = ip(0, []);
	if (direct) return direct;
	if (bytes.length >= 14) {
		let type = u16(bytes, 12);
		let at = 14;
		if (type === 0x8100 && bytes.length >= 18) {
			type = u16(bytes, 16);
			at = 18;
		}
		if (type === 0x0800 || type === 0x86dd) {
			const framed = ip(at, ["Ethernet"]);
			if (framed) return framed;
		}
	}
	return { inner: bytes, stripped: [] };
}

const u16 = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
/** `<<` is signed in JavaScript, so a 32-bit read has to go through multiplication. */
const u32 = (b: Uint8Array, at: number) => b[at]! * 0x1000000 + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!);
const hex = (n: number, width: number) => `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;

function need(bytes: Uint8Array, at: number, len: number, what: string): void {
	if (at + len > bytes.length) {
		throw new ParseError(
			`Truncated: ${what} needs ${len} byte${len === 1 ? "" : "s"} at offset ${at}, but the packet ends at ${bytes.length}.`,
			at,
			Math.max(1, bytes.length - at),
		);
	}
}

// ---------------------------------------------------------------------------
// RTP
// ---------------------------------------------------------------------------

/** RFC 3551 static payload types, for the ones still seen in the wild. */
const PAYLOAD_TYPES: Record<number, string> = {
	0: "PCMU", 3: "GSM", 4: "G723", 8: "PCMA", 9: "G722", 18: "G729",
	26: "JPEG", 31: "H261", 32: "MPV", 33: "MP2T", 34: "H263",
};

function parseRtp(bytes: Uint8Array, clock: number): { spans: Span[]; extras: Output[]; segments: Segment[] } {
	need(bytes, 0, 12, "the RTP fixed header");
	const spans: Span[] = [];
	const extras: Output[] = [];

	const version = bytes[0]! >> 6;
	const padding = (bytes[0]! & 0x20) !== 0;
	const extension = (bytes[0]! & 0x10) !== 0;
	const csrcCount = bytes[0]! & 0x0f;
	const marker = (bytes[1]! & 0x80) !== 0;
	const payloadType = bytes[1]! & 0x7f;

	if (version !== 2) {
		throw new ParseError(`Version is ${version}, but RTP is always version 2. This is probably not an RTP packet.`, 0, 1);
	}

	spans.push({ at: 0, len: 1, label: "V / P / X / CC", value: `2 / ${padding ? 1 : 0} / ${extension ? 1 : 0} / ${csrcCount}` });
	spans.push({
		at: 1, len: 1, label: "Payload type",
		value: `${payloadType}${PAYLOAD_TYPES[payloadType] ? ` (${PAYLOAD_TYPES[payloadType]})` : ""}`,
		note: payloadType >= 96 ? "dynamic; only the signalling says what it is" : undefined,
	});
	spans.push({ at: 1, len: 1, label: "Marker", value: marker ? "set" : "clear" });
	spans.push({ at: 2, len: 2, label: "Sequence", value: String(u16(bytes, 2)) });
	spans.push({ at: 4, len: 4, label: "Timestamp", value: String(u32(bytes, 4)), note: mediaTime(u32(bytes, 4), clock) });
	spans.push({ at: 8, len: 4, label: "SSRC", value: hex(u32(bytes, 8), 8), mark: true });

	let at = 12;
	for (let i = 0; i < csrcCount; i++) {
		need(bytes, at, 4, `CSRC ${i + 1}`);
		spans.push({ at, len: 4, label: `CSRC ${i + 1}`, value: hex(u32(bytes, at), 8), mark: true });
		at += 4;
	}

	if (extension) {
		need(bytes, at, 4, "the extension header");
		const profile = u16(bytes, at);
		const words = u16(bytes, at + 2);
		const dataAt = at + 4;
		need(bytes, dataAt, words * 4, "the extension data");

		// RFC 8285 gives two forms, distinguished by the profile field. Anything else is profile-specific
		// and cannot be decoded without knowing the profile, which is honest to say rather than guess.
		const form = profile === 0xbede ? "one-byte" : (profile & 0xfff0) === 0x1000 ? "two-byte" : "profile-specific";
		spans.push({ at, len: 2, label: "Extension profile", value: hex(profile, 4), note: `${form} form (RFC 8285)` });
		spans.push({ at: at + 2, len: 2, label: "Extension length", value: `${words} word${words === 1 ? "" : "s"}` });

		if (form === "profile-specific") {
			spans.push({ at: dataAt, len: words * 4, label: "Extension data", value: `${words * 4} bytes`, note: "undecodable without the profile", mark: true });
		} else {
			const rows = parseExtensionElements(bytes, dataAt, words * 4, form, spans);
			if (rows.length > 0) {
				extras.push({
					kind: "table",
					caption: `Header extension elements, ${form} form`,
					columns: [
						{ label: "ID", align: "end", mono: true, wrap: "none", rowHeader: true },
						{ label: "Length", align: "end", mono: true, wrap: "none" },
						{ label: "Offset", align: "end", mono: true, wrap: "none" },
						{ label: "Data", mono: true, wrap: "prose" },
					],
					rows,
				});
			}
		}
		at = dataAt + words * 4;
	}

	const payloadEnd = padding ? bytes.length - (bytes[bytes.length - 1] ?? 0) : bytes.length;
	if (padding) {
		const count = bytes[bytes.length - 1] ?? 0;
		if (count === 0 || count > bytes.length - at) {
			throw new ParseError(
				`The padding bit is set and the last byte says ${count} padding bytes, which does not fit the ${bytes.length - at} bytes left.`,
				bytes.length - 1, 1,
			);
		}
		spans.push({ at: bytes.length - count, len: count, label: "Padding", value: `${count} byte${count === 1 ? "" : "s"}`, tone: "warn", mark: true });
	}
	if (payloadEnd > at) {
		spans.push({ at, len: payloadEnd - at, label: "Payload", value: `${payloadEnd - at} bytes`, note: "not decoded; the payload type says how", mark: true });
	}
	const extensionLen = extension ? 4 + u16(bytes, 12 + csrcCount * 4 + 2) * 4 : 0;
	const segments: Segment[] = [
		{ label: "Fixed header", len: 12 },
		{ label: "CSRC list", len: csrcCount * 4 },
		{ label: "Header extension", len: extensionLen },
		{ label: "Payload", len: Math.max(0, payloadEnd - at) },
		{ label: "Padding", len: bytes.length - payloadEnd },
	].filter((g) => g.len > 0);
	return { spans, extras, segments };
}

/** One-byte and two-byte RFC 8285 elements. ID 0 is padding; in the one-byte form ID 15 stops parsing. */
function parseExtensionElements(
	bytes: Uint8Array, from: number, length: number, form: "one-byte" | "two-byte", spans: Span[],
): Cell[][] {
	const rows: Cell[][] = [];
	let at = from;
	const end = from + length;
	while (at < end) {
		if (bytes[at] === 0) { at++; continue; } // padding between elements
		let id: number;
		let len: number;
		let headerLen: number;
		if (form === "one-byte") {
			id = bytes[at]! >> 4;
			if (id === 15) break; // reserved: "stop parsing"
			len = (bytes[at]! & 0x0f) + 1; // encoded as len-1
			headerLen = 1;
		} else {
			need(bytes, at, 2, "a two-byte extension element header");
			id = bytes[at]!;
			len = bytes[at + 1]!;
			headerLen = 2;
		}
		need(bytes, at + headerLen, len, `extension element ${id}`);
		const data = [...bytes.slice(at + headerLen, at + headerLen + len)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
		rows.push([{ text: String(id), mono: true }, { text: String(len), mono: true }, { text: String(at), mono: true }, { text: data, mono: true }]);
		spans.push({ at, len: headerLen + len, label: `Extension ID ${id}`, value: `${len} byte${len === 1 ? "" : "s"}`, mark: true });
		at += headerLen + len;
	}
	return rows;
}


// ---------------------------------------------------------------------------
// RTCP
// ---------------------------------------------------------------------------

const RTCP_TYPES: Record<number, string> = {
	200: "SR (sender report)", 201: "RR (receiver report)", 202: "SDES (source description)",
	203: "BYE", 204: "APP", 205: "RTPFB (transport feedback)", 206: "PSFB (payload feedback)",
};

/** RFC 3550 6.5: SDES item types. */
const SDES_ITEMS: Record<number, string> = {
	1: "CNAME", 2: "NAME", 3: "EMAIL", 4: "PHONE", 5: "LOC", 6: "TOOL", 7: "NOTE", 8: "PRIV",
};

/** RFC 4585 6.1, RFC 5104 4 and the two drafts: what FMT means under each feedback packet type. */
const FEEDBACK_NAMES: Record<number, Record<number, string>> = {
	205: { 1: "NACK", 3: "TMMBR", 4: "TMMBN", 11: "CCFB", 15: "TWCC" },
	206: { 1: "PLI", 2: "SLI", 3: "RPSI", 4: "FIR", 15: "AFB" },
};

/** A short name for one sub-packet, the one the size chart and the summary use: "SR", "NACK", "REMB". */
function subName(bytes: Uint8Array, at: number, type: number, fmt: number): string {
	const feedback = FEEDBACK_NAMES[type]?.[fmt];
	if (feedback === "AFB" && at + 16 <= bytes.length && ascii(bytes, at + 12, 4) === "REMB") return "REMB";
	if (feedback) return feedback;
	if (type === 205) return "RTPFB";
	if (type === 206) return "PSFB";
	return RTCP_TYPES[type]?.split(" ")[0] ?? String(type);
}

const ascii = (bytes: Uint8Array, at: number, len: number) => String.fromCharCode(...bytes.slice(at, at + len));

/** One decoded feedback message, kept so the answer says the same thing as the fields. */
type Feedback =
	| { type: "NACK"; media: number; lost: number[] }
	| { type: "PLI"; media: number }
	| { type: "FIR"; requests: { ssrc: number; seq: number }[] }
	| { type: "REMB"; bps: number; ssrcs: number[] }
	| { type: "TWCC"; media: number; base: number; count: number; received: number; refMs: number; fbCount: number; packets: TwccPacket[] }
	| { type: "CCFB"; streams: { ssrc: number; begin: number; reported: number; received: number; marked: number }[] };

/** One packet a TWCC message reports on. `deltaMs` and `arrivalMs` are null for a packet that never arrived. */
interface TwccPacket {
	seq: number;
	status: "not received" | "small delta" | "large delta" | "reserved";
	deltaMs: number | null;
	arrivalMs: number | null;
}

/** Everything the summary needs, filled in while the sub-packets are parsed. */
interface Findings {
	names: string[];
	blocks: { kind: string; ssrc: number; percent: number; cumulative: number }[];
	sender?: { ssrc: number; packets: number };
	reporter?: number;
	bye?: { ssrcs: number[]; reason?: string };
	feedback: Feedback[];
	compoundInvalid: boolean;
	/** The RTP clock rate the reader chose, or 0: it is in the signalling, never in the packet. */
	clock: number;
}

const khz = (hz: number) => `${hz / 1000} kHz`;
/** An RTP timestamp as seconds of media, given the clock rate. Only a difference between two means anything. */
const mediaTime = (ts: number, clock: number) =>
	clock > 0 ? `${(ts / clock).toFixed(3)} s at ${khz(clock)}; only the difference between two packets means anything` : "the clock rate is not in the packet: choose one to read this in seconds";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "100, 101 and 103", with the middle cut once a list is longer than a sentence can carry. */
function list(values: (string | number)[], most = 8): string {
	const shown = values.length > most ? [...values.slice(0, most - 1).map(String), `${values.length - most + 1} more`] : values.map(String);
	return shown.length <= 1 ? (shown[0] ?? "") : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}
const bitrate = (bps: number) =>
	bps >= 1e6 ? `${(bps / 1e6).toFixed(2)} Mbit/s` : bps >= 1e3 ? `${(bps / 1e3).toFixed(1)} kbit/s` : `${bps} bit/s`;
const ms = (value: number, places = 2) => `${value.toFixed(places)} ms`;

/**
 * The feedback messages of RFC 4585, RFC 5104 and the two drafts WebRTC uses. Each shares one header: the
 * common header, whose count field is FMT here, then the SSRC of the packet's sender and the SSRC of the media
 * source it is about, then the feedback control information (FCI), whose shape FMT decides.
 */
function parseFeedback(
	bytes: Uint8Array, at: number, total: number, type: number, fmt: number, index: number, spans: Span[], extras: Output[], found: Findings,
): void {
	const body = at + 4;
	const end = at + total;
	need(bytes, body, 8, "the feedback header's two SSRCs");
	const media = u32(bytes, body + 4);
	const n = `#${index + 1}`;
	spans.push({ at: body, len: 4, label: `${n} Sender SSRC`, value: hex(u32(bytes, body), 8), mark: true });
	spans.push({ at: body + 4, len: 4, label: `${n} Media source SSRC`, value: hex(media, 8), note: media === 0 ? "0: the message names its streams inside" : "the stream this feedback is about", mark: true });
	const fci = body + 8;
	const name = subName(bytes, at, type, fmt);

	switch (name) {
		case "NACK": {
			// RFC 4585 6.2.1: each 4-byte entry is a PID, one lost packet, and a 16-bit mask BLP: bit i set means PID + i + 1 was lost too.
			const rows: Cell[][] = [];
			const lost: number[] = [];
			for (let e = fci; e + 4 <= end; e += 4) {
				const pid = u16(bytes, e);
				const blp = u16(bytes, e + 2);
				const these = [pid];
				for (let bit = 0; bit < 16; bit++) if (blp & (1 << bit)) these.push((pid + bit + 1) & 0xffff);
				lost.push(...these);
				rows.push([{ text: String(pid), mono: true }, { text: `0b${blp.toString(2).padStart(16, "0")}`, mono: true }, { text: these.join(", "), mono: true }]);
				spans.push({ at: e, len: 4, label: `${n} NACK entry ${rows.length}`, value: `${plural(these.length, "packet")} lost: ${these.join(", ")}`, mark: true });
			}
			found.feedback.push({ type: "NACK", media, lost });
			extras.push({
				kind: "table",
				id: `nack-${index + 1}`,
				caption: `NACK ${n}: each entry is one lost packet (PID) and a mask of the 16 after it (BLP)`,
				columns: [
					{ label: "PID", align: "end", mono: true, wrap: "none", rowHeader: true },
					{ label: "BLP", mono: true, wrap: "none" },
					{ label: "Lost sequence numbers", mono: true, wrap: "prose" },
				],
				rows,
			});
			break;
		}
		case "PLI":
			// RFC 4585 6.3.1: no FCI at all. The message is its own meaning.
			found.feedback.push({ type: "PLI", media });
			break;
		case "FIR": {
			// RFC 5104 4.3.1: entries of 8 bytes, the SSRC asked for a keyframe and a command sequence number, then 3 reserved bytes.
			const requests: { ssrc: number; seq: number }[] = [];
			for (let e = fci; e + 8 <= end; e += 8) {
				const ssrc = u32(bytes, e);
				const seq = bytes[e + 4]!;
				requests.push({ ssrc, seq });
				spans.push({ at: e, len: 4, label: `${n} FIR SSRC ${requests.length}`, value: hex(ssrc, 8), note: "the stream asked for a keyframe", mark: true });
				spans.push({ at: e + 4, len: 1, label: `${n} FIR sequence ${requests.length}`, value: String(seq), note: "the same number twice is a repeat of the same request" });
			}
			found.feedback.push({ type: "FIR", requests });
			break;
		}
		case "REMB": {
			// draft-alvestrand-rmcat-remb-03 2.2: "REMB", a count of SSRCs, a 6-bit exponent and an 18-bit mantissa, then the SSRCs.
			need(bytes, fci, 8, "the REMB identifier and bitrate");
			const count = bytes[fci + 4]!;
			const exponent = bytes[fci + 5]! >> 2;
			const mantissa = ((bytes[fci + 5]! & 0x03) << 16) | (bytes[fci + 6]! << 8) | bytes[fci + 7]!;
			const bps = mantissa * 2 ** exponent;
			spans.push({ at: fci, len: 4, label: `${n} Identifier`, value: "REMB" });
			spans.push({ at: fci + 4, len: 1, label: `${n} SSRC count`, value: String(count) });
			spans.push({ at: fci + 5, len: 3, label: `${n} Bitrate`, value: bitrate(bps), note: `mantissa ${mantissa} x 2^${exponent} = ${bps} bit/s`, mark: true });
			const ssrcs: number[] = [];
			for (let i = 0; i < count; i++) {
				need(bytes, fci + 8 + i * 4, 4, `REMB SSRC ${i + 1}`);
				const ssrc = u32(bytes, fci + 8 + i * 4);
				ssrcs.push(ssrc);
				spans.push({ at: fci + 8 + i * 4, len: 4, label: `${n} REMB SSRC ${i + 1}`, value: hex(ssrc, 8), mark: true });
			}
			found.feedback.push({ type: "REMB", bps, ssrcs });
			break;
		}
		case "TWCC":
			parseTwcc(bytes, fci, end, media, index, spans, extras, found);
			break;
		case "CCFB":
			parseCcfb(bytes, body + 4, end, index, spans, extras, found);
			break;
		default:
			if (end > fci) spans.push({ at: fci, len: end - fci, label: `${n} ${name} body`, value: `${end - fci} bytes`, note: "not decoded by this tool" });
	}
}

/**
 * RFC 8888's congestion control feedback, the standards-track successor to TWCC: per stream, the SSRC, the first
 * sequence number and a count, then one 16-bit block per packet, R (received), the echoed ECN mark, and the arrival
 * time as an offset BEFORE the report timestamp in 1/1024 s. The report timestamp, NTP's middle 32 bits, ends the
 * message. The first stream's SSRC sits where RFC 4585 puts the media source, so parsing starts there.
 */
function parseCcfb(bytes: Uint8Array, from: number, end: number, index: number, spans: Span[], extras: Output[], found: Findings): void {
	const n = `#${index + 1}`;
	need(bytes, end - 4, 4, "the report timestamp");
	const rts = u32(bytes, end - 4);
	const streams: { ssrc: number; begin: number; reported: number; received: number; marked: number }[] = [];
	const rows: Cell[][] = [];
	let at = from;
	while (at < end - 4) {
		need(bytes, at, 8, `report block ${streams.length + 1}`);
		const ssrc = u32(bytes, at);
		const begin = u16(bytes, at + 4);
		const reported = u16(bytes, at + 6);
		if (streams.length > 0) spans.push({ at, len: 4, label: `${n} Stream ${streams.length + 1} SSRC`, value: hex(ssrc, 8), mark: true });
		spans.push({ at: at + 4, len: 4, label: `${n} Stream ${streams.length + 1} range`, value: `${reported} packets from sequence ${begin}` });
		const metrics = at + 8;
		const padded = Math.ceil(reported / 2) * 4;
		need(bytes, metrics, padded, `the ${reported} packet metric blocks of stream ${hex(ssrc, 8)}`);
		let received = 0;
		let marked = 0;
		for (let i = 0; i < reported; i++) {
			const block = u16(bytes, metrics + i * 2);
			const seq = (begin + i) & 0xffff;
			const got = (block & 0x8000) !== 0;
			const ecn = (block >> 13) & 0x03;
			const ato = block & 0x1fff;
			if (got) received++;
			if (got && ecn === 3) marked++;
			const when = !got ? "" : ato === 0x1fff ? "unavailable" : ato === 0x1ffe ? "over 8 s before" : ms((ato / 1024) * 1000);
			rows.push([
				{ text: hex(ssrc, 8), mono: true },
				{ text: String(seq), mono: true },
				got ? { text: ecn === 3 ? "arrived, marked congested (ECN CE)" : "arrived", tone: ecn === 3 ? "warn" : "muted" } : { text: "lost", tone: "bad" },
				{ text: when, mono: true },
			]);
		}
		spans.push({ at: metrics, len: Math.max(padded, 1), label: `${n} Stream ${streams.length + 1} packets`, value: `${received} of ${reported} arrived`, mark: padded > 0 });
		streams.push({ ssrc, begin, reported, received, marked });
		at = metrics + padded;
	}
	spans.push({ at: end - 4, len: 4, label: `${n} Report timestamp`, value: short(rts), note: `${shortSeconds(rts)}, NTP's middle 32 bits: every arrival is counted back from here` });
	found.feedback.push({ type: "CCFB", streams });
	extras.push({
		kind: "table",
		id: `ccfb-${index + 1}`,
		caption: `RFC 8888 feedback ${n}: when each packet arrived, before the report timestamp`,
		columns: [
			{ label: "Stream", mono: true, wrap: "none" },
			{ label: "Sequence", align: "end", mono: true, wrap: "none", rowHeader: true },
			{ label: "Status", wrap: "none" },
			{ label: "Arrived before the report", align: "end", mono: true, wrap: "none" },
		],
		rows: rows.slice(0, 500),
	});
}

/**
 * Transport-wide congestion control feedback, draft-holmer-rmcat-transport-wide-cc-extensions-01 section 3.1.
 *
 * The header says which packets it covers (a base sequence number and a count) and a reference time in 64 ms
 * steps. Then come 16-bit chunks of packet status, either a run of one status or a vector of 14 one-bit or 7
 * two-bit statuses, until every packet in the count has one. Then one receive delta per received packet: one
 * unsigned byte for a "small delta", two signed bytes for a "large" one, both in 250 microsecond steps, the
 * first counted from the reference time and each later one from the packet before it.
 *
 * ⚠️ A chunk can describe more statuses than the count needs. The extra ones are padding, not packets, so the
 * decode stops at the count rather than at the end of the last chunk.
 */
function parseTwcc(bytes: Uint8Array, fci: number, end: number, media: number, index: number, spans: Span[], extras: Output[], found: Findings): void {
	const n = `#${index + 1}`;
	need(bytes, fci, 8, "the TWCC header");
	const base = u16(bytes, fci);
	const count = u16(bytes, fci + 2);
	const rawRef = (bytes[fci + 4]! << 16) | (bytes[fci + 5]! << 8) | bytes[fci + 6]!;
	const ref = rawRef >= 0x800000 ? rawRef - 0x1000000 : rawRef;
	const fbCount = bytes[fci + 7]!;
	spans.push({ at: fci, len: 2, label: `${n} Base sequence`, value: String(base), note: "the first packet this message reports on", mark: true });
	spans.push({ at: fci + 2, len: 2, label: `${n} Packet status count`, value: String(count) });
	spans.push({ at: fci + 4, len: 3, label: `${n} Reference time`, value: ms(ref * 64, 0), note: `${ref} x 64 ms, on the receiver's clock` });
	spans.push({ at: fci + 7, len: 1, label: `${n} Feedback count`, value: String(fbCount), note: "counts these messages, so a lost one shows as a gap" });

	const statuses: TwccPacket["status"][] = [];
	const names: TwccPacket["status"][] = ["not received", "small delta", "large delta", "reserved"];
	let at = fci + 8;
	let chunks = 0;
	while (statuses.length < count) {
		need(bytes, at, 2, `TWCC status chunk ${chunks + 1}`);
		const chunk = u16(bytes, at);
		const before = statuses.length;
		if ((chunk & 0x8000) === 0) {
			const symbol = (chunk >> 13) & 0x03;
			const run = chunk & 0x1fff;
			for (let i = 0; i < run && statuses.length < count; i++) statuses.push(names[symbol]!);
			spans.push({ at, len: 2, label: `${n} Run chunk ${chunks + 1}`, value: `${run} x ${names[symbol]}`, mark: true });
		} else if ((chunk & 0x4000) === 0) {
			for (let i = 13; i >= 0 && statuses.length < count; i--) statuses.push(names[(chunk >> i) & 0x01]!);
			spans.push({ at, len: 2, label: `${n} Vector chunk ${chunks + 1}`, value: `${statuses.length - before} one-bit statuses`, mark: true });
		} else {
			for (let i = 12; i >= 0 && statuses.length < count; i -= 2) statuses.push(names[(chunk >> i) & 0x03]!);
			spans.push({ at, len: 2, label: `${n} Vector chunk ${chunks + 1}`, value: `${statuses.length - before} two-bit statuses`, mark: true });
		}
		at += 2;
		chunks++;
		if (statuses.length === before) {
			throw new ParseError(`TWCC status chunk ${chunks} describes no packets, so the ${count} the header promises can never be read.`, at - 2, 2);
		}
	}

	const packets: TwccPacket[] = [];
	const deltasAt = at;
	let clock = ref * 64;
	for (let i = 0; i < statuses.length; i++) {
		const status = statuses[i]!;
		const seq = (base + i) & 0xffff;
		if (status === "small delta") {
			need(bytes, at, 1, `the receive delta of packet ${seq}`);
			clock += bytes[at]! * 0.25;
			packets.push({ seq, status, deltaMs: bytes[at]! * 0.25, arrivalMs: clock });
			at += 1;
		} else if (status === "large delta") {
			need(bytes, at, 2, `the receive delta of packet ${seq}`);
			const raw = u16(bytes, at);
			const delta = (raw >= 0x8000 ? raw - 0x10000 : raw) * 0.25;
			clock += delta;
			packets.push({ seq, status, deltaMs: delta, arrivalMs: clock });
			at += 2;
		} else {
			packets.push({ seq, status, deltaMs: null, arrivalMs: null });
		}
	}
	if (at > end) throw new ParseError(`Truncated: the receive deltas run to offset ${at}, past the end of this TWCC message at ${end}.`, end - 1, 1);
	const received = packets.filter((p) => p.arrivalMs !== null).length;
	if (at > deltasAt) spans.push({ at: deltasAt, len: at - deltasAt, label: `${n} Receive deltas`, value: `${plural(received, "delta")}, ${at - deltasAt} bytes`, note: "250 microsecond steps", mark: true });
	if (end > at) spans.push({ at, len: end - at, label: `${n} Padding`, value: plural(end - at, "byte"), note: "to the next 32-bit boundary" });
	found.feedback.push({ type: "TWCC", media, base, count, received, refMs: ref * 64, fbCount, packets });

	/*
	 * The arrival times as a chart: what a sender's congestion controller does with this message is compare
	 * these against when it sent each packet, so the shape, steady or stretching, is the thing to see. Lost
	 * packets are gaps rather than zeros. Capped, because a status count can reach 65535.
	 */
	const shown = packets.slice(0, 500);
	const first = shown.find((p) => p.arrivalMs !== null)?.arrivalMs ?? 0;
	extras.push({
		kind: "series",
		id: `twcc-chart-${index + 1}`,
		chart: {
			id: `twcc-${index + 1}`,
			xLabel: "Transport-wide sequence number",
			yLabel: "Arrived after the first",
			yUnit: "ms",
			x: shown.map((p) => p.seq),
			series: [{ label: "Arrival", unit: "ms", shape: "points", points: shown.map((p) => (p.arrivalMs === null ? null : Number((p.arrivalMs - first).toFixed(2)))) }],
			readout: { titles: shown.map((p) => (p.arrivalMs === null ? `Packet ${p.seq}, lost` : `Packet ${p.seq}`)) },
		},
	});
	extras.push({
		kind: "table",
		id: `twcc-${index + 1}`,
		caption: `TWCC ${n}: ${plural(count, "packet")} from sequence ${base}, ${received} arrived${packets.length > shown.length ? `, the first ${shown.length} shown` : ""}`,
		columns: [
			{ label: "Sequence", align: "end", mono: true, wrap: "none", rowHeader: true },
			{ label: "Status", wrap: "none" },
			{ label: "Delta", align: "end", mono: true, wrap: "none" },
			{ label: "Arrived, after the reference time", align: "end", mono: true, wrap: "none" },
		],
		rows: shown.map((p) => [
			{ text: String(p.seq), mono: true },
			p.arrivalMs === null ? { text: "lost", tone: "bad" } : { text: p.status === "large delta" ? "arrived, large delta" : "arrived", tone: "muted" },
			{ text: p.deltaMs === null ? "" : ms(p.deltaMs), mono: true },
			{ text: p.arrivalMs === null ? "" : ms(p.arrivalMs - ref * 64), mono: true },
		]),
		link: { chart: `twcc-${index + 1}`, keys: shown.map((p) => p.seq) },
	});
}

/** NTP epoch is 1900; Unix is 1970. The difference is fixed and famous. */
const NTP_UNIX_OFFSET = 2_208_988_800;

/**
 * A binary fraction as six decimal places, carrying into the whole seconds when it rounds up to one.
 *
 * ⚠️ The fraction is a count of 1/2^32 (or 1/2^16) of a second, not decimal digits. Printing the raw integer after
 * a decimal point, which version 1.1 did, turns 0x40000000, a quarter of a second, into ".1073741824".
 */
function seconds(whole: number, fraction: number, bits: number): string {
	const text = (fraction / 2 ** bits).toFixed(6);
	return text.startsWith("1") ? `${whole + 1}.000000` : `${whole}${text.slice(1)}`;
}

/** NTP's short format, 16 bits of seconds and 16 of fraction, as RFC 3550 writes it: 0xD8F0:4000. */
const short = (x: number) => `0x${hex(x >>> 16, 4).slice(2)}:${hex(x & 0xffff, 4).slice(2)}`;
const shortSeconds = (x: number) => `${seconds(x >>> 16, x & 0xffff, 16)} s`;

/**
 * A, the time the report arrived, in NTP's short format. Optional: blank means no round trip is asked for.
 * Accepted with or without 0x, a colon or spaces, because RFC 3550 writes it as 0xb710:8000 and a log as b7108000.
 */
function readArrival(text: string | undefined): number | null {
	const trimmed = (text ?? "").trim();
	if (trimmed === "") return null;
	const digits = trimmed.replace(/0x/gi, "").replace(/[\s:]/g, "");
	if (!/^[0-9a-f]{8}$/i.test(digits)) {
		throw new ParseError(`A is 8 hex digits of NTP time, such as d8f1:4ccc: 16 bits of seconds and 16 of fraction, the middle of the 64-bit timestamp. Got "${trimmed}".`);
	}
	return Number.parseInt(digits, 16);
}

/**
 * An RTCP packet, or a compound one. RFC 3550 requires compounds to begin with SR or RR, which is worth
 * saying when they do not: a receiver may drop the whole compound.
 */
function parseRtcp(bytes: Uint8Array, arrival: number | null, found: Findings): { spans: Span[]; extras: Output[]; summary: Field[]; segments: Segment[]; timing: Field[] } {
	const spans: Span[] = [];
	const segments: Segment[] = [];
	const extras: Output[] = [];
	const summary: Field[] = [];
	const timing: Field[] = [];
	const seen: string[] = [];
	let at = 0;
	let index = 0;

	while (at < bytes.length) {
		need(bytes, at, 4, "an RTCP common header");
		const version = bytes[at]! >> 6;
		if (version !== 2) throw new ParseError(`Sub-packet ${index + 1} has version ${version}; RTCP is always version 2.`, at, 1);
		const padding = (bytes[at]! & 0x20) !== 0;
		const count = bytes[at]! & 0x1f;
		const type = bytes[at + 1]!;
		// The length field is in 32-bit words MINUS ONE, so a 4-byte packet encodes 0. Off-by-one here
		// is the classic RTCP bug, and it walks the parser off the end of a compound.
		const words = u16(bytes, at + 2);
		const total = (words + 1) * 4;
		need(bytes, at, total, `sub-packet ${index + 1} (${RTCP_TYPES[type] ?? `type ${type}`})`);

		const name = RTCP_TYPES[type] ?? `type ${type} (unknown)`;
		seen.push(subName(bytes, at, type, count));
		segments.push({ label: `#${seen.length} ${seen.at(-1)}`, len: Math.min(total, bytes.length - at) });
		const feedback = type === 205 || type === 206;
		spans.push({ at, len: 1, label: `#${index + 1} V / P / ${feedback ? "FMT" : "count"}`, value: `2 / ${padding ? 1 : 0} / ${count}`, ...(feedback ? { note: `FMT ${count} under type ${type} is ${seen.at(-1)}` } : {}) });
		spans.push({ at: at + 1, len: 1, label: `#${index + 1} Packet type`, value: `${type} ${name}` });
		spans.push({ at: at + 2, len: 2, label: `#${index + 1} Length`, value: `${words} (${total} bytes)` });

		const body = at + 4;
		switch (type) {
			case 200: { // SR
				need(bytes, body, 24, "the sender info block");
				const ntpSec = u32(bytes, body + 4);
				const ntpFrac = u32(bytes, body + 8);
				spans.push({ at: body, len: 4, label: `#${index + 1} Sender SSRC`, value: hex(u32(bytes, body), 8), mark: true });
				spans.push({
					at: body + 4, len: 8, label: `#${index + 1} NTP timestamp`,
					value: `${seconds(ntpSec, ntpFrac, 32)} s`,
					// The date keeps the fraction to the millisecond, truncated as a clock reading is.
					note: ntpSec > NTP_UNIX_OFFSET ? new Date((ntpSec - NTP_UNIX_OFFSET) * 1000 + Math.floor((ntpFrac * 1000) / 2 ** 32)).toISOString() : "before 1970; probably not a real clock",
				});
				// What a receiver echoes as LSR, so an SR and the RR that answers it can be matched across two pastes.
				const middle = u32(bytes, body + 6);
				timing.push({ group: `SR #${index + 1}`, label: "Middle 32 bits", value: hex(middle, 8), note: `${short(middle)} = ${shortSeconds(middle)}; an RR answering this SR carries it as LSR` });
				spans.push({ at: body + 12, len: 4, label: `#${index + 1} RTP timestamp`, value: String(u32(bytes, body + 12)), note: mediaTime(u32(bytes, body + 12), found.clock) });
				spans.push({ at: body + 16, len: 4, label: `#${index + 1} Packets sent`, value: String(u32(bytes, body + 16)) });
				found.sender ??= { ssrc: u32(bytes, body), packets: u32(bytes, body + 16) };
				spans.push({ at: body + 20, len: 4, label: `#${index + 1} Octets sent`, value: String(u32(bytes, body + 20)) });
				const rows = reportBlocks(bytes, body + 24, count, index, spans, timing, arrival, "SR", found);
				if (rows.length > 0) extras.push(reportTable(rows, `SR #${index + 1}`, found));
				break;
			}
			case 201: { // RR
				need(bytes, body, 4, "the reporter SSRC");
				spans.push({ at: body, len: 4, label: `#${index + 1} Reporter SSRC`, value: hex(u32(bytes, body), 8), mark: true });
				found.reporter ??= u32(bytes, body);
				const rows = reportBlocks(bytes, body + 4, count, index, spans, timing, arrival, "RR", found);
				if (rows.length > 0) extras.push(reportTable(rows, `RR #${index + 1}`, found));
				break;
			}
			case 202: { // SDES
				let chunk = body;
				for (let c = 0; c < count; c++) {
					need(bytes, chunk, 4, `SDES chunk ${c + 1}`);
					const ssrc = u32(bytes, chunk);
					spans.push({ at: chunk, len: 4, label: `#${index + 1} SDES SSRC ${c + 1}`, value: hex(ssrc, 8), mark: true });
					let item = chunk + 4;
					for (;;) {
						need(bytes, item, 1, "an SDES item type");
						const itemType = bytes[item]!;
						if (itemType === 0) break; // list terminator
						need(bytes, item + 1, 1, "an SDES item length");
						const len = bytes[item + 1]!;
						need(bytes, item + 2, len, `SDES item ${itemType}`);
						const text = new TextDecoder().decode(bytes.slice(item + 2, item + 2 + len));
						spans.push({ at: item, len: 2 + len, label: `#${index + 1} ${SDES_ITEMS[itemType] ?? `SDES ${itemType}`}`, value: text, mark: true });
						item += 2 + len;
					}
					// Chunks are padded with nulls to the next 32-bit boundary, and the terminator counts.
					const consumed = item + 1 - chunk;
					chunk += Math.ceil(consumed / 4) * 4;
				}
				break;
			}
			case 203: { // BYE
				let src = body;
				found.bye = { ssrcs: [] };
				for (let c = 0; c < count; c++) {
					need(bytes, src, 4, `BYE SSRC ${c + 1}`);
					spans.push({ at: src, len: 4, label: `#${index + 1} BYE SSRC ${c + 1}`, value: hex(u32(bytes, src), 8), mark: true });
					found.bye.ssrcs.push(u32(bytes, src));
					src += 4;
				}
				// The reason is optional, and only present if the length field left room for it.
				if (src < at + total) {
					const len = bytes[src]!;
					need(bytes, src + 1, len, "the BYE reason");
					const reason = new TextDecoder().decode(bytes.slice(src + 1, src + 1 + len));
					spans.push({ at: src, len: 1 + len, label: `#${index + 1} BYE reason`, value: reason, mark: true });
					found.bye.reason = reason;
				}
				break;
			}
			case 204: { // APP: an SSRC, a four-character name, then data only the named application can read.
				need(bytes, body, 8, "the APP SSRC and name");
				spans.push({ at: body, len: 4, label: `#${index + 1} SSRC`, value: hex(u32(bytes, body), 8), mark: true });
				spans.push({ at: body + 4, len: 4, label: `#${index + 1} Name`, value: ascii(bytes, body + 4, 4), note: `subtype ${count}; only the application that chose this name can read the data`, mark: true });
				if (total > 12) spans.push({ at: body + 8, len: total - 12, label: `#${index + 1} Application data`, value: plural(total - 12, "byte") });
				break;
			}
			case 205:
			case 206:
				parseFeedback(bytes, at, total, type, count, index, spans, extras, found);
				break;
			default:
				if (total > 4) {
					spans.push({ at: body, len: total - 4, label: `#${index + 1} Body`, value: `${total - 4} bytes`, note: "not decoded by this tool" });
				}
		}
		at += total;
		index++;
	}

	// RFC 3550 6.1: a compound packet must begin with SR or RR, or a receiver may discard all of it.
	const first = bytes[1];
	found.names = seen;
	found.compoundInvalid = index > 1 && first !== 200 && first !== 201;
	if (arrival !== null && !timing.some((f) => f.label === "Round trip")) {
		timing.push({ group: "Round trip", label: "Round trip", value: "no report block", note: "A is read against a report block's LSR and DLSR, and this packet has none" });
	}
	return { spans, extras, summary, segments, timing };
}

/**
 * RFC 3550 section 6.4.1's round trip: A - LSR - DLSR, all three in 1/65536 s.
 *
 * Why it needs no synchronised clocks: A and LSR are both read off the SR sender's clock, and DLSR is a duration
 * the receiver measured on its own. The subtraction is modulo 2^32, as the RFC's arithmetic is, so it survives the
 * 16-bit seconds wrapping every 18 hours.
 */
function roundTrip(arrival: number, lsr: number, dlsr: number): Field {
	const units = (arrival - lsr - dlsr) >>> 0;
	if (units >= 0x80000000) {
		return { label: "Round trip", value: "negative", tone: "bad", note: `A ${short(arrival)} is earlier than LSR + DLSR, so A is from another clock, or this report answers a later SR` };
	}
	const s = units / 65536;
	return { label: "Round trip", value: s < 1 ? `${(s * 1000).toFixed(3)} ms` : `${s.toFixed(3)} s`, note: `A - LSR - DLSR = ${short(arrival)} - ${short(lsr)} - ${short(dlsr)} = ${units} / 65536 s` };
}

function reportBlocks(
	bytes: Uint8Array, from: number, count: number, index: number, spans: Span[], timing: Field[], arrival: number | null, kind: string, found: Findings,
): Cell[][] {
	const rows: Cell[][] = [];
	let at = from;
	for (let i = 0; i < count; i++) {
		need(bytes, at, 24, `report block ${i + 1}`);
		const ssrc = u32(bytes, at);
		const fraction = bytes[at + 4]!;
		// Cumulative lost is a 24-bit SIGNED value: duplicates can make it negative.
		const rawCumulative = (bytes[at + 5]! << 16) | (bytes[at + 6]! << 8) | bytes[at + 7]!;
		const cumulative = rawCumulative >= 0x800000 ? rawCumulative - 0x1000000 : rawCumulative;
		const percent = (fraction / 256) * 100;
		found.blocks.push({ kind, ssrc, percent, cumulative });
		const jitterUnits = u32(bytes, at + 12);
		const lsrValue = u32(bytes, at + 16);
		const trip = lsrValue === 0 ? null : arrival === null ? undefined : roundTrip(arrival, lsrValue, u32(bytes, at + 20));
		/*
		 * The fraction as the 256ths it is sent in, so a reader can check it against a threshold: 26/256 is 10.16%,
		 * which a rounded "10.2%" beside "over 10%" hides. Toned by the thresholds of the loss-based rule browsers use
		 * (see reportTable), the only rule here that decides anything.
		 */
		rows.push([
			{ text: hex(ssrc, 8), mono: true },
			{ text: `${fraction}/256 = ${percent.toFixed(2)}%`, mono: true, ...(percent >= 5 ? { tone: percent > 10 ? ("bad" as const) : ("warn" as const) } : {}) },
			{ text: String(cumulative), mono: true, ...(cumulative < 0 ? { tone: "warn" as const } : {}) },
			{ text: found.clock > 0 ? `${jitterUnits} = ${ms((jitterUnits / found.clock) * 1000, 3)}` : `${jitterUnits} units`, mono: true },
			trip === null
				? { text: "none, no SR yet", tone: "muted" }
				: trip === undefined
					? { text: "needs arrival time", tone: "muted" }
					: { text: trip.value, mono: true, ...(trip.tone ? { tone: trip.tone } : {}) },
		]);
		spans.push({ at, len: 24, label: `#${index + 1} Report block ${i + 1}`, value: `${hex(ssrc, 8)}, ${fraction}/256 lost`, mark: true, list: false });

		/*
		 * The same block's numbers as arithmetic a reader can check. The fraction is truncated to 256ths, so 6 lost
		 * of 250 reads 6/256 = 2.34%, not 2.40%; LSR and DLSR are seconds in 1/65536ths.
		 */
		const group = `${kind} #${index + 1}, block ${i + 1}`;
		const lsr = lsrValue;
		const dlsr = u32(bytes, at + 20);
		timing.push({ group, label: "Highest sequence", value: String(u32(bytes, at + 8)), note: "the extended highest sequence number received" });
		// The fraction and the jitter are in the report table, the fraction as the 256ths it is sent in.
		timing.push(lsr === 0
			? { group, label: "LSR", value: "0", note: "no SR received yet, so there is no round trip to measure" }
			: { group, label: "LSR", value: short(lsr), note: `${shortSeconds(lsr)}, the middle 32 bits of the SR this answers` });
		timing.push({ group, label: "DLSR", value: ms((dlsr / 65536) * 1000, 1), note: `${dlsr} / 65536 s, ${short(dlsr)}: how long the receiver held the SR before replying` });
		if (lsr === 0) {
			if (arrival !== null) timing.push({ group, label: "Round trip", value: "none", note: "LSR is 0: the receiver had no SR to answer, so A has nothing to be measured against" });
		} else {
			timing.push(trip === undefined || trip === null
				? { group, label: "Round trip", value: "needs A", note: "enter when this report arrived to get A - LSR - DLSR" }
				: { group, ...trip });
		}
		at += 24;
	}
	return rows;
}

function reportTable(rows: Cell[][], name: string, found: Findings): Output {
	const blocks = found.blocks.slice(-rows.length);
	const worst = Math.max(...blocks.map((b) => b.percent));
	/*
	 * The thresholds of the loss-based rule browsers use, draft-ietf-rmcat-gcc-02 section 6: over 10% lost the rate is
	 * cut, from 2% to 10% it is held, under 2% it grows. A rule of thumb about senders, not something the packet says,
	 * so it is a note under the numbers rather than a headline.
	 */
	const rule =
		worst > 10
			? ". Over 10% lost: the loss-based rule browsers use cuts the sending rate"
			: worst >= 5
				? ". From 2% to 10% lost, the loss-based rule browsers use holds the rate, so the loss carries on"
				: "";
	return {
		kind: "table",
		role: "decoded",
		caption: `${name} reports on ${plural(rows.length, "stream")}, lost since its last report${rule}`,
		columns: [
			{ label: "Reports on", mono: true, wrap: "none", rowHeader: true },
			{ label: "Lost (interval)", align: "end", mono: true, wrap: "none" },
			{ label: "Cum. lost", align: "end", mono: true, wrap: "none" },
			{ label: "Jitter", align: "end", mono: true, wrap: "none" },
			{ label: "RTT", align: "end", wrap: "none" },
		],
		rows,
	};
}

/** What the packet is, in one line, and what it asks for: the part a reader came for. */
function answerRtp(bytes: Uint8Array, segments: Segment[], stripped: string[]): Field[] {
	const type = bytes[1]! & 0x7f;
	const payload = segments.find((g) => g.label === "Payload")?.len ?? 0;
	const padding = segments.find((g) => g.label === "Padding")?.len ?? 0;
	const header = bytes.length - payload - padding;
	const named = PAYLOAD_TYPES[type];
	return [
		{
			label: "Packet",
			value: `RTP, ${plural(bytes.length, "byte")}`,
			note: `${header} header, ${payload} payload${padding > 0 ? `, ${padding} padding` : ""}${stripped.length > 0 ? `, once the ${list(stripped)} headers are stripped` : ""}`,
		},
		{
			label: "Payload type",
			value: named ? `${type}, ${named}` : String(type),
			...(named ? {} : { note: type >= 96 ? "dynamic: only the signalling can name it" : "static, but not one this tool names" }),
		},
		{ label: "Sequence", value: String(u16(bytes, 2)), note: `SSRC ${hex(u32(bytes, 8), 8)}` },
	];
}

function answerRtcp(bytes: Uint8Array, found: Findings, stripped: string[]): Field[] {
	const names = found.names;
	const from =
		found.sender && names[0] === "SR"
			? ` from ${hex(found.sender.ssrc, 8)}`
			: found.reporter !== undefined && names[0] === "RR"
				? ` from ${hex(found.reporter, 8)}`
				: "";
	const answer: Field[] = [
		{
			label: "Packet",
			value: `RTCP${names.length > 1 ? " compound" : ""}, ${plural(bytes.length, "byte")}: ${names[0]}${from}${names.length > 1 ? `, then ${names.slice(1).join(", then ")}` : ""}`,
			...(stripped.length > 0 ? { note: `once the ${list(stripped)} headers are stripped` } : {}),
		},
	];
	// RFC 3550 6.1: a protocol rule, so the one place here a tone is earned without the reader setting a limit.
	if (found.compoundInvalid) {
		answer.push({
			label: "Compound order",
			value: `starts with ${names[0]}, not SR or RR`,
			tone: "bad",
			note: "RFC 3550 6.1 requires a sender or receiver report first, and a receiver that checks may drop the whole packet.",
		});
	}
	for (const fb of found.feedback) {
		switch (fb.type) {
			case "NACK":
				answer.push({
					label: "Asks again for",
					value: `${plural(fb.lost.length, "packet")}: ${list(fb.lost)}`,
					note: `On stream ${hex(fb.media, 8)}. Resend them if they are still in the send buffer; otherwise the receiver conceals the gap.`,
				});
				break;
			case "PLI":
				answer.push({
					label: "Asks for",
					value: `a keyframe on ${hex(fb.media, 8)}`,
					note: "A picture loss indication: the receiver lost video it needs, and its picture is frozen or broken until a keyframe arrives.",
				});
				break;
			case "FIR":
				answer.push({
					label: "Asks for",
					value: `a keyframe on ${list(fb.requests.map((r) => hex(r.ssrc, 8)))}`,
					note: "A full intra request is a command: the sender must answer with a keyframe. A repeated sequence number is the same request again.",
				});
				break;
			case "REMB":
				answer.push({
					label: "Bandwidth estimate",
					value: bitrate(fb.bps),
					note: `For ${list(fb.ssrcs.map((x) => hex(x, 8)))} together: what the receiver thinks the path carries.`,
				});
				break;
			case "CCFB": {
				const reported = fb.streams.reduce((sum, x) => sum + x.reported, 0);
				const received = fb.streams.reduce((sum, x) => sum + x.received, 0);
				const marked = fb.streams.reduce((sum, x) => sum + x.marked, 0);
				answer.push({ label: "Lost", value: `${reported - received} of ${reported}`, note: `reported on ${plural(fb.streams.length, "stream")}` });
				if (marked > 0) answer.push({ label: "Marked congested", value: `${marked} of ${received}`, note: "ECN CE: a router queue is filling, and set the mark instead of dropping the packet." });
				break;
			}
			case "TWCC":
				answer.push({ label: "Lost", value: `${fb.count - fb.received} of ${fb.count}`, note: `from transport-wide sequence ${fb.base}` });
				break;
		}
	}
	if (found.bye) {
		answer.push({
			label: "Leaving",
			value: list(found.bye.ssrcs.map((x) => hex(x, 8))),
			...(found.bye.reason ? { note: `because "${found.bye.reason}"` } : {}),
		});
	}
	return answer;
}

export default {
	run({ packet, view, arrival: arrivalText, clock: clockText }): Output {
		let bytes: Uint8Array;
		let arrival: number | null;
		let frame: ReturnType<typeof stripFrame>;
		try {
			frame = stripFrame(readHex(packet));
			bytes = frame.inner;
			if (bytes.length === 0) throw new ParseError(`The ${list(frame.stripped)} headers were stripped, and the UDP packet inside is empty.`);
		} catch (error) {
			if (error instanceof ParseError) {
				return { kind: "error", message: error.message, input: "packet", ...(error.at !== undefined ? { at: error.at, len: error.len ?? 1 } : {}) };
			}
			throw error;
		}
		try {
			arrival = readArrival(arrivalText);
		} catch (error) {
			if (error instanceof ParseError) return { kind: "error", message: error.message, input: "arrival" };
			throw error;
		}

		try {
			/*
			 * RTP and RTCP share the first two bits and are told apart by the second byte. RTCP uses
			 * 200-206 there; RTP's payload type is 0-127, so the ranges cannot collide. Guessing wrong
			 * decodes a different packet and reports it confidently, which is the worst outcome for a
			 * tool like this, so it is dispatched rather than assumed.
			 */
			const second = bytes[1] ?? 0;
			const isRtcp = second >= 200 && second <= 206;
			const clock = Number(clockText) > 0 ? Number(clockText) : 0;
			const found: Findings = { names: [], blocks: [], feedback: [], compoundInvalid: false, clock };
			const { spans, extras, summary = [], segments, timing = [] } = isRtcp ? parseRtcp(bytes, arrival, found) : { ...parseRtp(bytes, clock), summary: [] as Field[], timing: [] as Field[] };
			/*
			 * One entry per field of the packet. An RTCP span's "#2 Length" becomes "Length" under "SDES #2", so a
			 * compound reads as its sub-packets rather than as one long list of numbered labels.
			 */
			const packetGroup = isRtcp ? "Packet" : undefined;
			const fields: Field[] = [
				{ label: "Protocol", value: isRtcp ? "RTCP" : "RTP", note: `second byte is ${second}`, ...(packetGroup ? { group: packetGroup } : {}) },
				...(frame.stripped.length > 0
					? [{ label: "Stripped first", value: `${list(frame.stripped)} headers`, note: `UDP port ${frame.ports?.[0]} to ${frame.ports?.[1]}; the offsets below count from the UDP payload`, ...(packetGroup ? { group: packetGroup } : {}) }]
					: []),
				...summary,
			].concat(
				spans
					.filter((s) => s.list !== false)
					.map((s) => {
						const numbered = isRtcp ? /^#(\d+) (.*)$/.exec(s.label) : null;
						return {
							label: numbered ? numbered[2]! : s.label,
							value: s.value,
							...(numbered ? { group: `${found.names[Number(numbered[1]) - 1]} #${numbered[1]}` } : {}),
							...(s.note ? { note: s.note } : {}),
							...(s.tone ? { tone: s.tone } : {}),
						};
					}),
			);
			/*
			 * No tone on a range: since toolbench 0.10.0 each untoned range takes its own series colour, so
			 * neighbouring fields read as different fields. A tone is for meaning, and none of these is good or bad.
			 */
			const highlight: ByteRange[] = spans.filter((s) => s.mark).map((s) => ({ at: s.at, len: s.len, label: s.label }));
			const answer = isRtcp ? answerRtcp(bytes, found, frame.stripped) : answerRtp(bytes, segments, frame.stripped);

			/*
			 * What the packet is and asks for, then its report blocks or feedback as a table, then the bytes, then the
			 * field list and the timing arithmetic. A TWCC chart, when there is one, comes last: the table beside it
			 * links to it. Each part carries an `id`, so tests and links find it by name rather than by position.
			 */
			const parts: Output[] = [
				{ kind: "fields", role: "answer", id: "answer", fields: answer },
				...extras.filter((part) => part.kind === "table").map((part) => ({ ...part, role: "decoded" })),
			];
			if (view !== "fields") {
				parts.push({ kind: "bytes", id: "bytes", bytes: [...bytes], caption: "Each named range is one field of the packet", highlight });
			}
			parts.push({ kind: "fields", role: "decoded", id: "fields", fields });
			if (timing.length > 0) parts.push({ kind: "fields", role: "method", id: "timing", fields: timing });
			parts.push(...extras.filter((part) => part.kind === "series"));
			return { kind: "group", parts };
		} catch (error) {
			if (error instanceof ParseError) {
				return { kind: "error", message: error.message, input: "packet", ...(error.at !== undefined ? { at: error.at, len: error.len ?? 1 } : {}) };
			}
			throw error;
		}
	},
} satisfies Tool<Input>;
