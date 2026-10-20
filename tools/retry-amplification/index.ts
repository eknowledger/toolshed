/**
 * How many calls reach the bottom of a call chain when every layer retries.
 *
 * Retries look additive in a config file, "2 here, 3 there", and they are not. A layer that retries wraps the one
 * below it, so it multiplies: code that makes 3 attempts through a proxy that makes 3 makes 9, and every call further
 * down sees all of them. With depth `d` and `n` attempts per call, the bottom sees `n^d` calls for one user request
 * when it is failing, which is exactly when it can least afford them.
 *
 * The arithmetic, layer by layer from the bottom up: a layer making `n` attempts over something that fails with
 * probability `f` makes `1 + f + ... + f^(n-1)` attempts on average, and fails with probability `f^n`. Failures are
 * independent and only at the bottom; nothing in the middle fails on its own.
 *
 * A retry budget, as Envoy and the SRE book describe it, caps each layer's retries at a share of its requests, so
 * no layer can multiply by more than `1 + budget`. Here it is that cap and nothing more: real budgets are measured
 * over a window or over concurrent requests, so read the capped numbers as a ceiling.
 *
 * The same arithmetic as `service-mesh/retry_fanout.py` in mainlog-code; the fixtures are its output.
 *
 * The answer comes first, with its multiplication, then the chain it multiplies along, then what to change, the
 * biggest cut first. Each change is scored by running the same arithmetic with that change made, so "turn on a
 * budget" says how many calls it leaves, not just that it helps.
 */
import type { Cell, Field, GraphEdge, GraphNode, Output, Tool } from "@toolbench/sdk";

/**
 * `platform` is the Mesh preset select. It only fills `mesh` in the form, so the arithmetic reads the number and never the
 * name: a reader who picks Istio and then types 5 gets 5.
 */
type Input = { depth: number; platform?: string; mesh: number; app: number; client: number; fail: number; budget: string };

class InputError extends Error {
	readonly input: string;

	constructor(message: string, input: string) {
		super(message);
		this.name = "InputError";
		this.input = input;
	}
}

type Layer = { call: number; who: "proxy" | "code" | "client"; attempts: number };

/** The retry layers from the bottom up. Call 1 is the deepest. */
function layersOf(depth: number, mesh: number, app: number, client: number): Layer[] {
	const out: Layer[] = [];
	for (let c = 1; c <= depth; c++) {
		out.push({ call: c, who: "proxy", attempts: 1 + mesh });
		if (app) out.push({ call: c, who: "code", attempts: 1 + app });
	}
	if (client) out.push({ call: depth + 1, who: "client", attempts: 1 + client });
	return out;
}

/** Fixed places, without a trailing ".00" on whole numbers, so 27 reads as 27 and 1.728 as 1.728. */
function num(x: number, places = 2): string {
	if (Number.isInteger(x)) return x.toLocaleString("en-US");
	return Number(x.toFixed(places)).toLocaleString("en-US", { maximumFractionDigits: places });
}

function chance(f: number): string {
	if (f === 0) return "0%";
	if (f >= 0.0001) return `${num(f * 100, 2)}%`;
	return `1 in ${Math.round(1 / f).toLocaleString("en-US")}`;
}

/** Fewest calls at the bottom, worst case, for a chain of retry layers given as attempts each, after `cap`. */
const product = (attempts: number[], cap: (m: number) => number) => attempts.reduce((w, n) => w * cap(n), 1);

/**
 * Calls at the bottom for one user request, walking the layers up from the bottom: the worst case, when every try
 * fails; the average, when each call to the bottom fails with probability `p`; and the chance the user's request
 * still fails. Exported so the tests can check the exact arithmetic behind a number the page rounds.
 */
export function bottomCalls(
	depth: number,
	mesh: number,
	app: number,
	client: number,
	p: number,
	budget: number | null,
): { worst: number; expected: number; stillFails: number } {
	const cap = (m: number) => (budget === null ? m : Math.min(m, 1 + budget));
	let worst = 1;
	let expected = 1;
	let f = p;
	for (const layer of layersOf(depth, mesh, app, client)) {
		worst *= cap(layer.attempts);
		let m = 0;
		for (let j = 0; j < layer.attempts; j++) m += f ** j;
		expected *= cap(m);
		f = f ** layer.attempts;
	}
	return { worst, expected, stillFails: f };
}

/**
 * A count of calls as a reader should read it. Whole numbers are exact; anything else comes from a budget or an
 * average, which are models, so one decimal and "about": 1.728 is a cap computed as if the budget always binds,
 * and three decimals claimed a precision the model does not have.
 */
