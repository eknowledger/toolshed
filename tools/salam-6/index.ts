import type { Ctx, Output, Tool } from "@toolbench/sdk";

type Input = { name: string; greeting: string; ya: boolean };

const GREETINGS: Record<string, string> = {
	ahlan: "أهلاً",
	marhaban: "مرحباً",
	salam: "السلام عليكم",
	sabah: "صباح الخير",
	masa: "مساء الخير",
};

const LETTER = /[\u0621-\u063A\u0641-\u064A\u0671]/;
const MARK = /[\u064B-\u065F\u0670]/;

/*
 * The letters that never join the letter after them: ا د ذ ر ز و, the hamza forms of alif and waw, ta marbuta,
 * and the hamza on its own, which joins neither neighbour. Every other letter joins the next one in a word.
 */
const NEVER_JOINS = new Set(["ء", "آ", "أ", "ؤ", "إ", "ا", "ة", "د", "ذ", "ر", "ز", "و", "ٱ"]);

/** What each letter is called, for the table and the byte legend, where an Arabic letter beside Latin text would be reordered. */
const NAMES: Record<string, string> = {
	ء: "hamza",
	آ: "alif madda",
	أ: "alif, hamza above",
	ؤ: "waw, hamza",
	إ: "alif, hamza below",
	ئ: "ya, hamza",
	ا: "alif",
	ب: "ba",
	ة: "ta marbuta",
	ت: "ta",
	ث: "tha",
	ج: "jim",
	ح: "ḥa",
	خ: "kha",
	د: "dal",
	ذ: "dhal",
	ر: "ra",
	ز: "zay",
	س: "sin",
	ش: "shin",
	ص: "ṣad",
	ض: "ḍad",
	ط: "ṭa",
	ظ: "ẓa",
	ع: "ʿayn",
	غ: "ghayn",
	ف: "fa",
	ق: "qaf",
	ك: "kaf",
	ل: "lam",
	م: "mim",
	ن: "nun",
	ه: "ha",
	و: "waw",
	ى: "alif maqsura",
	ي: "ya",
	ٱ: "alif wasla",
};
const MARK_NAMES: Record<string, string> = {
	"\u064B": "fathatan",
	"\u064C": "dammatan",
	"\u064D": "kasratan",
	"\u064E": "fatha",
	"\u064F": "damma",
	"\u0650": "kasra",
	"\u0651": "shadda",
	"\u0652": "sukun",
};

/*
 * Each letter's value in the eastern (Mashriqi) abjad order, أبجد هوز حطي كلمن سعفص قرشت ثخذ ضظغ: the old order
 * of the alphabet, in which the letters were also numerals. A hamza seat counts as the letter carrying it, and ta marbuta as ه.
 */
const ABJAD: Record<string, number> = {
	ا: 1,
	أ: 1,
	إ: 1,
	آ: 1,
	ٱ: 1,
	ء: 1,
	ب: 2,
	ج: 3,
	د: 4,
	ه: 5,
	ة: 5,
	و: 6,
	ؤ: 6,
	ز: 7,
	ح: 8,
	ط: 9,
	ي: 10,
	ى: 10,
	ئ: 10,
	ك: 20,
	ل: 30,
	م: 40,
	ن: 50,
	س: 60,
	ع: 70,
	ف: 80,
	ص: 90,
	ق: 100,
	ر: 200,
	ش: 300,
	ت: 400,
	ث: 500,
	خ: 600,
	ذ: 700,
	ض: 800,
	ظ: 900,
	غ: 1000,
};

