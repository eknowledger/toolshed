/**
 * Properties of the agent tool schema linter that a fixture cannot pin.
 *
 *   pnpm test
 *
 *  - closing a field (adding a pattern, an enum or a format) never makes the result worse;
 *  - the reader setting changes severity only, never which fields are data;
 *  - every prose field name is caught whatever its case, and a fact's name is never read as a command;
 *  - schema mode and example mode agree on what a link is;
 *  - a tool definition is read in every shape model APIs use, and an agent-as-tool's one string is words;
 *  - an MCP tool list is read whole, wrapped or bare, and its scope line agrees with the problems above it;
 *  - the output reads in scanning order: the problems worst first, the scope line, then every field.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import tool, { lint, nameShape } from "./index.ts";

const base = (extra: Record<string, unknown> = {}) => ({
	type: "object",
	additionalProperties: false,
	properties: {
		type: { const: "ReservationCancelled" },
		id: { type: "string", pattern: "^evt_[0-9]+$" },
		source: { enum: ["restaurant"] },
		...extra,
	},
});

const text = (c: unknown): string =>
	typeof c === "object" && c !== null && "text" in c ? String((c as { text: unknown }).text) : String(c);
/** The findings table's rows as [risk, where, problem], or [] when there is nothing to fix. */
const findings = (contract: unknown, reader = "model") => {
	const out = tool.run({ contract: JSON.stringify(contract), reader });
	assert.equal(out.kind, "group");
	const t = out.kind === "group" ? out.parts.find((p) => p.role === "findings") : undefined;
	return t?.kind === "table" ? t.rows.map((r) => r.slice(0, 3).map(text)) : [];
};
/** The worst risk in the result, "none" when every field is constrained and the envelope is complete. */
const worst = (contract: unknown, reader = "model") => findings(contract, reader)[0]?.[0] ?? "none";

describe("the verdict", () => {
	it("a typed fact passes, and adding a note fails it", () => {
		assert.equal(worst(base()), "none");
		assert.equal(worst(base({ note: { type: "string" } })), "High");
	});
	it("giving a loose string a pattern, an enum or a format turns it into data", () => {
		assert.deepEqual(findings(base({ slot: { type: "string" } })), [["Medium", "slot", "accepts any text"]]);
		for (const closed of [
			{ type: "string", pattern: "^[A-Z]{3} [0-9:]{5}$" },
			{ enum: ["Fri 19:00"] },
			{ type: "string", format: "date-time" },
		]) {
			assert.equal(worst(base({ slot: closed })), "none", JSON.stringify(closed));
		}
	});
	it("the reader setting changes severity, never which fields are data", () => {
		const c = base({ note: { type: "string" }, slot: { type: "string" } });
		const asModel = lint(c, "model").events[0]!.findings.map((f) => [f.field, f.verdict]);
		const asCode = lint(c, "code").events[0]!.findings.map((f) => [f.field, f.verdict]);
		assert.deepEqual(asModel, asCode);
		assert.equal(worst(c, "model"), "High");
		assert.equal(worst(c, "code"), "Medium");
	});
	it("an open schema is reported, even when every field is data", () => {
		const open = { ...base(), additionalProperties: true };
		assert.equal(lint(open, "model").events[0]!.closed, false);
	});
});

describe("names", () => {
	it("facts named for what happened are facts", () => {
		for (const n of [
			"ReservationCancelled",
			"ReservationConfirmed",
			"PaymentReceived",
			"MessageSent",
			"DepositPaid",
			"booking.created",
		]) {
			assert.equal(nameShape(n).shape, "fact", n);
		}
	});
	it("requests and imperatives are commands, including ones that end in -ed", () => {
		for (const n of [
			"GroupTextRequested",
			"SendReminder",
			"PleaseTextGroup",
			"NotifyUser",
			"CancelReservationCommand",
		]) {
			assert.equal(nameShape(n).shape, "command", n);
		}
	});
	it("a name it can't classify is unclear, not passed", () => {
		assert.equal(nameShape("ReservationCancel").shape, "unclear");
	});
});

describe("fields", () => {
	it("every prose field name is words, whatever its case", () => {
		for (const name of ["note", "Notes", "MESSAGE", "instructions", "prompt", "comment", "description", "body"]) {
			const f = lint(base({ [name]: { type: "string" } }), "model").events[0]!.findings.find((x) => x.field === name);
			assert.ok(f?.words, name);
		}
	});
	it("schema mode and example mode agree that a link is a link", () => {
		const bySchema = lint(base({ href: { type: "string", format: "uri" } }), "model").events[0]!.findings.find(
			(f) => f.field === "href",
		);
		const byValue = lint(
			{ type: "ReservationCancelled", id: "evt_1", href: "https://evil.example/claim" },
			"model",
		).events[0]!.findings.find((f) => f.field === "href");
		assert.equal(bySchema?.verdict, "link");
		assert.equal(byValue?.verdict, "link");
	});
	it("nested fields and arrays are walked, with dotted paths", () => {
		const c = base({ party: { type: "object", properties: { names: { type: "array", items: { type: "string" } } } } });
		const paths = lint(c, "model").events[0]!.findings.map((f) => f.field);
		assert.ok(paths.includes("party.names[]"), paths.join(", "));
	});
	it("a single-word value with no schema is unclear, never data", () => {
		const f = lint({ type: "ReservationCancelled", id: "evt_17", reservation: "R1" }, "model").events[0]!.findings;
		assert.ok(
			f.every((x) => x.verdict === "unclear"),
			JSON.stringify(f),
		);
	});
});