function calls(x: number): string {
	if (Number.isInteger(x)) return `${x.toLocaleString("en-US")} ${x === 1 ? "call" : "calls"}`;
	return `about ${num(x, 1)} calls`;
}
const bare = (x: number) => (Number.isInteger(x) ? x.toLocaleString("en-US") : `about ${num(x, 1)}`);

export default {
	run(input: Input) {
		try {
			const depth = Number(input.depth);
			const mesh = Number(input.mesh);
			const app = Number(input.app);
			const client = Number(input.client);
			const p = Number(input.fail) / 100;
			if (!(Number.isInteger(depth) && depth >= 1 && depth <= 12))
				throw new InputError("Depth is a whole number of calls, 1 to 12.", "depth");
			for (const [v, key, label] of [
				[mesh, "mesh", "Proxy retries"],
				[app, "app", "Code retries"],
				[client, "client", "Client retries"],
			] as const) {
				if (!(Number.isInteger(v) && v >= 0 && v <= 10))
					throw new InputError(`${label} must be a whole number from 0 to 10.`, key);
			}
			if (!(p >= 0 && p <= 1)) throw new InputError("The failure share is a percentage from 0 to 100.", "fail");
			const budget = input.budget === "none" ? null : Number(input.budget) / 100;
			if (budget !== null && !(budget > 0 && budget < 1)) throw new InputError("Unknown budget.", "budget");

			const layers = layersOf(depth, mesh, app, client);
			const cap = (m: number) => (budget === null ? m : Math.min(m, 1 + budget));
			const { worst, expected, stillFails } = bottomCalls(depth, mesh, app, client, p, budget);

			const perCall = (1 + mesh) * (app ? 1 + app : 1);
			const perCallWorst = cap(1 + mesh) * (app ? cap(1 + app) : 1);
			const clientMul = client ? cap(1 + client) : 1;

			/* Calls each service receives, top first: the top service gets the user's tries, the bottom gets the most. */
			const services: { name: string; worst: number }[] = [];
			for (let level = 0; level <= depth; level++) {
				services.push({
					name: level === 0 ? "Top service" : level === depth ? "Bottom service" : `Service ${level + 1}`,
					worst: clientMul * perCallWorst ** level,
				});
			}

			/*
			 * ⚠️ The answer comes first, said once. It used to be said four times, in a banner, a tile, the tree and a
			 * table, and the number a reader came for was the same in all four. No tone: a count is not a verdict, and
			 * the post this embeds in is about what the count means.
			 */
			const key: Output = {
				kind: "fields",
				role: "key",
				fields: [
					{
						label: "Calls at the bottom service",
						value: calls(worst),
						note:
							budget === null
								? "For one user request, while it is down."
								: `At most, for one user request while it is down, if the ${num(budget * 100)}% budget binds.`,
					},
				],
			};

			/*
			 * The multiplication behind it. With a budget the factors are the cap, not the retries, because the cap is
			 * what multiplies.
			 */
			const factors =
				budget === null
					? [...(client ? [`${1 + client} from the client`] : []), ...Array.from({ length: depth }, () => String(perCall))]
					: layers.map(() => num(1 + budget, 2));
			const formula =
				budget === null
					? `${perCall} ${perCall === 1 ? "try" : "tries"} per call${app ? ` (${1 + app} in the code, each through ${1 + mesh} in the proxy)` : ""}, ${depth} ${depth === 1 ? "call" : "calls"} deep: ${factors.join(" x ")} = ${bare(worst)}`
					: `${layers.length} retrying ${layers.length === 1 ? "layer" : "layers"}, each capped at ${num(1 + budget, 2)} times its traffic: ${factors.join(" x ")} = ${bare(worst)}`;

			/*
			 * Each change, scored by the same arithmetic with it made. Only changes that lower the worst case are offered,
			 * and the biggest reduction comes first. The reason each works is in the method notes, so the table stays
			 * two columns that fit a phone.
			 */
			const proxyOnly = (n: number) => Array.from({ length: depth }, () => n);
			const withClient = (xs: number[]) => (client ? [...xs, 1 + client] : xs);
			const candidates: { what: string; after: number; why: string }[] = [];
			if (app && mesh) {
				candidates.push({
					what: "Retry in the code or the proxy, not both",
					after: product(withClient(proxyOnly(Math.max(1 + app, 1 + mesh))), cap),
					why: `The code's ${1 + app} tries each go through the proxy's ${1 + mesh}, so every call makes ${perCall}.`,
				});
			}
			if (depth > 1 && perCall > 1) {
				candidates.push({
					what: "Retry only at the top",
					after: product(withClient([perCall]), cap),
					why: `${depth} calls in a row each retry, so their tries multiply. Retrying once, at the top, and failing fast below it stops that.`,
				});
			}
			if (budget === null) {
				candidates.push({
					what: "A 20% retry budget",
					after: product(
						layers.map((l) => l.attempts),
						(m) => Math.min(m, 1.2),
					),
					why: "Retries are allowed only while they are a small share of a layer's requests: 20% is Envoy's default once a budget is turned on. Envoy's always allows 3 at once, so at low traffic it does not bind.",
				});
			}
			if (client) {
				candidates.push({
					what: "No client retries",
					after: product(
						layersOf(depth, mesh, app, 0).map((l) => l.attempts),
						cap,
					),
					why: `Each of the client's ${1 + client} tries goes down the whole chain again. Waiting for a Retry-After has the same effect.`,
				});
			}
			const changes = candidates.filter((c) => c.after < worst * 0.95).sort((a, b) => a.after - b.after);

			const parts: Output[] = [
				key,
				{ kind: "text", role: "formula", mono: true, text: formula },
				chain(depth, client, perCallWorst, services, budget),
			];
			if (changes.length) {
				parts.push({
					kind: "table",
					role: "comparison",
					caption: "What each change leaves at the bottom",
					columns: [{ label: "Change" }, { label: "Calls at the bottom", align: "end", mono: true }],
					rows: changes.map((c): Cell[] => [c.what, { text: bare(c.after), mono: true }]),
				});
			}

			/*
			 * The partial-failure numbers only mean something when the bottom is not simply down: at 100% the average is
			 * the worst case and every request fails, which says nothing the answer has not.
			 */
			if (p < 1) {
				parts.push({
					kind: "fields",
					role: "metrics",
					fields: [
						{
							label: `When the bottom fails ${num(p * 100, 2)}%`,
							value: calls(expected),
							note: "The average for each user request: extra load on a service that is already failing.",
						},
						...(budget === null
							? [
									{
										label: "User requests that still fail",
										value: chance(stillFails),
										note: `If failures were independent. Real ones come in runs, so this is the best case. Without retries, ${chance(p)}.`,
									},
								]
							: []),
					],
				});
			}

			const method: Field[] = [
				{
					group: "How this was worked out",
					label: "Every layer retries the error it gets",
					value: "As a gRPC service that passes UNAVAILABLE up does",
					note: "Failures are independent and happen only at the bottom; nothing in the middle fails on its own.",
				},
			];
			if (budget !== null) {
				method.push({
					group: "How this was worked out",
					label: "The budget",
					value: `Each layer at most ${num(1 + budget, 2)} times its traffic`,
					note: "Real budgets are counted over a window or over requests in flight, so read the capped numbers as a ceiling.",
				});
			}
			for (const c of changes) method.push({ group: "Why each change works", label: c.what, value: c.why });
			parts.push({ kind: "fields", role: "method", fields: method });

			return { kind: "group", parts };
		} catch (error) {
			if (error instanceof InputError) return { kind: "error", message: error.message, input: error.input };
			throw error;
		}
	},
} satisfies Tool<Input>;

