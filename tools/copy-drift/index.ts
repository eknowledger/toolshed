/**
 * Copy drift: two copies of a function, how alike they are, where they differ, and, given each one's git history,
 * whether they have been changing together or drifting apart.
 *
 * Three things a reader cannot do by eye, each a place the usual rule of thumb ("three copies, then abstract") goes
 * wrong:
 *
 *  1. **How alike, once names are set aside.** `get(url)` and `head(link)` are the same code. Every identifier,
 *     string and number becomes a placeholder, and the two token streams are compared with the ratio Python's
 *     difflib computes, 2M/T: matched tokens, twice, over the total. The algorithm is difflib's own, ported, with
 *     autojunk off, so a Python figure and this one agree.
 *  2. **Where they differ, and whether only in names.** A line diff of the two, each differing line marked as a name
 *     change (the same shape) or a real one.
 *  3. **Whether they move together.** From two `git log` listings, the commits that changed both, only one, or only
 *     the other, counted only after both copies existed. That last rule is the one that matters: `git log -L`
 *     follows a range of lines back past the moment it became a copy, and a change made when there was one copy
 *     is not a one-sided change.
 *
 * What it deliberately cannot do: say whether a one-sided change was a missed update or a deliberate difference.
 * Only reading the diff can. It leads with how many there are and lists them, newest first, so you can, then shows
 * where the code differs today, above the history that produced it.
 *
 * Six inputs, down from nine in 1.x: the language is read from the code, the comparison is always of the bodies,
 * and the near-duplicate line is fixed at cochange.py's 85%. Each is stated in the result, so nothing is hidden.
 */
import type { Cell, Field, Output, Series, Tool } from "@toolbench/sdk";

type Input = {
	a: string;
	b: string;
	historya: string;
	historyb: string;
	since: string;
	ignore: string;
};

class InputError extends Error {
	readonly input: string;
	constructor(message: string, input: string) {
		super(message);
		this.input = input;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Tokens

export type Lang = "python" | "js" | "c";

/** Python 3.12's keyword.kwlist: soft keywords such as `match` and `type` are names, as tokenize treats them. */
const PY_KEYWORDS = new Set(
	"False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(
		" ",
	),
);

const JS_KEYWORDS = new Set(
	"abstract as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface keyof let new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield".split(
		" ",
	),
);

/** The union of C, C++, C#, Java, Go, Rust, Kotlin and Swift keywords: one list, so `map` is a keyword in C too. */
const C_KEYWORDS = new Set(
	"abstract as async auto await bool break case catch chan char class const continue default defer delete do double else enum extends extern false final finally float fn for fun func go goto if impl implements import in init int interface is let long loop map match mod mut namespace new nil null object operator override package private protected pub public range register return select self short signed sizeof static struct super switch template this throw trait true try type typedef typename union unsigned use using val var virtual void volatile when where while yield".split(
		" ",
	),
);

const PY_OPS = [
	"**=",
	"//=",
	">>=",
	"<<=",
	"...",
	"->",
	":=",
	"**",
	"//",
	"<<",
	">>",
	"<=",
	">=",
	"==",
	"!=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"@=",
];
const C_OPS = [
	">>>=",
	"<<=",
	">>=",
	">>>",
	"===",
	"!==",
	"**=",
	"&&=",
	"||=",
	"??=",
	"...",
	"->",
	"=>",
	"::",
	"?.",
	"??",
	"&&",
	"||",
	"++",
	"--",
	"<<",
	">>",
	"<=",
	">=",
	"==",
	"!=",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	":=",
	"**",
	"<-",
];
const SINGLE = "+-*/%@&|^~<>()[]{},:;.=!?";

const NAME_START = /[A-Za-z_$\u0080-￿]/;
const NAME_PART = /[A-Za-z0-9_$\u0080-￿]/;
const NUMBER =
	/^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?[jJlLfFdDuU]*n?)/;
