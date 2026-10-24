import type { Output, Tool } from "@toolbench/sdk";

type Input = { name: string; greeting: string; ya: boolean };

const GREETINGS: Record<string, string> = {
	ahlan: "أهلاً",
	marhaban: "مرحباً",
	salam: "السلام عليكم",
	sabah: "صباح الخير",
	masa: "مساء الخير",
};

/** The Arabic letters, hamza forms included, then the marks written above or below them. */
const LETTER = /[\u0621-\u063A\u0641-\u064A\u0671]/;
const MARK = /[\u064B-\u065F\u0670]/;

export default {
	run({ name, greeting, ya }): Output {
		if (name.trim().length === 0) {
			return { kind: "error", message: "Type a name.", input: "name" };
		}
		for (let i = 0; i < name.length; i++) {
			const ch = name[i]!;
			if (LETTER.test(ch) || MARK.test(ch) || /\s/.test(ch)) continue;
			const shown = String.fromCodePoint(name.codePointAt(i) ?? 0);
			return {
				kind: "error",
				message: `"${shown}" is not an Arabic letter. Write the name in Arabic letters, for example أحمد.`,
				input: "name",
				at: i,
				len: shown.length,
			};
		}
		const clean = name.trim().split(/\s+/).join(" ");
		return { kind: "text", text: `${GREETINGS[greeting]}${ya ? " يا" : ""} ${clean}` };
	},
} satisfies Tool<Input>;
