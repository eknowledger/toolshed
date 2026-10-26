/**
 * An ICE pair ranker: paste both sides' candidates and see the checklist RFC 8445 builds from them, in order.
 *
 * Three steps, each one a place to go wrong by hand:
 *
 *  1. **Pair** every local candidate with every remote one of the same component, transport and address family
 *     (section 6.1.2.2), and price each pair: 2^32*min(G,D) + 2*max(G,D) + (G>D?1:0), with G the controlling agent's
 *     candidate priority and D the controlled one's (6.1.2.3).
 *  2. **Replace** each server-reflexive or peer-reflexive local candidate by its base, the address its packets really
 *     leave from, and **prune** a pair that now duplicates a higher-priority one (6.1.2.4). A server-reflexive
 *     candidate is never checked on its own; its job is to tell the other side where to send.
 *  3. **Order** what is left by priority, and keep the first 100 (6.1.2.5). That is the order the checks run in.
 *
 * Candidates come from whatever the reader has: SDP `a=candidate` lines, a whole offer or answer, the JSON of an
 * RTCIceCandidate or a list of them, or the JSON of `getStats()`, whose local-candidate and remote-candidate entries
 * fill both sides at once. Copying the lines out by hand is the step people get wrong, so the tool does it.
 *
 * Priorities are read as given, never recomputed, because they are what the agents exchanged; each one is also
 * decoded into its type, local preference and component, so a hand-made line that does not match its own type is
 * visible.
 */
import type { Cell, Field, Output, Tool } from "@toolbench/sdk";

type Input = { local: string; remote: string; controlling: string };

class InputError extends Error {
	readonly input: string;
	constructor(message: string, input: string) {
		super(message);
		this.input = input;
	}
}

interface Candidate {
	where: string;
	foundation: string;
	component: number;
	transport: string;
	priority: number;
	address: string;
	port: number;
	type: string;
	raddr?: string;
	rport?: number;
	tcptype?: string;
}

const TYPE_PREF: Record<number, string> = { 126: "host", 110: "prflx", 100: "srflx", 0: "relay" };
const TYPE_NAME: Record<string, string> = { host: "host", srflx: "server-reflexive", prflx: "peer-reflexive", relay: "relayed" };
/** RFC 8445 section 5.1.2.2's recommended order. Only the order is a rule; the numbers are recommendations. */
const TYPE_RANK: Record<string, number> = { host: 3, prflx: 2, srflx: 1, relay: 0 };
/** The default checklist size, RFC 8445 section 6.1.2.5. */
const PAIR_LIMIT = 100;

/**
 * One `candidate:` attribute, as RFC 8839 section 5.1 writes it, at a known position. Each token stops at a quote,
 * a backslash or a comma, so the same expression reads a line of SDP and a candidate string inside JSON.
 */
