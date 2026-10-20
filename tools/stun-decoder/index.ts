/**
 * A STUN message decoder: paste a STUN message, as hex or as a capture's hex dump, and see every field, the
 * addresses un-XORed, and the checks a receiver would run.
 *
 * STUN (RFC 8489) is what ICE's connectivity checks and TURN's control messages are made of, so the same twenty-byte
 * header turns up in all three. This reads the header, splits the 14-bit type into its method and class, walks the
 * attributes, and does the things a list of fields cannot: it un-XORs XOR-MAPPED-ADDRESS and its relatives back into
 * the address they carry, and it checks the integrity attributes. FINGERPRINT is a CRC-32 anyone can verify.
 * MESSAGE-INTEGRITY and MESSAGE-INTEGRITY-SHA256 are HMACs keyed with a credential, so they are verified when the
 * reader gives the password: the password itself for ICE and other short-term credentials, MD5 of
 * "username:realm:password" for TURN's long-term ones.
 *
 * It leads with what the message is, the address or error it carries and whether its integrity holds, then what
 * to fix, because the question behind a paste is usually "why did this fail", not "what is in byte 24".
 *
 * References: RFC 8489 (STUN), RFC 8445 (ICE's attributes), RFC 8656 (TURN's), RFC 5769 (the test vectors).
 */
import type { ByteRange, Cell, Field, Output, Tool } from "@toolbench/sdk";

type Input = { message: string; password: string; username: string; realm: string; view: string };

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

// ---------------------------------------------------------------------------
// Reading what was pasted
// ---------------------------------------------------------------------------

/** Separators people put between hex bytes: spaces, colons, commas, dashes. Not dots: a dump's ASCII column is dots. */
const HEX_SEGMENT = /^(?:0x|[0-9a-f]|[\s:,-])+$/i;
/** A dump line: an offset of 4 to 8 hex digits, then a colon or at least two spaces, then a byte. */
const DUMP_LINE = /^\s*(?:0x)?([0-9a-f]{4,8})(?::\s*|\s{2,})(?=[0-9a-f]{2})/i;

/** The hex digits of a run of text that should be nothing but hex, or an error naming what else is in it. */
function hexOf(segment: string): string {
	const strays = [...new Set(segment.replace(/0x/gi, "").replace(/[0-9a-f\s:,-]/gi, ""))];
	if (strays.length > 0) {
		throw new ParseError(
			`This is not hex: it contains ${strays.map((c) => `"${c}"`).join(", ")}. Expected hex digits, optionally separated by spaces, colons or commas.`,
		);
	}
	return segment.replace(/0x/gi, "").replace(/[^0-9a-f]/gi, "");
}

/**
 * Hex, however it was copied: a plain string, bytes separated by spaces, colons or commas, `0x` or `\x` prefixes, or a
 * dump with offsets down the left and the ASCII column on the right, from Wireshark, tcpdump -X, hexdump -C or xxd.
 *
 * ⚠️ A dump's ASCII column can look like hex ("abcd" is printable and hex alike), so it is not left to the parser to
 * tell apart. Each line is cut at the first gap of two or more spaces that is followed by something that is not hex,
 * and a dump's bytes per line are capped by the difference between one offset and the next, which is exact whatever
 * the ASCII column holds. The same gap rule lets a paste from an RFC's figure keep its notes ("Magic cookie") beside
 * the bytes.
 */
function readHex(text: string): { bytes: Uint8Array; dump: boolean } {
	const lines = text.replace(/\\x/gi, " ").split(/\r?\n/);
	const dump = lines.some((l) => DUMP_LINE.test(l));
	const rows: { offset?: number; digits: string }[] = [];
	for (const raw of lines) {
		let line = raw.replace(/\|[^|]*\|\s*$/, "");
		let offset: number | undefined;
		if (dump) {
			const m = DUMP_LINE.exec(line);
			if (!m) {
				if (line.trim()) rows.push({ digits: hexOf(line) });
				continue;
			}
			offset = Number.parseInt(m[1]!, 16);
			line = line.slice(m[0].length);
		}
		const segments = line.split(/\s{2,}/);
		let digits = "";
		for (const [i, segment] of segments.entries()) {
			if (segment === "" || HEX_SEGMENT.test(segment)) {
				digits += segment.replace(/0x/gi, "").replace(/[^0-9a-f]/gi, "");
				continue;
			}
			// The first segment is the bytes themselves, so anything odd in it is an error rather than a note.
			if (i === 0) digits += hexOf(segment);
			break;
		}
		rows.push({ ...(offset !== undefined ? { offset } : {}), digits });
	}
	if (dump) {
		for (let i = 0; i < rows.length - 1; i++) {
			const here = rows[i]!.offset;
			const next = rows[i + 1]!.offset;
			if (here !== undefined && next !== undefined && next > here) rows[i]!.digits = rows[i]!.digits.slice(0, (next - here) * 2);
		}
	}
	const cleaned = rows.map((r) => r.digits).join("");
	if (cleaned.length === 0) throw new ParseError("No hex digits found. Paste a STUN message as hex, or a hex dump from Wireshark.");
	if (cleaned.length % 2 !== 0) throw new ParseError(`There is an odd number of hex digits (${cleaned.length}), and a byte needs two.`);
	const bytes = new Uint8Array(cleaned.length / 2);
	for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
	return { bytes, dump };
}

