/**
 * State machine analyzer: a completeness check for a state machine. Every state against every event, which cells nobody
 * decided, which states can't be reached or left, and where two rules disagree.
 *
 * A state machine is usually drawn as its happy path. Written as a table, most of its cells are an event arriving in
 * a state that wasn't waiting for it, and each needs a decision. The input is written the way a person sketches one:
 *
 *     gather:                              a state; the first one is the start
 *       slots_complete -> search           a move
 *       slots_missing -> stay              an outcome: stay, defer, reject, ignore, or back
 *     search:
 *       slot_free -> confirm   # a reason  shown in the gaps and the tests
 *     every state except search:           a block for several states; also "a, b:" and "every state:"
 *       model_unavailable -> degraded
 *       anything else -> reject            every event this state has no other rule for
 *     events: model_back                   an event no rule uses yet
 *
 * A target with no header of its own, `done` say, is where the machine ends: it is not a row, because nothing
 * happens after it. The narrower rule wins: a state's own header beats a block of three, which beats `every state`
 * (and a block that names its states beats an `every state` block as large), and any named event beats
 * `anything else`. Two rules equally narrow that say different things about one cell are a
 * conflict, and the cell is left undecided until someone picks.
 */
import type { Cell, Field, GraphEdge, GraphNode, Output, Tool } from "@toolbench/sdk";

type Input = { machine: string; also: string[] };

class InputError extends Error {
	readonly at?: number;
	readonly len?: number;
	constructor(message: string, at?: number, len?: number) {
		super(message);
		if (at !== undefined) this.at = at;
		if (len !== undefined) this.len = len;
	}
}

export type Kind = "move" | "back" | "stay" | "defer" | "reject" | "ignore";
export type Outcome = { kind: Kind; to: string; line: number; reason: string };

const OUTCOMES = new Set(["stay", "defer", "reject", "ignore", "back"]);
const RESERVED = new Set([...OUTCOMES, "every", "events", "anything"]);
const NAME = /^\w[\w.-]*$/;

/**
 * How a cell reads in the grid. Words and a symbol, so a cell never has to be decoded from a colour. Only the cells
 * that need someone's attention carry a warning tone: an undecided or disputed cell is bad, and defer, which holds an
 * event for later, is warn. Reject is a bare ✕ in the muted tone, on purpose: in a finished machine most cells are
 * rejects, and writing or painting each one as loudly as a gap would hide the moves and the gaps. The legend says
 * what ✕ means.
 */
export function mark(o: Outcome | null, rules = 0): { text: string; tone?: "good" | "warn" | "bad" | "muted" } {
	if (rules > 1) return { text: `${rules} rules`, tone: "bad" };
	if (!o) return { text: "?", tone: "bad" };
	if (o.kind === "move") return { text: `→ ${o.to}`, tone: "good" };
	if (o.kind === "back") return { text: "↩ back", tone: "good" };
	if (o.kind === "reject") return { text: "✕", tone: "muted" };
	if (o.kind === "defer") return { text: "defer", tone: "warn" };
	return { text: o.kind };
}
export const LEGEND =
	"→ moves to that state, ↩ back returns to the state before, ✕ reject drops the event, ? undecided, 2 rules is a conflict.";

type Where = { line: number; at: number; len: number };
type Block = (Where & { names: string[] }) | (Where & { except: string[] });
type Rule = { block: Block; events: string[] | "else"; outcome: Outcome };

export type Machine = {
	states: string[];
	events: string[];
	ends: string[];
	start: string;
	/** One entry per state and event; null where nobody decided or two rules disagree. */
	cells: Map<string, Outcome | null>;
	/** The cells two equally narrow rules disagree about, with every rule that claims them. */
	conflicts: { state: string; event: string; rules: Outcome[] }[];
};

