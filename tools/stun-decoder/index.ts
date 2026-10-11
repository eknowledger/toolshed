/**
 * A STUN message decoder: paste the hex of a STUN message and see every field, the addresses un-XORed, and the
 * checks a receiver would run.
 *
 * STUN (RFC 8489) is what ICE's connectivity checks and TURN's control messages are made of, so the same twenty-byte
 * header turns up in all three. This reads the header, splits the 14-bit type into its method and class, walks the
 * attributes, and does the two things a list of fields cannot: it un-XORs XOR-MAPPED-ADDRESS and its relatives back
 * into the address they carry, and it checks the integrity attributes. FINGERPRINT is a CRC-32 anyone can verify;
 * MESSAGE-INTEGRITY is an HMAC-SHA1 keyed with the password, so it is verified only when the reader gives one.
 *
 * References: RFC 8489 (STUN), RFC 8445 (ICE's attributes), RFC 8656 (TURN's).
 */
import type { ByteRange, Cell, Field, Output, Series, Tool } from "@toolbench/sdk";

type Input = { message: string; password: string; view: string };

class ParseError extends Error {
	readonly at: number | undefined;
	readonly len: number | undefined;
	constructor(message: string, at?: number, len?: number) {
		super(message);
		this.at = at;
		this.len = len;
	}
}

const MAGIC = 0x2112a442;

/** Read hex the way rtcp-inspector does: tolerant of separators and Wireshark offsets, strict about anything else. */
function readHex(text: string): Uint8Array {
	const withoutOffsets = text
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*(?:0x)?[0-9a-f]{4,8}[:\s]\s/i, " "))
		.join(" ")
		.replace(/0x/gi, "");
	const strays = [...new Set(withoutOffsets.replace(/[0-9a-f\s:,.\-|]/gi, ""))];
	if (strays.length > 0) {
		throw new ParseError(`Not hex: found ${strays.map((c) => `"${c}"`).join(", ")}. Expected hex digits, optionally separated by spaces, colons or commas.`);
	}
	const cleaned = withoutOffsets.replace(/[^0-9a-f]/gi, "");
	if (cleaned.length === 0) throw new ParseError("No hex digits found. Paste a STUN message as hex.");
	if (cleaned.length % 2 !== 0) throw new ParseError(`Odd number of hex digits (${cleaned.length}); a byte needs two.`);
	const bytes = new Uint8Array(cleaned.length / 2);
	for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
	return bytes;
}