const u16 = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u32 = (b: Uint8Array, at: number) => b[at]! * 0x1000000 + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!);
const hex = (n: number, width: number) => `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
const hexBytes = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A plausible STUN header at `p`: two zero bits, the cookie, a length that is a multiple of 4 and fits. */
const headerAt = (b: Uint8Array, p: number) =>
	p + 20 <= b.length && (b[p]! & 0xc0) === 0 && u32(b, p + 4) === MAGIC && u16(b, p + 2) % 4 === 0 && p + 20 + u16(b, p + 2) <= b.length;

/**
 * Where the STUN message starts. A hex dump of a captured frame begins with the Ethernet, IP and UDP headers, and
 * asking a reader to count off 42 bytes by hand is exactly the job a tool is for. The cookie at byte 4 of a header is
 * what makes this safe: a random 32-bit match is a one in four billion chance at each offset. A message whose own
 * cookie is at byte 4 is never moved, even when its length is wrong, so that error is still reported against it.
 */
function locate(b: Uint8Array): number {
	if (b.length < 8 || u32(b, 4) === MAGIC) return 0;
	for (let p = 1; p + 20 <= b.length; p++) if (headerAt(b, p)) return p;
	return 0;
}

/** What the bytes before a located message were, in words, when they parse as the usual headers. */
function describePrefix(b: Uint8Array, skip: number): string {
	const ip = (at: number): number | undefined => {
		if (at + 40 > b.length) return undefined;
		const v = b[at]! >> 4;
		if (v === 4 && b[at + 9] === 17) return at + (b[at]! & 0x0f) * 4;
		if (v === 6 && b[at + 6] === 17) return at + 40;
		return undefined;
	};
	const family = (at: number) => (b[at]! >> 4 === 4 ? "IPv4" : "IPv6");
	const ether = b.length > 14 && (u16(b, 12) === 0x0800 || u16(b, 12) === 0x86dd) ? ip(14) : undefined;
	if (ether !== undefined && ether + 8 === skip) return `the Ethernet, ${family(14)} and UDP headers of a captured frame`;
	const raw = ip(0);
	if (raw !== undefined && raw + 8 === skip) return `the ${family(0)} and UDP headers of a captured packet`;
	return "bytes that are not STUN, most likely the headers of a captured packet";
}

function need(bytes: Uint8Array, at: number, len: number, what: string): void {
	if (at + len > bytes.length) {
		throw new ParseError(
			`The message is cut short: ${what} needs ${len} byte${len === 1 ? "" : "s"} at offset ${at}, but the message ends at ${bytes.length}.`,
			at,
			Math.max(1, bytes.length - at),
		);
	}
}

// ---------------------------------------------------------------------------
// CRC-32, MD5, SHA-1, SHA-256 and their HMACs, small and synchronous, because a pure tool cannot call SubtleCrypto
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

const rotl = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;
const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;

/** Merkle-Damgard padding: a 1 bit, zeros, and the length in bits, big-endian for SHA, little-endian for MD5. */
function pad(msg: Uint8Array, littleEndian: boolean): DataView {
	const padded = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6);
	padded.set(msg);
	padded[msg.length] = 0x80;
	const view = new DataView(padded.buffer);
	const bits = msg.length * 8;
	const hi = Math.floor(bits / 2 ** 32);
	if (littleEndian) {
		view.setUint32(padded.length - 8, bits >>> 0, true);
		view.setUint32(padded.length - 4, hi, true);
	} else {
		view.setUint32(padded.length - 4, bits >>> 0);
		view.setUint32(padded.length - 8, hi);
	}
	return view;
}

export function sha1(msg: Uint8Array): Uint8Array {
	const view = pad(msg, false);
	let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
	const w = new Uint32Array(80);
	for (let off = 0; off < view.byteLength; off += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
		for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
		let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
		for (let i = 0; i < 80; i++) {
			const [f, k] =
				i < 20
					? [(b & c) | (~b & d), 0x5a827999]
					: i < 40
						? [b ^ c ^ d, 0x6ed9eba1]
						: i < 60
							? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
							: [b ^ c ^ d, 0xca62c1d6];
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

/** The first 32 bits of the fractional parts of the cube roots of the first 64 primes (FIPS 180-4 section 4.2.2). */
const K256 = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256, for MESSAGE-INTEGRITY-SHA256 and the SHA-256 long-term key of RFC 8489. */
export function sha256(msg: Uint8Array): Uint8Array {
	const view = pad(msg, false);
	const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
	const w = new Uint32Array(64);
	for (let off = 0; off < view.byteLength; off += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
			const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
			w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
		for (let i = 0; i < 64; i++) {
			const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i]! + w[i]!) >>> 0;
			const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
			[hh, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
		}
		[a, b, c, d, e, f, g, hh].forEach((x, i) => {
			h[i] = (h[i]! + x) >>> 0;
		});
	}
	const out = new Uint8Array(32);
	const ov = new DataView(out.buffer);
	h.forEach((x, i) => ov.setUint32(i * 4, x));
	return out;
}

const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

/** MD5, which TURN's long-term credential still uses for its key (RFC 8489 section 9.2.2). */
export function md5(msg: Uint8Array): Uint8Array {
	const view = pad(msg, true);
	let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
	for (let off = 0; off < view.byteLength; off += 64) {
		let [a, b, c, d] = [a0, b0, c0, d0];
		for (let i = 0; i < 64; i++) {
			const [f, g] =
				i < 16
					? [(b & c) | (~b & d), i]
					: i < 32
						? [(d & b) | (~d & c), (5 * i + 1) % 16]
						: i < 48
							? [b ^ c ^ d, (3 * i + 5) % 16]
							: [c ^ (b | ~d), (7 * i) % 16];
			const sum = (a + (f >>> 0) + MD5_K[i]! + view.getUint32(off + g * 4, true)) >>> 0;
			[a, d, c] = [d, c, b];
			b = (b + rotl(sum, MD5_S[(i >> 4) * 4 + (i % 4)]!)) >>> 0;
		}
		[a0, b0, c0, d0] = [(a0 + a) >>> 0, (b0 + b) >>> 0, (c0 + c) >>> 0, (d0 + d) >>> 0];
	}
	const out = new Uint8Array(16);
	const ov = new DataView(out.buffer);
	[a0, b0, c0, d0].forEach((x, i) => ov.setUint32(i * 4, x, true));
	return out;
}

function hmac(hash: (m: Uint8Array) => Uint8Array, size: number, key: Uint8Array, msg: Uint8Array): Uint8Array {
	const k = key.length > 64 ? hash(key) : key;
	const block = new Uint8Array(64);
	block.set(k);
	const inner = new Uint8Array(64 + msg.length);
	const outer = new Uint8Array(64 + size);
	for (let i = 0; i < 64; i++) {
		inner[i] = block[i]! ^ 0x36;
		outer[i] = block[i]! ^ 0x5c;
	}
	inner.set(msg, 64);
	outer.set(hash(inner), 64);
	return hash(outer);
}

export const hmacSha1 = (key: Uint8Array, msg: Uint8Array) => hmac(sha1, 20, key, msg);
export const hmacSha256 = (key: Uint8Array, msg: Uint8Array) => hmac(sha256, 32, key, msg);

/**
 * SASLprep (RFC 4013), which a long-term password goes through, to the extent that changes a real password:
 * characters "commonly mapped to nothing" are removed, other spaces become a plain space, and the result is
 * NFKC-normalised. RFC 5769's long-term vector is exactly this case: "The<U+00AD>M<U+00AA>tr<U+2168>" becomes
 * "TheMatrIX". The prohibited-character and bidi checks are left out: they reject a password, and a tool checking a
 * message someone else signed is better off trying it.
 */
export function saslprep(password: string): string {
	return password
		.replace(/[\u00AD\u034F\u1806\u180B-\u180D\u200B-\u200D\u2060\uFE00-\uFE0F\uFEFF]/g, "")
		.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
		.normalize("NFKC");
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
	0x001: "Binding",
	0x003: "Allocate",
	0x004: "Refresh",
	0x006: "Send",
	0x007: "Data",
	0x008: "CreatePermission",
	0x009: "ChannelBind",
};
const CLASSES = ["request", "indication", "success response", "error response"];

const ATTRIBUTES: Record<number, string> = {
	0x0001: "MAPPED-ADDRESS",
	0x0006: "USERNAME",
	0x0008: "MESSAGE-INTEGRITY",
	0x0009: "ERROR-CODE",
	0x000a: "UNKNOWN-ATTRIBUTES",
	0x000c: "CHANNEL-NUMBER",
	0x000d: "LIFETIME",
	0x0012: "XOR-PEER-ADDRESS",
	0x0013: "DATA",
	0x0014: "REALM",
	0x0015: "NONCE",
	0x0016: "XOR-RELAYED-ADDRESS",
	0x0019: "REQUESTED-TRANSPORT",
	0x001c: "MESSAGE-INTEGRITY-SHA256",
	0x001d: "PASSWORD-ALGORITHM",
	0x001e: "USERHASH",
	0x0020: "XOR-MAPPED-ADDRESS",
	0x0024: "PRIORITY",
	0x0025: "USE-CANDIDATE",
	0x8022: "SOFTWARE",
	0x8023: "ALTERNATE-SERVER",
	0x8028: "FINGERPRINT",
	0x8029: "ICE-CONTROLLED",
	0x802a: "ICE-CONTROLLING",
};

const TYPE_PREFS: Record<number, string> = { 126: "host", 110: "peer-reflexive", 100: "server-reflexive", 0: "relayed" };

/**
 * What to do about an error response, by code: RFC 8489 section 14.8 and RFC 8656 section 19. Only the codes whose
 * remedy is specific; any other gets a pointer to the RFCs.
 */
const ERROR_ACTIONS: Record<number, string> = {
	300: "Try the server named in ALTERNATE-SERVER instead.",
	400: "The server could not parse the request. Decode the request you sent with this tool and look for what it marks.",
	401: "Send the request again with USERNAME, and the REALM and NONCE from this response, signed with MESSAGE-INTEGRITY keyed with MD5 of username:realm:password.",
	403: "The server refuses this request with these credentials. Check that the account may use TURN, and that the peer address is allowed.",
	420: "The server does not understand the attributes listed in UNKNOWN-ATTRIBUTES. Send the request again without them.",
	437: "The server has no allocation for this client address and port, or a different one. Start again with a new Allocate.",
	438: "The nonce has expired. Send the request again with the NONCE from this response.",
	441: "The credentials do not match the allocation. Use the same username as the Allocate that created it.",
	442: "The server does not relay this transport. Ask for UDP (17) in REQUESTED-TRANSPORT.",
	486: "This user has as many allocations as the server allows. Free one with a Refresh of lifetime 0, or wait for one to expire.",
	487: "Both ICE agents claim the same role. Switch roles as RFC 8445 section 7.2.5.1 says, and send the check again.",
	500: "The server failed. Retry after a short wait.",
	508: "The server has no relay capacity left. Try another TURN server.",
};

type Tone = "good" | "warn" | "bad";

interface Attr {
	at: number;
	type: number;
	len: number;
	name: string;
	value: string;
	note?: string;
	tone?: Tone;
}

/** One integrity check: what it is, whether it passed, and, when it could not be run, why. */
interface Check {
	name: string;
	at: number;
	result: "pass" | "fail" | "unchecked";
	detail: string;
}

function address(bytes: Uint8Array, at: number, len: number, xor: boolean, txid: Uint8Array): { value: string; note: string; tone?: Tone } {
	const family = bytes[at + 1];
	const rawPort = u16(bytes, at + 2);
	const port = xor ? rawPort ^ (MAGIC >>> 16) : rawPort;
	if (family === 0x01 && len >= 8) {
		const raw = u32(bytes, at + 4);
		const ip = xor ? (raw ^ MAGIC) >>> 0 : raw;
		const text = [24, 16, 8, 0].map((s) => (ip >>> s) & 0xff).join(".");
		return {
			value: `${text}:${port}`,
			note: xor ? `IPv4. The port is ${hex(rawPort, 4)} XOR 0x2112 and the address ${hex(raw, 8)} XOR 0x2112A442.` : "IPv4, sent in the clear.",
		};
	}
	if (family === 0x02 && len >= 20) {
		const mask = new Uint8Array(16);
		new DataView(mask.buffer).setUint32(0, MAGIC);
		mask.set(txid, 4);
		const words: string[] = [];
		for (let i = 0; i < 16; i += 2) words.push((((bytes[at + 4 + i]! ^ (xor ? mask[i]! : 0)) << 8) | (bytes[at + 5 + i]! ^ (xor ? mask[i + 1]! : 0))).toString(16));
		return { value: `[${words.join(":")}]:${port}`, note: xor ? "IPv6. It is XORed with the cookie followed by the transaction ID." : "IPv6, sent in the clear." };
	}
	return { value: `family ${family}`, note: "This is not an address family STUN defines.", tone: "warn" };
}

interface Credentials {
	password: string;
	username: string;
	realm: string;
}

function decode(bytes: Uint8Array, creds: Credentials) {
	need(bytes, 0, 20, "the STUN header");
	const type = u16(bytes, 0);
	if (type & 0xc000) throw new ParseError(`The first two bits are ${type >> 14}, but a STUN message's are always 00. This is probably not a STUN message.`, 0, 1);
	const length = u16(bytes, 2);
	const cookie = u32(bytes, 4);
	if (cookie !== MAGIC) {
		throw new ParseError(
			`The magic cookie is ${hex(cookie, 8)}, but STUN's is always 0x2112A442. This is probably not a STUN message, or it is the older RFC 3489 kind.`,
			4,
			4,
		);
	}
	if (length % 4 !== 0) throw new ParseError(`The length is ${length}, but STUN attributes are padded to 4 bytes, so it is always a multiple of 4.`, 2, 2);
	if (20 + length > bytes.length) throw new ParseError(`The header says ${length} bytes of attributes follow, but only ${bytes.length - 20} do.`, 2, 2);
	const method = (type & 0x000f) | ((type & 0x00e0) >> 1) | ((type & 0x3e00) >> 2);
	const klass = ((type & 0x0010) >> 4) | ((type & 0x0100) >> 7);
	const txid = bytes.slice(8, 20);

	const attrs: Attr[] = [];
	const checks: Check[] = [];
	const text = (v: number, len: number) => new TextDecoder().decode(bytes.slice(v, v + len));
	const attrText = (t: number): string | undefined => {
		const a = attrs.find((x) => x.type === t);
		return a ? text(a.at + 4, a.len) : undefined;
	};
	let errorCode: number | undefined;

	/*
	 * The key for both integrity attributes. Long-term when there is a realm to use, from the message or from the
	 * reader: a TURN server's success response does not repeat USERNAME or REALM, so the reader has to give them.
	 * Short-term otherwise, which is every ICE check. The message's own values win over the reader's.
	 */
	const key = (): { key: Uint8Array; how: string } | { missing: string } => {
		const realm = attrText(0x0014) ?? creds.realm;
		const prepped = saslprep(creds.password);
		const changed = prepped !== creds.password ? `, after SASLprep turned the password into "${prepped}"` : "";
		if (!realm) return { key: new TextEncoder().encode(prepped), how: `the password itself, a short-term credential as ICE uses${changed}` };
		const username = attrText(0x0006) ?? creds.username;
		if (!username) return { missing: "This is a long-term credential and the message has no USERNAME. Enter the username to check it." };
		const sha = attrs.some((x) => x.type === 0x001d && x.len >= 2 && u16(bytes, x.at + 4) === 0x0002);
		const input = new TextEncoder().encode(`${username}:${realm}:${prepped}`);
		return sha
			? { key: sha256(input), how: `SHA-256 of "${username}:${realm}:password", a long-term credential, as PASSWORD-ALGORITHM asks${changed}` }
			: { key: md5(input), how: `MD5 of "${username}:${realm}:password", a long-term credential as TURN uses${changed}` };
	};

	let at = 20;
	while (at < 20 + length) {
		need(bytes, at, 4, "an attribute header");
		const aType = u16(bytes, at);
		const aLen = u16(bytes, at + 2);
		need(bytes, at + 4, aLen, `attribute ${hex(aType, 4)}`);
		const v = at + 4;
		const name = ATTRIBUTES[aType] ?? (aType < 0x8000 ? "unknown, must be understood" : "unknown, may be ignored");
		let value = `${aLen} bytes`;
		let note: string | undefined;
		let tone: Tone | undefined;
		switch (aType) {
			case 0x0001:
			case 0x0020:
			case 0x0012:
			case 0x0016:
			case 0x8023: {
				const a = address(bytes, v, aLen, aType !== 0x0001 && aType !== 0x8023, txid);
				value = a.value;
				note = a.note;
				tone = a.tone;
				break;
			}
			case 0x0006: {
				value = text(v, aLen);
				const parts = value.split(":");
				// RFC 8445 section 7.2.2: the receiver's ufrag, a colon, the sender's.
				note = parts.length === 2 ? `For ICE, "${parts[0]}" is the receiver's ufrag and "${parts[1]}" the sender's.` : "Who is asking.";
				break;
			}
			case 0x0014:
				value = text(v, aLen);
				note = "The server's name for the set of accounts the password belongs to.";
				break;
			case 0x0015:
				value = text(v, aLen);
				note = "A value the server chose, to be sent back with the next request.";
				break;
			case 0x8022:
				value = text(v, aLen);
				note = "The software that sent this message.";
				break;
			case 0x0009: {
				errorCode = (bytes[v + 2]! & 0x07) * 100 + bytes[v + 3]!;
				value = `${errorCode} ${text(v + 4, aLen - 4)}`;
				note = `Class ${bytes[v + 2]! & 0x07} and number ${bytes[v + 3]}, then the reason phrase.`;
				break;
			}
			case 0x000d:
				value = `${u32(bytes, v)} s`;
				note = "How long the allocation lasts unless it is refreshed.";
				break;
			case 0x0019:
				value = bytes[v] === 17 ? "UDP (17)" : `protocol ${bytes[v]}`;
				note = "The transport the client wants the relay to use towards peers.";
				break;
			case 0x000c:
				value = hex(u16(bytes, v), 4);
				break;
			case 0x001d:
				value = u16(bytes, v) === 2 ? "SHA-256 (2)" : u16(bytes, v) === 1 ? "MD5 (1)" : `algorithm ${u16(bytes, v)}`;
				note = "The hash used to make the long-term key.";
				break;
			case 0x0024: {
				const p = u32(bytes, v);
				const tp = Math.floor(p / 2 ** 24);
				value = String(p);
				note = `Type preference ${tp}${TYPE_PREFS[tp] ? `, which is ${TYPE_PREFS[tp]} in RFC 8445's recommended values` : ""}. Local preference ${(p >>> 8) & 0xffff}, component ${256 - (p & 0xff)}.`;
				break;
			}
			case 0x0025:
				value = "present";
				note = "The controlling agent nominates this pair for the call.";
				break;
			case 0x8029:
			case 0x802a:
				value = hexBytes(bytes.slice(v, v + aLen));
				note = `The sender says it is the ${aType === 0x802a ? "controlling" : "controlled"} agent. The number breaks a tie if both sides claim the same role.`;
				break;
			case 0x0008:
			case 0x001c: {
				value = hexBytes(bytes.slice(v, v + aLen));
				const sha = aType === 0x001c;
				if (!creds.password) {
					note = `An ${sha ? "HMAC-SHA256" : "HMAC-SHA1"} of the message, keyed with a credential. Enter the password to check it.`;
					checks.push({ name, at, result: "unchecked", detail: "no password given" });
					break;
				}
				const k = key();
				if ("missing" in k) {
					note = k.missing;
					checks.push({ name, at, result: "unchecked", detail: "no username for the long-term key" });
					break;
				}
				const signed = withLength(bytes, at, aLen + 4);
				const expect = sha ? hmacSha256(k.key, signed) : hmacSha1(k.key, signed);
				// MESSAGE-INTEGRITY-SHA256 may be truncated to as few as 16 bytes (RFC 8489 section 14.6).
				const ok = aLen > 0 && aLen <= expect.length && expect.slice(0, aLen).every((x, i) => x === bytes[v + i]);
				note = ok ? `It matches. The key is ${k.how}.` : `It does not match. The key tried is ${k.how}.`;
				if (!ok) tone = "bad";
				checks.push({ name, at, result: ok ? "pass" : "fail", detail: k.how });
				break;
			}
			case 0x8028: {
				const got = u32(bytes, v);
				const want = (crc32(withLength(bytes, at, 8)) ^ 0x5354554e) >>> 0;
				value = hex(got, 8);
				const ok = got === want;
				note = ok ? "It matches: the CRC-32 of everything before it, XOR 0x5354554E." : `It does not match. The bytes before it give ${hex(want, 8)}.`;
				if (!ok) tone = "bad";
				checks.push({ name, at, result: ok ? "pass" : "fail", detail: "" });
				break;
			}
		}
		attrs.push({ at, type: aType, len: aLen, name, value, ...(note ? { note } : {}), ...(tone ? { tone } : {}) });
		at = v + aLen + ((4 - (aLen % 4)) % 4);
	}
	return { type, method, klass, length, txid, attrs, checks, errorCode };
}