export const key = (s: string, e: string) => `${s}\u0000${e}`;
const split = (raw: string) =>
	raw
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean);
const quote = (s: string) => `"${s}"`;
const and = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** Read the text and resolve every cell. Throws InputError on a line it can't read, naming the line. */
export function parse(text: string): Machine {
	const states: string[] = [];
	const events: string[] = [];
	const blocks: Block[] = [];
	const rules: Rule[] = [];
	const addState = (s: string) => {
		if (!states.includes(s)) states.push(s);
	};
	const addEvent = (e: string) => {
		if (!events.includes(e)) events.push(e);
	};
	let block: Block | null = null;
	let offset = 0;

	for (const [n, raw] of text.split("\n").entries()) {
		const at = offset;
		const len = raw.length;
		offset += raw.length + 1;
		const line = n + 1;
		const hash = raw.indexOf("#");
		const body = (hash < 0 ? raw : raw.slice(0, hash)).trim();
		const reason = hash < 0 ? "" : raw.slice(hash + 1).trim();
		if (!body) continue;
		const fail = (msg: string): never => {
			throw new InputError(`Line ${line}: ${msg}`, at, len);
		};
		const name = (x: string, what: string) => {
			if (!NAME.test(x)) fail(`${quote(x)} isn't a ${what} name. Use letters, digits, _ . and -, with no spaces.`);
			return x;
		};

		const declared = /^events\s*:(.*)$/i.exec(body);
		if (declared) {
			for (const e of split(declared[1] ?? "")) addEvent(name(e, "event"));
			continue;
		}

		const arrow = /->|→|=>/.exec(body);
		if (arrow) {
			if (!block) fail(`${quote(body)} has no state above it. Start with a state and a colon, like "search:".`);
			const lhs = body.slice(0, arrow.index).trim();
			const rhs = body.slice(arrow.index + arrow[0].length).trim();
			if (!lhs) fail("there is no event before the arrow.");
			if (!rhs) fail("there is nothing after the arrow. Write a state, or stay, defer, reject, ignore or back.");
			if (/\s/.test(rhs))
				fail(`after the arrow comes one state, or stay, defer, reject, ignore or back, not ${quote(rhs)}.`);
			const word = rhs.toLowerCase();
			const outcome: Outcome = OUTCOMES.has(word)
				? { kind: word as Kind, to: "", line, reason }
				: { kind: "move", to: name(rhs, "state"), line, reason };
			let evs: string[] | "else";
			if (/^(anything\s+else|\*)$/i.test(lhs)) evs = "else";
			else {
				evs = split(lhs).map((e) => name(e, "event"));
				evs.forEach(addEvent);
			}
			rules.push({ block: block as Block, events: evs, outcome });
			continue;
		}

		if (body.endsWith(":")) {
			const head = body.slice(0, -1).trim();
			const every = /^every\s+states?(?:\s+except\s+(.*))?$/i.exec(head);
			if (every) {
				const except = every[1] === undefined ? [] : split(every[1]);
				if (every[1] !== undefined && !except.length) fail('"except" needs the states to leave out.');
				for (const s of except) name(s, "state");
				block = { line, at, len, except };
			} else {
				const names = split(head);
				if (!names.length) fail("there is a colon with no state before it.");
				for (const s of names) {
					name(s, "state");
					if (RESERVED.has(s.toLowerCase())) fail(`${quote(s)} is a word this tool reads, so it can't be a state.`);
					addState(s);
				}
				block = { line, at, len, names };
			}
			blocks.push(block);
			continue;
		}

		fail(
			`${quote(body)} is neither a state nor a rule. A state ends with a colon, like "search:", and a rule has an arrow, like "slot_free -> confirm".`,
		);
	}

	if (!states.length)
		throw new InputError(
			"There are no states. Write one with a colon, then its rules beneath it:\ngather:\n  slots_complete -> search",
		);
	if (!events.length)
		throw new InputError('There are no events. Write a rule under a state, like "slots_complete -> search".');
	for (const b of blocks)
		if ("except" in b)
			for (const s of b.except)
				if (!states.includes(s))
					throw new InputError(`Line ${b.line}: ${quote(s)} isn't one of the states, ${and(states)}.`, b.at, b.len);

	const members = (b: Block) => ("names" in b ? b.names : states.filter((s) => !b.except.includes(s)));
	const ends: string[] = [];
	for (const r of rules) {
		const o = r.outcome;
		if (o.kind === "move" && !states.includes(o.to) && !ends.includes(o.to)) ends.push(o.to);
	}

	// Narrower wins: a named event beats "anything else", then the block covering fewer states, and a block that
	// names its states beats an "every state" block of the same size, because naming them is the narrower intent.
	const rank = (r: Rule) => (r.events === "else" ? 1e6 : 0) + members(r.block).length + ("names" in r.block ? 0 : 0.5);
	const effect = (o: Outcome, s: string) => (o.kind === "move" && o.to === s ? "stay" : `${o.kind} ${o.to}`);
	const cells = new Map<string, Outcome | null>();
	const conflicts: Machine["conflicts"] = [];
	for (const s of states) {
		for (const e of events) {
			const claim = rules.filter((r) => members(r.block).includes(s) && (r.events === "else" || r.events.includes(e)));
			if (!claim.length) {
				cells.set(key(s, e), null);
				continue;
			}
			const best = Math.min(...claim.map(rank));
			const top = claim.filter((r) => rank(r) === best).map((r) => r.outcome);
			if (new Set(top.map((o) => effect(o, s))).size > 1) {
				conflicts.push({ state: s, event: e, rules: top });
				cells.set(key(s, e), null);
				continue;
			}
			const o = top[0] as Outcome;
			cells.set(key(s, e), o.kind === "move" && o.to === s ? { ...o, kind: "stay", to: "" } : o);
		}
	}
	return { states, events, ends, start: states[0] as string, cells, conflicts };
}