const u16 = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u32 = (b: Uint8Array, at: number) => b[at]! * 0x1000000 + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!);
const hex = (n: number, width: number) => `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
const hexBytes = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

function need(bytes: Uint8Array, at: number, len: number, what: string): void {
	if (at + len > bytes.length) {
		throw new ParseError(`Truncated: ${what} needs ${len} byte${len === 1 ? "" : "s"} at offset ${at}, but the message ends at ${bytes.length}.`, at, Math.max(1, bytes.length - at));
	}
}

// ---------------------------------------------------------------------------
// CRC-32 and HMAC-SHA1, small and synchronous, because a pure tool cannot call SubtleCrypto
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

export function crc32(b: Uint8Array): number {
	let c = 0xffffffff;
	for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

export function sha1(msg: Uint8Array): Uint8Array {
	const ml = msg.length;
	const withPad = new Uint8Array(((ml + 9 + 63) >> 6) << 6);
	withPad.set(msg);
	withPad[ml] = 0x80;
	const bits = ml * 8;
	const view = new DataView(withPad.buffer);
	view.setUint32(withPad.length - 4, bits >>> 0);
	view.setUint32(withPad.length - 8, Math.floor(bits / 2 ** 32));
	let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
	const w = new Uint32Array(80);
	const rotl = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;
	for (let off = 0; off < withPad.length; off += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
		for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
		let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
		for (let i = 0; i < 80; i++) {
			const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
			const t = (rotl(a, 5) + (f >>> 0) + e + k + w[i]!) >>> 0;
			[e, d, c, b, a] = [d, c, rotl(b, 30), a, t];
		}
		[h0, h1, h2, h3, h4] = [(h0 + a) >>> 0, (h1 + b) >>> 0, (h2 + c) >>> 0, (h3 + d) >>> 0, (h4 + e) >>> 0];
	}
	const out = new Uint8Array(20);
	const ov = new DataView(out.buffer);
	[h0, h1, h2, h3, h4].forEach((h, i) => ov.setUint32(i * 4, h));
	return out;
}

export function hmacSha1(key: Uint8Array, msg: Uint8Array): Uint8Array {
	const k = key.length > 64 ? sha1(key) : key;
	const block = new Uint8Array(64);
	block.set(k);
	const inner = new Uint8Array(64 + msg.length);
	const outer = new Uint8Array(64 + 20);
	for (let i = 0; i < 64; i++) {
		inner[i] = block[i]! ^ 0x36;
		outer[i] = block[i]! ^ 0x5c;
	}
	inner.set(msg, 64);
	outer.set(sha1(inner), 64);
	return sha1(outer);
}

/** A copy of the message up to `end`, with its length field set as if the message ended just after `end + extra`. */
function withLength(bytes: Uint8Array, end: number, extra: number): Uint8Array {
	const out = bytes.slice(0, end);
	const len = end - 20 + extra;
	out[2] = (len >> 8) & 0xff;
	out[3] = len & 0xff;
	return out;
}

// ---------------------------------------------------------------------------
// Types and attributes
// ---------------------------------------------------------------------------

const METHODS: Record<number, string> = {
	0x001: "Binding", 0x003: "Allocate", 0x004: "Refresh", 0x006: "Send", 0x007: "Data", 0x008: "CreatePermission", 0x009: "ChannelBind",
};
const CLASSES = ["request", "indication", "success response", "error response"];

const ATTRIBUTES: Record<number, string> = {
	0x0001: "MAPPED-ADDRESS", 0x0006: "USERNAME", 0x0008: "MESSAGE-INTEGRITY", 0x0009: "ERROR-CODE", 0x000a: "UNKNOWN-ATTRIBUTES",
	0x000c: "CHANNEL-NUMBER", 0x000d: "LIFETIME", 0x0012: "XOR-PEER-ADDRESS", 0x0013: "DATA", 0x0014: "REALM", 0x0015: "NONCE",
	0x0016: "XOR-RELAYED-ADDRESS", 0x0019: "REQUESTED-TRANSPORT", 0x001c: "MESSAGE-INTEGRITY-SHA256", 0x001d: "PASSWORD-ALGORITHM",
	0x001e: "USERHASH", 0x0020: "XOR-MAPPED-ADDRESS", 0x0024: "PRIORITY", 0x0025: "USE-CANDIDATE", 0x8022: "SOFTWARE",
	0x8023: "ALTERNATE-SERVER", 0x8028: "FINGERPRINT", 0x8029: "ICE-CONTROLLED", 0x802a: "ICE-CONTROLLING",
};

const TYPE_PREFS: Record<number, string> = { 126: "host", 110: "peer-reflexive", 100: "server-reflexive", 0: "relayed" };

interface Attr {
	at: number;
	type: number;
	len: number;
	name: string;
	value: string;
	note?: string;
	tone?: "good" | "warn" | "bad";
}

function address(bytes: Uint8Array, at: number, len: number, xor: boolean, txid: Uint8Array): { value: string; note: string } {
	const family = bytes[at + 1];
	const rawPort = u16(bytes, at + 2);
	const port = xor ? rawPort ^ (MAGIC >>> 16) : rawPort;
	if (family === 0x01 && len >= 8) {
		const raw = u32(bytes, at + 4);
		const ip = xor ? (raw ^ MAGIC) >>> 0 : raw;
		const text = [24, 16, 8, 0].map((s) => (ip >>> s) & 0xff).join(".");
		return { value: `${text}:${port}`, note: xor ? `port ${hex(rawPort, 4)} XOR 0x2112, address ${hex(raw, 8)} XOR 0x2112A442` : "sent in the clear" };
	}
	if (family === 0x02 && len >= 20) {
		const mask = new Uint8Array(16);
		new DataView(mask.buffer).setUint32(0, MAGIC);
		mask.set(txid, 4);
		const words: string[] = [];
		for (let i = 0; i < 16; i += 2) words.push((((bytes[at + 4 + i]! ^ (xor ? mask[i]! : 0)) << 8) | (bytes[at + 5 + i]! ^ (xor ? mask[i + 1]! : 0))).toString(16));
		return { value: `[${words.join(":")}]:${port}`, note: xor ? "IPv6: XOR with the cookie and the transaction ID" : "IPv6, sent in the clear" };
	}
	return { value: `family ${family}`, note: "not an address family STUN defines", tone: "warn" } as { value: string; note: string };
}

function decode(bytes: Uint8Array, password: string) {
	need(bytes, 0, 20, "the STUN header");
	const type = u16(bytes, 0);
	if (type & 0xc000) throw new ParseError(`The first two bits are ${type >> 14}, but STUN's are always 00. This is probably not a STUN message.`, 0, 1);
	const length = u16(bytes, 2);
	const cookie = u32(bytes, 4);
	if (cookie !== MAGIC) throw new ParseError(`The magic cookie is ${hex(cookie, 8)}, but STUN's is always 0x2112A442. This is probably not a STUN message, or it is the older RFC 3489 kind.`, 4, 4);
	if (length % 4 !== 0) throw new ParseError(`The length is ${length}, but STUN attributes are padded to 4 bytes, so it is always a multiple of 4.`, 2, 2);
	if (20 + length > bytes.length) throw new ParseError(`The header says ${length} bytes of attributes follow, but only ${bytes.length - 20} do.`, 2, 2);
	const method = (type & 0x000f) | ((type & 0x00e0) >> 1) | ((type & 0x3e00) >> 2);
	const klass = ((type & 0x0010) >> 4) | ((type & 0x0100) >> 7);
	const txid = bytes.slice(8, 20);

	const attrs: Attr[] = [];
	let at = 20;
	while (at < 20 + length) {
		need(bytes, at, 4, "an attribute header");
		const aType = u16(bytes, at);
		const aLen = u16(bytes, at + 2);
		need(bytes, at + 4, aLen, `attribute ${hex(aType, 4)}`);
		const v = at + 4;
		const name = ATTRIBUTES[aType] ?? (aType < 0x8000 ? "unknown (comprehension-required)" : "unknown (comprehension-optional)");
		let value = `${aLen} bytes`;
		let note: string | undefined;
		let tone: Attr["tone"];
		const text = () => new TextDecoder().decode(bytes.slice(v, v + aLen));
		switch (aType) {
			case 0x0001:
			case 0x0020:
			case 0x0012:
			case 0x0016:
			case 0x8023: {
				const a = address(bytes, v, aLen, aType !== 0x0001 && aType !== 0x8023, txid);
				value = a.value;
				note = a.note;
				break;
			}
			case 0x0006: {
				value = text();
				const parts = value.split(":");
				// RFC 8445 section 7.2.2: the receiver's ufrag, a colon, the sender's.
				if (parts.length === 2) note = `ICE: "${parts[0]}" is the receiver's ufrag, "${parts[1]}" the sender's`;
				break;
			}
			case 0x0014:
			case 0x0015:
			case 0x8022:
				value = text();
				break;
			case 0x0009: {
				const code = (bytes[v + 2]! & 0x07) * 100 + bytes[v + 3]!;
				value = `${code} ${new TextDecoder().decode(bytes.slice(v + 4, v + aLen))}`;
				tone = "warn";
				break;
			}
			case 0x000d:
				value = `${u32(bytes, v)} s`;
				break;
			case 0x0019:
				value = bytes[v] === 17 ? "UDP (17)" : `protocol ${bytes[v]}`;
				break;
			case 0x000c:
				value = hex(u16(bytes, v), 4);
				break;
			case 0x0024: {
				const p = u32(bytes, v);
				const tp = Math.floor(p / 2 ** 24);
				value = String(p);
				note = `type preference ${tp}${TYPE_PREFS[tp] ? `, ${TYPE_PREFS[tp]} by RFC 8445's recommended values` : ""}; local preference ${(p >>> 8) & 0xffff}; component ${256 - (p & 0xff)}`;
				break;
			}
			case 0x0025:
				value = "present";
				note = "the controlling agent nominates this pair";
				break;
			case 0x8029:
			case 0x802a:
				value = hexBytes(bytes.slice(v, v + aLen));
				note = "a tiebreaker, compared only if both sides claim the same role";
				break;
			case 0x0008: {
				value = hexBytes(bytes.slice(v, v + aLen));
				if (!password) {
					note = "an HMAC-SHA1 keyed with the password; give the password to check it";
				} else {
					const expect = hmacSha1(new TextEncoder().encode(password), withLength(bytes, at, aLen + 4));
					const ok = expect.every((x, i) => x === bytes[v + i]);
					note = ok ? "matches the password given" : "does not match the password given";
					tone = ok ? "good" : "bad";
				}
				break;
			}
			case 0x8028: {
				const got = u32(bytes, v);
				const want = (crc32(withLength(bytes, at, 8)) ^ 0x5354554e) >>> 0;
				value = hex(got, 8);
				note = got === want ? "matches: CRC-32 of everything before it, XOR 0x5354554E" : `does not match: expected ${hex(want, 8)}`;
				tone = got === want ? "good" : "bad";
				break;
			}
		}
		attrs.push({ at, type: aType, len: aLen, name, value, ...(note ? { note } : {}), ...(tone ? { tone } : {}) });
		at = v + aLen + ((4 - (aLen % 4)) % 4);
	}
	return { type, method, klass, length, txid, attrs };
}