const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
const codePoint = (ch: string) => `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
const utf8 = (s: string) => [...new TextEncoder().encode(s)];

interface Letter {
	ch: string;
	/** The letter followed by its marks, as written. */
	written: string;
	/** Whether this letter is joined to the one after it, as the name is written. */
	joins: boolean;
}

type Parsed = { letters: Letter[]; clean: string } | { problem: Output };

export function parse(name: string): Parsed {
	if (name.trim().length === 0) return { problem: { kind: "error", message: "Type a name.", input: "name" } };
	const letters: Letter[] = [];
	const wordEnds = new Set<number>();
	for (let i = 0; i < name.length; i++) {
		const ch = name[i]!;
		if (/\s/.test(ch)) {
			if (letters.length > 0) wordEnds.add(letters.length - 1);
			continue;
		}
		if (LETTER.test(ch)) {
			letters.push({ ch, written: ch, joins: false });
			continue;
		}
		if (MARK.test(ch) && letters.length > 0) {
			letters.at(-1)!.written += ch;
			continue;
		}
		const shown = String.fromCodePoint(name.codePointAt(i) ?? 0);
		return {
			problem: {
				kind: "error",
				message: `"${shown}" is not an Arabic letter. Write the name in Arabic letters, for example أحمد.`,
				input: "name",
				at: i,
				len: shown.length,
			},
		};
	}
	// A letter joins the next one when it can, the next one is in the same word, and the next one is not a hamza.
	letters.forEach((l, i) => {
		const next = letters[i + 1];
		l.joins = !NEVER_JOINS.has(l.ch) && next !== undefined && !wordEnds.has(i) && next.ch !== "ء";
	});
	return { letters, clean: name.trim().split(/\s+/).join(" ") };
}

/** Connected runs of letters: a piece ends at every letter that is not joined to the next. */
export function pieces(letters: Letter[]): string[] {
	const out: string[] = [];
	let current = "";
	for (const l of letters) {
		current += l.written;
		if (!l.joins) {
			out.push(current);
			current = "";
		}
	}
	return out;
}

function factorial(n: number): number {
	let f = 1;
	for (let i = 2; i <= n; i++) f *= i;
	return f;
}

/** How many distinct orders the letters have: n! over the factorial of each repeated letter's count. */
export function arrangementsByFormula(chars: string[]): number {
	const counts = new Map<string, number>();
	for (const c of chars) counts.set(c, (counts.get(c) ?? 0) + 1);
	let total = factorial(chars.length);
	for (const k of counts.values()) total /= factorial(k);
	return total;
}

/** Steps `a` to the next arrangement in sorted order, in place. False once the last one has been passed. */
function nextArrangement(a: string[]): boolean {
	let i = a.length - 2;
	while (i >= 0 && a[i]! >= a[i + 1]!) i--;
	if (i < 0) return false;
	let j = a.length - 1;
	while (a[j]! <= a[i]!) j--;
	[a[i], a[j]] = [a[j]!, a[i]!];
	for (let l = i + 1, r = a.length - 1; l < r; l++, r--) [a[l], a[r]] = [a[r]!, a[l]!];
	return true;
}

/*
 * Every distinct order of the letters, counted one at a time. The formula above knows the total at once; the
 * tool counts anyway, because counting is what makes its running time grow with the name, and the formula
 * gives the progress bar its denominator.
 */
export function countArrangements(chars: string[], ctx: Ctx): number {
	const total = arrangementsByFormula(chars);
	const a = [...chars].sort();
	let count = 0;
	do {
		count++;
		// Every 1024 orders rather than every one: reading the signal a million times is itself the slow part.
		if ((count & 0x3ff) === 0) {
			ctx.signal.throwIfAborted();
			ctx.progress(count / total, {
				kind: "fields",
				fields: [{ label: "Arrangements so far", value: count.toLocaleString("en") }],
			});
		}
	} while (nextArrangement(a));
	return count;
}

export default {
	run({ name, greeting, ya }, ctx): Output {
		const parsed = parse(name);
		if ("problem" in parsed) return parsed.problem;
		const { letters, clean } = parsed;
		const bytes = utf8(clean);
		const runs = pieces(letters);
		const values = letters.map((l) => ABJAD[l.ch] ?? 0);
		const abjad = values.reduce((sum, v) => sum + v, 0);
		const count = countArrangements(
			letters.map((l) => l.ch),
			ctx,
		);

		// One highlighted range per letter, its marks included, so the legend says which bytes spell which letter.
		const highlight: { at: number; len: number; label: string }[] = [];
		let at = 0;
		for (const ch of clean) {
			const len = utf8(ch).length;
			if (LETTER.test(ch)) highlight.push({ at, len, label: `${codePoint(ch)} ${NAMES[ch]}` });
			else if (MARK.test(ch)) {
				const last = highlight.at(-1)!;
				last.len += len;
				last.label += ` + ${MARK_NAMES[ch] ?? "mark"} ${codePoint(ch)}`;
			}
			at += len;
		}

		return {
			kind: "group",
			parts: [
				{ kind: "text", text: `${GREETINGS[greeting]}${ya ? " يا" : ""} ${clean}` },
				{
					kind: "fields",
					fields: [
						{ label: "Letters", value: String(letters.length) },
						{ label: "Pieces", value: String(runs.length), note: runs.join(" · ") },
						{
							label: "UTF-8 bytes",
							value: String(bytes.length),
							note: "two for each Arabic letter or mark, one for a space",
						},
						{ label: "Abjad value", value: String(abjad), note: "the letters' values added up" },
					],
				},
				{
					kind: "series",
					chart: {
						xLabel: "Letter, first to last",
						yLabel: "Abjad value",
						x: letters.map((l, i) => `${i + 1}. ${l.ch}`),
						series: [{ label: "Abjad value", shape: "bar", points: values }],
					},
				},
				{
					kind: "table",
					caption: "Letter by letter",
					columns: [
						{ label: "Letter" },
						{ label: "Name" },
						{ label: "Code point", mono: true },
						{ label: "UTF-8", mono: true },
						{ label: "Abjad", align: "end" },
						{ label: "Joins the next" },
					],
					rows: letters.map((l, i) => [
						l.written,
						NAMES[l.ch] ?? "",
						codePoint(l.ch),
						utf8(l.written).map(hex).join(" "),
						values[i]!,
						l.joins ? "yes" : "no",
					]),
				},
				{ kind: "bytes", bytes, caption: "The name in UTF-8, one highlighted run per letter", highlight },
				{
					kind: "fields",
					fields: [
						{
							label: "Arrangements",
							value: count.toLocaleString("en"),
							note: "every distinct order of the letters, counted one by one",
						},
					],
				},
			],
		};
	},
} satisfies Tool<Input>;