describe("past-tense facts whose first word is also a verb", () => {
	it("are facts, not commands", () => {
		for (const n of [
			"CallEnded",
			"EmailBounced",
			"TextMessageSent",
			"RunCompleted",
			"ChargeSucceeded",
			"RefundIssued",
			"PaymentRequestReceived",
			"UserSignedUp",
		]) {
			assert.equal(nameShape(n).shape, "fact", n);
		}
	});
	it("a closed CallEnded schema is facts only", () => {
		const c = {
			type: "object",
			additionalProperties: false,
			properties: {
				type: { const: "CallEnded" },
				id: { type: "string", pattern: "^c[0-9]+$" },
				source: { enum: ["telephony"] },
			},
		};
		assert.equal(worst(c), "none");
	});
});

describe("the reader setting softens a command", () => {
	it("a command read only by code is a warning, not an instruction crossing", () => {
		const c = {
			type: "object",
			additionalProperties: false,
			properties: {
				type: { const: "SendReminder" },
				id: { type: "string", pattern: "^r[0-9]+$" },
				source: { enum: ["calendar"] },
			},
		};
		assert.deepEqual(findings(c, "model"), [["High", "SendReminder", "a command named as an event"]]);
		assert.deepEqual(findings(c, "code"), [["Medium", "SendReminder", "a command named as an event"]]);
	});
});

describe("tool definitions", () => {
	const params = { type: "object", properties: { input: { type: "string" } } };
	it("is read in each shape model APIs use, and the agent-as-tool string carries words", () => {
		for (const def of [
			{ name: "messaging", input_schema: params },
			{ name: "messaging", parameters: params },
			{ type: "function", function: { name: "messaging", parameters: params } },
			[{ name: "messaging", input_schema: params }],
		]) {
			const r = lint(def, "model");
			assert.equal(r.mode, "tool", JSON.stringify(def));
			assert.equal(r.events[0]!.shape, "call");
			assert.ok(r.events[0]!.findings[0]!.words);
			assert.equal(worst(def), "High");
		}
	});
	it("typed, closed parameters are facts only, and the tool's name is never judged", () => {
		const def = {
			name: "send_text_now",
			input_schema: {
				type: "object",
				additionalProperties: false,
				properties: { reservation: { type: "string", pattern: "^R[0-9]+$" }, party: { type: "integer" } },
			},
		};
		assert.equal(worst(def), "none");
	});
});

describe("MCP tool lists", () => {
	const closed = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, properties });
	const tight = {
		name: "get_reservation",
		inputSchema: closed({ reservation_id: { type: "string", pattern: "^R[0-9]+$" } }),
	};
	const loose = { name: "find_tables", inputSchema: closed({ area: { type: "string" } }) };
	const wordy = { name: "ask_concierge", inputSchema: closed({ question: { type: "string" } }) };
	const list = { tools: [tight, loose, wordy] };

	it("reads the tools/list result, the bare array and the JSON-RPC response alike", () => {
		const shapes = [list, list.tools, { jsonrpc: "2.0", id: 1, result: list }];
		const read = shapes.map((c) => lint(c, "model"));
		for (const r of read) assert.equal(r.mode, "tool");
		assert.deepEqual(read[1], read[0]);
		assert.deepEqual(read[2], read[0]);
		assert.deepEqual(
			read[0]!.events.map((e) => e.name),
			["get_reservation", "find_tables", "ask_concierge"],
		);
	});
	it("puts the field that carries words first, and the scope line counts every field that takes any text", () => {
		assert.deepEqual(
			findings(list).map((r) => r.slice(0, 2)),
			[
				["High", "ask_concierge.question"],
				["Medium", "find_tables.area"],
			],
		);
		assert.deepEqual(
			findings(list, "code").map((r) => r[0]),
			["Medium", "Medium"],
		);
		const out = tool.run({ contract: JSON.stringify(list), reader: "model" });
		const scope = out.kind === "group" ? out.parts.find((p) => p.role === "answer") : undefined;
		assert.equal(scope?.kind, "fields");
		const got = scope?.kind === "fields" ? scope.fields.map((f) => [f.label, f.value, f.note ?? ""]) : [];
		// Two flagged above, two counted here: the old headline said "1 of 3 tools" because it counted high risk only.
		assert.deepEqual(got, [
			["Checked", "3 tools, 3 fields", ""],
			["Accept any text", "2 of 3", "1 high risk and 1 medium"],
			["Refuse extra fields", "3 of 3 schemas", ""],
		]);
	});
	it("a list with no free text still flags a loose string, as medium", () => {
		assert.deepEqual(findings({ tools: [tight, loose] }), [["Medium", "find_tables.area", "accepts any text"]]);
	});
	it("one field table row per field, naming its tool, with what it accepts and its risk in words", () => {
		const out = tool.run({ contract: JSON.stringify(list), reader: "model" });
		const table = out.kind === "group" ? out.parts[2] : undefined;
		assert.equal(table?.kind, "table");
		const rows =
			table?.kind === "table"
				? table.rows.map((r) => r.slice(0, 4).map((c) => (typeof c === "object" ? c.text : String(c))))
				: [];
		assert.deepEqual(rows, [
			["get_reservation", "reservation_id", "text matching ^R[0-9]+$", "Constrained"],
			["find_tables", "area", "any text", "Medium"],
			["ask_concierge", "question", "any text", "High"],
		]);
	});
	it("an empty list and a broken entry are input errors, not an example message", () => {
		for (const [c, msg] of [
			[{ tools: [] }, /empty/],
			[{ tools: [tight, { name: "x" }] }, /^Tool 2 in the list/],
		] as const) {
			const out = tool.run({ contract: JSON.stringify(c), reader: "model" });
			assert.equal(out.kind, "error");
			assert.match(out.kind === "error" ? out.message : "", msg);
		}
	});
});

