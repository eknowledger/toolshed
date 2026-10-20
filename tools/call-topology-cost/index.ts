/**
 * Call topology cost: where the work of a voice call lands for mesh, an SFU, an MCU, and a server that is simply the
 * other end of the call.
 *
 * The arithmetic is post 6's demo, `topology_cost.py`, and the fixtures are its output. Every number is a count of
 * streams times one stream's rate, so nothing here is measured and nothing is estimated:
 *
 *  - one packet is the codec payload (bitrate x frame / 8), plus 12 B of RTP (RFC 3550), 8 of UDP and 20 of IPv4 or
 *    40 of IPv6 (RFC 8200's fixed header), plus the SRTP authentication tag (10 B for AES_CM_128_HMAC_SHA1_80, RFC
 *    3711; 16 B for AEAD_AES_128_GCM, RFC 7714) and any RTP header extensions, in RFC 8285's one-byte form;
 *  - mesh sends every voice N-1 times from the client; an SFU receives N and sends K(N-1), K being the streams it
 *    forwards; an MCU receives N and sends N mixes, each leaving out its listener's own voice (RFC 7667 section
 *    3.6.1); the server that is the other peer is one stream each way, per user.
 *
 * Assumptions, each a choice the README states: everyone talks all the time (no DTX), mesh runs one encoder per
 * connection as RFC 7667 section 3.4 draws it, and the peer server talks back while the user talks.
 */
import type { Cell, Output, Tool } from "@toolbench/sdk";

type Input = {
	participants: number;
	pattern: string;
	loudest: number;
	codec?: string;
	bitrate: number;
	frame: string;
	packet?: string;
	ip?: string;
	srtp: string;
	ext?: string;
};

class InputError extends Error {
	readonly input: string;
	constructor(message: string, input: string) {
		super(message);
		this.input = input;
	}
}

const RTP_B = 12;
const UDP_B = 8;
const IP_B: Record<string, number> = { "4": 20, "6": 40 };

/**
 * Header extensions, each as the bytes of data its element carries. In RFC 8285's one-byte form every element is one
 * byte of ID and length plus its data, after a 4-byte header (0xBEDE and a length), padded to a multiple of 4 bytes:
 * the audio level is 1 byte of data (RFC 6464), the MID "0" 1, a transport-wide sequence number 2, abs-send-time 3.
 */
const EXTENSIONS: Record<string, { label: string; data: number[] }> = {
	none: { label: "no header extensions", data: [] },
	level: { label: "the audio level", data: [1] },
	"level-mid": { label: "the audio level and the MID", data: [1, 1] },
	"level-mid-twcc": { label: "the audio level, the MID and a transport-wide sequence number", data: [1, 1, 2] },
	"level-mid-twcc-abs": { label: "the audio level, the MID, a transport-wide sequence number and abs-send-time", data: [1, 1, 2, 3] },
};

/** Bytes on the wire for a set of one-byte-form extensions: none at all, or the 4-byte header, the elements, and padding. */
export function extensionBytes(data: number[]): number {
	if (data.length === 0) return 0;
	const raw = 4 + data.reduce((sum, d) => sum + 1 + d, 0);
	return Math.ceil(raw / 4) * 4;
}

type Ops = { unprotect: number; decode: number; mix: number; encode: number; protect: number };
type Row = { key: string; name: string; up: number; down: number; serverIn: number | null; serverOut: number | null; server: Ops | null; grows: string };

/** kb/s with no trailing noise: 48, 55.2, 4320. */
const kb = (x: number) => String(Math.round(x * 100) / 100);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function rows(n: number, k: number): Row[] {
	const fwd = Math.min(k, n - 1);
	return [
		{ key: "mesh", name: "Mesh", up: n - 1, down: n - 1, serverIn: null, serverOut: null, server: null, grows: "N-1 streams up from every client" },
		{
			key: "sfu",
			name: k < n ? `SFU, ${k} loudest` : "SFU",
			up: 1,
			down: fwd,
			serverIn: n,
			// Each of the K forwarded speakers gets the other K-1, everyone else gets K: K(K-1) + (N-K)K = K(N-1).
			serverOut: k * (n - 1),
			server: { unprotect: n, decode: 0, mix: 0, encode: 0, protect: k * (n - 1) },
			grows: k < n ? "K(N-1) streams out of the server" : "N(N-1) streams out of the server",
		},
		{ key: "mcu", name: "MCU", up: 1, down: 1, serverIn: n, serverOut: n, server: { unprotect: n, decode: n, mix: n > 2 ? n : 0, encode: n, protect: n }, grows: "N decodes, mixes and encodes on the server" },
		{ key: "peer", name: "Server is the peer", up: 1, down: 1, serverIn: 1, serverOut: 1, server: { unprotect: 1, decode: 1, mix: 0, encode: 1, protect: 1 }, grows: "one stream each way, per user" },
	];
}

