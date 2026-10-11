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
 *  3. **Order** what is left by priority. That is the order the checks run in.
 *
 * Priorities are read from the candidate lines as given, never recomputed, because they are what the agents
 * exchanged; each one is also decoded into its type, local preference and component, so a hand-made line that does
 * not match its own type is visible.
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
	line: number;
	foundation: string;
	component: number;
	transport: string;
	priority: number;
	address: string;
	port: number;
	type: string;
	raddr?: string;
	rport?: number;
}

const TYPE_PREF: Record<number, string> = { 126: "host", 110: "prflx", 100: "srflx", 0: "relay" };
const TYPE_NAME: Record<string, string> = { host: "host", srflx: "server-reflexive", prflx: "peer-reflexive", relay: "relayed" };

/** One `candidate:` line, with or without SDP's `a=` in front, as RFC 8839 section 5.1 writes it. */
function parse(text: string, input: string): Candidate[] {
	const out: Candidate[] = [];
	text.split(/\r?\n/).forEach((raw, i) => {
		const line = raw.trim().replace(/^a=/, "");
		if (!line) return;
		const m = /^candidate:(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s+typ\s+(\S+)(.*)$/i.exec(line);
		if (!m) throw new InputError(`Line ${i + 1} is not a candidate line: expected "candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type>".`, input);
		const extras = m[8] ?? "";
		const raddr = /\braddr\s+(\S+)/.exec(extras)?.[1];
		const rport = /\brport\s+(\d+)/.exec(extras)?.[1];
		const type = m[7]!.toLowerCase();
		if (!TYPE_NAME[type]) throw new InputError(`Line ${i + 1} has type "${m[7]}"; ICE's types are host, srflx, prflx and relay.`, input);
		out.push({
			line: i + 1, foundation: m[1]!, component: Number(m[2]), transport: m[3]!.toLowerCase(), priority: Number(m[4]),
			address: m[5]!, port: Number(m[6]), type, ...(raddr ? { raddr } : {}), ...(rport ? { rport: Number(rport) } : {}),
		});
	});
	if (out.length === 0) throw new InputError("No candidate lines.", input);
	return out;
}

/** IPv4, IPv6, or an mDNS name, which a browser uses to hide a private address and which pairs with either. */
function family(address: string): "v4" | "v6" | "mdns" {
	if (/\.local$/i.test(address)) return "mdns";
	return address.includes(":") ? "v6" : "v4";
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

function decode(p: number): string {
	const tp = Math.floor(p / 2 ** 24);
	return `type ${tp}${TYPE_PREF[tp] ? ` (${TYPE_PREF[tp]})` : ""}, local ${(p >>> 8) & 0xffff}, component ${256 - (p & 0xff)}`;
}

export default {
	run(input: Input) {
		try {
			const locals = parse(input.local, "local");
			const remotes = parse(input.remote, "remote");
			const localControls = input.controlling !== "remote";

			type Pair = { l: Candidate; r: Candidate; b: Candidate; priority: bigint; state: "check" | "pruned"; why?: string };
			const pairs: Pair[] = [];
			for (const l of locals) {
				for (const r of remotes) {
					if (l.component !== r.component || l.transport !== r.transport) continue;
					const fl = family(l.address);
					const fr = family(r.address);
					if (fl !== "mdns" && fr !== "mdns" && fl !== fr) continue;
					const [g, d] = localControls ? [l.priority, r.priority] : [r.priority, l.priority];
					pairs.push({ l, r, b: base(l, locals), priority: pairPriority(g, d), state: "check" });
				}
			}
			if (pairs.length === 0) throw new InputError("No candidates can be paired: a pair needs the same component, the same transport and the same address family on both sides.", "remote");
			pairs.sort((a, b) => (a.priority > b.priority ? -1 : a.priority < b.priority ? 1 : 0));
			const seen = new Map<string, Pair>();
			for (const p of pairs) {
				const key = `${p.b.address}:${p.b.port}|${p.r.address}:${p.r.port}|${p.l.component}`;
				const earlier = seen.get(key);
				if (earlier) {
					p.state = "pruned";
					p.why = `same base and remote as ${earlier.l.type} → ${earlier.r.type}, which is checked first`;
				} else seen.set(key, p);
			}
			const checks = pairs.filter((p) => p.state === "check");
			const label = (c: Candidate) => `${c.type} ${c.address}:${c.port}`;

			/*
			 * One sentence first, for a reader who has never seen a checklist: what will happen, in words. The fields
			 * after it are the same facts as numbers, for the reader who wants to check them.
			 */
			const pruned = pairs.length - checks.length;
			const relayed = checks.filter((p) => p.l.type === "relay" || p.r.type === "relay").length;
			const words = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
			const summary = [
				`${words(checks.length, "check runs", "checks run")}, starting with ${checks[0]!.b.type} to ${checks[0]!.r.type}.`,
				pruned
					? `${words(pruned, "pair is", "pairs are")} dropped because ${pruned === 1 ? "it" : "each"} would send the same packet from the same place as a better pair.`
					: "",
				relayed ? `${words(relayed, "check goes", "checks go")} through a relay, so ${relayed === 1 ? "it comes" : "they come"} last.` : "",
			]
				.filter(Boolean)
				.join(" ");
			const fields: Field[] = [
				{ label: "In short", value: summary },
				{ label: "Checks", value: `${checks.length}`, note: `${pairs.length} pairs formed, ${pruned} pruned` },
				{ label: "First check", value: `${label(checks[0]!.b)} → ${label(checks[0]!.r)}`, note: `pair priority ${checks[0]!.priority}` },
				{ label: "Controlling", value: localControls ? "local" : "remote", note: "its candidate priorities are G in the formula; the other side's are D" },
				...locals.map((c) => ({ label: `Local ${c.type}, line ${c.line}`, value: String(c.priority), note: decode(c.priority) })),
				...remotes.map((c) => ({ label: `Remote ${c.type}, line ${c.line}`, value: String(c.priority), note: decode(c.priority) })),
			];
			let n = 0;
			const rows: Cell[][] = pairs.map((p) => [
				{ text: p.state === "check" ? String(++n) : "pruned", mono: true, ...(p.state === "pruned" ? { tone: "warn" as const } : {}) },
				{ text: label(p.l), mono: true },
				{ text: p.b !== p.l ? `${p.b.address}:${p.b.port}` : reflexive(p.l) ? "a host, hidden" : "itself", mono: true },
				{ text: label(p.r), mono: true },
				{ text: String(p.priority), mono: true },
				p.why ?? (p.b === p.l && reflexive(p.l) ? "base hidden: a reflexive candidate is sent from the host it was learned from, so if that host is listed this repeats its check" : ""),
			]);
			/*
			 * The grid the post draws: local candidates down, remote across, each cell the pair's place in the check
			 * order. A rank is a quantity of "how far down the list", so the one-hue scale gives a later check more ink (the
			 * host decides which end that is in each theme) and the key's "1 runs first" says which way to read it; a pruned or
			 * impossible pair is an empty cell rather than a colour that would claim a place.
			 */
			const order = new Map(checks.map((p, i) => [p, i + 1]));
			const values = locals.map((l) => remotes.map((r) => {
				const p = pairs.find((x) => x.l === l && x.r === r);
				return p && p.state === "check" ? (order.get(p) ?? null) : null;
			}));
			const parts: Output[] = [
				{ kind: "fields", fields },
				{
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
				},
				{
					kind: "table",
					caption: "Every pair, highest priority first. Pruned pairs would send the same check as one above them",
					columns: [
						{ label: "Check", align: "end", mono: true },
						{ label: "Local candidate", mono: true },
						{ label: "Sent from", mono: true },
						{ label: "Remote candidate", mono: true },
						{ label: "Pair priority", align: "end", mono: true },
						{ label: "Why pruned" },
					],
					rows,
				},
			];
			return { kind: "group", parts };
		} catch (error) {
			if (error instanceof InputError) return { kind: "error", message: error.message, input: error.input };
			throw error;
		}
	},
} satisfies Tool<Input>;