const CANDIDATE =
	/candidate:([^\s"\\,]+)\s+(\d+)\s+([^\s"\\,]+)\s+(\d+)\s+([^\s"\\,]+)\s+(\d+)\s+typ\s+([^\s"\\,]+)((?:\s+[a-z][a-z-]*\s+[^\s"\\,]+)*)/iy;
/** Where a candidate attribute starts: "candidate:" not inside a longer word, so not "remote-candidates:". */
const START = /(?<![\w-])candidate:/gi;

interface Parsed {
	candidates: Candidate[];
	/** getStats' remote-candidate entries, which fill the other side when it was left empty. */
	others: Candidate[];
	repeats: number;
	lite: boolean;
	source: "lines" | "stats";
}

function fromLines(text: string, input: string): Candidate[] {
	const out: Candidate[] = [];
	for (const start of text.matchAll(START)) {
		CANDIDATE.lastIndex = start.index;
		const m = CANDIDATE.exec(text);
		const line = text.slice(0, start.index).split("\n").length;
		if (!m) {
			throw new InputError(
				`Line ${line} has a candidate that does not parse: expected "candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type>".`,
				input,
			);
		}
		const extras = m[8] ?? "";
		const raddr = /\braddr\s+([^\s"\\,]+)/.exec(extras)?.[1];
		const rport = /\brport\s+(\d+)/.exec(extras)?.[1];
		const tcptype = /\btcptype\s+(\w+)/.exec(extras)?.[1];
		const type = m[7]!.toLowerCase();
		if (!TYPE_NAME[type]) throw new InputError(`Line ${line} has type "${m[7]}", but ICE's types are host, srflx, prflx and relay.`, input);
		out.push({
			where: `line ${line}`,
			foundation: m[1]!,
			component: Number(m[2]),
			transport: m[3]!.toLowerCase(),
			priority: Number(m[4]),
			address: m[5]!,
			port: Number(m[6]),
			type,
			...(raddr ? { raddr } : {}),
			...(rport ? { rport: Number(rport) } : {}),
			...(tcptype ? { tcptype: tcptype.toLowerCase() } : {}),
		});
	}
	return out;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * getStats' candidate entries (W3C webrtc-stats, RTCIceCandidateStats), from `JSON.stringify([...report.values()])`,
 * an object keyed by id, or `[...report]` pairs: every object anywhere in the paste whose `type` is local-candidate or
 * remote-candidate. getStats has no component, because a bundled, rtcp-muxed call has only one, so it is 1.
 */
function fromStats(text: string): { local: Candidate[]; remote: Candidate[] } | undefined {
	const trimmed = text.trim();
	if (!/^[[{]/.test(trimmed)) return undefined;
	let json: Json;
	try {
		json = JSON.parse(trimmed) as Json;
	} catch {
		return undefined;
	}
	const local: Candidate[] = [];
	const remote: Candidate[] = [];
	const walk = (v: Json): void => {
		if (Array.isArray(v)) return v.forEach(walk);
		if (v === null || typeof v !== "object") return;
		const t = v.type;
		if (t === "local-candidate" || t === "remote-candidate") {
			const side = t === "local-candidate" ? local : remote;
			const address = String(v.address ?? v.ip ?? "");
			const type = String(v.candidateType ?? "").toLowerCase();
			if (address && TYPE_NAME[type] && typeof v.port === "number" && typeof v.priority === "number") {
				side.push({
					where: `entry ${String(v.id ?? side.length + 1)}`,
					foundation: String(v.foundation ?? v.id ?? side.length + 1),
					component: 1,
					transport: String(v.protocol ?? "udp").toLowerCase(),
					priority: v.priority,
					address,
					port: v.port,
					type,
					...(typeof v.relatedAddress === "string" && v.relatedAddress ? { raddr: v.relatedAddress } : {}),
					...(typeof v.relatedPort === "number" ? { rport: v.relatedPort } : {}),
					...(typeof v.tcpType === "string" ? { tcptype: v.tcpType } : {}),
				});
			}
			return;
		}
		Object.values(v).forEach(walk);
	};
	walk(json);
	return local.length || remote.length ? { local, remote } : undefined;
}

/** The same candidate pasted twice, from two m-sections of an unbundled SDP or two copies of a line. */
function dedupe(list: Candidate[]): { kept: Candidate[]; repeats: number } {
	const seen = new Set<string>();
	const kept = list.filter((c) => {
		const key = `${c.component}|${c.transport}|${c.address}|${c.port}|${c.type}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return { kept, repeats: list.length - kept.length };
}

function parse(text: string, input: string): Parsed {
	const lite = /(?:^|\n)\s*a=ice-lite\b/.test(text);
	const stats = fromStats(text);
	if (stats) {
		const a = dedupe(stats.local);
		const b = dedupe(stats.remote);
		return { candidates: a.kept, others: b.kept, repeats: a.repeats + b.repeats, lite, source: "stats" };
	}
	const { kept, repeats } = dedupe(fromLines(text, input));
	return { candidates: kept, others: [], repeats, lite, source: "lines" };
}

/** IPv4, IPv6, or an mDNS name, which a browser uses to hide a private address and which pairs with either. */
function family(address: string): "v4" | "v6" | "mdns" {
	if (/\.local\.?$/i.test(address)) return "mdns";
	return address.includes(":") ? "v6" : "v4";
}

/** An address the internet cannot route to: RFC 1918, carrier-grade NAT, link-local, unique-local IPv6. */
function isPrivate(address: string): boolean {
	if (family(address) === "mdns") return true;
	const v4 = /^(\d+)\.(\d+)\./.exec(address);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		return a === 10 || a === 127 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254);
	}
	return /^(?:f[cd]|fe[89ab])/i.test(address) || address === "::1";
}

const pairPriority = (g: number, d: number) => 2n ** 32n * BigInt(Math.min(g, d)) + 2n * BigInt(Math.max(g, d)) + (g > d ? 1n : 0n);

/** The base a check is sent from: a reflexive candidate's related address, which is the host it was learned from. */
function base(c: Candidate, locals: Candidate[]): Candidate {
	if (c.type !== "srflx" && c.type !== "prflx") return c;
	return locals.find((l) => l.type === "host" && l.address === c.raddr && l.port === c.rport && l.component === c.component) ?? c;
}

/*
 * A reflexive candidate whose related address names no listed host. Browsers send "raddr 0.0.0.0" to hide it, and
 * the check still leaves from a host, so calling the candidate its own base would teach the opposite of the RFC.
 * It is not pruned either: the host may simply not be in the list, and then this pair is checked.
 */
const reflexive = (c: Candidate) => c.type === "srflx" || c.type === "prflx";

/** TCP candidates pair active with passive and simultaneous-open with itself (RFC 6544 section 6.2). */
function tcpCompatible(l: Candidate, r: Candidate): boolean {
	if (l.transport !== "tcp" || !l.tcptype || !r.tcptype) return true;
	if (l.tcptype === "so") return r.tcptype === "so";
	return (l.tcptype === "active" && r.tcptype === "passive") || (l.tcptype === "passive" && r.tcptype === "active");
}

function decode(p: number): string {
	const tp = Math.floor(p / 2 ** 24);
	return `Type preference ${tp}${TYPE_PREF[tp] ? `, which is ${TYPE_PREF[tp]} in RFC 8445's recommended values` : ""}. Local preference ${(p >>> 8) & 0xffff}, component ${256 - (p & 0xff)}.`;
}

type Tone = "good" | "warn" | "bad";
type Action = { tone: Tone | "normal"; problem: string; fix: string };

/** A relay that outranks a direct path on its own side: its checks run first and its traffic goes through a server. */
function rankProblem(side: Candidate[], name: string): Action | undefined {
	const tp = (c: Candidate) => Math.floor(c.priority / 2 ** 24);
	for (const a of side) {
		for (const b of side) {
			if (TYPE_RANK[a.type]! < TYPE_RANK[b.type]! && tp(a) > tp(b)) {
				return {
					tone: "warn",
					problem: `The ${name} ${a.type} candidate on ${a.where} has a higher type preference (${tp(a)}) than the ${b.type} on ${b.where} (${tp(b)}).`,
					fix: `RFC 8445 asks for host above peer-reflexive above server-reflexive above relayed. With this order, checks through the ${a.type} candidate run first. If the stack was configured by hand, put the type preferences back in that order.`,
				};
			}
		}
	}
	return undefined;
}

export default {
	run(input: Input) {
		try {
			const mine = parse(input.local, "local");
			const theirs = input.remote.trim() ? parse(input.remote, "remote") : undefined;
			const locals = mine.candidates;
			// One getStats paste has both sides; the remote box can then stay empty.
			const remotes = theirs ? (theirs.source === "stats" && theirs.candidates.length === 0 ? theirs.others : theirs.candidates) : mine.others;
			if (locals.length === 0) {
				throw new InputError("No local candidates found. Paste a=candidate lines, a whole SDP, RTCIceCandidate JSON, or the JSON of getStats().", "local");
			}
			if (remotes.length === 0) {
				throw new InputError(
					mine.source === "stats"
						? "The getStats paste has no remote-candidate entries. Paste the other side's candidates here."
						: "No remote candidates found. Paste the other side's a=candidate lines, its SDP, or getStats JSON with remote-candidate entries.",
					"remote",
				);
			}
			const localControls = input.controlling !== "remote";
			const repeats = mine.repeats + (theirs?.repeats ?? 0);

			type Pair = { l: Candidate; r: Candidate; b: Candidate; priority: bigint; state: "check" | "pruned" | "over"; same?: Pair };
			const pairs: Pair[] = [];
			for (const l of locals) {
				for (const r of remotes) {
					if (l.component !== r.component || l.transport !== r.transport || !tcpCompatible(l, r)) continue;
					const fl = family(l.address);
					const fr = family(r.address);
					if (fl !== "mdns" && fr !== "mdns" && fl !== fr) continue;
					const [g, d] = localControls ? [l.priority, r.priority] : [r.priority, l.priority];
					pairs.push({ l, r, b: base(l, locals), priority: pairPriority(g, d), state: "check" });
				}
			}
			if (pairs.length === 0) {
				throw new InputError("No candidates can be paired: a pair needs the same component, the same transport and the same address family on both sides.", "remote");
			}
			pairs.sort((a, b) => (a.priority > b.priority ? -1 : a.priority < b.priority ? 1 : 0));
			const seen = new Map<string, Pair>();
			let kept = 0;
			for (const p of pairs) {
				const key = `${p.b.address}:${p.b.port}|${p.r.address}:${p.r.port}|${p.l.component}`;
				const earlier = seen.get(key);
				if (earlier) {
					p.state = "pruned";
					p.same = earlier;
				} else if (++kept > PAIR_LIMIT) {
					p.state = "over";
				} else seen.set(key, p);
			}
			const checks = pairs.filter((p) => p.state === "check");
			const pruned = pairs.filter((p) => p.state === "pruned").length;
			const over = pairs.filter((p) => p.state === "over").length;
			const label = (c: Candidate) => `${c.type} ${c.address}:${c.port}`;
			const words = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

			// What to do, worst first. Each is a rule a reader can act on, not a restatement of the table.
			const actions: Action[] = [];
			const remoteLite = theirs?.lite ?? false;
			if (mine.lite && remoteLite) {
				actions.push({ tone: "warn", problem: "Both sides are ICE-lite.", fix: "Between two lite agents no connectivity checks are sent at all (RFC 8445 section 6.1.1), so this order never runs. One side has to run full ICE." });
			} else if (remoteLite && !localControls) {
				actions.push({ tone: "warn", problem: "The remote side is ICE-lite, and a lite agent is always the controlled one.", fix: "Set the controlling side to Local (RFC 8445 section 6.1.1)." });
			} else if (mine.lite && localControls) {
				actions.push({ tone: "warn", problem: "The local side is ICE-lite, and a lite agent is always the controlled one.", fix: "Set the controlling side to Remote (RFC 8445 section 6.1.1)." });
			}
			const anyRelay = [...locals, ...remotes].some((c) => c.type === "relay");
			if (!anyRelay) {
				const publicRemote = remotes.some((c) => c.type === "host" && !isPrivate(c.address));
				actions.push(
					publicRemote
						? {
								tone: "normal",
								problem: "Neither side has a relayed candidate, but the remote side has a public host address.",
								fix: "That usually connects. Only a network that blocks UDP stops it; a TURN server over TCP or TLS on port 443 is the fallback.",
							}
						: {
								tone: "warn",
								problem: "Neither side has a relayed candidate, so there is no fallback through a server.",
								fix: "If a firewall blocks UDP, or both NATs give a new port per destination, every check fails and the call never connects. Add a TURN server to iceServers.",
							},
				);
			}
			for (const problem of [rankProblem(locals, "local"), rankProblem(remotes, "remote")]) if (problem) actions.push(problem);
			if (over) {
				actions.push({
					tone: "warn",
					problem: `${words(pairs.length - pruned, "pair is", "pairs are")} left after pruning, more than the ${PAIR_LIMIT} a checklist holds by default.`,
					fix: `The lowest ${words(over, "pair is", "pairs are")} never checked (RFC 8445 section 6.1.2.5). Gather fewer candidates, for example one network interface.`,
				});
			}
			const mdnsRemote = remotes.filter((c) => family(c.address) === "mdns").length;
			if (mdnsRemote) {
				actions.push({
					tone: "normal",
					problem: `${words(mdnsRemote, "remote host candidate is an mDNS name", "remote host candidates are mDNS names")}, ending in .local.`,
					fix: "A name like that only resolves on the same local network. Across the internet, the reflexive or relayed pairs carry the call.",
				});
			}
			const hidden = locals.filter((c) => reflexive(c) && base(c, locals) === c).length;
			if (hidden) {
				actions.push({
					tone: "normal",
					problem: `${words(hidden, "local reflexive candidate does", "local reflexive candidates do")} not say which host address ${hidden === 1 ? "it was" : "they were"} learned from.`,
					fix: "Browsers hide it as raddr 0.0.0.0. Its pairs are kept here; if the host it came from is listed, the browser prunes them.",
				});
			}
			const unpaired = [...locals.map((c) => ["local", c] as const), ...remotes.map((c) => ["remote", c] as const)].filter(
				([side, c]) => !pairs.some((p) => (side === "local" ? p.l : p.r) === c),
			);
			if (unpaired.length) {
				actions.push({
					tone: "normal",
					problem: `${words(unpaired.length, "candidate has", "candidates have")} nothing to pair with: ${unpaired.map(([side, c]) => `${side} ${label(c)}`).join(", ")}.`,
					fix: "A pair needs the same component, transport and address family on both sides. An IPv6 candidate needs an IPv6 one on the other side.",
				});
			}
			if (repeats) {
				actions.push({
					tone: "normal",
					problem: `${words(repeats, "candidate was", "candidates were")} pasted more than once.`,
					fix: "Each is counted once. An SDP without BUNDLE repeats its candidates in every media section.",
				});
			}
			const worst = { bad: 0, warn: 1, normal: 2, good: 3 };
			actions.sort((a, b) => worst[a.tone] - worst[b.tone]);

			/*
			 * The answer is a list, so it is drawn as one: the computed order, which the tool works out from the RFC and
			 * does not observe. The arithmetic and the candidates' own priorities go last, for the reader checking it.
			 */
			const method: Field[] = [
				{
					group: "Roles",
					label: "Controlling",
					value: localControls ? "local" : "remote",
					note: "Its candidate priorities are G in the pair formula, the other side's D.",
				},
				{ group: "Roles", label: "Pair priority", value: "2^32 x min(G, D) + 2 x max(G, D) + (G > D ? 1 : 0)", note: "RFC 8445 section 6.1.2.3" },
				{
					group: "Roles",
					label: "Read from",
					value: mine.source === "stats" || theirs?.source === "stats" ? "getStats() JSON" : "candidate attributes",
					note: mine.source === "stats" && !theirs ? "The local-candidate and remote-candidate entries of one report." : "Every candidate: attribute in the paste, wherever it was.",
				},
				...locals.map((c) => ({ group: "Local candidates", label: `${c.type}, ${c.where}`, value: String(c.priority), note: decode(c.priority) })),
				...remotes.map((c) => ({ group: "Remote candidates", label: `${c.type}, ${c.where}`, value: String(c.priority), note: decode(c.priority) })),
			];
			const order = new Map(checks.map((p, i) => [p, i + 1]));
			const via = (p: Pair) => (p.l.type === "relay" || p.r.type === "relay" ? "TURN" : "direct");
			const ranked: Output = {
				kind: "table",
				role: "comparison",
				id: "order",
				caption: `Computed check order, highest priority first. ${localControls ? "Local" : "Remote"} side controls`,
				columns: [
					{ label: "#", align: "end", mono: true, wrap: "none", rowHeader: true },
					{ label: "Local", mono: true, wrap: "none" },
					{ label: "Remote", mono: true, wrap: "none" },
					{ label: "Route", wrap: "prose" },
					{ label: "Priority", align: "end", mono: true, wrap: "none" },
				],
				rows: checks.map((p): Cell[] => [
					{ text: String(order.get(p)), mono: true },
					{ text: label(p.l), mono: true },
					{ text: label(p.r), mono: true },
					via(p),
					{ text: String(p.priority), mono: true, tone: "muted" },
				]),
			};
			const dropped = pairs.filter((p) => p.state !== "check");
			const prunedTable: Output | null = dropped.length
				? {
						kind: "table",
						role: "decoded",
						id: "pruned",
						caption: over
							? `Pruned, ${words(pruned, "pair", "pairs")} sending the same check as one above, and ${over} past the ${PAIR_LIMIT} a checklist holds`
							: `Pruned: ${pruned === 1 ? "this pair sends" : "these pairs send"} the same check, from the same place to the same place, as one above`,
						columns: [
							{ label: "Local", mono: true, wrap: "none", rowHeader: true },
							{ label: "Sent from", mono: true, wrap: "none" },
							{ label: "Remote", mono: true, wrap: "none" },
							{ label: "Same as", align: "end", wrap: "none" },
						],
						rows: dropped.map((p): Cell[] => [
							{ text: label(p.l), mono: true },
							{ text: p.b !== p.l ? `${p.b.address}:${p.b.port}` : reflexive(p.l) ? "a host, hidden" : `${p.l.address}:${p.l.port}`, mono: true },
							{ text: label(p.r), mono: true },
							p.same ? `#${order.get(p.same)}` : { text: `over ${PAIR_LIMIT}`, tone: "muted" },
						]),
					}
				: null;
			const severity = (t: Action["tone"]) => (t === "bad" ? "Problem" : t === "warn" ? "Warning" : "Note");
			const findings: Output | null = actions.length
				? {
						kind: "table",
						role: "findings",
						id: "findings",
						caption: "What to look at, most serious first",
						columns: [
							{ label: "Severity", wrap: "none" },
							{ label: "What we found", wrap: "prose" },
							{ label: "What it means and what to do", wrap: "prose" },
						],
						rows: actions.map((a): Cell[] => [{ text: severity(a.tone), tone: a.tone === "normal" ? "muted" : a.tone === "good" ? "muted" : a.tone }, a.problem, a.fix]),
					}
				: null;
			/*
			 * The grid the post draws: local candidates down, remote across, each cell the pair's place in the check
			 * order. A rank is a quantity of "how far down the list", so the one-hue scale gives a later check more ink (the
			 * host decides which end that is in each theme) and the key's "1 runs first" says which way to read it; a pruned or
			 * impossible pair is an empty cell rather than a colour that would claim a place.
			 *
			 * Only when both sides have two candidates or more: with one on either side it is a single row or column, and a
			 * gradient along it says nothing the numbered list does not.
			 */
			const values = locals.map((l) =>
				remotes.map((r) => {
					const p = pairs.find((x) => x.l === l && x.r === r);
					return p && p.state === "check" ? (order.get(p) ?? null) : null;
				}),
			);
			const heatmap: Output | null =
				locals.length >= 2 && remotes.length >= 2
					? {
							kind: "heatmap",
							heatmap: {
								label: "Check order (1 runs first)",
								xLabel: "Remote",
								yLabel: "Local",
								x: remotes.map((c) => `${c.type} ${c.port}`),
								y: locals.map((c) => `${c.type} ${c.port}`),
								values,
								scale: "sequential",
							},
						}
					: null;
			const urgent = actions.some((a) => a.tone === "warn" || a.tone === "bad");
			const parts: Output[] = [ranked];
			if (findings && urgent) parts.push(findings);
			if (prunedTable) parts.push(prunedTable);
			if (findings && !urgent) parts.push(findings);
			if (heatmap) parts.push(heatmap);
			parts.push({ kind: "fields", role: "method", id: "method", fields: method });
			return { kind: "group", parts };
		} catch (error) {
			if (error instanceof InputError) return { kind: "error", message: error.message, input: error.input };
			throw error;
		}
	},
} satisfies Tool<Input>;