export default {
	run(input: Input) {
		try {
			const n = Number(input.participants);
			if (!Number.isInteger(n) || n < 2) throw new InputError("A call needs at least 2 participants.", "participants");
			if (n > 50) throw new InputError("At most 50 participants.", "participants");
			const bitrate = Number(input.bitrate);
			if (!Number.isInteger(bitrate) || bitrate < 6 || bitrate > 510)
				throw new InputError("The bitrate must be 6 to 510 kb/s, Opus's range (RFC 6716 section 2.1.1). G.711 is 64.", "bitrate");
			const frame = Number(input.frame);
			if (![10, 20, 40, 60].includes(frame)) throw new InputError("Frames are 10, 20, 40 or 60 ms.", "frame");
			if ((bitrate * frame) % 8 !== 0) throw new InputError("bitrate x frame length must be a whole number of bytes.", "bitrate");
			const loudest = Number(input.loudest ?? 0);
			if (!Number.isInteger(loudest) || loudest < 0) throw new InputError("The number of loudest streams is a whole number, 0 for all.", "loudest");
			if (loudest > n) throw new InputError("The loudest streams can be at most the number of participants.", "loudest");
			const ipB = IP_B[input.ip ?? "4"];
			if (ipB === undefined) throw new InputError("IP is version 4 or 6.", "ip");
			const ext = EXTENSIONS[input.ext ?? "none"];
			if (!ext) throw new InputError(`Header extensions must be one of ${Object.keys(EXTENSIONS).join(", ")}.`, "ext");
			const tag = Number(input.srtp);
			const extB = extensionBytes(ext.data);

			const payload = (bitrate * frame) / 8;
			const sizeAt = (ms: number) => (bitrate * ms) / 8 + RTP_B + UDP_B + ipB + tag + extB;
			const size = sizeAt(frame);
			const pps = 1000 / frame;
			const per = (size * 8 * pps) / 1000;
			const k = loudest === 0 ? n : loudest;
			const all = rows(n, k);
			const pick = all.find((r) => r.key === input.pattern) ?? all[1]!;
			const none: Cell = { text: "none", tone: "muted" };
			const rate = (streams: number | null): Cell => (streams === null ? none : { text: kb(streams * per), mono: true });

			/*
			 * The answer is the comparison: the question is which pattern, so all four go first, in one frame. Client
			 * columns are one device and server columns the whole call, which the caption says because the two scopes
			 * sit side by side. The pattern the reader picked is named in words, not coloured: picking it is not a
			 * judgement about it.
			 */
			const comparison: Output = {
				kind: "table",
				role: "comparison",
				caption: `${plural(n, "person", "people")}, everyone talking${k < n ? `, the SFU forwarding the ${k} loudest` : ""}. In kb/s: the client columns are one device, the server columns the whole call`,
				columns: [
					{ label: "Pattern" },
					{ label: "Client up", align: "end", mono: true },
					{ label: "Client down", align: "end", mono: true },
					{ label: "Server in", align: "end", mono: true },
					{ label: "Server out", align: "end", mono: true },
				],
				rows: all.map((r): Cell[] => [
					`${r.key === "peer" ? "Peer, per user" : r.name}${r.key === pick.key ? " (picked)" : ""}`,
					{ text: kb(r.up * per), mono: true },
					{ text: kb(r.down * per), mono: true },
					rate(r.serverIn),
					rate(r.serverOut),
				]),
			};

			/*
			 * The picked pattern's streams, as counts of one stream's rate. Nodes are aggregates (all the clients, not
			 * each one), so the picture stays three boxes at 50 people; the per-device figures are in the table above.
			 */
			const each = (count: number) => `${count} x ${kb(per)} kb/s`;
			const graph: Output = (() => {
				if (pick.key === "mesh") {
					return {
						kind: "graph",
						graph: {
							label: `Mesh, ${n} people: every device sends to every other`,
							spacing: "compact",
							nodes: [
								{ id: "talk", label: plural(n, "client"), note: `each sends ${plural(n - 1, "stream")}` },
								{ id: "hear", label: plural(n, "client"), note: `each receives ${n - 1}` },
							],
							edges: [{ from: "talk", to: "hear", label: each(n * (n - 1)) }],
						},
					};
				}
				if (pick.key === "peer") {
					return {
						kind: "graph",
						graph: {
							label: "The server is the other end: one stream each way, per user",
							spacing: "compact",
							nodes: [
								{ id: "user", label: "1 user" },
								{ id: "server", label: "Server", note: "decodes, then encodes its reply" },
							],
							edges: [
								{ from: "user", to: "server", label: each(1) },
								{ from: "server", to: "user", label: each(1) },
							],
						},
					};
				}
				const server = pick.key === "sfu" ? "SFU" : "MCU";
				return {
					kind: "graph",
					graph: {
						label: `${pick.name}, ${n} people: every stream in and out of the server`,
						spacing: "compact",
						nodes: [
							{ id: "talk", label: plural(n, "client"), note: "talking" },
							{ id: "server", label: server, note: pick.key === "sfu" ? "forwards without decoding" : n > 2 ? "one mix per listener" : "decodes and re-encodes" },
							{ id: "hear", label: plural(n, "client"), note: pick.key === "mcu" ? (n > 2 ? "each hears one mix" : "each hears 1 voice") : `each hears ${plural(pick.down, "voice")}` },
						],
						edges: [
							{ from: "talk", to: "server", label: each(pick.serverIn!) },
							{ from: "server", to: "hear", label: pick.key === "mcu" && pick.server!.mix > 0 ? `${n} mixes x ${kb(per)} kb/s` : each(pick.serverOut!) },
						],
					},
				};
			})();

			/*
			 * What would make the picked pattern cheaper, each computed rather than asserted. Switching pattern is not
			 * here: the comparison above already prices every switch. Sorted by the kb/s each takes off the busiest
			 * flow, the server's output or a mesh device's upload, largest first.
			 */
			type Advice = { change: string; saves: number; gain: string; cost: string };
			const advice: Advice[] = [];
			if (pick.key === "sfu" && k === n && n > 3) {
				const top = rows(n, 3)[1]!;
				advice.push({
					change: "Forward only the 3 loudest",
					saves: (pick.serverOut! - top.serverOut!) * per,
					gain: `The server's output falls from ${kb(pick.serverOut! * per)} to ${kb(top.serverOut! * per)} kb/s, each listener's from ${kb(pick.down * per)} to ${kb(top.down * per)}.`,
					cost: "Quieter voices are not heard while three others are louder. Senders must write the audio level.",
				});
			}
			if (frame < 60) {
				const longer = frame === 10 ? 20 : frame === 20 ? 40 : 60;
				const perLonger = (sizeAt(longer) * 8 * (1000 / longer)) / 1000;
				const streams = pick.serverOut ?? pick.up;
				advice.push({
					change: `Send ${longer} ms frames`,
					saves: (per - perLonger) * streams,
					gain: `Each stream falls from ${kb(per)} to ${kb(perLonger)} kb/s, because the headers are sent ${longer === 2 * frame ? "half" : "two thirds"} as often.`,
					cost: `${longer - frame} ms more delay, and each lost packet takes ${longer} ms of sound.`,
				});
			}
			advice.sort((x, y) => y.saves - x.saves);

			/*
			 * Server work, with the five operations as named columns rather than "3 / 0 / 0 / 0 / 6". Mesh has no
			 * server, so it has no row. With the tag left out of the size, the crypto counts still stand: WebRTC always
			 * encrypts, and the choice only changes what one packet weighs.
			 */
			const servers = all.filter((r) => r.server !== null);
			const work: Output = {
				kind: "table",
				role: "comparison",
				caption: `Server operations every ${frame} ms frame${tag === 0 ? ". Decrypts and encrypts assume SRTP, which WebRTC always uses, though the packet size here leaves out its tag" : ""}`,
				columns: [
					{ label: "Pattern" },
					{ label: "Decrypt", align: "end", mono: true },
					{ label: "Decode", align: "end", mono: true },
					{ label: "Mix", align: "end", mono: true },
					{ label: "Encode", align: "end", mono: true },
					{ label: "Encrypt", align: "end", mono: true },
				],
				rows: servers.map((r): Cell[] => [
					r.key === "peer" ? "Peer, per user" : r.name,
					{ text: String(r.server!.unprotect), mono: true },
					{ text: String(r.server!.decode), mono: true },
					{ text: String(r.server!.mix), mono: true },
					{ text: String(r.server!.encode), mono: true },
					{ text: String(r.server!.protect), mono: true },
				]),
			};

			const breakdown = [
				`${payload} B of sound`,
				`${RTP_B} B RTP`,
				`${UDP_B} B UDP`,
				`${ipB} B IPv${input.ip ?? "4"}`,
				...(tag ? [`${tag} B SRTP tag`] : []),
				...(extB ? [`${extB} B of header extensions, for ${ext.label}`] : []),
			];
			const method: Output = {
				kind: "fields",
				role: "method",
				fields: [
					{ label: "One packet", value: `${size} B`, note: `${breakdown.join(", ")}.` },
					{ label: "One stream", value: `${kb(per)} kb/s`, note: `${pps} packets a second, so the server sends ${pick.serverOut === null ? "none" : kb(pick.serverOut * pps)} a second for the ${pick.key === "peer" ? "peer server, per user" : pick.name}.` },
					{ label: "Assumes", value: "Everyone talks all the time, with no silence suppression, so these are the busiest case." },
				],
			};

			const parts: Output[] = [
				comparison,
				graph,
				...(advice.length > 0
					? [
							{
								kind: "table" as const,
								role: "actions",
								caption: `What would make the ${pick.key === "peer" ? "peer server" : pick.name} cheaper, largest saving first`,
								columns: [{ label: "Change" }, { label: "What it saves" }, { label: "What it costs" }],
								rows: advice.map((a): Cell[] => [a.change, a.gain, a.cost]),
							},
						]
					: []),
				work,
				method,
			];
			return { kind: "group", parts };
		} catch (error) {
			if (error instanceof InputError) return { kind: "error", message: error.message, input: error.input };
			throw error;
		}
	},
} satisfies Tool<Input>;