type Decoded = ReturnType<typeof decode>;
type Finding = { level: "bad" | "warn" | "normal"; problem: string; fix: string };

const LEVEL = { bad: "Fails", warn: "Warning", normal: "Unchecked" } as const;

/**
 * What the message is, in its own fields, and what is wrong with it, worst first.
 *
 * No tone on the identity: a success response is a message class, not a pass. Only a failed integrity check is
 * coloured, because that is the one thing a receiver acts on by dropping the message.
 */
function assess(m: Decoded, methodName: string): { answer: Field[]; findings: Finding[] } {
	const findings: Finding[] = [];
	const has = (t: number) => m.attrs.some((a) => a.type === t);
	const value = (t: number) => m.attrs.find((a) => a.type === t)?.value;
	const failed = m.checks.filter((c) => c.result === "fail");
	const passed = m.checks.filter((c) => c.result === "pass");
	const unchecked = m.checks.filter((c) => c.result === "unchecked");
	const iceCheck = m.method === 0x001 && m.klass === 0 && has(0x0024);

	for (const c of failed) {
		findings.push(
			c.name === "FINGERPRINT"
				? {
						level: "bad",
						problem: "FINGERPRINT: the bytes changed after the sender wrote it, so a receiver drops the message.",
						fix: "Copy the packet again. A dump cut short, or bytes from two packets, both do this.",
					}
				: {
						level: "bad",
						problem: `${c.name}: the key tried is ${c.detail}.`,
						fix: has(0x0014)
							? "Check the TURN password, and the username and realm. All three go into the key."
							: "For an ICE check and its answer, use the ice-pwd from the SDP of the side that receives the check, not the sender's.",
					},
		);
	}
	if (m.errorCode !== undefined) {
		findings.push({
			level: "warn",
			problem: `The server answered ${value(0x0009)}.`,
			fix: ERROR_ACTIONS[m.errorCode] ?? "Look this code up in RFC 8489 section 14.8, or RFC 8656 section 19 for TURN.",
		});
	}
	if (iceCheck && !has(0x8028)) {
		findings.push({ level: "warn", problem: "This ICE check has no FINGERPRINT.", fix: "RFC 8445 section 7.2.4 requires FINGERPRINT on every connectivity check. Add it last." });
	}
	if (iceCheck && !has(0x0008) && !has(0x001c)) {
		findings.push({
			level: "warn",
			problem: "This ICE check has no MESSAGE-INTEGRITY, so the receiver cannot tell it belongs to the call.",
			fix: "Sign it with the receiver's ice-pwd, and send USERNAME as the receiver's ufrag, a colon, then the sender's.",
		});
	}
	for (const c of unchecked) {
		findings.push({
			level: "normal",
			problem: `${c.name}: ${c.detail}.`,
			fix:
				c.detail === "no password given"
					? "Enter the password: for ICE, the ice-pwd of the side receiving the check; for TURN, the account's password."
					: "Enter the username the client used, and the realm, both from the request this answers.",
		});
	}
	const order = { bad: 0, warn: 1, normal: 2 };
	findings.sort((a, b) => order[a.level] - order[b.level]);

	const answer: Field[] = [];
	const user = value(0x0006)?.split(":");
	const what = iceCheck
		? `An ICE connectivity check${user?.length === 2 ? ` from "${user[1]}" to "${user[0]}"` : ""}${has(0x0025) ? " that nominates this pair" : ""}.`
		: m.method === 0x001 && m.klass === 0 && m.attrs.length === 0
			? "It asks the server which address it sees, and carries nothing else."
			: undefined;
	answer.push({ label: "Message", value: `${methodName} ${CLASSES[m.klass]}`, note: `${hex(m.type, 4)}${what ? `. ${what}` : ""}` });

	if (m.errorCode !== undefined) {
		answer.push({ label: "Error", value: value(0x0009) ?? String(m.errorCode) });
	} else if (has(0x0016)) {
		answer.push({ label: "Relayed address", value: value(0x0016)!, ...(has(0x000d) ? { note: `for ${value(0x000d)}` } : {}) });
	} else if (has(0x0020) || has(0x0001)) {
		answer.push({ label: "Mapped address", value: (value(0x0020) ?? value(0x0001))!, note: "Where the server saw the sender." });
	} else if (has(0x0006) && !iceCheck) {
		answer.push({ label: "Username", value: value(0x0006)!, ...(has(0x0014) ? { note: `realm ${value(0x0014)}` } : {}) });
	}

	const names = (cs: typeof m.checks) => cs.map((c) => c.name).join(" and ");
	let integrity: Field;
	if (failed.length) {
		integrity = { label: "Integrity", value: `${names(failed)} ${failed.length === 1 ? "does" : "do"} not match`, tone: "bad" };
		if (passed.length) integrity.note = `${names(passed)} ${passed.length === 1 ? "matches" : "match"}.`;
	} else if (passed.length) {
		integrity = { label: "Integrity", value: `${names(passed)} ${passed.length === 1 ? "matches" : "match"}` };
		if (unchecked.length) integrity.note = `${names(unchecked)} not checked.`;
	} else if (unchecked.length) {
		integrity = { label: "Integrity", value: `${names(unchecked)} not checked` };
	} else {
		integrity = { label: "Integrity", value: "none present", note: "No FINGERPRINT or MESSAGE-INTEGRITY." };
	}
	answer.push(integrity);
	return { answer, findings };
}

