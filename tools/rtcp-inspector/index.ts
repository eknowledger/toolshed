/**
 * An RTP and RTCP packet inspector.
 *
 * Every free browser decoder for this either shows a flat field list with no relation to the bytes, or
 * requires a pcap. This one takes the hex you copied out of Wireshark or a log and shows the header
 * fields, the report blocks, and the bytes themselves with each field marked in place, so "the
 * extension header is here" is something you can see rather than infer.
 *
 * Scope: the RTP fixed header with CSRCs, both RFC 8285 extension forms, padding, and the RTCP types
 * that carry the information anyone actually debugs with, which is SR, RR, SDES and BYE, including
 * compound packets. APP and the feedback types (RTPFB, PSFB) are follow-ups inside this tool.
 *
 * References: RFC 3550 (RTP/RTCP), RFC 8285 (header extensions), RFC 3551 (payload types).
 */
import type { ByteRange, Cell, Field, Output, Series, Tool } from "@toolbench/sdk";

type Input = { packet: string; view: string };

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
}

/** One part of the packet for the size chart: a header region, the payload, or an RTCP sub-packet. */
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
 * Read hex, tolerantly. People paste from Wireshark ("0000 80 e0 00 2a"), from a log ("80:e0:00:2a"),
 * or as one run of digits. Offsets at line starts are the interesting case: Wireshark's copy-as-hex
 * includes them, and treating them as data silently decodes a different packet.
 */
function readHex(text: string): Uint8Array {
	const withoutOffsets = text
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*(?:0x)?[0-9a-f]{4,8}[:\s]\s/i, " "))
		.join(" ");
	// Wireshark's "copy as hex dump" also carries an ASCII gutter. Anything after two spaces at the
	// end of a line is that gutter, not bytes.
	const withoutPrefixes = withoutOffsets.replace(/0x/gi, "");
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

