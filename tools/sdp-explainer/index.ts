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
 * The fixtures were first the output of a reference model written beside the post; the rules have moved on since
 * (simulcast, data channels, bundle-only sections, and the tls-id rule real stacks ignore), each with its own
 * fixture and test. Candidate priorities are decoded the way the ICE pair ranker decodes them, and never recomputed: they are what
 * the agent sent.
 *
 * What it deliberately cannot do: check a fingerprint against a certificate. It has no certificate, so it can only
 * say one is present and whether the two sides' differ. The DTLS handshake does the real check.
 */
import type { Cell, Field, Output, TextTone, Tool } from "@toolbench/sdk";

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
	rid: "RTP (streams)",
	simulcast: "RTP (streams)",
	"bundle-only": "RTP (streams)",
	"sctp-port": "RTP (streams)",
	"max-message-size": "RTP (streams)",
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
 * RFC 8853's simulcast: `a=simulcast:send h;m;l` names the encodings a sender offers, and each name must be declared by
 * an `a=rid:<name> send` line in the same section (RFC 8853 section 5.1; RFC 8851 section 4). A `~` before a name pauses
 * that encoding, and `,` separates alternatives for one encoding.
 */
function checkSimulcast(lines: string[], m: number[], i: number, add: (s: Severity, message: string, at: number) => void): void {
	const rids = new Map(attrs(lines, m, "rid").map((r) => {
		const [id, dir] = r.value.split(/\s+/);
		return [id ?? "", dir ?? ""] as const;
	}));
	for (const sim of attrs(lines, m, "simulcast")) {
		const f = sim.value.trim().split(/\s+/);
		for (let k = 0; k + 1 < f.length; k += 2) {
			const dir = f[k]!;
			if (dir !== "send" && dir !== "recv") {
				add("error", `m= section ${i}: a=simulcast direction "${dir}" is not send or recv (RFC 8853 section 5.1)`, sim.at);
				continue;
			}
			for (const name of f[k + 1]!.split(/[;,]/).map((x) => x.replace(/^~/, ""))) {
				const declared = rids.get(name);
				if (declared === undefined) add("error", `m= section ${i}: a=simulcast names rid ${name}, which no a=rid line in this section declares (RFC 8853 section 5.1)`, sim.at);
				else if (declared !== dir) add("error", `m= section ${i}: rid ${name} is declared ${declared} but a=simulcast lists it to ${dir} (RFC 8853 section 5.1)`, sim.at);
			}
		}
	}
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
	let hasTlsId = false;
	mediaBlocks.forEach((m, k) => {
		const i = k + 1;
		const mAt = m[0]!;
		const mline = lines[mAt]!.slice(2).split(/\s+/);
		const port = Number(mline[1]);
		const proto = mline[2] ?? "";
		if (mline.length < 4 || !/^\d+$/.test(mline[1] ?? "")) {
			add("error", `m= section ${i}: the m= line is not <media> <port> <proto> <fmt> (RFC 8866 section 5.14)`, mAt);
		}
		/*
		 * A data channel is an m=application section of SCTP over DTLS, RFC 8841, and has no RTP: no RTP profile, no
		 * rtcp-mux, no codecs. Holding it to the audio rules flagged every offer with a data channel as broken.
		 */
		const data = mline[0] === "application";
		if (data ? !/^(UDP|TCP)\/DTLS\/SCTP$/.test(proto) : proto !== "UDP/TLS/RTP/SAVPF") {
			add("error", `m= section ${i}: proto ${proto}, not ${data ? "UDP/DTLS/SCTP (RFC 8841 section 4.2)" : "UDP/TLS/RTP/SAVPF (RFC 9429 section 5.1.2)"}`, mAt);
		}
		const bundleOnly = port === 0 && attrs(lines, m, "bundle-only").length > 0;
		const cLines = m.filter((j) => lines[j]!.startsWith("c="));
		const c = cLines.length ? cLines : sessionBlock.filter((j) => lines[j]!.startsWith("c="));
		const cAddr = c.length ? (lines[c[0]!]!.split(/\s+/)[2] ?? "") : "";
		if (!c.length) add("error", `m= section ${i}: no c= line (RFC 8866 section 5.7)`, mAt);
		const mid = attrs(lines, m, "mid");
		mids.push(...mid.map((x) => x.value));
		media.push(mid[0]?.value === undefined ? `${mline[0]}, no mid` : `${mline[0]} mid ${mid[0].value}`);
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
		if (anyAttr(m, "tls-id").length) hasTlsId = true;
		if (!data && !attrs(lines, m, "rtcp-mux").length) {
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
		// A bundle-only section has port 0 on purpose: it is carried on the bundle's transport (RFC 9143 section 6).
		if (!cands.length && c.length && !bundleOnly && !(port === 9 && cAddr === "0.0.0.0")) {
			add("warning", `m= section ${i}: no candidates, so port 9 and IN IP4 0.0.0.0 expected (RFC 9429 section 5.2.1)`, mAt);
		}
		checkSimulcast(lines, m, i, add);
		const notHost = cands.find((x) => x.type !== "host");
		if (lite && notHost) add("error", "ICE-lite agents only use host candidates (RFC 8445 section 2.5)", notHost.at);
	});
	/*
	 * ⚠️ Once per description, and a note, not a warning on every section. RFC 8842 sections 5.2 and 5.3 do ask for
	 * a=tls-id, but libwebrtc (Chrome, Safari), Firefox and aiortc never write one, and every one of them accepts a
	 * description without it. A warning on every section of every browser's offer is noise that hides real problems.
	 */
	if (mediaBlocks.length && !hasTlsId) {
		add("note", "no a=tls-id: RFC 8842 asks for one, but Chrome, Firefox and aiortc never send it, and all of them accept a description without it", mediaBlocks[0]![0]!);
	}
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
					: f[2] === "UDP/DTLS/SCTP"
						? "UDP/DTLS/SCTP, a data channel: SCTP messages inside the DTLS connection, over UDP"
						: `profile ${f[2]}`;
			if (f[3] === "webrtc-datachannel") return `Starts a data channel section on ${port}: SCTP messages inside the DTLS connection, over ${f[2]?.startsWith("TCP") ? "TCP" : "UDP"} (RFC 8841 section 4.2).`;
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
		case "rid": {
			const [id, dir, ...rest] = vf;
			const limits = rest.join(" ");
			return `Declares rid ${id}, one encoding this side will ${dir === "recv" ? "receive" : "send"}${limits ? `, limited to ${limits}` : ""}; a=simulcast lists these, and each packet names its encoding in the rtp-stream-id header extension (RFC 8851).`;
		}
		case "simulcast": {
			const pieces: string[] = [];
			for (let k = 0; k + 1 < vf.length; k += 2) {
				const names = vf[k + 1]!.split(";");
				const paused = names.filter((x) => x.startsWith("~")).map((x) => x.slice(1));
				pieces.push(`${vf[k] === "recv" ? "receive" : "send"} ${names.length} encoding${names.length === 1 ? "" : "s"}, ${names.map((x) => x.replace(/^~/, "")).join(", ")}${paused.length ? `, with ${paused.join(", ")} paused for now` : ""}`);
			}
			return `Simulcast: this side will ${pieces.join(", and ")}, each one a separate copy of the same source at its own resolution or bitrate, so a server can forward each viewer the one that fits (RFC 8853).`;
		}
		case "bundle-only":
			return "This section has no transport of its own: it only works if the other side bundles it, which is why its port is 0 (RFC 9143 section 6).";
		case "sctp-port":
			return `The data channel's SCTP port, ${v}, inside the DTLS connection, not a UDP port (RFC 8841 section 5).`;
		case "max-message-size":
			return `The largest data channel message this side can take, ${v} bytes${v === "0" ? ", where 0 means no limit" : ""} (RFC 8841 section 6).`;
		case "ssrc-group":
			if (vf[0] === "SIM") return `Legacy simulcast: SSRCs ${vf.slice(1).join(", ")} are the same source at different qualities. Chrome's older way of saying what a=simulcast and a=rid now say, a semantics no RFC registers (RFC 8853 replaces it).`;
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

function problemCounts(problems: Problem[]) {
	const n = (s: Severity) => problems.filter((p) => p.severity === s).length;
	return { errors: n("error"), warnings: n("warning"), notes: n("note") };
}

/** "an offer", "an answer", as the start of a sentence or after a label. */
const kindName = (m: Model) => (m.kind === "unknown" ? "Neither offer nor answer" : m.kind === "offer" ? "Offer" : "Answer");

/**
 * What this SDP sets up, as a spec sheet: the path, the keys and the media, under their own headings. No tone: a
 * description that parses is not good news, and a problem is toned on its own row in the findings.
 */
function summary(m: Model, problems: Problem[]): Field[] {
	const byType = new Map<string, number>();
	for (const c of m.candidates) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
	const types = [...byType].sort(([a], [b]) => (a < b ? -1 : 1));
	const algs = [...new Set(m.fingerprints.map((f) => f.split(/\s+/)[0]!))].sort();
	const p = problemCounts(problems);
	const found = [p.errors ? plural(p.errors, "error") : "", p.warnings ? plural(p.warnings, "warning") : ""].filter(Boolean);
	const verdict = found.length
		? `${found.join(" and ")} found by these checks${p.errors ? ": a WebRTC stack may refuse it" : ""}.`
		: `No problems found by these checks${p.notes ? `, and ${plural(p.notes, "note")}` : ""}.`;
	return [
		{
			label: "This SDP",
			value: `${kindName(m)}${m.setup ? ` (a=setup:${m.setup})` : ""}, ${plural(m.media.length, "media section")}`,
			note: verdict,
		},
		{ group: "Transport", label: "ICE", value: `${m.lite ? "lite" : "full"}, ufrag ${m.ufrag}` },
		types.length
			? { group: "Transport", label: "Candidates", value: types.map(([t, n]) => `${n} ${t}`).join(", "), note: m.trickle }
			: { group: "Transport", label: "Candidates", value: m.trickle },
		{ group: "Transport", label: "BUNDLE", value: m.bundle?.length ? `mid ${m.bundle.join(" ")}` : "none" },
		{ group: "Security", label: "DTLS role", value: ROLE[m.setup] ?? "not stated" },
		{
			group: "Security",
			label: "Fingerprints",
			value: m.fingerprints.length ? algs.join(", ") : "none",
			...(m.fingerprints.length > 1 ? { note: plural(m.fingerprints.length, "fingerprint") } : {}),
		},
		{ group: "Media", label: "Sections", value: m.media.join("; ") || "none" },
		{ group: "Media", label: "Codecs", value: m.codecs.join(", ") || "none", note: plural(m.codecs.length, "payload type") },
		{ group: "Media", label: "rtcp-mux", value: m.rtcpMux ? "yes" : "no" },
	];
}

/** How the reading was done: what decides offer or answer, what was counted, and what the SDP cannot show. */
function method(sides: Model[]): Field[] {
	const lines = (m: Model) =>
		[...PHASES, "Other" as const]
			.filter((ph) => m.counts[ph] > 0)
			.map((ph) => `${SHORT[ph]} ${m.counts[ph]}`)
			.join(", ");
	return [
		{ label: "Offer or answer", value: "from a=setup", note: "actpass is an offer, active or passive an answer" },
		...sides.map((m, i) => ({ label: sides.length > 1 ? (i === 0 ? "Lines, this SDP" : "Lines, the other side") : "Lines", value: String(m.lines.length), note: lines(m) })),
		{ label: "Severity", value: "error, warning, note", note: "an error is a MUST broken, a warning a SHOULD or a value real stacks accept anyway, a note a decoded oddity" },
		{ label: "Fingerprints", value: "present or not", note: "only the DTLS handshake can check one against the certificate" },
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
			? { group, label: "Offer and answer", value: "this SDP offers, the other answers" }
			: offerer === "b"
				? { group, label: "Offer and answer", value: "the other side offers, this SDP answers" }
				: a.kind === "offer" && b.kind === "offer"
					? { group, label: "Offer and answer", value: "both are offers (a=setup:actpass twice)", tone: "bad", note: "an answer must say active or passive (RFC 9429 section 5.3.1)" }
					: a.kind === "answer" && b.kind === "answer"
						? { group, label: "Offer and answer", value: "both are answers", tone: "bad" }
						: { group, label: "Offer and answer", value: "not settled: a side has no a=setup", tone: "bad" },
	);

	if (a.lite !== b.lite) {
		const full = a.lite ? "b" : "a";
		out.push({ group, label: "ICE roles", value: `${who(full)} controls`, note: "full against lite: the full agent controls (RFC 8445 section 6.1.1)" });
	} else {
		const both = a.lite ? "both lite" : "both full";
		out.push(
			offerer
				? { group, label: "ICE roles", value: `${who(offerer)} controls`, note: `${both}: the offerer controls (RFC 8445 section 6.1.1)` }
				: { group, label: "ICE roles", value: "not settled", note: `${both}: the offerer controls, and neither is the one offer (RFC 8445 section 6.1.1)`, tone: "bad" },
		);
	}

	const sa = a.setup;
	const sb = b.setup;
	let hello: Field;
	if (sa === "actpass" && sb === "actpass") {
		hello = { group, label: "ClientHello sent by", value: "not settled: both are offers (actpass twice), so no DTLS role can be settled", tone: "bad" };
	} else if (sb === "active" && (sa === "actpass" || sa === "passive")) {
		hello = { group, label: "ClientHello sent by", value: "the other side (a=setup:active)" };
	} else if (sa === "active" && (sb === "actpass" || sb === "passive")) {
		hello = { group, label: "ClientHello sent by", value: "this side (a=setup:active)" };
	} else if (sb === "passive" && sa === "actpass") {
		hello = { group, label: "ClientHello sent by", value: "this side (actpass against passive)" };
	} else if (sa === "passive" && sb === "actpass") {
		hello = { group, label: "ClientHello sent by", value: "the other side (actpass against passive)" };
	} else {
		hello = { group, label: "ClientHello sent by", value: `not settled: a=setup:${sa || "none"} against a=setup:${sb || "none"}`, tone: "bad" };
	}
	hello.note = "the side whose a=setup resolves to active (RFC 5763 section 5)";
	out.push(hello);

	const theirs = new Set(b.codecs.map((c) => c.toLowerCase()));
	const agreed = a.codecs.filter((c) => theirs.has(c.toLowerCase()));
	out.push(
		agreed.length
			? { group, label: "Codec agreed", value: agreed.join(", "), note: "payload type and encoding both list" }
			: { group, label: "Codec agreed", value: "none in common", note: "no payload type with the same encoding on both sides", tone: "bad" },
	);

	const ba = a.bundle?.join(" ");
	const bb = b.bundle?.join(" ");
	out.push(
		ba !== undefined && ba === bb
			? { group, label: "BUNDLE", value: `mid ${ba}, on both` }
			: ba === undefined && bb === undefined
				? { group, label: "BUNDLE", value: "neither side bundles", tone: "warn" }
				: { group, label: "BUNDLE", value: `this side ${ba ?? "none"}, the other ${bb ?? "none"}`, note: "the same mids should be grouped on both sides (RFC 9143)", tone: "warn" },
	);

	out.push(
		a.rtcpMux && b.rtcpMux
			? { group, label: "rtcp-mux", value: "on both" }
			: { group, label: "rtcp-mux", value: `missing on ${a.rtcpMux ? "the other side" : b.rtcpMux ? "this side" : "both"}`, note: "RFC 8834 section 4.5", tone: "bad" },
	);

	const fa = new Set(a.fingerprints.map((f) => f.toUpperCase()));
	const shared = b.fingerprints.some((f) => fa.has(f.toUpperCase()));
	out.push(
		!a.fingerprints.length || !b.fingerprints.length
			? { group, label: "Fingerprints", value: `missing on ${a.fingerprints.length ? "the other side" : b.fingerprints.length ? "this side" : "both"}`, tone: "bad" }
			: shared
				? { group, label: "Fingerprints", value: "present on both, the same certificate", note: "two peers with one certificate, or one SDP pasted twice", tone: "warn" }
				: { group, label: "Fingerprints", value: "present on both, different certificates", note: "only the DTLS handshake can check either against its certificate" },
	);
	return out;
}

/** Every line, whole: a cut line hides the attribute value a reader came to check. */
function lineTable(m: Model, onlyProblems: boolean, caption: string): Output | null {
	const flagged = new Set(m.problems.map((p) => p.at));
	const rows: Cell[][] = [];
	m.lines.forEach((l, i) => {
		if (onlyProblems && !flagged.has(i)) return;
		rows.push([{ text: String(l.n), mono: true, tone: "muted" }, { text: l.text, mono: true }, l.what, l.phase]);
	});
	if (!rows.length) return null;
	return {
		kind: "table",
		role: "decoded",
		caption,
		columns: [{ label: "#", align: "end", mono: true }, { label: "Line", mono: true }, { label: "What it sets" }, { label: "Read by" }],
		rows,
	};
}

const SEVERITY_TONE: Record<Severity, TextTone> = { error: "bad", warning: "warn", note: "muted" };
const SEVERITY_ORDER: Severity[] = ["error", "warning", "note"];

/**
 * Whether two descriptions settle a call, as the first field of the pair readout. A failed rule between them, or
 * an error on either side, means they do not, and that is the one place a tone is earned without a reader's limit.
 */
function pairVerdict(pairFields: Field[], problems: Problem[]): Field {
	const p = problemCounts(problems);
	const reasons = pairFields.filter((f) => f.tone === "bad").map((f) => UNSETTLED[f.label] ?? `${f.label} is not agreed`);
	if (p.errors) reasons.push(`${plural(p.errors, "error")} break${p.errors === 1 ? "s" : ""} a rule a WebRTC stack enforces`);
	if (reasons.length) {
		const joined = reasons.length === 1 ? reasons[0]! : `${reasons.slice(0, -1).join(", ")} and ${reasons.at(-1)}`;
		return { label: "These two", value: "do not settle a call", note: `${joined[0]!.toUpperCase()}${joined.slice(1)}.`, tone: "bad" };
	}
	const ice = pairFields.find((f) => f.label === "ICE roles")?.value ?? "";
	const hello = pairFields.find((f) => f.label === "ClientHello sent by")?.value.replace(/ \(.*\)$/, "") ?? "";
	const [enc = "", , pt = ""] = (pairFields.find((f) => f.label === "Codec agreed")?.value.split(",")[0] ?? "").split(" ");
	const name = enc.split("/")[0] ?? "";
	const codec = `${name.toLowerCase() === "opus" ? "Opus" : name} as payload type ${pt}`;
	const said = `${ice[0]!.toUpperCase()}${ice.slice(1)} ICE, ${hello} sends the DTLS ClientHello, and both list ${codec}.`;
	return { label: "These two", value: "settle a call", note: p.warnings ? `${said} ${plural(p.warnings, "warning")} worth a look.` : said };
}

/** What each unsettled pair field means for the call, in a clause the verdict can join. */
const UNSETTLED: Record<string, string> = {
	"Offer and answer": "they are not one offer and one answer",
	"ICE roles": "neither side is known to control ICE",
	"ClientHello sent by": "no side is set to start the DTLS handshake",
	"Codec agreed": "they list no codec in common",
	"rtcp-mux": "rtcp-mux is missing on a side",
	Fingerprints: "a side has no certificate fingerprint",
};

export default {
	run(input: Input) {
		try {
			const a = explain(input.sdp ?? "", "sdp");
			const b = (input.other ?? "").trim() ? explain(input.other, "other") : null;
			const onlyProblems = input.show === "problems";
			const sides = b ? [a, b] : [a];

			// Worst first, then in line order, since that is the order to fix them in.
			const problems = (b ? ([[a, "this SDP, "], [b, "the other side, "]] as const) : ([[a, ""]] as const)).flatMap(([m, where]) =>
				m.problems.map((p) => ({
					p,
					n: m.lines[p.at]!.n,
					row: [{ text: p.severity, tone: SEVERITY_TONE[p.severity] }, { text: `${where}line ${m.lines[p.at]!.n}`, mono: true }, p.message] as Cell[],
				})),
			);
			const problemRows = problems.sort((x, y) => SEVERITY_ORDER.indexOf(x.p.severity) - SEVERITY_ORDER.indexOf(y.p.severity) || x.n - y.n).map((x) => x.row);
			const all = sides.flatMap((m) => m.problems);
			const pairFields = b ? pair(a, b) : [];

			/*
			 * The answer in the form the input asks for. Two descriptions lead with what they settle between them; one
			 * leads with what it sets up, unless it breaks a rule, when the problems lead, located by line. A table of
			 * notes only is something to know, not to fix, so it follows the summary. Each part has an id.
			 */
			const fixable = all.some((p) => p.severity !== "note");
			const findings: Output | null = problemRows.length
				? {
						kind: "table",
						role: "findings",
						id: "problems",
						caption: fixable ? "What to fix, worst first" : "Worth knowing, nothing to fix",
						columns: [{ label: "Severity" }, { label: "Where" }, { label: "Problem" }],
						rows: problemRows,
					}
				: null;
			const parts: Output[] = [];
			if (b) parts.push({ kind: "fields", role: "answer", id: "pair", fields: [pairVerdict(pairFields, all), ...pairFields] });
			if (findings && fixable) parts.push(findings);
			parts.push({ kind: "fields", role: b ? "decoded" : "answer", id: "summary", fields: summary(a, b ? a.problems : all) });
			if (findings && !fixable) parts.push(findings);
			const what = onlyProblems ? "The lines with a problem" : "Every line";
			const tableA = lineTable(a, onlyProblems, `${what} of this SDP, and the phase that reads it`);
			if (tableA) parts.push(tableA);
			const tableB = b ? lineTable(b, onlyProblems, `${what} of the other side's SDP`) : null;
			if (tableB) parts.push(tableB);
			parts.push({ kind: "fields", role: "method", id: "method", fields: method(sides) });
			return { kind: "group", parts };
		} catch (error) {
			if (error instanceof InputError) return { kind: "error", message: error.message, input: error.input };
			throw error;
		}
	},
} satisfies Tool<Input>;
