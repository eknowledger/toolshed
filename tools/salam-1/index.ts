import type { Output, Tool } from "@toolbench/sdk";

type Input = { name: string };

export default {
	run({ name }): Output {
		if (name.trim() === "") return { kind: "error", message: "Type a name.", input: "name" };
		return { kind: "text", text: `أهلاً يا ${name.trim()}` };
	},
} satisfies Tool<Input>;