describe("the output's order", () => {
	it("is the problems, the scope line, then every field", () => {
		const out = tool.run({ contract: JSON.stringify(base({ note: { type: "string" } })), reader: "model" });
		assert.equal(out.kind, "group");
		const parts = out.kind === "group" ? out.parts : [];
		assert.deepEqual(
			parts.map((p) => [p.kind, p.role]),
			[
				["table", "findings"],
				["fields", "answer"],
				["table", undefined],
			],
		);
		assert.deepEqual(parts[1]?.kind === "fields" ? parts[1].fields.map((f) => f.label) : [], [
			"Checked",
			"Accept any text",
			"Refuse extra fields",
		]);
	});
	it("has no problems table when there is nothing to fix, so the scope line leads", () => {
		const out = tool.run({ contract: JSON.stringify(base()), reader: "model" });
		assert.deepEqual(out.kind === "group" ? out.parts.map((p) => p.role) : [], ["answer", undefined]);
	});
	it("names the field in its change, rather than one sentence for every string", () => {
		const rows = findings(base({ slot: { type: "string" }, note: { type: "string" } }));
		const out = tool.run({
			contract: JSON.stringify(base({ slot: { type: "string" }, note: { type: "string" } })),
			reader: "model",
		});
		const t = out.kind === "group" ? out.parts[0] : undefined;
		const changes = t?.kind === "table" ? t.rows.map((r) => text(r[3])) : [];
		assert.equal(rows.length, 2);
		assert.match(changes[0] ?? "", /^Remove note\./);
		assert.match(changes[1] ?? "", /^Limit slot /);
	});
	it("puts a command before a free-text field, and the envelope after both", () => {
		const c = {
			type: "object",
			properties: { type: { const: "SendReminder" }, note: { type: "string" }, slot: { type: "string" } },
		};
		const out = tool.run({ contract: JSON.stringify(c), reader: "model" });
		const fix = out.kind === "group" ? out.parts[0] : undefined;
		const where = fix?.kind === "table" ? fix.rows.map((r) => text(r[1])) : [];
		assert.deepEqual(where, ["SendReminder", "note", "slot", "SendReminder", "SendReminder", "SendReminder"]);
	});
	it("writes every reason as a sentence: a capital letter first, a full stop last", () => {
		const c = base({ note: { type: "string" }, slot: { type: "string" }, href: { type: "string", format: "uri" } });
		for (const reader of ["model", "code"]) {
			for (const f of lint(c, reader).events[0]!.findings) assert.match(f.why, /^[A-Z"].*\.$/, f.why);
		}
	});
});

describe("the markdown copy", () => {
	it("restates the scope, the problems and every field, one row each", () => {
		const out = tool.run({
			contract: JSON.stringify(base({ note: { type: "string" } })),
			reader: "model",
			also: "markdown",
		});
		assert.equal(out.kind, "group");
		const last = out.kind === "group" ? out.parts[out.parts.length - 1] : undefined;
		assert.equal(last?.kind, "code");
		const src = last?.kind === "code" ? last.source : "";
		assert.equal(src.split("\n").filter((l) => l.startsWith("| `")).length, 3);
		assert.match(
			src,
			/^\*\*Checked: 1 event type, 3 fields\. Accept any text: 1 of 3 \(1 high risk\)\. Refuse extra fields: 1 of 1 schema\.\*\*/,
		);
		assert.match(src, /^1\. High, `note` accepts any text: Remove note\./m);
		assert.match(src, /text matching `\^evt_\[0-9\]\+\$`/);
	});
});