function parseRtp(bytes: Uint8Array): { spans: Span[]; extras: Output[]; segments: Segment[] } {
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
	spans.push({ at: 4, len: 4, label: "Timestamp", value: String(u32(bytes, 4)), note: "clock rate is not in the packet" });
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
						{ label: "ID", align: "end", mono: true },
						{ label: "Length", align: "end", mono: true },
						{ label: "Offset", align: "end", mono: true },
						{ label: "Data", mono: true },
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

/** NTP epoch is 1900; Unix is 1970. The difference is fixed and famous. */
const NTP_UNIX_OFFSET = 2_208_988_800;

/**
 * An RTCP packet, or a compound one. RFC 3550 requires compounds to begin with SR or RR, which is worth
 * saying when they do not: a receiver may drop the whole compound.
 */
function parseRtcp(bytes: Uint8Array): { spans: Span[]; extras: Output[]; summary: Field[]; segments: Segment[] } {
	const spans: Span[] = [];
	const segments: Segment[] = [];
	const extras: Output[] = [];
	const summary: Field[] = [];
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
		seen.push(RTCP_TYPES[type]?.split(" ")[0] ?? String(type));
		segments.push({ label: `#${seen.length} ${seen.at(-1)}`, len: Math.min(total, bytes.length - at) });
		spans.push({ at, len: 1, label: `#${index + 1} V / P / count`, value: `2 / ${padding ? 1 : 0} / ${count}` });
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
					value: `${ntpSec}.${ntpFrac.toString().padStart(10, "0")}`,
					note: ntpSec > NTP_UNIX_OFFSET ? new Date((ntpSec - NTP_UNIX_OFFSET) * 1000).toISOString() : "before 1970; probably not a real clock",
				});
				spans.push({ at: body + 12, len: 4, label: `#${index + 1} RTP timestamp`, value: String(u32(bytes, body + 12)) });
				spans.push({ at: body + 16, len: 4, label: `#${index + 1} Packets sent`, value: String(u32(bytes, body + 16)) });
				spans.push({ at: body + 20, len: 4, label: `#${index + 1} Octets sent`, value: String(u32(bytes, body + 20)) });
				const rows = reportBlocks(bytes, body + 24, count, index, spans);
				if (rows.length > 0) extras.push(reportTable(rows, `SR #${index + 1}: ${count} report block${count === 1 ? "" : "s"}`));
				break;
			}
			case 201: { // RR
				need(bytes, body, 4, "the reporter SSRC");
				spans.push({ at: body, len: 4, label: `#${index + 1} Reporter SSRC`, value: hex(u32(bytes, body), 8), mark: true });
				const rows = reportBlocks(bytes, body + 4, count, index, spans);
				if (rows.length > 0) extras.push(reportTable(rows, `RR #${index + 1}: ${count} report block${count === 1 ? "" : "s"}`));
				break;
			}
			case 202: { // SDES
				const rows: Cell[][] = [];
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
						rows.push([
							{ text: hex(ssrc, 8), mono: true },
							{ text: SDES_ITEMS[itemType] ?? `type ${itemType}` },
							{ text: String(len), mono: true },
							{ text, mono: true },
						]);
						spans.push({ at: item, len: 2 + len, label: `#${index + 1} ${SDES_ITEMS[itemType] ?? `SDES ${itemType}`}`, value: text, mark: true });
						item += 2 + len;
					}
					// Chunks are padded with nulls to the next 32-bit boundary, and the terminator counts.
					const consumed = item + 1 - chunk;
					chunk += Math.ceil(consumed / 4) * 4;
				}
				if (rows.length > 0) {
					extras.push({
						kind: "table", caption: `SDES #${index + 1}: ${rows.length} item${rows.length === 1 ? "" : "s"}`,
						columns: [{ label: "SSRC", mono: true }, { label: "Item" }, { label: "Len", align: "end", mono: true }, { label: "Value", mono: true }],
						rows,
					});
				}
				break;
			}
			case 203: { // BYE
				let src = body;
				for (let c = 0; c < count; c++) {
					need(bytes, src, 4, `BYE SSRC ${c + 1}`);
					spans.push({ at: src, len: 4, label: `#${index + 1} BYE SSRC ${c + 1}`, value: hex(u32(bytes, src), 8), mark: true });
					src += 4;
				}
				// The reason is optional, and only present if the length field left room for it.
				if (src < at + total) {
					const len = bytes[src]!;
					need(bytes, src + 1, len, "the BYE reason");
					const reason = new TextDecoder().decode(bytes.slice(src + 1, src + 1 + len));
					spans.push({ at: src, len: 1 + len, label: `#${index + 1} BYE reason`, value: reason, mark: true });
					summary.push({ label: "Leaving because", value: reason, group: "BYE" });
				}
				break;
			}
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
	summary.unshift({ label: "Sub-packets", value: `${index}`, note: seen.join(" + ") });
	if (index > 1 && first !== 200 && first !== 201) {
		summary.push({
			label: "Compound order", value: "invalid", tone: "bad",
			note: "RFC 3550 6.1: a compound packet must start with SR or RR, so a receiver may drop all of it",
		});
	}
	return { spans, extras, summary, segments };
}

/**
 * Where the packet's bytes go, as one stacked bar: for RTP, how much is header and how much is the sound or
 * video it carries; for RTCP, how big each sub-packet of a compound is. Only the bytes pasted are counted.
 * The UDP and IP headers around them are not in the input, so the chart says nothing about them rather than
 * assuming IPv4 or IPv6.
 *
 * At most six parts, because the chart has six colours; a longer compound folds its tail into one segment.
 */