const PY_STRING_START = /^([rRbBuUfF]{0,2})('''|"""|'|")/;

/** A token as the comparison sees it, and the text it came from, which the "text" comparison uses instead. */
export interface Token {
	shape: string;
	text: string;
}

class Lexer {
	readonly out: Token[] = [];
	readonly src: string;
	readonly lang: Lang;
	pos = 0;
	constructor(src: string, lang: Lang) {
		this.src = src;
		this.lang = lang;
	}

	keyword(name: string): boolean {
		return (this.lang === "python" ? PY_KEYWORDS : this.lang === "js" ? JS_KEYWORDS : C_KEYWORDS).has(name);
	}

	push(shape: string, text: string) {
		this.out.push({ shape, text });
	}

	/** Read tokens until the end, or until `stop` says so at bracket depth zero. Returns the stopping character. */
	run(stop?: (ch: string, next: string) => boolean): string | null {
		const s = this.src;
		let depth = 0;
		while (this.pos < s.length) {
			const ch = s[this.pos]!;
			const next = s[this.pos + 1] ?? "";
			if (stop && depth === 0 && stop(ch, next)) return ch;
			if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\\") {
				this.pos++;
				continue;
			}
			if (this.lang === "python" ? ch === "#" : ch === "/" && next === "/") {
				while (this.pos < s.length && s[this.pos] !== "\n") this.pos++;
				continue;
			}
			if (this.lang !== "python" && ch === "/" && next === "*") {
				const end = s.indexOf("*/", this.pos + 2);
				this.pos = end < 0 ? s.length : end + 2;
				continue;
			}
			if (this.lang === "python") {
				const m = PY_STRING_START.exec(s.slice(this.pos, this.pos + 5));
				if (m && (m[1] === "" || /^(?:[rRuUbBfF]|[rR][bBfF]|[bBfF][rR])$/.test(m[1]!))) {
					this.pyString(m[1]!, m[2]!);
					continue;
				}
			} else if (ch === '"' || ch === "'" || ch === "`") {
				this.quoted(ch);
				continue;
			}
			if (NAME_START.test(ch)) {
				let end = this.pos + 1;
				while (end < s.length && NAME_PART.test(s[end]!)) end++;
				const name = s.slice(this.pos, end);
				this.push(this.keyword(name) ? name : "ID", name);
				this.pos = end;
				continue;
			}
			const num = /[0-9.]/.test(ch) ? NUMBER.exec(s.slice(this.pos)) : null;
			if (num && num[0] !== "" && num[0] !== ".") {
				this.push("NUM", num[0]);
				this.pos += num[0].length;
				continue;
			}
			const ops = this.lang === "python" ? PY_OPS : C_OPS;
			const op = ops.find((o) => s.startsWith(o, this.pos)) ?? (SINGLE.includes(ch) ? ch : null);
			if (op) {
				if ("([{".includes(op)) depth++;
				else if (")]}".includes(op)) depth = Math.max(0, depth - 1);
				this.push(op, op);
				this.pos += op.length;
				continue;
			}
			this.pos++; // a character no language here has a token for: skipped, as tokenize would report and move on
		}
		return null;
	}

	/** A string in a C-family language: one STR, whatever is inside, template literals included. */
	quoted(q: string) {
		const s = this.src;
		const start = this.pos;
		let i = this.pos + 1;
		while (i < s.length && s[i] !== q) {
			if (s[i] === "\\") i++;
			else if (s[i] === "\n" && q !== "`") break;
			i++;
		}
		this.pos = Math.min(i + 1, s.length);
		this.push("STR", s.slice(start, this.pos));
	}

	/**
	 * A Python string. A plain one is one STR. An f-string is what Python 3.12's tokenize makes of it: the literal text
	 * is dropped, and each replacement field yields `{`, its expression's tokens, a `!` conversion, a `:` and any
	 * nested fields of its format spec, and `}`.
	 */
	pyString(prefix: string, q: string) {
		const s = this.src;
		const start = this.pos;
		const raw = /[rR]/.test(prefix);
		this.pos += prefix.length + q.length;
		if (!/[fF]/.test(prefix)) {
			while (this.pos < s.length && !s.startsWith(q, this.pos)) {
				if (s[this.pos] === "\\") this.pos++;
				else if (q.length === 1 && s[this.pos] === "\n") break;
				this.pos++;
			}
			this.pos = Math.min(this.pos + q.length, s.length);
			this.push("STR", s.slice(start, this.pos));
			return;
		}
		this.fstringBody(q, raw, false);
	}

	/** The literal part of an f-string, or of a format spec (`inSpec`, which ends at the field's closing brace). */
	fstringBody(q: string, raw: boolean, inSpec: boolean) {
		const s = this.src;
		while (this.pos < s.length) {
			if (inSpec && s[this.pos] === "}") return;
			if (!inSpec && s.startsWith(q, this.pos)) {
				this.pos += q.length;
				return;
			}
			const ch = s[this.pos]!;
			if (ch === "\\" && !raw) {
				this.pos += 2;
				continue;
			}
			if (ch === "{" && s[this.pos + 1] === "{" && !inSpec) {
				this.pos += 2;
				continue;
			}
			if (ch === "}" && s[this.pos + 1] === "}" && !inSpec) {
				this.pos += 2;
				continue;
			}
			if (ch === "{") {
				this.field(q, raw);
				continue;
			}
			if (q.length === 1 && ch === "\n") return;
			this.pos++;
		}
	}

	/** One replacement field, from its `{` to its `}`. */
	field(q: string, raw: boolean) {
		this.push("{", "{");
		this.pos++;
		const stop = (ch: string, next: string) =>
			ch === "}" || ch === ":" || (ch === "!" && next !== "=") || this.src.startsWith(q, this.pos);
		let at = this.run(stop);
		if (at === "!") {
			this.push("!", "!");
			this.pos++;
			at = this.run(stop);
		}
		if (at === ":") {
			this.push(":", ":");
			this.pos++;
			this.fstringBody(q, raw, true);
		}
		if (this.src[this.pos] === "}") {
			this.push("}", "}");
			this.pos++;
		}
	}
}

/** Common leading whitespace removed, as textwrap.dedent does, so a method pasted from inside a class still lexes. */
export function dedent(src: string): string {
	const lines = src.replace(/\r\n?/g, "\n").split("\n");
	let common: string | null = null;
	for (const line of lines) {
		if (!line.trim()) continue;
		const lead = /^[ \t]*/.exec(line)![0];
		if (common === null) common = lead;
		else {
			let i = 0;
			while (i < common.length && i < lead.length && common[i] === lead[i]) i++;
			common = common.slice(0, i);
		}
	}
	const cut = common?.length ?? 0;
	return lines.map((l) => (l.trim() ? l.slice(cut) : "")).join("\n");
}

export function tokens(src: string, lang: Lang): Token[] {
	const lexer = new Lexer(dedent(src), lang);
	lexer.run();
	return lexer.out;
}

/**
 * The body alone: what follows the signature, and for Python the docstring, which is how cochange.py compares two
 * functions. Two copies with different parameter lists (a module-level wrapper and the method it wraps) can have
 * nearly identical bodies, and the signature would hide that.
 */
export function body(ts: Token[], lang: Lang): Token[] {
	let depth = 0;
	if (lang === "python") {
		const def = ts.findIndex((t) => t.text === "def");
		if (def < 0) return ts;
		for (let i = def + 1; i < ts.length; i++) {
			const t = ts[i]!.text;
			if (t === "(" || t === "[" || t === "{") depth++;
			else if (t === ")" || t === "]" || t === "}") depth--;
			else if (t === ":" && depth === 0) {
				const rest = ts.slice(i + 1);
				return rest.length > 1 && rest[0]!.shape === "STR" ? rest.slice(1) : rest;
			}
		}
		return ts;
	}
	for (let i = 0; i < ts.length; i++) {
		const t = ts[i]!.text;
		if (t === "(" || t === "[") depth++;
		else if (t === ")" || t === "]") depth--;
		else if (t === "{" && depth === 0) {
			const rest = ts.slice(i + 1);
			return rest.length && rest[rest.length - 1]!.text === "}" ? rest.slice(0, -1) : rest;
		}
	}
	return ts;
}

export function shape(src: string, lang: Lang): string[] {
	return tokens(src, lang).map((t) => t.shape);
}

// ---------------------------------------------------------------------------------------------------------------
// difflib.SequenceMatcher, without junk: the same matching blocks, so the same ratio, as Python's

type Block = [number, number, number];

export class Matcher<T> {
	private readonly b2j = new Map<T, number[]>();
	readonly a: readonly T[];
	readonly b: readonly T[];
	constructor(a: readonly T[], b: readonly T[]) {
		this.a = a;
		this.b = b;
		b.forEach((x, j) => {
			const at = this.b2j.get(x);
			if (at) at.push(j);
			else this.b2j.set(x, [j]);
		});
	}

	longest(alo: number, ahi: number, blo: number, bhi: number): Block {
		let besti = alo;
		let bestj = blo;
		let bestsize = 0;
		let j2len = new Map<number, number>();
		for (let i = alo; i < ahi; i++) {
			const next = new Map<number, number>();
			for (const j of this.b2j.get(this.a[i]!) ?? []) {
				if (j < blo) continue;
				if (j >= bhi) break;
				const k = (j2len.get(j - 1) ?? 0) + 1;
				next.set(j, k);
				if (k > bestsize) {
					besti = i - k + 1;
					bestj = j - k + 1;
					bestsize = k;
				}
			}
			j2len = next;
		}
		return [besti, bestj, bestsize];
	}

	blocks(): Block[] {
		const queue: [number, number, number, number][] = [[0, this.a.length, 0, this.b.length]];
		const found: Block[] = [];
		while (queue.length) {
			const [alo, ahi, blo, bhi] = queue.pop()!;
			const [i, j, k] = this.longest(alo, ahi, blo, bhi);
			if (k) {
				found.push([i, j, k]);
				if (alo < i && blo < j) queue.push([alo, i, blo, j]);
				if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
			}
		}
		found.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
		const merged: Block[] = [];
		for (const blk of found) {
			const last = merged[merged.length - 1];
			if (last && last[0] + last[2] === blk[0] && last[1] + last[2] === blk[1]) last[2] += blk[2];
			else merged.push([...blk]);
		}
		merged.push([this.a.length, this.b.length, 0]);
		return merged;
	}

	ratio(): number {
		const total = this.a.length + this.b.length;
		if (!total) return 1;
		return (2 * this.blocks().reduce((n, blk) => n + blk[2], 0)) / total;
	}

	/** difflib's get_opcodes: how to turn a into b, as equal, replace, delete and insert ranges. */
	opcodes(): { tag: "equal" | "replace" | "delete" | "insert"; i1: number; i2: number; j1: number; j2: number }[] {
		let i = 0;
		let j = 0;
		const out: { tag: "equal" | "replace" | "delete" | "insert"; i1: number; i2: number; j1: number; j2: number }[] =
			[];
		for (const [ai, bj, size] of this.blocks()) {
			const tag = i < ai && j < bj ? "replace" : i < ai ? "delete" : j < bj ? "insert" : null;
			if (tag) out.push({ tag, i1: i, i2: ai, j1: j, j2: bj });
			i = ai + size;
			j = bj + size;
			if (size) out.push({ tag: "equal", i1: ai, i2: i, j1: bj, j2: j });
		}
		return out;
	}
}

export function similarity(a: readonly string[], b: readonly string[]): number {
	return new Matcher(a, b).ratio();
}

// ---------------------------------------------------------------------------------------------------------------
// History

export interface Commit {
	sha: string;
	/** Seconds since the epoch. */
	ts: number;
	date: string;
	subject: string;
}

const MONTHS: Record<string, number> = {
	Jan: 0,
	Feb: 1,
	Mar: 2,
	Apr: 3,
	May: 4,
	Jun: 5,
	Jul: 6,
	Aug: 7,
	Sep: 8,
	Oct: 9,
	Nov: 10,
	Dec: 11,
};
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?\s?(Z|[+-]\d{2}:?\d{2})?)?$/;
const ONE_LINE =
	/^([0-9a-f]{7,40})\s+(\d{9,11}|\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2}| [+-]\d{4})?)?)\s+(?:\d{4}-\d{2}-\d{2}\s+)?(.*)$/;

function offsetSeconds(z: string | undefined): number {
	if (!z || z === "Z") return 0;
	const m = /^([+-])(\d{2}):?(\d{2})$/.exec(z.trim());
	if (!m) return 0;
	return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60);
}

/** An ISO date, a date and time with or without an offset, or seconds since the epoch, as git prints them. */
export function parseDate(text: string): number | null {
	const t = text.trim();
	if (/^\d{9,11}$/.test(t)) return Number(t);
	const spaced = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) ([+-]\d{4})$/.exec(t); // %ci
	const m = ISO.exec(spaced ? `${spaced[1]}${spaced[2]}` : t);
	if (!m) return null;
	const utc =
		Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)) /
		1000;
	return utc - offsetSeconds(m[7]);
}

/** git's default date: "Wed Apr 12 16:53:12 2023 +0200". */
function parseDefaultDate(text: string): number | null {
	const m = /^\w{3} (\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4}) ([+-]\d{4})$/.exec(text.trim());
	if (!m || MONTHS[m[1]!] === undefined) return null;
	return (
		Date.UTC(Number(m[6]), MONTHS[m[1]!]!, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) / 1000 -
		offsetSeconds(m[7])
	);
}

function isoDay(ts: number): string {
	return new Date(ts * 1000).toISOString().slice(0, 10);
}

/**
 * Commits from what `git log` prints, in either of two shapes: one line per commit, `<sha> <date> <subject>`, as
 * `--format='%h %cI %s'` gives; or git's default, a `commit <sha>` line, a `Date:` line and an indented subject.
 * Everything else, the patches `-L` prints by default included, is ignored.
 */
export function parseHistory(text: string, input: string): Commit[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const commits: Commit[] = [];
	for (let n = 0; n < lines.length; n++) {
		const line = lines[n]!;
		const block = /^commit ([0-9a-f]{7,40})\b/.exec(line);
		if (block) {
			let ts: number | null = null;
			let subject = "";
			let k = n + 1;
			for (; k < lines.length && !/^commit [0-9a-f]{7,40}\b/.test(lines[k]!); k++) {
				const l = lines[k]!;
				const d = /^(?:Commit)?Date:\s+(.*)$/.exec(l);
				if (d && ts === null) ts = parseDefaultDate(d[1]!) ?? parseDate(d[1]!);
				else if (ts !== null && !subject && /^ {4}\S/.test(l)) subject = l.trim();
				if (/^diff --git /.test(l)) break;
			}
			if (ts === null) throw new InputError(`Commit ${block[1]!.slice(0, 7)} has no Date: line.`, input);
			commits.push({ sha: block[1]!, ts, date: isoDay(ts), subject });
			continue;
		}
		const one = ONE_LINE.exec(line.trim());
		if (one) {
			const ts = parseDate(one[2]!);
			if (ts !== null) commits.push({ sha: one[1]!, ts, date: isoDay(ts), subject: one[3]!.trim() });
		}
	}
	const seen = new Set<string>();
	return commits.filter((c) => {
		const key = c.sha.slice(0, 7);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export interface CoChange {
	since: Commit;
	sinceFrom: "history" | "input";
	together: Commit[];
	onlyA: Commit[];
	onlyB: Commit[];
	ignored: Commit[];
	before: number;
}

/**
 * Together, only A, only B: counted strictly after `since`, which is the younger copy's first commit unless the
 * reader names a commit or a date. A commit in both listings, matched on its first seven hex digits, is together.
 */
export function countChanges(a: Commit[], b: Commit[], since: string, ignore: string[]): CoChange {
	const key = (c: Commit) => c.sha.slice(0, 7).toLowerCase();
	const first = (cs: Commit[]) => cs.reduce((x, y) => (y.ts < x.ts ? y : x));
	let start: Commit = [first(a), first(b)].reduce((x, y) => (y.ts > x.ts ? y : x));
	let sinceFrom: CoChange["sinceFrom"] = "history";
	const named = since.trim();
	if (named) {
		const bySha = [...a, ...b].find(
			(c) => /^[0-9a-f]{7,40}$/i.test(named) && c.sha.toLowerCase().startsWith(named.toLowerCase().slice(0, 7)),
		);
		const ts = bySha?.ts ?? parseDate(named);
		if (ts === null || ts === undefined)
			throw new InputError(`"${named}" is neither a commit in either history nor a date.`, "since");
		start = bySha ?? { sha: "", ts, date: isoDay(ts), subject: "the date you gave" };
		sinceFrom = "input";
	}
	const inA = new Map(a.map((c) => [key(c), c]));
	const inB = new Map(b.map((c) => [key(c), c]));
	const all = new Map<string, Commit>([...inB, ...inA]);
	const words = ignore.map((w) => w.trim().toLowerCase()).filter(Boolean);
	const ignored = (c: Commit) =>
		words.some(
			(w) =>
				c.subject.toLowerCase().includes(w) ||
				(/^[0-9a-f]{7,40}$/.test(w) && c.sha.toLowerCase().startsWith(w.slice(0, 7))),
		);
	const out: CoChange = { since: start, sinceFrom, together: [], onlyA: [], onlyB: [], ignored: [], before: 0 };
	for (const [k, c] of [...all].sort((x, y) => x[1].ts - y[1].ts)) {
		if (c.ts <= start.ts) {
			out.before++;
			continue;
		}
		if (ignored(c)) out.ignored.push(c);
		else if (inA.has(k) && inB.has(k)) out.together.push(c);
		else if (inA.has(k)) out.onlyA.push(c);
		else out.onlyB.push(c);
	}
	return out;
}

/**
 * The answer line: the one-sided count, because those are the commits to read. The tool's one rule, stated rather than
 * tuned, is that fewer than five changes since both existed is too few to read anything into. It no longer names the
 * pair "mostly together" or "drifting apart": the counts do not settle that, and reading the one-sided commits does.
 */
export function answer(together: number, oneSided: number): { value: string; note: string } {
	const total = together + oneSided;
	const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;
	if (total < 5) {
		return {
			value: `Too early to tell: ${oneSided} of ${commits(total)} changed only one copy.`,
			note: "Fewer than 5 changes since both copies existed. Keep both for now, and add a check that tells you when one changes without the other.",
		};
	}
	if (oneSided === 0)
		return {
			value: `None of the ${commits(total)} changed only one copy.`,
			note: "Every change touched both, so a shared function would have taken the same edits.",
		};
	return {
		value: `${oneSided} of ${commits(total)} changed only one copy. Read ${oneSided === 1 ? "that one" : "those"} first.`,
		note: "Each is either a change the other copy missed, or a reason the two differ.",
	};
}

// ---------------------------------------------------------------------------------------------------------------
// The line diff

interface DiffRow {
	aLine: number | null;
	a: string;
	bLine: number | null;
	b: string;
	kind: "names" | "shape" | "only A" | "only B";
}

const MAX_ROWS = 200;

export function lineDiff(srcA: string, srcB: string, lang: Lang): DiffRow[] {
	const linesOf = (src: string) =>
		dedent(src)
			.split("\n")
			.map((text, i) => ({ n: i + 1, text: text.trim() }))
			.filter((l) => l.text && !(lang === "python" ? l.text.startsWith("#") : l.text.startsWith("//")));
	const la = linesOf(srcA);
	const lb = linesOf(srcB);
	const m = new Matcher(
		la.map((l) => l.text),
		lb.map((l) => l.text),
	);
	const rows: DiffRow[] = [];
	const lineShape = (t: string) =>
		tokens(t, lang)
			.map((x) => x.shape)
			.join(" ");
	for (const op of m.opcodes()) {
		if (op.tag === "equal") continue;
		const n = Math.max(op.i2 - op.i1, op.j2 - op.j1);
		for (let k = 0; k < n; k++) {
			const x = op.i1 + k < op.i2 ? la[op.i1 + k]! : null;
			const y = op.j1 + k < op.j2 ? lb[op.j1 + k]! : null;
			const kind = x && y ? (lineShape(x.text) === lineShape(y.text) ? "names" : "shape") : x ? "only A" : "only B";
			rows.push({ aLine: x?.n ?? null, a: x?.text ?? "", bLine: y?.n ?? null, b: y?.text ?? "", kind });
		}
	}
	return rows;
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * Near-duplicate at 85% alike, names set aside: the threshold cochange.py uses. It was an input; it is fixed now
 * because nobody has a better number for their own pair, and a slider invited tuning the answer.
 */
export const THRESHOLD = 0.85;

const LANG_NAME: Record<Lang, string> = {
	python: "Python",
	js: "JavaScript or TypeScript",
	c: "the C family (C, C++, C#, Java, Go, Rust, Kotlin, Swift)",
};

/**
 * Which lexer to use, read from the code itself. It was a select; the three lexers differ only in comments, strings
 * and the keyword list, so a wrong guess between JavaScript and the C family moves the figure by a token or two, and
 * Python, the one that differs a lot, is the easiest to recognise.
 */
export function detectLang(src: string): Lang {
	if (/^[ \t]*(?:async[ \t]+)?def[ \t]+\w+[ \t]*\(/m.test(src)) return "python";
	if (
		/\b(?:fn|func|fun)[ \t]+\w|#include\b|\b(?:public|private|protected)[ \t]+(?:static[ \t]+)?\w+[ \t]+\w+[ \t]*\(/.test(
			src,
		)
	)
		return "c";
	if (/\bfunction\b|=>|===|!==|\b(?:const|let)[ \t]+\w+[ \t]*=|\bexport[ \t]/.test(src)) return "js";
	if (/:[ \t]*(?:#.*)?$/m.test(src) && !/[{};]/.test(src)) return "python";
	return "c";
}

const pct = (r: number) => `${Math.floor(r * 1000) / 10}%`;
const decimalYear = (ts: number) => {
	const d = new Date(ts * 1000);
	const y = d.getUTCFullYear();
	const start = Date.UTC(y, 0, 1) / 1000;
	const end = Date.UTC(y + 1, 0, 1) / 1000;
	return Math.round((y + (ts - start) / (end - start)) * 1000) / 1000;
};
const line = (c: Commit) => `${c.sha.slice(0, 7)} ${c.date} ${c.subject}`.trim();

export default {
	run(input: Input) {
		try {
			const srcA = input.a ?? "";
			const srcB = input.b ?? "";
			if (!srcA.trim()) throw new InputError("Paste the first copy.", "a");
			if (!srcB.trim()) throw new InputError("Paste the second copy.", "b");
			const lang = detectLang(`${srcA}\n${srcB}`);
			const ta = body(tokens(srcA, lang), lang);
			const tb = body(tokens(srcB, lang), lang);
			if (!ta.length) throw new InputError("The first copy has no code in it, only comments or blank lines.", "a");
			if (!tb.length) throw new InputError("The second copy has no code in it, only comments or blank lines.", "b");
			const shapeR = similarity(
				ta.map((t) => t.shape),
				tb.map((t) => t.shape),
			);
			const textR = similarity(
				ta.map((t) => t.text),
				tb.map((t) => t.text),
			);
			const rows = lineDiff(srcA, srcB, lang);
			const count = (k: DiffRow["kind"]) => rows.filter((r) => r.kind === k).length;
			const near = shapeR >= THRESHOLD;

			const alike: Field = {
				label: "Alike, names set aside",
				value: pct(shapeR),
				note: `every identifier, string and number replaced; ${near ? "at or over" : "under"} the 85% near-duplicate line`,
			};
			const written: Field = {
				label: "Alike, as written",
				value: pct(textR),
				note: "every name kept",
			};
			const likeness: Output = {
				kind: "fields",
				role: "metrics",
				fields: [
					alike,
					written,
					...(rows.length ? [] : [{ label: "Lines that differ", value: "none", note: "line for line the same" }]),
				],
			};

			// The current code, above the history: it is what a merge has to reconcile.
			const diff: Output[] = [];
			if (rows.length) {
				const shown = rows.slice(0, MAX_ROWS);
				const does = count("shape") + count("only A") + count("only B");
				diff.push({
					kind: "table",
					caption: `Current differences: ${rows.length} line${rows.length === 1 ? "" : "s"}, ${does} in what the code does and ${count("names")} only in names, strings or numbers${rows.length > MAX_ROWS ? `. The first ${MAX_ROWS} are shown` : ""}`,
					columns: [
						{ label: "A", align: "end", mono: true },
						{ label: "Copy A", mono: true },
						{ label: "B", align: "end", mono: true },
						{ label: "Copy B", mono: true },
						{ label: "Differs in" },
					],
					rows: shown.map((r): Cell[] => [
						r.aLine === null ? "" : String(r.aLine),
						{ text: r.a, mono: true },
						r.bLine === null ? "" : String(r.bLine),
						{ text: r.b, mono: true },
						r.kind === "names"
							? { text: "names or literals", tone: "muted" }
							: r.kind === "shape"
								? "what it does"
								: r.kind,
					]),
				});
			}

			const how: Field[] = [
				{
					label: "Read as",
					value: LANG_NAME[lang],
					note: "from the code itself: it decides what counts as a keyword, a comment and a string",
				},
				{
					label: "Compared",
					value: "The bodies only, leaving out each signature and, in Python, the docstring.",
					note: "A wrapper and the method it wraps can share a body under different parameter lists. The line diff still shows the signatures.",
				},
				{
					label: "Near-duplicate at",
					value: "85% alike, names set aside",
					note: "the threshold the companion cochange.py uses",
				},
			];

			const hasA = (input.historya ?? "").trim();
			const hasB = (input.historyb ?? "").trim();
			const parts: Output[] = [];
			if (hasA || hasB) {
				if (!hasA) throw new InputError("Paste the first copy's history too: a pair needs both.", "historya");
				if (!hasB) throw new InputError("Paste the second copy's history too: a pair needs both.", "historyb");
				const ha = parseHistory(input.historya, "historya");
				const hb = parseHistory(input.historyb, "historyb");
				const expected =
					"Expected lines like \"f1157db 2023-03-20T11:30:11Z Use standard logging style\", from git log --no-patch --format='%h %cI %s' -L <start>,<end>:<file>.";
				const none = (text: string) =>
					/^[0-9a-f]{7,40} \S/m.test(text)
						? `These commits have no dates, and counting from when both copies existed needs one. ${expected}`
						: `No commits found. ${expected}`;
				if (!ha.length) throw new InputError(none(input.historya), "historya");
				if (!hb.length) throw new InputError(none(input.historyb), "historyb");
				const c = countChanges(ha, hb, input.since ?? "", (input.ignore ?? "").split(","));
				const oneSided = c.onlyA.length + c.onlyB.length;
				const v = answer(c.together.length, oneSided);
				const since =
					c.sinceFrom === "input"
						? `Since ${c.since.sha ? c.since.sha.slice(0, 7) : c.since.date}`
						: "Since both copies existed";
				parts.push({ kind: "fields", role: "answer", fields: [{ label: since, value: v.value, note: v.note }] });

				const counted = [
					...c.together.map((x) => ["both", x] as const),
					...c.onlyA.map((x) => ["only A", x] as const),
					...c.onlyB.map((x) => ["only B", x] as const),
				].sort((x, y) => x[1].ts - y[1].ts);
				const lonely = counted
					.filter(([side]) => side !== "both")
					.map(([side, x]): [string, Commit] => [side === "only A" ? "A" : "B", x])
					.reverse();
				if (counted.length) {
					// Bars rather than a two-set Venn: a one-commit region is a sliver nobody can read, and a bar labels exactly.
					parts.push({
						kind: "series",
						chart: {
							xLabel: "Changed",
							yLabel: "Commits",
							orientation: "horizontal",
							x: ["Both", "A only", "B only"],
							series: [
								{
									label: "Commits",
									shape: "bar",
									unit: "commits",
									points: [c.together.length, c.onlyA.length, c.onlyB.length],
								},
							],
						},
					});
				}
				if (lonely.length) {
					parts.push({
						kind: "table",
						role: "actions",
						caption: "Changed only one copy, newest first",
						columns: [{ label: "Copy" }, { label: "Commit", mono: true }, { label: "Date" }, { label: "Subject" }],
						rows: lonely.map(([side, x]): Cell[] => [side, { text: x.sha.slice(0, 7), mono: true }, x.date, x.subject]),
					});
				}
				parts.push(...diff, likeness);
				if (counted.length) {
					const run = { both: 0, "only A": 0, "only B": 0 };
					const pts: Record<keyof typeof run, number[]> = { both: [], "only A": [], "only B": [] };
					for (const [side] of counted) {
						run[side]++;
						for (const k of Object.keys(run) as (keyof typeof run)[]) pts[k].push(run[k]);
					}
					const series: Series[] = [
						{ label: "Changed both", points: pts.both, shape: "step", unit: "commits" },
						{ label: "Changed only A", points: pts["only A"], shape: "step", unit: "commits" },
						{ label: "Changed only B", points: pts["only B"], shape: "step", unit: "commits" },
					];
					parts.push({
						kind: "series",
						chart: {
							id: "drift",
							xLabel: "Year",
							yLabel: "Commits so far",
							x: counted.map(([, x]) => decimalYear(x.ts)),
							series,
							readout: { titles: counted.map(([side, x]) => `${line(x)} (${side})`), highlightTable: true },
						},
					});
					parts.push({
						kind: "table",
						caption: "Every counted commit, oldest first",
						columns: [{ label: "Commit", mono: true }, { label: "Date" }, { label: "Changed" }, { label: "Subject" }],
						rows: counted.map(([side, x]): Cell[] => [
							{ text: x.sha.slice(0, 7), mono: true },
							x.date,
							side === "both" ? { text: "both", tone: "muted" } : side,
							x.subject,
						]),
						link: { chart: "drift", keys: counted.map(([, x]) => decimalYear(x.ts)) },
					});
				}
				parts.push({
					kind: "fields",
					role: "method",
					fields: [
						{
							label: "Counted from",
							value: line(c.since) || c.since.date,
							note:
								c.sinceFrom === "input"
									? "the commit or date you gave"
									: "the younger copy's first commit in its history. If that is earlier than the copy itself, name the commit that made it in Count from.",
						},
						{
							label: "Left out",
							value: `${c.before} at or before the count starts, ${c.ignored.length} ignored`,
							note: "At or before: in either history up to the commit counted from, when there was one copy or the traced lines were other code. Ignored: by the words or commits you listed.",
						},
						...how,
					],
				});
			} else {
				// With no history, the code is all there is, so the diff comes straight after the answer.
				parts.push({
					kind: "fields",
					role: "answer",
					fields: [
						{
							label: near ? "Near-duplicates" : "Two different functions",
							value: `${pct(shapeR)} alike once names, strings and numbers are set aside, ${near ? "at or over" : "under"} the 85% line.`,
							note: near
								? "Whether to merge them depends on whether they change together. Paste each copy's git log to find out."
								: "Different enough that a change to one is unlikely to belong in the other.",
						},
					],
				});
				alike.note = "every identifier, string and number replaced";
				parts.push(...diff, likeness, { kind: "fields", role: "method", fields: how });
			}
			return { kind: "group", parts };
		} catch (error) {
			if (error instanceof InputError) return { kind: "error", message: error.message, input: error.input };
			throw error;
		}
	},
} satisfies Tool<Input>;
