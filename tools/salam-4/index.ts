import type { Output, Tool } from "@toolbench/sdk";

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
	ء: "hamza", آ: "alif madda", أ: "alif, hamza above", ؤ: "waw, hamza", إ: "alif, hamza below", ئ: "ya, hamza",
	ا: "alif", ب: "ba", ة: "ta marbuta", ت: "ta", ث: "tha", ج: "jim", ح: "ḥa", خ: "kha", د: "dal", ذ: "dhal",
	ر: "ra", ز: "zay", س: "sin", ش: "shin", ص: "ṣad", ض: "ḍad", ط: "ṭa", ظ: "ẓa", ع: "ʿayn", غ: "ghayn",
	ف: "fa", ق: "qaf", ك: "kaf", ل: "lam", م: "mim", ن: "nun", ه: "ha", و: "waw", ى: "alif maqsura", ي: "ya",
	ٱ: "alif wasla",
};
const MARK_NAMES: Record<string, string> = {
	"\u064B": "fathatan", "\u064C": "dammatan", "\u064D": "kasratan", "\u064E": "fatha",
	"\u064F": "damma", "\u0650": "kasra", "\u0651": "shadda", "\u0652": "sukun",
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

export default {
	run({ name, greeting, ya }): Output {
		const parsed = parse(name);
		if ("problem" in parsed) return parsed.problem;
		const { letters, clean } = parsed;
		const bytes = utf8(clean);
		const runs = pieces(letters);

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
						{ label: "UTF-8 bytes", value: String(bytes.length), note: "two for each Arabic letter or mark, one for a space" },
					],
				},
				{
					kind: "table",
					caption: "Letter by letter",
					columns: [
						{ label: "Letter" },
						{ label: "Name" },
						{ label: "Code point", mono: true },
						{ label: "UTF-8", mono: true },
						{ label: "Joins the next" },
					],
					rows: letters.map((l) => [
						l.written,
						NAMES[l.ch] ?? "",
						codePoint(l.ch),
						utf8(l.written).map(hex).join(" "),
						l.joins ? "yes" : "no",
					]),
				},
				{ kind: "bytes", bytes, caption: "The name in UTF-8, one highlighted run per letter", highlight },
			],
		};
	},
} satisfies Tool<Input>;