export default {
	run({ message, password, view }: Input): Output {
		try {
			const bytes = readHex(message);
			const m = decode(bytes, password.trim());
			const methodName = METHODS[m.method] ?? `method ${hex(m.method, 3)}`;
			const fields: Field[] = [
				{ label: "Message", value: `${methodName} ${CLASSES[m.klass]}`, note: `type ${hex(m.type, 4)}: method ${hex(m.method, 3)}, class ${m.klass}` },
				{ label: "Length", value: `${m.length} bytes of attributes`, note: `${bytes.length} bytes in all, with the 20-byte header` },
				{ label: "Magic cookie", value: "0x2112A442", note: "fixed: tells STUN apart from the media sharing the port", tone: "good" },
				{ label: "Transaction ID", value: hexBytes(m.txid), note: "random, so the answer can be matched to the request" },
				...m.attrs.map((a) => ({ label: a.name, value: a.value, ...(a.note ? { note: a.note } : {}), ...(a.tone ? { tone: a.tone } : {}) })),
			];
			const rows: Cell[][] = m.attrs.map((a) => [
				{ text: hex(a.type, 4), mono: true },
				a.name,
				{ text: String(a.len), mono: true },
				{ text: String(a.at), mono: true },
				{ text: a.value, mono: true, ...(a.tone ? { tone: a.tone } : {}) },
			]);
			const parts: Output[] = [
				{ kind: "fields", fields },
				{
					kind: "series",
					chart: {
						xLabel: "Message",
						yLabel: "Size",
						yUnit: "bytes",
						x: [`${bytes.length} bytes`],
						orientation: "horizontal",
						series: [
							{ label: "Header", unit: "bytes", shape: "bar", stack: "msg", points: [20] },
							...m.attrs.slice(0, 5).map((a): Series => ({ label: a.name, unit: "bytes", shape: "bar", stack: "msg", points: [4 + a.len + ((4 - (a.len % 4)) % 4)] })),
							...(m.attrs.length > 5 ? [{ label: `${m.attrs.length - 5} more attributes`, unit: "bytes", shape: "bar" as const, stack: "msg", points: [m.attrs.slice(5).reduce((s, a) => s + 4 + a.len + ((4 - (a.len % 4)) % 4), 0)] }] : []),
						],
					},
				},
				{
					kind: "table",
					caption: `${m.attrs.length} attribute${m.attrs.length === 1 ? "" : "s"}, each padded to 4 bytes`,
					columns: [
						{ label: "Type", mono: true },
						{ label: "Attribute" },
						{ label: "Length", align: "end", mono: true },
						{ label: "Offset", align: "end", mono: true },
						{ label: "Value", mono: true },
					],
					rows,
				},
			];
			if (view !== "fields") {
				const highlight: ByteRange[] = [{ at: 4, len: 4, label: "Magic cookie" }, { at: 8, len: 12, label: "Transaction ID" }, ...m.attrs.map((a) => ({ at: a.at, len: 4 + a.len, label: a.name }))];
				parts.push({ kind: "bytes", bytes: [...bytes], caption: "The header, then each attribute, marked in place", highlight });
			}
			return { kind: "group", parts };
		} catch (error) {
			if (error instanceof ParseError) return { kind: "error", message: error.message, input: "message", ...(error.at !== undefined ? { at: error.at, len: error.len ?? 1 } : {}) };
			throw error;
		}
	},
} satisfies Tool<Input>;
