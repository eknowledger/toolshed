/**
 * An SDP explainer: paste an offer or an answer and see every line, what it sets, and which phase of the call reads
 * it: ICE finding the path, DTLS making the keys, RTP and its codec carrying the sound, RTCP reporting on it.
 *
 * Three things a reader cannot easily do by eye, each a place a hand-written description goes wrong:
 *
 *  1. **Group the lines by the phase that reads them.** An SDP is written in RFC 8866's fixed order, which is the
 *     order a parser wants and not the order a call uses it in. The phase table is the model's, and a line it does
 *     not know is "Other": the tool says so rather than guessing, as RFC 8866 tells a parser to ignore what it does
 *     not understand.
 *  2. **Check it against the rules a WebRTC stack applies**, each with the RFC sentence behind it: an error for a
 *     MUST broken, a warning for a SHOULD or a value real stacks accept anyway, a note for a decoded oddity.
 *  3. **Read two descriptions as a pair**: who controls ICE, who sends the DTLS ClientHello, which codec both list.
 *
 * The rules are the reference model's (`tool_reference.py`, beside the post), and the fixtures are its output.
 * Candidate priorities are decoded the way the ICE pair ranker decodes them, and never recomputed: they are what
 * the agent sent.
 *
 * What it deliberately cannot do: check a fingerprint against a certificate. It has no certificate, so it can only
 * say one is present and whether the two sides' differ. The DTLS handshake does the real check.
 */
import type { Cell, Field, Output, Series, Tool, Tone } from "@toolbench/sdk";

type Input = { sdp: string; other: string; show: string };

class InputError extends Error {
	readonly input: string;
	constructor(message: string, input: string) {
		super(message);
		this.input = input;
	}
}

export const PHASES = ["Session", "ICE (path)", "DTLS (keys)", "RTP (streams)", "Codec", "RTCP (feedback)"] as const;
export type Phase = (typeof PHASES)[number] | "Other";
const SHORT: Record<Phase, string> = {
	Session: "Session",
	"ICE (path)": "ICE",
	"DTLS (keys)": "DTLS",
	"RTP (streams)": "RTP",
	Codec: "Codec",
	"RTCP (feedback)": "RTCP",
	Other: "Other",
};

/*
 * Which phase reads each attribute. `c=` is ICE's because it is the default candidate's address, which an ICE agent
 * replaces with the candidates; `a=group` is ICE's because BUNDLE is what lets one path carry every section.
 */
const ATTR_PHASE: Record<string, Phase> = {
	group: "ICE (path)",
	"ice-options": "ICE (path)",
	"ice-ufrag": "ICE (path)",
	"ice-pwd": "ICE (path)",
	"ice-lite": "ICE (path)",
	candidate: "ICE (path)",
	"end-of-candidates": "ICE (path)",
	fingerprint: "DTLS (keys)",
	setup: "DTLS (keys)",
	"tls-id": "DTLS (keys)",
	mid: "RTP (streams)",
	msid: "RTP (streams)",
	"msid-semantic": "RTP (streams)",
	ssrc: "RTP (streams)",
	"ssrc-group": "RTP (streams)",
	extmap: "RTP (streams)",
	"extmap-allow-mixed": "RTP (streams)",
	sendrecv: "RTP (streams)",
	sendonly: "RTP (streams)",
	recvonly: "RTP (streams)",
	inactive: "RTP (streams)",
	rtpmap: "Codec",
	fmtp: "Codec",
	ptime: "Codec",
	maxptime: "Codec",
	rtcp: "RTCP (feedback)",
	"rtcp-mux": "RTCP (feedback)",
	"rtcp-mux-only": "RTCP (feedback)",
	"rtcp-rsize": "RTCP (feedback)",
	"rtcp-fb": "RTCP (feedback)",
};

export function phaseOf(line: string): Phase {
	const head = line.slice(0, 2);
	if (head === "v=" || head === "o=" || head === "s=" || head === "t=") return "Session";
	if (head === "c=") return "ICE (path)";
	if (head === "m=") return "RTP (streams)";
	if (head === "a=") return ATTR_PHASE[line.slice(2).split(":", 1)[0]!] ?? "Other";
	return "Other";
}

const TYPE_PREF: Record<number, string> = { 126: "host", 110: "prflx", 100: "srflx", 0: "relay" };

/** RFC 8445 section 5.1.2.1: priority = 2^24 x type preference + 2^8 x local preference + (256 - component). */
export function decodePriority(p: number) {
	return { type: Math.floor(p / 2 ** 24), local: Math.floor(p / 2 ** 8) % 2 ** 16, component: 256 - (p % 256) };
}

export type Severity = "error" | "warning" | "note";
export interface Problem {
	severity: Severity;
	message: string;
	/** Index into `Model.lines`: the line the problem is about, or the m= line of the section that lacks something. */
	at: number;
}

interface Line {
	/** Its line number in the pasted text, blank lines included, so a reader can find it. */
	n: number;
	text: string;
	phase: Phase;
	what: string;
}

interface Candidate {
	at: number;
	foundation: string;
	component: number;
	transport: string;
	priority: number;
	address: string;
	port: number;
	type: string;
	raddr?: string;
	rport?: string;
}

export interface Model {
	lines: Line[];
	problems: Problem[];
	kind: "offer" | "answer" | "unknown";
	setup: string;
	lite: boolean;
	ufrag: string;
	candidates: Candidate[];
	trickle: string;
	fingerprints: string[];
	media: string[];
	codecs: string[];
	bundle: string[] | null;
	rtcpMux: boolean;
	counts: Record<Phase, number>;
}