/** States a run from the start can arrive in. `back` returns somewhere already reached, so it adds nothing. */
export function reachable(m: Machine): Set<string> {
	const seen = new Set([m.start]);
	const todo = [m.start];
	for (let s = todo.pop(); s !== undefined; s = todo.pop()) {
		for (const e of m.events) {
			const o = m.cells.get(key(s, e));
			if (o?.kind === "move" && m.states.includes(o.to) && !seen.has(o.to)) {
				seen.add(o.to);
				todo.push(o.to);
			}
		}
	}
	return seen;
}

/** States no event moves anywhere else: once in, the machine stays. */
export function stuck(m: Machine): string[] {
	const leaves = (o: Outcome | null | undefined) => o?.kind === "move" || o?.kind === "back";
	return m.states.filter((s) => !m.events.some((e) => leaves(m.cells.get(key(s, e)))));
}

export const say = (o: Outcome) => (o.kind === "move" ? `-> ${o.to}` : o.kind);
const py = (s: string) => JSON.stringify(s);

export function skeleton(m: Machine): string {
	const disputed = new Map(m.conflicts.map((c) => [key(c.state, c.event), c]));
	const rows: string[] = [];
	for (const s of m.states) {
		for (const e of m.events) {
			const o = m.cells.get(key(s, e));
			const c = disputed.get(key(s, e));
			const expected = o ? py(o.kind === "move" ? o.to : o.kind) : "None";
			const note = c ? `two answers, lines ${and(c.rules.map((r) => String(r.line)))}` : o ? o.reason : "undecided";
			rows.push(`    (${py(s)}, ${py(e)}, ${expected}),${note ? `  # ${note}` : ""}`);
		}
	}
	return [
		"import pytest",
		"",
		"# One case per cell: (state, event, what should happen). A state's name is a move; stay, defer,",
		"# reject and ignore keep the machine where it is; back returns to the state it came from.",
		"# None is a cell with no rule yet, so its test fails until one is written.",
		"CELLS = [",
		...rows,
		"]",
		"",
		"",
		"def deliver(state, event):",
		'    """Put your machine in `state`, deliver `event`, and return the new state or the outcome word."""',
		"    raise NotImplementedError",
		"",
		"",
		'@pytest.mark.parametrize("state, event, expected", CELLS, ids=[f"{s}-{e}" for s, e, _ in CELLS])',
		"def test_cell(state, event, expected):",
		"    if expected is None:",
		'        pytest.fail(f"no rule says what {event} does in {state}")',
		"    assert deliver(state, event) == expected",
		"",
	].join("\n");
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The shape, in one value: a conflict first, because it is a bug, then the states that can't be reached or left.
 * Null when there is nothing to say, so the coverage line does not gain a "None" field.
 */
function shape(m: Machine, unreachable: string[], noExit: string[]): Field | null {
	const c0 = m.conflicts[0];
	if (c0)
		return {
			label: "Conflicts",
			value: `${plural(m.conflicts.length, "cell")} with two answers`,
			note: `${c0.state} on ${c0.event}: lines ${and(c0.rules.map((r) => String(r.line)))} say different things.`,
			tone: "bad",
		};
	if (unreachable.length || noExit.length) {
		const same = unreachable.length === noExit.length && unreachable.every((s) => noExit.includes(s));
		const value = same
			? `${and(unreachable)} can't be reached or left`
			: [
					...(unreachable.length ? [`${and(unreachable)} can't be reached`] : []),
					...(noExit.length ? [`${and(noExit)} can't be left`] : []),
				].join(", and ");
		return { label: "Shape", value, mono: false };
	}
	return null;
}

/**
 * The happy path, as the author wrote it: from the start, take each state's first-written move to somewhere not yet
 * visited, until an end or a state with nowhere new to go. First-written rather than shortest, because a shortcut
 * such as `committed -> report` is an exception path, and the drawing a person starts from lists the happy path first.
 */
export function mainPath(m: Machine): string[] {
	const path = [m.start];
	for (let s: string | undefined = m.start; s && m.states.includes(s); ) {
		const here: string = s;
		const next = m.events
			.map((e) => m.cells.get(key(here, e)))
			.filter((o): o is Outcome => o?.kind === "move" && !path.includes(o.to))
			.sort((a, b) => a.line - b.line)[0];
		s = next?.to;
		if (s) path.push(s);
	}
	return path;
}

/** Up to three event names, then a count, so a label stays one short line. */
const few = (es: string[]) => (es.length > 3 ? `${es.slice(0, 2).join(", ")} and ${es.length - 2} more` : and(es));

/**
 * The machine as states and arrows, one arrow per pair of states, labelled with the events that take it.
 *
 * Only moves are drawn. A `stay` (and defer, reject, ignore) leaves the state where it is, so as a self-loop it would
 * put a loop on almost every node of a finished machine, 22 of them in the booking, and say nothing the grid doesn't.
 * A `back` is dashed, to each state that moves into it, because that is where it can return to.
 */
export function graph(m: Machine, unreachable: string[], noExit: string[]): Output {
	const path = mainPath(m);
	const nodes: GraphNode[] = [
		...m.states.map((s): GraphNode => {
			const lost = unreachable.includes(s);
			const stuckHere = noExit.includes(s);
			const note =
				lost && stuckHere ? "can't be reached or left" : lost ? "can't be reached" : stuckHere ? "no way out" : "";
			return {
				id: s,
				...(note ? { note, tone: "warn" as const } : {}),
				...(s === m.start ? { badge: "start" } : {}),
				...(path.includes(s) ? { rank: path.indexOf(s) } : {}),
			};
		}),
		...m.ends.map(
			(s): GraphNode => ({
				id: s,
				shape: "pill",
				note: "end",
				...(path.includes(s) ? { rank: path.indexOf(s) } : {}),
			}),
		),
	];
	const moves = new Map<string, { from: string; to: string; events: string[]; back: boolean }>();
	const add = (from: string, to: string, e: string, back: boolean) => {
		const k = `${key(from, to)}\u0000${back}`;
		const edge = moves.get(k) ?? { from, to, events: [], back };
		edge.events.push(e);
		moves.set(k, edge);
	};
	for (const s of m.states)
		for (const e of m.events) {
			const o = m.cells.get(key(s, e));
			if (o?.kind === "move") add(s, o.to, e, false);
		}
	for (const s of m.states)
		for (const e of m.events) {
			if (m.cells.get(key(s, e))?.kind !== "back") continue;
			const from = m.states.filter((p) => p !== s && m.events.some((x) => m.cells.get(key(p, x))?.to === s));
			for (const p of from) add(s, p, e, true);
		}
	const edges = [...moves.values()].map(
		(x): GraphEdge => ({
			from: x.from,
			to: x.to,
			label: x.back ? `${few(x.events)}, back` : few(x.events),
			...(x.back ? { line: "dashed" as const } : {}),
		}),
	);
	return {
		kind: "graph",
		graph: {
			label: `The machine's moves, from ${m.start}`,
			layout: "layered",
			direction: "LR",
			nodes,
			edges,
			...(path.length > 1 ? { highlight: path } : {}),
		},
	};
}

export default {
	run(input: Input) {
		try {
			const m = parse(String(input.machine ?? ""));
			const all = [...m.cells.values()];
			const decided = all.filter((o): o is Outcome => o !== null);
			const open = all.length - decided.length;
			const reach = reachable(m);
			const unreachable = m.states.filter((s) => !reach.has(s));
			const noExit = stuck(m);

			const count = (k: Kind) => decided.filter((o) => o.kind === k || (k === "move" && o.kind === "back")).length;
			const kinds = (["move", "stay", "defer", "ignore", "reject"] as const)
				.map((k) => [k, count(k)] as const)
				.filter(([, n]) => n > 0)
				.map(([k, n]) => plural(n, k));
			/*
			 * ⚠️ One coverage line comes first, and it is what a card shows. It replaced a "Biggest gap" headline that
			 * forced four tied event names into one sentence, and three tiles that were one fraction.
			 */
			const gap = shape(m, unreachable, noExit);
			const coverage: Output = {
				kind: "fields",
				role: "answer",
				fields: [
					{
						label: "Decided",
						value: `${decided.length} of ${all.length} pairs`,
						note: `${plural(m.states.length, "state")} x ${plural(m.events.length, "event")}${kinds.length ? `: ${and(kinds)}` : ""}. It starts at ${m.start}${m.ends.length ? ` and ends at ${and(m.ends)}` : ""}.`,
					},
					{
						label: "Undecided",
						value: String(open),
						note: open ? "Marked ? in the table, most open events first." : "Every pair has an answer.",
					},
					...(gap ? [gap] : []),
				],
			};

			const disputed = new Map(m.conflicts.map((c) => [key(c.state, c.event), c.rules.length]));
			const cell = (s: string, e: string) => mark(m.cells.get(key(s, e)) ?? null, disputed.get(key(s, e)));
			// A pasted table loses the grid's legend-at-a-glance and often its caption, so a reject keeps its word there.
			const word = (s: string, e: string) => (m.cells.get(key(s, e))?.kind === "reject" ? "✕ reject" : cell(s, e).text);
			/*
			 * The least-decided events on top, ties in the order written, so the rows to work on are the first a reader
			 * sees, and a finished machine keeps its written order. `matrix` so it scrolls on a phone rather than
			 * stacking into one card per event.
			 */
			const openIn = (e: string) => m.states.filter((s) => !m.cells.get(key(s, e))).length;
			const byOpen = m.events
				.map((e, i) => ({ e, i, n: openIn(e) }))
				.sort((x, y) => y.n - x.n || x.i - y.i)
				.map((x) => x.e);
			const grid: Output = {
				kind: "table",
				role: "matrix",
				caption: LEGEND,
				columns: [
					{ label: "Event", wrap: "none", rowHeader: true },
					...m.states.map((s) => ({ label: s, mono: true, wrap: "none" as const })),
				],
				rows: byOpen.map((e): Cell[] => [{ text: e, mono: true }, ...m.states.map((s) => cell(s, e))]),
			};

			const said = (o: Outcome) => `line ${o.line} says ${say(o)}${o.reason ? ` (${o.reason})` : ""}`;
			const gaps = [
				...m.conflicts.map((c) => ({
					gap: "Two answers",
					tone: "bad" as const,
					where: `${c.state} on ${c.event}`,
					why: `${c.rules.map(said).join("; ").replace(/^l/, "L")}.`,
				})),
				...unreachable.map((s) => ({
					gap: "Can't be reached",
					tone: "warn" as const,
					where: s,
					why: `Nothing leads here from ${m.start}, the start.`,
				})),
				...noExit.map((s) => ({
					gap: "No way out",
					tone: "warn" as const,
					where: s,
					why: "No event moves it to another state.",
				})),
			];
			const parts: Output[] = [coverage, grid, graph(m, unreachable, noExit)];
			if (gaps.length)
				parts.push({
					kind: "table",
					caption: "Gaps",
					columns: [
						{ label: "Gap", wrap: "none" },
						{ label: "Where", mono: true, wrap: "none" },
						{ label: "Why", wrap: "prose" },
					],
					rows: gaps.map((g): Cell[] => [{ text: g.gap, tone: g.tone }, { text: g.where, mono: true }, g.why]),
				});
			if (input.also.includes("markdown")) {
				const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
				const md = [
					`${all.length} cells: ${decided.length} decided, ${open} undecided.`,
					"",
					row(["Event", ...m.states]),
					row(["---", ...m.states.map(() => "---")]),
					...byOpen.map((e) => row([e, ...m.states.map((s) => word(s, e))])),
					"",
					LEGEND,
					...(gaps.length ? ["", "Gaps:", "", ...gaps.map((g) => `- ${g.gap}: ${g.where}. ${g.why}`)] : []),
					"",
				];
				parts.push({ kind: "code", lang: "markdown", source: md.join("\n") });
			}
			if (input.also.includes("pytest")) parts.push({ kind: "code", lang: "python", source: skeleton(m) });
			return { kind: "group", parts };
		} catch (error) {
			if (error instanceof InputError)
				return {
					kind: "error",
					message: error.message,
					input: "machine",
					...(error.at !== undefined ? { at: error.at } : {}),
					...(error.len !== undefined ? { len: error.len } : {}),
				};
			throw error;
		}
	},
} satisfies Tool<Input>;