export default {
	run({ message, password, username, realm, view }: Input): Output {
		try {
			const read = readHex(message);
			const all = read.bytes;
			const skip = locate(all);
			const head = all.subarray(skip);
			const declared = head.length >= 4 ? 20 + u16(head, 2) : 0;
			// Only a message that parses is trimmed to its length: a short one must still fail on its length.
			const bytes = head.length >= 20 && u32(head, 4) === MAGIC && head.length > declared ? head.slice(0, declared) : head.slice();
			const m = decode(bytes, { password: password.trim(), username: username.trim(), realm: realm.trim() });
			const after = head.length - bytes.length;
			const methodName = METHODS[m.method] ?? `Method ${hex(m.method, 3)}`;
			const { answer, findings } = assess(m, methodName);

			const method: Field[] = [
				{
					label: "Message type",
					value: hex(m.type, 4),
					note: `Method ${hex(m.method, 3)}, ${methodName}, and class ${m.klass}, ${CLASSES[m.klass]}, with their bits interleaved.`,
					group: "Header",
				},
				{ label: "Length", value: `${m.length} bytes`, note: "Of attributes, after the 20-byte header.", group: "Header" },
				{ label: "Magic cookie", value: "0x2112A442", note: "Always the same. It tells STUN apart from the media sharing the port.", group: "Header" },
				{ label: "Transaction ID", value: hexBytes(m.txid), note: "Random, so the answer can be matched to the request.", group: "Header" },
			];
			// Only what the reading changed: a plain hex paste read in full says nothing worth a row.
			if (read.dump) method.push({ label: "Read as", value: "a hex dump", note: "The offsets and the ASCII column were left out.", group: "Input" });
			if (skip > 0) method.push({ label: "Skipped before it", value: `${skip} bytes`, note: `The STUN message starts after ${describePrefix(all, skip)}.`, group: "Input" });
			if (after > 0) method.push({ label: "Left out after it", value: plural(after, "byte"), note: "Past the length the header gives.", group: "Input" });

			const parts: Output[] = [{ kind: "fields", role: "answer", fields: answer }];
			if (findings.length) {
				parts.push({
					kind: "table",
					role: "findings",
					caption: "What to fix, most serious first",
					columns: [{ label: "Severity" }, { label: "What is wrong" }, { label: "What to do" }],
					rows: findings.map((f): Cell[] => [{ text: LEVEL[f.level], ...(f.level !== "normal" ? { tone: f.level } : { tone: "muted" as const }) }, f.problem, f.fix]),
				});
			}
			if (m.attrs.length) {
				parts.push({
					kind: "table",
					role: "decoded",
					caption: `${plural(m.attrs.length, "attribute")}, each padded to 4 bytes`,
					columns: [
						{ label: "Offset", align: "end", mono: true },
						{ label: "Attribute" },
						{ label: "Value", mono: true },
						{ label: "How it was decoded" },
						{ label: "Value bytes", align: "end", mono: true },
					],
					rows: m.attrs.map((a): Cell[] => [
						{ text: hex(a.at, 4), mono: true, tone: "muted" },
						a.name,
						{ text: a.value, mono: true, ...(a.tone ? { tone: a.tone } : {}) },
						a.note ?? "",
						{ text: String(a.len), mono: true, tone: "muted" },
					]),
				});
			}
			if (view !== "fields") {
				/*
				 * No tones on the ranges, except a check that failed: each range gets its own series colour from the host,
				 * which tells neighbours apart, and red is kept for the one range a reader has to look at.
				 */
				const failed = new Set(m.checks.filter((c) => c.result === "fail").map((c) => c.at));
				const highlight: ByteRange[] = [
					{ at: 0, len: 4, label: "Type and length" },
					{ at: 4, len: 4, label: "Magic cookie" },
					{ at: 8, len: 12, label: "Transaction ID" },
					...m.attrs.map((a) => ({ at: a.at, len: 4 + a.len, label: a.name, ...(failed.has(a.at) ? { tone: "bad" as const } : {}) })),
				];
				parts.push({ kind: "bytes", bytes: [...bytes], caption: "The header, then each attribute in place", highlight });
			}
			parts.push({ kind: "fields", role: "method", fields: method });
			return { kind: "group", parts };
		} catch (error) {
			if (error instanceof ParseError) return { kind: "error", message: error.message, input: "message", ...(error.at !== undefined ? { at: error.at, len: error.len ?? 1 } : {}) };
			throw error;
		}
	},
} satisfies Tool<Input>;