const ICE_CHAR = /^[A-Za-z0-9+/]+$/;
const KIND_OF_SETUP: Record<string, Model["kind"]> = { actpass: "offer", active: "answer", passive: "answer" };
const ROLE: Record<string, string> = {
	actpass: "either; the answerer chooses",
	active: "DTLS client: sends the ClientHello",
	passive: "DTLS server: waits for the ClientHello",
};

/** Every `a=<name>` or `a=<name>:<value>` in a block of line indices, with where it is. */
function attrs(lines: string[], block: number[], name: string): { value: string; at: number }[] {
	const out: { value: string; at: number }[] = [];
	for (const i of block) {
		const x = lines[i]!;
		if (x === `a=${name}`) out.push({ value: "", at: i });
		else if (x.startsWith(`a=${name}:`)) out.push({ value: x.slice(name.length + 3), at: i });
	}
	return out;
}

function parseCandidate(value: string, at: number): Candidate | null {
	const f = value.split(/\s+/);
	if (f.length < 8 || f[6] !== "typ" || !/^\d+$/.test(f[1]!) || !/^\d+$/.test(f[3]!) || !/^\d+$/.test(f[5]!)) return null;
	const raddr = f.indexOf("raddr");
	const rport = f.indexOf("rport");
	return {
		at,
		foundation: f[0]!,
		component: Number(f[1]),
		transport: f[2]!,
		priority: Number(f[3]),
		address: f[4]!,
		port: Number(f[5]),
		type: f[7]!,
		...(raddr > 7 && f[raddr + 1] ? { raddr: f[raddr + 1] } : {}),
		...(rport > 7 && f[rport + 1] ? { rport: f[rport + 1] } : {}),
	};
}

/**
 * Reads one description. Exported for the tests, which check its properties over every sample.
 *
 * Lines are trimmed and blank ones dropped, so CRLF, LF and a description copied with an RFC's indentation all
 * read the same.
 */