function sizeChart(segments: Segment[], total: number, isRtcp: boolean): Output {
	const shown = segments.length > 6 ? [...segments.slice(0, 5), { label: `${segments.length - 5} more sub-packets`, len: segments.slice(5).reduce((sum, g) => sum + g.len, 0) }] : segments;
	const share = (len: number) => `${len} bytes, ${Math.round((len / total) * 100)}%`;
	const series: Series[] = shown.map((g) => ({ label: g.label, unit: "bytes", shape: "bar", stack: "packet", points: [g.len], notes: [share(g.len)] }));
	return {
		kind: "series",
		chart: {
			xLabel: isRtcp ? "Compound packet" : "Packet",
			yLabel: "Size",
			yUnit: "bytes",
			x: [`${total} bytes`],
			orientation: "horizontal",
			series,
			readout: { titles: [isRtcp ? `${total} bytes in ${segments.length} sub-packet${segments.length === 1 ? "" : "s"}` : `${total} bytes of RTP, before UDP and IP`] },
		},
	};
}

function reportBlocks(bytes: Uint8Array, from: number, count: number, index: number, spans: Span[]): Cell[][] {
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
		rows.push([
			{ text: hex(ssrc, 8), mono: true },
			{ text: `${percent.toFixed(1)}%`, mono: true, ...(percent >= 5 ? { tone: percent >= 10 ? ("bad" as const) : ("warn" as const) } : {}) },
			{ text: String(cumulative), mono: true, ...(cumulative < 0 ? { tone: "warn" as const } : {}) },
			{ text: String(u32(bytes, at + 8)), mono: true },
			{ text: String(u32(bytes, at + 12)), mono: true },
			{ text: hex(u32(bytes, at + 16), 8), mono: true },
			{ text: String(u32(bytes, at + 20)), mono: true },
		]);
		spans.push({ at, len: 24, label: `#${index + 1} Report block ${i + 1}`, value: `${hex(ssrc, 8)}, ${percent.toFixed(1)}% lost`, mark: true });
		at += 24;
	}
	return rows;
}

function reportTable(rows: Cell[][], caption: string): Output {
	return {
		kind: "table", caption,
		columns: [
			{ label: "Source SSRC", mono: true },
			{ label: "Fraction lost", align: "end", mono: true },
			{ label: "Cumulative lost", align: "end", mono: true },
			{ label: "Highest seq", align: "end", mono: true },
			{ label: "Jitter", align: "end", mono: true },
			{ label: "LSR", align: "end", mono: true },
			{ label: "DLSR", align: "end", mono: true },
		],
		rows,
	};
}

export default {
	run({ packet, view }): Output {
		let bytes: Uint8Array;
		try {
			bytes = readHex(packet);
		} catch (error) {
			if (error instanceof ParseError) {
				return { kind: "error", message: error.message, input: "packet", ...(error.at !== undefined ? { at: error.at, len: error.len ?? 1 } : {}) };
			}
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
			const { spans, extras, summary = [], segments } = isRtcp ? parseRtcp(bytes) : { ...parseRtp(bytes), summary: [] as Field[] };
			const fields: Field[] = [
				{ label: "Protocol", value: isRtcp ? "RTCP" : "RTP", note: `second byte is ${second}` },
				...summary,
			].concat(spans.map((s) => ({
				label: s.label,
				value: s.value,
				...(s.note ? { note: s.note } : {}),
				...(s.tone ? { tone: s.tone } : {}),
			})));
			const highlight: ByteRange[] = spans.filter((s) => s.mark).map((s) => ({ at: s.at, len: s.len, label: s.label }));

			const parts: Output[] = [{ kind: "fields", fields }, sizeChart(segments, bytes.length, isRtcp), ...extras];
			if (view !== "fields") {
				parts.push({ kind: "bytes", bytes: [...bytes], caption: "Each named range is one header field", highlight });
			}
			return { kind: "group", parts };
		} catch (error) {
			if (error instanceof ParseError) {
				return { kind: "error", message: error.message, input: "packet", ...(error.at !== undefined ? { at: error.at, len: error.len ?? 1 } : {}) };
			}
			throw error;
		}
	},
} satisfies Tool<Input>;
