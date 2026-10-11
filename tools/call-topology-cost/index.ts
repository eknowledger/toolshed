/**
 * Call topology cost: where the work of a voice call lands for mesh, an SFU, an MCU, and a server that is simply the
 * other end of the call.
 *
 * The arithmetic is post 6's demo, `topology_cost.py`, and the fixtures are its output. Every number is a count of
 * streams times one stream's rate, so nothing here is measured and nothing is estimated:
 *
 *  - one packet is the Opus payload (bitrate x frame / 8) plus 12 B of RTP, 8 of UDP and 20 of IPv4, plus the SRTP
 *    tag and the RFC 6464 audio-level extension when asked for;
 *  - mesh sends every voice N-1 times from the client; an SFU receives N and sends K(N-1), K being the streams it
 *    forwards; an MCU receives N and sends N mixes, each leaving out its listener's own voice (RFC 7667 section
 *    3.6.1); the server that is the other peer is one stream each way, per user.
 *
 * Assumptions, each a choice the README states: everyone talks all the time (no DTX), mesh runs one encoder per
 * connection as RFC 7667 section 3.4 draws it, and the peer server talks back while the user talks.
 */
import type { Cell, Field, Output, Tool } from "@toolbench/sdk";

type Input = { participants: number; bitrate: number; frame: string; srtp: string; level: boolean; loudest: number; pattern: string };

class InputError extends Error {
	readonly input: string;
	constructor(message: string, input: string) {
		super(message);
		this.input = input;
	}
}

const HEADERS = 12 + 8 + 20;
const LEVEL_B = 8;

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

const opsText = (o: Ops) =>
	[plural(o.unprotect, "decrypt"), o.decode ? plural(o.decode, "decode") : "0 decodes", o.mix ? plural(o.mix, "mix", "mixes") : "", o.encode ? plural(o.encode, "encode") : "", plural(o.protect, "encrypt")].filter(Boolean).join(", ");

export default {
	run(input: Input) {
		try {
			const n = Number(input.participants);
			if (!Number.isInteger(n) || n < 2) throw new InputError("A call needs at least 2 participants.", "participants");
			if (n > 50) throw new InputError("At most 50 participants.", "participants");
			const bitrate = Number(input.bitrate);
			if (!Number.isInteger(bitrate) || bitrate < 6 || bitrate > 510) throw new InputError("Opus runs from 6 to 510 kb/s (RFC 6716 section 2.1.1).", "bitrate");
			const frame = Number(input.frame);
			if (![10, 20, 40, 60].includes(frame)) throw new InputError("Frames are 10, 20, 40 or 60 ms.", "frame");
			if ((bitrate * frame) % 8 !== 0) throw new InputError("bitrate x frame length must be a whole number of bytes.", "bitrate");
			const loudest = Number(input.loudest ?? 0);
			if (!Number.isInteger(loudest) || loudest < 0) throw new InputError("The number of loudest streams is a whole number, 0 for all.", "loudest");
			if (loudest > n) throw new InputError("The loudest streams can be at most the number of participants.", "loudest");
			const tag = Number(input.srtp);
			const payload = (bitrate * frame) / 8;
			const size = payload + HEADERS + tag + (input.level ? LEVEL_B : 0);
			const pps = 1000 / frame;
			const per = (size * 8 * pps) / 1000;
			const k = loudest === 0 ? n : loudest;
			const all = rows(n, k);
			const pick = all.find((r) => r.key === input.pattern) ?? all[1]!;

			const fields: Field[] = [
				{ label: "Client up", value: `${kb(pick.up * per)} kb/s`, note: plural(pick.up, "stream") },
				{ label: "Client down", value: `${kb(pick.down * per)} kb/s`, note: plural(pick.down, "stream") },
				{
					label: "Server out",
					value: pick.serverOut === null ? "no server" : `${kb(pick.serverOut * per)} kb/s`,
					note: pick.serverOut === null ? "every client sends to every other" : `${kb(pick.serverOut * pps)} packets/s`,
				},
				{ label: "Server work per frame", value: pick.server ? opsText(pick.server) : "none", note: `every ${frame} ms` },
				{ label: "Grows with N", value: pick.grows },
				{ label: "Packet", value: `${size} B`, note: `${payload} B Opus + 40 B headers${tag ? ` + ${tag} B SRTP tag` : ""}${input.level ? " + 8 B audio level" : ""}` },
				{ label: "Per stream", value: `${kb(per)} kb/s`, note: `${pps} packets/s` },
			];
			const x = all.map((r) => r.name);
			const chart = {
				id: "cost",
				xLabel: "Pattern",
				yLabel: "Rate",
				yUnit: "kb/s",
				orientation: "horizontal" as const,
				x,
				series: [
					{ label: "One client's upload", unit: "kb/s", shape: "bar" as const, points: all.map((r) => r.up * per) },
					{ label: "One client's download", unit: "kb/s", shape: "bar" as const, points: all.map((r) => r.down * per) },
					{ label: "Server out", unit: "kb/s", shape: "bar" as const, points: all.map((r) => (r.serverOut === null ? null : r.serverOut * per)) },
				],
				readout: { highlightTable: true },
			};
			const dash = "–";
			const tableRows: Cell[][] = all.map((r) => [
				r.key === "peer" ? `${r.name} (per user)` : r.name,
				{ text: kb(r.up * per), mono: true },
				{ text: kb(r.down * per), mono: true },
				{ text: r.serverIn === null ? dash : kb(r.serverIn * per), mono: true },
				{ text: r.serverOut === null ? dash : kb(r.serverOut * per), mono: true },
				{ text: r.serverOut === null ? dash : kb(r.serverOut * pps), mono: true },
				{ text: r.server ? `${r.server.unprotect} / ${r.server.decode} / ${r.server.mix} / ${r.server.encode} / ${r.server.protect}` : dash, mono: true },
			]);
			const parts: Output[] = [
				{ kind: "fields", fields },
				{ kind: "series", chart },
				{
					kind: "table",
					caption: `${n} participants${k < n ? `, the SFU forwarding the ${k} loudest` : ""}. Server work is per ${frame} ms frame: decrypts / decodes / mixes / encodes / encrypts`,
					columns: [
						{ label: "Pattern" },
						{ label: "Up, kb/s", align: "end", mono: true },
						{ label: "Down, kb/s", align: "end", mono: true },
						{ label: "Server in, kb/s", align: "end", mono: true },
						{ label: "Server out, kb/s", align: "end", mono: true },
						{ label: "Server packets/s out", align: "end", mono: true },
						{ label: "Server work per frame", mono: true },
					],
					rows: tableRows,
					link: { chart: "cost", keys: x },
				},
			];
			return { kind: "group", parts };
		} catch (error) {
			if (error instanceof InputError) return { kind: "error", message: error.message, input: error.input };
			throw error;
		}
	},
} satisfies Tool<Input>;