/**
 * The chain, one node per service, top to bottom, each edge labelled with how many times it multiplies.
 *
 * ⚠️ Not a tree of every try. The earlier tree followed the first try down and stood the others in as "try 2: 9 more
 * below, not drawn", which described the renderer rather than the system. One node per service with its total, and
 * "x3" on every hop, says the only thing the picture is for: it multiplies at every hop.
 */
function chain(
	depth: number,
	client: number,
	perCallWorst: number,
	services: { name: string; worst: number }[],
	budget: number | null,
): Output {
	const times = (x: number) => `x${num(x, 2)}`;
	const nodes: GraphNode[] = [{ id: "user", label: "User request", shape: "pill" }];
	const edges: GraphEdge[] = [];
	services.forEach((s, level) => {
		const id = `s${level}`;
		nodes.push({ id, label: s.name, note: calls(s.worst), role: level === depth ? "bottom" : "service" });
		const from = level === 0 ? "user" : `s${level - 1}`;
		const by = level === 0 ? (client ? services[0]!.worst : 1) : perCallWorst;
		edges.push({ from, to: id, ...(by !== 1 ? { label: times(by) } : {}) });
	});
	return {
		kind: "graph",
		graph: {
			label:
				budget === null
					? "Calls each service receives for one user request while the bottom is down"
					: `Calls each service receives for one user request while the bottom is down, with a ${num(budget * 100)}% budget`,
			layout: "layered",
			direction: "TB",
			spacing: "compact",
			nodes,
			edges,
		},
	};
}