export function explain(text: string, input = "sdp"): Model {
	const numbered: { n: number; text: string }[] = [];
	text.split(/\r?\n/).forEach((raw, i) => {
		const t = raw.trim();
		if (t) numbered.push({ n: i + 1, text: t });
	});
	const lines = numbered.map((l) => l.text);
	if (lines[0] !== "v=0") throw new InputError("Not SDP: the first line must be v=0 (RFC 8866 section 5.1)", input);

	const sessionBlock: number[] = [];
	const mediaBlocks: number[][] = [];
	lines.forEach((x, i) => {
		if (x.startsWith("m=")) mediaBlocks.push([]);
		(mediaBlocks.at(-1) ?? sessionBlock).push(i);
	});
	const problems: Problem[] = [];
	const add = (severity: Severity, message: string, at: number) => problems.push({ severity, message, at });
	const anyAttr = (block: number[], name: string) => {
		const own = attrs(lines, block, name);
		return own.length ? own : attrs(lines, sessionBlock, name);
	};

	const liteAt = attrs(lines, sessionBlock, "ice-lite");
	const lite = liteAt.length > 0;
	for (const m of mediaBlocks) for (const a of attrs(lines, m, "ice-lite")) add("error", "a=ice-lite is session-level only (RFC 8839 section 5.3)", a.at);
	const setups = mediaBlocks.flatMap((m) => anyAttr(m, "setup"));
	const setup = setups[0]?.value ?? "";
	const kind = KIND_OF_SETUP[setup] ?? "unknown";

	const candidates: Candidate[] = [];
	const mids: string[] = [];
	const media: string[] = [];
	const codecs: string[] = [];
	const fingerprints: string[] = [];
	let rtcpMux = mediaBlocks.length > 0;
	mediaBlocks.forEach((m, k) => {
		const i = k + 1;
		const mAt = m[0]!;
		const mline = lines[mAt]!.slice(2).split(/\s+/);
		const port = Number(mline[1]);
		const proto = mline[2] ?? "";
		if (mline.length < 4 || !/^\d+$/.test(mline[1] ?? "")) {
			add("error", `m= section ${i}: the m= line is not <media> <port> <proto> <fmt> (RFC 8866 section 5.14)`, mAt);
		}
		if (proto !== "UDP/TLS/RTP/SAVPF") add("error", `m= section ${i}: proto ${proto}, not UDP/TLS/RTP/SAVPF (RFC 9429 section 5.1.2)`, mAt);
		const cLines = m.filter((j) => lines[j]!.startsWith("c="));
		const c = cLines.length ? cLines : sessionBlock.filter((j) => lines[j]!.startsWith("c="));
		const cAddr = c.length ? (lines[c[0]!]!.split(/\s+/)[2] ?? "") : "";
		if (!c.length) add("error", `m= section ${i}: no c= line (RFC 8866 section 5.7)`, mAt);
		const mid = attrs(lines, m, "mid");
		mids.push(...mid.map((x) => x.value));
		media.push(`${mline[0]} mid ${mid[0]?.value ?? "?"}`);
		if (!mid.length) add("error", `m= section ${i}: no a=mid (RFC 9429 section 5.2.1)`, mAt);

		const ufrag = anyAttr(m, "ice-ufrag")[0];
		const pwd = anyAttr(m, "ice-pwd")[0];
		for (const [name, a, min] of [["ice-ufrag", ufrag, 4], ["ice-pwd", pwd, 22]] as const) {
			const len = a?.value.length ?? 0;
			if (len < min) add("error", `m= section ${i}: ${name} is ${len} characters, at least ${min} (RFC 8839 section 5.4)`, a?.at ?? mAt);
			else if (len > 256) add("error", `m= section ${i}: ${name} is ${len} characters, at most 256 (RFC 8839 section 5.4)`, a?.at ?? mAt);
		}
		for (const [name, a] of [["ice-ufrag", ufrag], ["ice-pwd", pwd]] as const) {
			if (a?.value && !ICE_CHAR.test(a.value)) {
				const bad = [...new Set(a.value.replace(/[A-Za-z0-9+/]/g, ""))].sort();
				add("warning", `m= section ${i}: ${name} has ${bad.map((b) => `'${b}'`).join(" ")}, not an ice-char (RFC 8839 section 5.1)`, a.at);
			}
		}
		const fp = anyAttr(m, "fingerprint");
		fingerprints.push(...fp.map((x) => x.value));
		if (!fp.length) add("error", `m= section ${i}: no a=fingerprint, so negotiation fails (RFC 9429 section 5.1.2)`, mAt);
		if (!anyAttr(m, "tls-id").length) add("warning", `m= section ${i}: no a=tls-id (RFC 8842 sections 5.2 and 5.3)`, mAt);
		if (!attrs(lines, m, "rtcp-mux").length) {
			rtcpMux = false;
			add("error", `m= section ${i}: no a=rtcp-mux (RFC 5761; RFC 8834 section 4.5)`, mAt);
		}
		for (const r of attrs(lines, m, "rtpmap")) {
			const [pt, enc] = r.value.split(/\s+/, 2);
			if (!pt || !enc) {
				add("error", `a=rtpmap is not <payload type> <encoding>/<clock rate> (RFC 8866 section 6.6)`, r.at);
				continue;
			}
			codecs.push(`${enc} pt ${pt}`);
			if (enc.toLowerCase().startsWith("opus/") && enc.toLowerCase() !== "opus/48000/2") {
				add("error", `opus must be opus/48000/2 (RFC 7587 section 7), not ${enc}`, r.at);
			}
		}
		const cands: Candidate[] = [];
		for (const a of attrs(lines, m, "candidate")) {
			const cand = parseCandidate(a.value, a.at);
			if (!cand) {
				add("error", "a=candidate is not <foundation> <component> <transport> <priority> <address> <port> typ <type> (RFC 8839 section 5.1)", a.at);
				continue;
			}
			cands.push(cand);
			const d = decodePriority(cand.priority);
			if (TYPE_PREF[d.type] !== cand.type || d.component !== cand.component) {
				add(
					"note",
					`candidate ${cand.foundation} (${cand.type}): priority ${cand.priority} decodes to type preference ${d.type}, local preference ${d.local}, component ${d.component}; not RFC 8445's recommended values for ${cand.type}`,
					a.at,
				);
			}
			if (cand.type !== "host" && !(cand.raddr && cand.rport)) add("error", `candidate ${cand.foundation} (${cand.type}) has no raddr/rport (RFC 8839 section 5.1)`, a.at);
		}
		candidates.push(...cands);
		if (cands.length && c.length && !cands.some((x) => x.address === cAddr && x.port === port)) {
			add("warning", `m= section ${i}: m= port and c= address match no candidate (RFC 8839 section 4.2.1.2)`, mAt);
		}
		if (!cands.length && c.length && !(port === 9 && cAddr === "0.0.0.0")) {
			add("warning", `m= section ${i}: no candidates, so port 9 and IN IP4 0.0.0.0 expected (RFC 9429 section 5.2.1)`, mAt);
		}
		const notHost = cands.find((x) => x.type !== "host");
		if (lite && notHost) add("error", "ICE-lite agents only use host candidates (RFC 8445 section 2.5)", notHost.at);
	});
	const groups = sessionBlock.filter((j) => lines[j]!.startsWith("a=group:BUNDLE"));
	for (const g of groups) {
		for (const mid of lines[g]!.split(/\s+/).slice(1)) {
			if (!mids.includes(mid)) add("error", `BUNDLE names mid ${mid}, which no m= section has (RFC 9143)`, g);
		}
	}
	if (kind === "offer" && lite) add("note", "a=ice-lite in an offer: a JSEP endpoint never sends this (RFC 9429 section 5.2.1)", liteAt[0]!.at);

	const ctx = { kind, setup, lite };
	const described = numbered.map((l) => ({ ...l, phase: phaseOf(l.text), what: describe(l.text, ctx) }));
	const counts = Object.fromEntries([...PHASES, "Other"].map((p) => [p, 0])) as Record<Phase, number>;
	for (const l of described) counts[l.phase]++;
	const hasEnd = mediaBlocks.some((m) => attrs(lines, m, "end-of-candidates").length > 0);
	const firstUfrag = mediaBlocks[0] ? anyAttr(mediaBlocks[0], "ice-ufrag")[0] : attrs(lines, sessionBlock, "ice-ufrag")[0];
	const bundle = groups.length ? lines[groups[0]!]!.split(/\s+/).slice(1) : null;
	return {
		lines: described,
		problems,
		kind,
		setup,
		lite,
		ufrag: firstUfrag?.value ?? "",
		candidates,
		trickle: hasEnd ? "complete (a=end-of-candidates)" : candidates.length ? "more may trickle" : "none yet",
		fingerprints,
		media,
		codecs,
		bundle,
		rtcpMux,
		counts,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// What each line sets. One plain sentence each, and only for what the model knows: an attribute it does not know is
// said to be unknown rather than given a plausible meaning.
// ---------------------------------------------------------------------------------------------------------------

const UNKNOWN = "Not a line this explainer knows, so it does not guess; an SDP parser ignores attributes it does not understand (RFC 8866 section 5).";

const EXTENSIONS: Record<string, string> = {
	"urn:ietf:params:rtp-hdrext:ssrc-audio-level": "the sender's audio level (RFC 6464), which SRTP authenticates but does not encrypt, so it is readable on the path",
	"urn:ietf:params:rtp-hdrext:csrc-audio-level": "the level of each voice a mixer mixed (RFC 6465), authenticated by SRTP but not encrypted",
	"urn:ietf:params:rtp-hdrext:sdes:mid": "the section's mid, so a receiver can tell which m= section a packet belongs to on a bundled port (RFC 9143)",
	"urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id": "the RtpStreamId, which names one encoding of a simulcast source (RFC 8852)",
	"urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id": "the RtpStreamId of the stream a repair stream repairs (RFC 8852)",
	"urn:ietf:params:rtp-hdrext:toffset": "the transmission time offset, how late a packet left after its timestamp (RFC 5450)",
};

const CODECS: Record<string, string> = {
	pcmu: "G.711 mu-law",
	pcma: "G.711 A-law",
	g722: "G.722",
	"telephone-event": "DTMF digits and other telephony events, sent as events rather than sound (RFC 4733)",
	cn: "comfort noise (RFC 3389)",
	red: "redundant audio (RFC 2198)",
	rtx: "retransmission of lost packets (RFC 4588)",
	ulpfec: "forward error correction (RFC 5109)",
	vp8: "VP8 video (RFC 7741)",
	vp9: "VP9 video",
	h264: "H.264 video (RFC 6184)",
	h265: "H.265 video (RFC 7798)",
	av1: "AV1 video",
};

const FMTP: Record<string, (v: string) => string> = {
	minptime: (v) => `minptime=${v}, at least ${v} ms of audio a packet, a parameter RFC 7587 does not define`,
	useinbandfec: (v) => (v === "1" ? "useinbandfec=1, the decoder can use Opus's in-band FEC (RFC 7587)" : `useinbandfec=${v} (RFC 7587)`),
	usedtx: (v) => `usedtx=${v}, whether the decoder prefers silence to be sent as DTX (RFC 7587)`,
	stereo: (v) => `stereo=${v}, ${v === "1" ? "the decoder prefers stereo" : "the decoder prefers mono"} (RFC 7587)`,
	"sprop-stereo": (v) => `sprop-stereo=${v}, whether the sender is likely to send stereo (RFC 7587)`,
	cbr: (v) => `cbr=${v}, whether the decoder prefers a constant bitrate (RFC 7587)`,
	maxaveragebitrate: (v) => `maxaveragebitrate=${v}, the most the receiver wants on average, in b/s (RFC 7587)`,
	maxplaybackrate: (v) => `maxplaybackrate=${v}, a hint at the receiver's highest output sample rate (RFC 7587)`,
	apt: (v) => `apt=${v}, it retransmits payload type ${v} (RFC 4588)`,
	"packetization-mode": (v) => `packetization-mode=${v} (RFC 6184)`,
	"profile-level-id": (v) => `profile-level-id=${v} (RFC 6184)`,
	"level-asymmetry-allowed": (v) => `level-asymmetry-allowed=${v} (RFC 6184)`,
};

const FEEDBACK: Record<string, string> = {
	nack: "generic NACK, asking for lost packets again (RFC 4585)",
	"nack pli": "picture loss indication, asking for a new picture (RFC 4585)",
	"nack sli": "slice loss indication (RFC 4585)",
	"nack rpsi": "reference picture selection indication (RFC 4585)",
	"ccm fir": "full intra request, asking for a key frame (RFC 5104)",
	"ccm tmmbr": "a temporary maximum bitrate request (RFC 5104)",
	"transport-cc": "transport-wide congestion control feedback, from an IETF draft rather than an RFC",
	"goog-remb": "Google's REMB bandwidth estimate, from an IETF draft rather than an RFC",
};

const DIRECTION: Record<string, string> = {
	sendrecv: "This side sends and receives media in this section (RFC 8866 section 6.7).",
	sendonly: "This side only sends media in this section (RFC 8866 section 6.7).",
	recvonly: "This side only receives media in this section (RFC 8866 section 6.7).",
	inactive: "This side neither sends nor receives media in this section (RFC 8866 section 6.7).",
};

const CAND_NAME: Record<string, string> = { host: "Host", srflx: "Server-reflexive", prflx: "Peer-reflexive", relay: "Relayed" };

function describeCandidate(value: string): string {
	const c = parseCandidate(value, 0);
	if (!c) return "A candidate line that does not parse, so its address cannot be read (RFC 8839 section 5.1).";
	const d = decodePriority(c.priority);
	const comp = c.component === 1 ? "for RTP" : c.component === 2 ? "for RTCP" : `for component ${c.component}`;
	const related = c.raddr && c.rport ? `${c.raddr}:${c.rport}` : "";
	const how =
		c.type === "srflx" && related
			? `, the NAT's mapping of ${related}`
			: c.type === "relay"
				? `, an address on a TURN server${related ? ` that saw this side as ${related}` : ""}`
				: c.type === "prflx"
					? ", learned from a connectivity check"
					: "";
	return `${CAND_NAME[c.type] ?? `A "${c.type}"`} candidate ${c.address}:${c.port} over ${c.transport.toUpperCase()} ${comp}${how}; priority ${c.priority} is type preference ${d.type}, local preference ${d.local}, component ${d.component} (RFC 8445 section 5.1.2).`;
}

function describe(line: string, ctx: { kind: Model["kind"]; setup: string; lite: boolean }): string {
	const type = line.slice(0, 2);
	const value = line.slice(2);
	const f = value.split(/\s+/);
	switch (type) {
		case "v=":
			return "The SDP version; 0 is the only one there is (RFC 8866 section 5.1).";
		case "o=": {
			const addr = f[5] === "0.0.0.0" ? "; its address, 0.0.0.0, is a placeholder so no local IP leaks (RFC 9429 section 5.2.1)" : `, from ${f[5]}`;
			return `The origin: session id ${f[1]} and version ${f[2]}, which goes up whenever the description changes (RFC 8866 section 5.2)${addr}.`;
		}
		case "s=":
			return value === "-" || value === "" ? "The session name; a dash means it has none (RFC 8866 section 5.3)." : `The session name, "${value}" (RFC 8866 section 5.3).`;
		case "t=":
			return value === "0 0" ? "When the session is active; 0 0 means it is unbounded and permanent (RFC 8866 section 5.9)." : `When the session is active: ${value}, as NTP seconds (RFC 8866 section 5.9).`;
		case "c=":
			return f[2] === "0.0.0.0"
				? "The connection address, 0.0.0.0: a placeholder, since no candidate is known yet (RFC 9429 section 5.2.1)."
				: `The connection address, ${f[2]}, the default candidate's; an ICE agent uses the candidates instead (RFC 8839 section 4.2.1.2).`;
		case "m=": {
			const port = f[1] === "9" ? "port 9, the placeholder before any candidate is known" : f[1] === "0" ? "port 0, so it is rejected, or bundle-only and carried on another section's port" : `port ${f[1]}`;
			const proto =
				f[2] === "UDP/TLS/RTP/SAVPF"
					? "UDP/TLS/RTP/SAVPF, which is RTP with feedback, protected by SRTP whose keys come from DTLS, over UDP"
					: `profile ${f[2]}`;
			const fmts = f.slice(3);
			return `Starts ${/^[aeiou]/.test(f[0] ?? "") ? "an" : "a"} ${f[0]} section on ${port}, ${proto}, offering payload type${fmts.length === 1 ? "" : "s"} ${fmts.join(", ")} (RFC 8866 section 5.14).`;
		}
		case "b=":
			return `A bandwidth limit, ${value}; none of the six phases owns it (RFC 8866 section 5.8).`;
		case "i=":
			return "A free-text title (RFC 8866 section 5.4); nothing in the call reads it.";
	}
	if (type !== "a=") return UNKNOWN;
	const colon = value.indexOf(":");
	const name = colon < 0 ? value : value.slice(0, colon);
	const v = colon < 0 ? "" : value.slice(colon + 1);
	const vf = v.split(/\s+/);
	switch (name) {
		case "group":
			if (vf[0] === "BUNDLE")
				return `Bundles the sections with mid ${vf.slice(1).join(", ")} onto one transport, so one ICE path and one DTLS handshake serve them all (RFC 9143).`;
			if (vf[0] === "LS") return `Lip sync: the sections with mid ${vf.slice(1).join(", ")} are played in sync (RFC 5888).`;
			return `Groups the sections with mid ${vf.slice(1).join(", ")} under the semantics "${vf[0]}" (RFC 5888).`;
		case "ice-options": {
			const known: Record<string, string> = {
				trickle: "trickle, so candidates may follow the description (RFC 8840)",
				ice2: "ice2, the ICE of RFC 8445 rather than the older RFC 5245 (RFC 8445 section 10)",
			};
			return `ICE options: ${vf.map((o) => known[o] ?? `${o}, which this explainer does not know`).join("; ")}.`;
		}
		case "ice-ufrag":
			return `The ICE username fragment, ${v}; checks sent to this side carry it first in their STUN USERNAME (RFC 8445 section 7.2.2).`;
		case "ice-pwd":
			return `The ICE password, ${v.length} characters; checks sent to this side are signed with it, in MESSAGE-INTEGRITY (RFC 8445 section 7.2.2).`;
		case "ice-lite":
			return "This side is ICE-lite: it has only host candidates and answers checks without sending any, so a full agent on the other side controls (RFC 8445 sections 2.5 and 6.1.1).";
		case "candidate":
			return describeCandidate(v);
		case "end-of-candidates":
			return "No more candidates will trickle for this section (RFC 8840 section 8).";
		case "fingerprint":
			return `The ${vf[0]} hash of the certificate this side will present in the DTLS handshake, which the other side must match or end the call; a hash, not a key (RFC 5763 section 5).`;
		case "setup":
			if (v === "actpass") return "DTLS role: either; the answerer picks, and SHOULD pick active, so the offerer usually waits for a ClientHello (RFC 9429 section 5.3.1).";
			if (v === "active") return "DTLS role: client, so this side sends the ClientHello (RFC 5763 section 5).";
			if (v === "passive") return "DTLS role: server, so this side waits for the other side's ClientHello (RFC 5763 section 5).";
			return `DTLS role "${v}", which is not one of actpass, active and passive (RFC 5763 section 5).`;
		case "tls-id":
			return "This side's half of the name of the DTLS association; the two sides' tls-id values together identify it, and a new value means a new handshake (RFC 8842 section 4).";
		case "mid":
			return `Names this section "${v}"; BUNDLE lists it, and the mid header extension stamps it on packets so a receiver can tell sections apart on one port (RFC 9143).`;
		case "msid":
			return vf[1]
				? `Ties this section to media stream ${vf[0]}, track ${vf[1]}, the ids the other side's WebRTC API sees (RFC 8830).`
				: `Ties this section to media stream ${vf[0]}, the id the other side's WebRTC API sees (RFC 8830).`;
		case "msid-semantic":
			return "Announces WebRTC media stream ids; it comes from early drafts of msid, and RFC 8830 removed that mechanism, so nothing needs it.";
		case "ssrc": {
			const [ssrc, ...rest] = vf;
			const attr = rest.join(" ");
			const ai = attr.indexOf(":");
			const aname = ai < 0 ? attr : attr.slice(0, ai);
			const aval = ai < 0 ? "" : attr.slice(ai + 1);
			return aname === "cname"
				? `SSRC ${ssrc}, the id in every RTP packet of this stream, with canonical name ${aval} (RFC 5576).`
				: `SSRC ${ssrc}'s "${aname}"${aval ? ` is ${aval}` : ""} (RFC 5576).`;
		}
		case "ssrc-group":
			return vf[0] === "FID"
				? `Pairs SSRC ${vf[1]} with ${vf.slice(2).join(", ")}, its retransmission stream (RFC 5576, RFC 4588).`
				: `Groups SSRCs ${vf.slice(1).join(", ")} under the semantics "${vf[0]}" (RFC 5576).`;
		case "extmap": {
			const id = vf[0] ?? "";
			const uri = vf[1] ?? "";
			const known = EXTENSIONS[uri];
			return known
				? `Header extension ${id} (RFC 8285) carries ${known}.`
				: `Maps header extension ${id} to ${uri}, which this explainer does not know (RFC 8285).`;
		}
		case "extmap-allow-mixed":
			return "One-byte and two-byte header extensions may be mixed in one stream (RFC 8285 section 6).";
		case "sendrecv":
		case "sendonly":
		case "recvonly":
		case "inactive":
			return DIRECTION[name]!;
		case "rtpmap": {
			const [pt, enc] = vf;
			if (!pt || !enc) return "An rtpmap that does not parse (RFC 8866 section 6.6).";
			const [codec, rate, channels] = enc.split("/");
			const lower = (codec ?? "").toLowerCase();
			if (lower === "opus")
				return `Payload type ${pt} is Opus at a ${rate} Hz RTP clock; the /${channels ?? ""} is required for every Opus session and does not mean stereo (RFC 7587 section 7).`;
			const what = CODECS[lower] ?? `${codec}, a codec this explainer does not describe (RFC 8866 section 6.6)`;
			return `Payload type ${pt} is ${what}, with an RTP clock of ${rate} Hz${channels ? ` and ${channels} channels` : ""}.`;
		}
		case "fmtp": {
			const [pt, ...rest] = vf;
			const params = rest.join(" ");
			if (/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(params))
				return `Payload type ${pt} carries events ${params}${params === "0-15" ? ", the 16 DTMF keys" : ""} (RFC 4733).`;
			const parts = params
				.split(";")
				.map((p) => p.trim())
				.filter(Boolean)
				.map((p) => {
					const [k, val = ""] = p.split("=");
					return FMTP[k ?? ""]?.(val) ?? `${p}, which this explainer does not describe`;
				});
			return `Format parameters for payload type ${pt}: ${parts.join("; ")}.`;
		}
		case "ptime":
			return `${v} ms of media in each packet (RFC 8866 section 6.4).`;
		case "maxptime":
			return `At most ${v} ms of media in each packet (RFC 8866 section 6.5).`;
		case "rtcp":
			return vf[0] === "9" && vf[3] === "0.0.0.0"
				? "Where RTCP would go without rtcp-mux: port 9 and 0.0.0.0, placeholders, since no candidate is known (RFC 3605; RFC 9429 section 5.2.1)."
				: `Where RTCP goes if the other side does not multiplex it: port ${vf[0]}${vf[3] ? ` at ${vf[3]}` : ""} (RFC 3605).`;
		case "rtcp-mux":
			return ctx.kind === "answer"
				? "Agrees to send RTCP on the RTP port, so one ICE path and one NAT binding carry both (RFC 5761)."
				: "Asks to send RTCP on the RTP port, so one ICE path and one NAT binding carry both (RFC 5761).";
		case "rtcp-mux-only":
			return "This side will only send RTCP on the RTP port, with no separate RTCP port to fall back to (RFC 8858).";
		case "rtcp-rsize":
			return "This side can use reduced-size RTCP, packets that need not be full compound reports (RFC 5506).";
		case "rtcp-fb": {
			const [pt, ...rest] = vf;
			const fb = rest.join(" ");
			const what = FEEDBACK[fb] || `${fb}, a feedback type this explainer does not describe`;
			return `Feedback for ${pt === "*" ? "every payload type" : `payload type ${pt}`}: ${what}.`;
		}
	}
	return UNKNOWN;
}

// ---------------------------------------------------------------------------------------------------------------
// Output.
// ---------------------------------------------------------------------------------------------------------------

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const MAX_LINE = 72;
const SRTP_POINT = "SRTP has no line: its keys come from DTLS, and the only trace in the SDP is the profile name UDP/TLS/RTP/SAVPF and the fingerprint.";

function problemCounts(problems: Problem[]) {
	const n = (s: Severity) => problems.filter((p) => p.severity === s).length;
	return { errors: n("error"), warnings: n("warning"), notes: n("note") };
}

function summary(m: Model): Field[] {
	const byType = new Map<string, number>();
	for (const c of m.candidates) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
	const types = [...byType].sort(([a], [b]) => (a < b ? -1 : 1));
	const algs = [...new Set(m.fingerprints.map((f) => f.split(/\s+/)[0]!))].sort();
	const p = problemCounts(m.problems);
	const tone: Tone = p.errors ? "bad" : p.warnings ? "warn" : "good";
	const phaseNote = [...PHASES, "Other" as const]
		.filter((ph) => m.counts[ph] > 0)
		.map((ph) => `${SHORT[ph]} ${m.counts[ph]}`)
		.join(", ");
	return [
		{ label: "Type", value: m.kind + (m.setup ? ` (a=setup:${m.setup})` : ""), note: "from a=setup: actpass is an offer, active or passive an answer" },
		{ label: "ICE", value: `${m.lite ? "lite" : "full"}, ufrag ${m.ufrag}` },
		{ label: "Candidates", value: `${types.map(([t, n]) => `${n} ${t}`).join(", ") || "0"}; ${m.trickle}` },
		{ label: "DTLS role", value: ROLE[m.setup] ?? "not stated" },
		{
			label: "Fingerprints",
			value: m.fingerprints.length ? `${m.fingerprints.length}: ${algs.join(", ")}` : "0: none",
			note: "present or not; only the DTLS handshake can check one against the certificate",
		},
		{ label: "Media", value: m.media.join("; ") || "none" },
		{ label: "Codecs", value: m.codecs.join(", ") || "none", note: plural(m.codecs.length, "payload type") },
		{ label: "Lines", value: String(m.lines.length), note: phaseNote },
		{ label: "Problems", value: `${plural(p.errors, "error")}, ${plural(p.warnings, "warning")}, ${plural(p.notes, "note")}`, tone },
		{ label: "SRTP", value: "no line of its own", note: "its keys come from DTLS; the only trace is the profile UDP/TLS/RTP/SAVPF and the fingerprint" },
	];
}

/** The pair readout: what two descriptions settle between them, by the rules in RFC 8445, RFC 5763 and RFC 9429. */
function pair(a: Model, b: Model): Field[] {
	const group = "Pair";
	const out: Field[] = [];
	const offerer = a.kind === "offer" && b.kind === "answer" ? "a" : b.kind === "offer" && a.kind === "answer" ? "b" : null;
	const who = (s: "a" | "b") => (s === "a" ? "this side" : "the other side");
	out.push(
		offerer === "a"
			? { group, label: "Offer and answer", value: "this SDP offers, the other answers", tone: "good" }
			: offerer === "b"
				? { group, label: "Offer and answer", value: "the other side offers, this SDP answers", tone: "good" }
				: a.kind === "offer" && b.kind === "offer"
					? { group, label: "Offer and answer", value: "both are offers (a=setup:actpass twice)", tone: "bad", note: "an answer must say active or passive (RFC 9429 section 5.3.1)" }
					: a.kind === "answer" && b.kind === "answer"
						? { group, label: "Offer and answer", value: "both are answers", tone: "bad" }
						: { group, label: "Offer and answer", value: "not settled: a side has no a=setup", tone: "bad" },
	);

	if (a.lite !== b.lite) {
		const full = a.lite ? "b" : "a";
		out.push({ group, label: "ICE roles", value: `${who(full)} controls`, note: "full against lite: the full agent controls (RFC 8445 section 6.1.1)", tone: "good" });
	} else {
		const both = a.lite ? "both lite" : "both full";
		out.push(
			offerer
				? { group, label: "ICE roles", value: `${who(offerer)} controls`, note: `${both}: the offerer controls (RFC 8445 section 6.1.1)`, tone: "good" }
				: { group, label: "ICE roles", value: "not settled", note: `${both}: the offerer controls, and neither is the one offer (RFC 8445 section 6.1.1)`, tone: "bad" },
		);
	}

	const sa = a.setup;
	const sb = b.setup;
	let hello: Field;
	if (sa === "actpass" && sb === "actpass") {
		hello = { group, label: "ClientHello sent by", value: "not settled: both are offers (actpass twice), so no DTLS role can be settled", tone: "bad" };
	} else if (sb === "active" && (sa === "actpass" || sa === "passive")) {
		hello = { group, label: "ClientHello sent by", value: "the other side (a=setup:active)", tone: "good" };
	} else if (sa === "active" && (sb === "actpass" || sb === "passive")) {
		hello = { group, label: "ClientHello sent by", value: "this side (a=setup:active)", tone: "good" };
	} else if (sb === "passive" && sa === "actpass") {
		hello = { group, label: "ClientHello sent by", value: "this side (actpass against passive)", tone: "good" };
	} else if (sa === "passive" && sb === "actpass") {
		hello = { group, label: "ClientHello sent by", value: "the other side (actpass against passive)", tone: "good" };
	} else {
		hello = { group, label: "ClientHello sent by", value: `not settled: a=setup:${sa || "none"} against a=setup:${sb || "none"}`, tone: "bad" };
	}
	hello.note = "the side whose a=setup resolves to active (RFC 5763 section 5)";
	out.push(hello);

	const theirs = new Set(b.codecs.map((c) => c.toLowerCase()));
	const agreed = a.codecs.filter((c) => theirs.has(c.toLowerCase()));
	out.push(
		agreed.length
			? { group, label: "Codec agreed", value: agreed.join(", "), note: "payload type and encoding both list", tone: "good" }
			: { group, label: "Codec agreed", value: "none in common", note: "no payload type with the same encoding on both sides", tone: "bad" },
	);

	const ba = a.bundle?.join(" ");
	const bb = b.bundle?.join(" ");
	out.push(
		ba !== undefined && ba === bb
			? { group, label: "BUNDLE", value: `mid ${ba}, on both`, tone: "good" }
			: ba === undefined && bb === undefined
				? { group, label: "BUNDLE", value: "neither side bundles", tone: "warn" }
				: { group, label: "BUNDLE", value: `this side ${ba ?? "none"}, the other ${bb ?? "none"}`, note: "the same mids should be grouped on both sides (RFC 9143)", tone: "warn" },
	);

	out.push(
		a.rtcpMux && b.rtcpMux
			? { group, label: "rtcp-mux", value: "on both", tone: "good" }
			: { group, label: "rtcp-mux", value: `missing on ${a.rtcpMux ? "the other side" : b.rtcpMux ? "this side" : "both"}`, note: "RFC 8834 section 4.5", tone: "bad" },
	);

	const fa = new Set(a.fingerprints.map((f) => f.toUpperCase()));
	const shared = b.fingerprints.some((f) => fa.has(f.toUpperCase()));
	out.push(
		!a.fingerprints.length || !b.fingerprints.length
			? { group, label: "Fingerprints", value: `missing on ${a.fingerprints.length ? "the other side" : b.fingerprints.length ? "this side" : "both"}`, tone: "bad" }
			: shared
				? { group, label: "Fingerprints", value: "present on both, the same certificate", note: "two peers with one certificate, or one SDP pasted twice", tone: "warn" }
				: { group, label: "Fingerprints", value: "present on both, different certificates", note: "only the DTLS handshake can check either against its certificate", tone: "good" },
	);
	return out;
}

function lineTable(m: Model, key: string, onlyProblems: boolean, caption: string): Output | null {
	const byLine = new Map<number, Problem[]>();
	for (const p of m.problems) byLine.set(p.at, [...(byLine.get(p.at) ?? []), p]);
	const rows: Cell[][] = [];
	let cut = false;
	m.lines.forEach((l, i) => {
		const ps = byLine.get(i) ?? [];
		if (onlyProblems && !ps.length) return;
		const tone: Tone = ps.some((p) => p.severity === "error") ? "bad" : ps.some((p) => p.severity === "warning") ? "warn" : "normal";
		if (l.text.length > MAX_LINE) cut = true;
		rows.push([
			{ text: String(l.n), mono: true },
			{ text: l.text.length > MAX_LINE ? `${l.text.slice(0, MAX_LINE - 1)}…` : l.text, mono: true },
			l.what,
			l.phase,
			ps.length ? { text: ps.map((p) => `${p.severity}: ${p.message}`).join("; "), tone } : "ok",
		]);
	});
	if (!rows.length) return null;
	return {
		kind: "table",
		caption: `${caption}${cut ? ` Lines over ${MAX_LINE} characters are cut here; the input has them whole.` : ""}`,
		columns: [{ label: "#", align: "end", mono: true }, { label: "Line", mono: true }, { label: "What it sets" }, { label: "Read by" }, { label: "Check" }],
		rows,
		link: { chart: "phases", keys: rows.map(() => key) },
	};
}

const SEVERITY_TONE: Record<Severity, Tone> = { error: "bad", warning: "warn", note: "normal" };

export default {
	run(input: Input) {
		try {
			const a = explain(input.sdp ?? "", "sdp");
			const b = (input.other ?? "").trim() ? explain(input.other, "other") : null;
			const onlyProblems = input.show === "problems";
			const keyA = `This SDP${a.kind === "unknown" ? "" : ` (${a.kind})`}`;
			const keyB = b ? `The other side${b.kind === "unknown" ? "" : ` (${b.kind})`}` : "";
			const sides = b ? [a, b] : [a];
			const x = b ? [keyA, keyB] : [keyA];

			const phases = [...PHASES, ...(sides.some((s) => s.counts.Other > 0) ? (["Other"] as const) : [])];
			const series: Series[] = phases.map((p) => ({ label: p, unit: "lines", shape: "bar", stack: "phase", points: sides.map((s) => s.counts[p]) }));

			const problemRows: Cell[][] = [];
			for (const [m, where] of b ? ([[a, "this SDP"], [b, "the other side"]] as const) : ([[a, ""]] as const)) {
				for (const p of m.problems) {
					problemRows.push([{ text: p.severity, tone: SEVERITY_TONE[p.severity] }, `${where ? `${where}, ` : ""}line ${m.lines[p.at]!.n}`, p.message]);
				}
			}

			const parts: Output[] = [{ kind: "fields", fields: summary(a) }];
			if (b) parts.push({ kind: "fields", fields: pair(a, b) });
			parts.push({
				kind: "series",
				chart: {
					id: "phases",
					xLabel: "SDP",
					yLabel: "Lines",
					orientation: "horizontal",
					x,
					series,
				},
			});
			if (problemRows.length) {
				parts.push({
					kind: "table",
					caption: "Problems: an error is a MUST broken, a warning a SHOULD or a value real stacks accept anyway, a note a decoded oddity",
					columns: [{ label: "Severity" }, { label: "Where" }, { label: "Problem" }],
					rows: problemRows,
				});
			}
			const what = onlyProblems ? "The lines with a problem" : "Every line";
			const tableA = lineTable(a, keyA, onlyProblems, `${what} of this SDP, and the phase that reads it. ${SRTP_POINT}`);
			if (tableA) parts.push(tableA);
			const tableB = b ? lineTable(b, keyB, onlyProblems, `${what} of the other side's SDP.`) : null;
			if (tableB) parts.push(tableB);
			return { kind: "group", parts };
		} catch (error) {
			if (error instanceof InputError) return { kind: "error", message: error.message, input: error.input };
			throw error;
		}
	},
} satisfies Tool<Input>;
