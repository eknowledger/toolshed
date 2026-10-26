/**
 * A linter for what agents are handed: paste the tool definitions a model can call (an MCP server's whole
 * `tools/list` result included), the schema of the events one agent sends another, or one example event, and see
 * which fields are data and which are a channel for someone else's words.
 *
 * The question it answers is the one that decides whether an instruction can cross from one agent to the next. When
 * a model reads an event, every free-text field in it is read like any other text, so a third party's sentence
 * copied into a `note` arrives at the receiver as something it may act on. A field the receiver can only read as
 * data (an enum, a number, an ID with a pattern) cannot carry an instruction. The linter sorts every field into one
 * of those two, and checks the three things around them:
 *
 *  1. **The event's name.** A fact is named for what happened (`ReservationCancelled`). A name like
 *     `GroupTextRequested` or `SendReminder` is a command, which Fowler calls "an event used as a passive-aggressive
 *     command" when it is styled as an event.
 *  2. **The envelope.** An `id`, so a receiver can drop a redelivery, and a `source`, so it knows whose word it is.
 *  3. **Closed schemas.** Without `additionalProperties: false`, a publisher can add a `note` and nothing refuses it.
 *
 * What it deliberately cannot do: decide that a field is safe because of what is in it today. A string with no
 * pattern is free text however short its values are now. And it reads names by rule, not by understanding, so a
 * fact named in the present tense ("ReservationCancel") is reported as unclear, not passed.
 *
 * The output is ordered for a reader scanning it: the problems, worst first, each with its change; then one line of
 * scope (what was read, how many fields take any text, how many schemas are closed); then every field with what it
 * accepts and why that is or isn't a risk, written as full sentences rather than shorthand.
 */
import type { Cell, Field, Output, TextTone, Tone, Tool } from "@toolbench/sdk";

type Input = { contract: string; reader: string; also?: string };

/** A field name that almost always holds prose. */
const PROSE =
	/^(note|notes|message|messages|text|body|comment|comments|description|reason|details|summary|content|instructions?|prompt|remarks?|memo|explanation|context|input|task|request|query|question)$/i;
/** Words that make a type name a request for action rather than a report of one. */
const COMMAND_WORD = /(Requested|Request|Command|Please|Instruction|Instructed|ToDo|Todo)/;
/** Imperative verbs a command-shaped type name starts with. */
const IMPERATIVE =
	/^(Send|Text|Notify|Tell|Book|Cancel|Create|Update|Delete|Remove|Add|Do|Make|Run|Start|Stop|Schedule|Pay|Charge|Refund|Email|Call|Reply|Ask|Set|Get|Fetch|Process|Handle|Execute|Trigger|Approve|Reject)[A-Z]/;
/** A participle that is a request: still a command, styled as a fact. */
const REQUEST_PAST = /(Requested|Instructed|Commanded|Ordered)$/;
/** Past participles, regular and the irregular ones event names use, optionally with a particle (SignedUp). */
const PAST =
	/(ed|Sent|Paid|Held|Made|Done|Taken|Given|Seen|Kept|Lost|Won|Built|Begun|Run|Set|Read|Met|Left|Found|Shown|Known|Withdrawn|Drawn|Grown|Thrown|Written|Chosen|Frozen|Spoken|Broken|Stolen|Forgotten|Hidden)(Up|Out|In|Off|Over|Back|Down)?$/;
const ID_NAME = /^(id|event_?id|eventId|message_?id|messageId)$/;
const SOURCE_NAME = /^(source|origin|from|sender|producer|issuer|actor)$/;
const URL_TEXT = /\b(https?:\/\/|www\.)|\b[a-z0-9-]+\.(com|net|org|io|example|dev|co|app|xyz)\/\S*/i;
const IMPERATIVE_TEXT =
	/(^|[.:;!]\s*)(please\s+)?(also\s+)?(text|send|tell|email|call|book|cancel|pay|refund|forward|reply|ignore|remember|visit|click|go to|transfer|approve|delete)\s+\S/i;

/** JSON Schema string formats that leave no room for a sentence, in the words a reader would use. */
const FORMATS: Record<string, string> = {
	"date-time": "date and time",
	date: "date",
	time: "time",
	duration: "duration",
	uuid: "UUID",
	email: "email address",
	ipv4: "IPv4 address",
	ipv6: "IPv6 address",
	hostname: "host name",
};

type Schema = {
	type?: string | string[];
	properties?: Record<string, Schema>;
	items?: Schema;
	enum?: unknown[];
	const?: unknown;
	pattern?: string;
	format?: string;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	required?: string[];
	additionalProperties?: boolean | Schema;
	$ref?: string;
};

/**
 * What a field is, for the fix list: `words` and `link` can carry an instruction, `any` has no type at all, `loose`
 * is a string with nothing limiting it, `ref` is a schema this linter does not follow, `token` an example value that
 * proves nothing either way.
 */
type Problem = "words" | "link" | "any" | "loose" | "ref" | "token" | null;

type Finding = {
	event: string;
	field: string;
	type: string;
	verdict: "data" | "free text" | "unclear" | "link";
	/** What the field will take, in words: "a whole number from 1 to 20", "any text, up to 2,000 characters". */
	accepts: string;
	/** Why that is or isn't a risk, as a full sentence. */
	why: string;
	tone: Tone;
	words: boolean;
	problem: Problem;
	pattern?: string;
	ref?: string;
};
type EventReport = {
	name: string;
	/** "call" is a tool definition: a request by design, so its name isn't judged and it needs no id or source. */
	shape: "fact" | "command" | "unclear" | "call";
	shapeWhy: string;
	hasId: boolean;
	hasSource: boolean;
	closed: boolean | null;
	findings: Finding[];
};
type Judged = Omit<Finding, "event" | "field">;

class InputError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isSchema = (v: unknown): v is Schema => isObj(v) && (isObj(v.properties) || v.type === "object");
const n = (x: number) => x.toLocaleString("en-US");
const join = (xs: string[], last = "and") =>
	xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} ${last} ${xs[xs.length - 1]}`;

/** Reads a type name: is it named for something that happened, or for something someone should do? */
export function nameShape(name: string): { shape: EventReport["shape"]; why: string } {
	const bare = name.replace(/^.*[./:]/, "");
	// A past participle at the end names something that happened, whatever verb or noun comes first
	// (CallEnded, EmailBounced, RefundIssued, PaymentRequestReceived). Only a participle that is itself a request
	// (GroupTextRequested) still makes it a command.
	if (REQUEST_PAST.test(bare))
		return {
			shape: "command",
			why: `"${bare}" says that someone asked for something to be done. That is a request, even though it is named like an event.`,
		};
	if (PAST.test(bare)) return { shape: "fact", why: `"${bare}" is named for something that already happened.` };
	if (COMMAND_WORD.test(bare))
		return {
			shape: "command",
			why: `"${bare}" asks for something to be done, even though it is sent as an event.`,
		};
	if (IMPERATIVE.test(bare))
		return { shape: "command", why: `"${bare}" starts with a verb that tells the receiver what to do.` };
	return {
		shape: "unclear",
		why: `"${bare}" is neither clearly something that happened nor clearly an order. Name an event for what happened, in the past tense.`,
	};
}

function typeOf(s: Schema): string {
	if (s.enum) return "enum";
	if (s.const !== undefined) return "const";
	const t = Array.isArray(s.type)
		? s.type.filter((x) => x !== "null").join("|")
		: (s.type ?? (s.properties ? "object" : "any"));
	return t;
}

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

function range(noun: string, s: Schema): string {
	if (s.minimum !== undefined && s.maximum !== undefined) return `${noun} from ${n(s.minimum)} to ${n(s.maximum)}`;
	if (s.minimum !== undefined) return `${noun}, ${n(s.minimum)} or more`;
	if (s.maximum !== undefined) return `${noun}, up to ${n(s.maximum)}`;
	return noun;
}

/** One schema field: what it accepts, whether that is data or a channel for words, and why, in a sentence. */
function judgeSchema(name: string, s: Schema, reader: string): Judged {
	const type = typeOf(s);
	const leaf = name.replace(/^.*\./, "").replace(/\[\]$/, "");
	const model = reader === "model";
	const risky: Tone = model ? "bad" : "warn";
	const data = (accepts: string, why: string, extra: Partial<Judged> = {}): Judged => ({
		type,
		verdict: "data",
		accepts,
		why,
		tone: "good",
		words: false,
		problem: null,
		...extra,
	});
	if (type === "enum") {
		const vals = (s.enum ?? []).map(show);
		return data(
			vals.length === 1
				? `only ${vals[0]}`
				: vals.length <= 4
					? `one of ${join(vals, "or")}`
					: `one of ${vals.length} fixed values`,
			vals.length === 1
				? "Only this one value is accepted, so there is no room for a sentence."
				: "Only these values are accepted, so there is no room for a sentence.",
		);
	}
	if (type === "const")
		return data(`only ${show(s.const)}`, "Only this one value is accepted, so there is no room for a sentence.");
	if (type === "integer" || type === "number")
		return data(range(type === "integer" ? "a whole number" : "a number", s), "A number can't carry an instruction.");
	if (type === "boolean") return data("true or false", "A true or false value can't carry an instruction.");
	if (type === "null") return data("nothing (null)", "An empty value can't carry an instruction.");
	if (s.$ref)
		return {
			type: "$ref",
			verdict: "unclear",
			accepts: `whatever ${s.$ref} allows`,
			why: `It points to another schema, ${s.$ref}, which this linter doesn't open. Paste that schema on its own to check it.`,
			tone: "warn",
			words: false,
			problem: "ref",
			ref: s.$ref,
		};
	if (type === "string" || type === "any") {
		if (s.format === "uri" || s.format === "url" || s.format === "iri") {
			return {
				type: `string (${s.format})`,
				verdict: "link",
				accepts: "a link",
				why: model
					? "The sender chooses where this link points, and a model reading it may follow it or show it to the user."
					: "The sender chooses where this link points. Check it before anything follows it.",
				tone: risky,
				words: true,
				problem: "link",
			};
		}
		if (s.format && FORMATS[s.format]) {
			return data(
				`a ${FORMATS[s.format]}`,
				`It has to be a valid ${FORMATS[s.format]}, so there is no room for a sentence.`,
				{
					type: `string (${s.format})`,
				},
			);
		}
		if (s.pattern)
			return data(
				`text matching ${s.pattern}`,
				"It must match this pattern, so it can hold an ID or a code but not a sentence, as long as the pattern is strict.",
				{ type: "string (pattern)", pattern: s.pattern },
			);
		if (type === "any")
			return {
				type,
				verdict: "unclear",
				accepts: "anything",
				why: model
					? "No type is set, so anything can go here, including a sentence the model will read."
					: "No type is set, so anything can go here. Give it a type.",
				tone: risky,
				words: true,
				problem: "any",
			};
		const accepts = s.maxLength !== undefined ? `any text, up to ${n(s.maxLength)} characters` : "any text";
		if (PROSE.test(leaf)) {
			return {
				type: "string",
				verdict: "free text",
				accepts,
				why: model
					? `A field called "${leaf}" is meant for sentences, and any text is allowed. The model on the other side reads it like any other text, so an instruction someone slipped in can reach it.`
					: `A field called "${leaf}" is meant for sentences, and any text is allowed. Only code reads it, so it can't instruct a model, but nothing limits what it says.`,
				tone: risky,
				words: true,
				problem: "words",
			};
		}
		return {
			type: "string",
			verdict: "free text",
			accepts,
			why: model
				? "Any text is allowed here, so a sentence from a stranger could reach the model. Limit it with a pattern or a list of allowed values."
				: "Any text is allowed here. If it really holds an ID or a code, limit it with a pattern, a format or a list of allowed values.",
			tone: "warn",
			words: false,
			problem: "loose",
		};
	}
	return {
		type,
		verdict: "unclear",
		accepts: type,
		why: `This linter doesn't judge fields of type ${type}. Check it by hand.`,
		tone: "warn",
		words: false,
		problem: "ref",
	};
}

function walkSchema(prefix: string, s: Schema, reader: string, out: Omit<Finding, "event">[], open: string[]): void {
	for (const [name, sub] of Object.entries(s.properties ?? {})) {
		const path = prefix ? `${prefix}.${name}` : name;
		const t = typeOf(sub);
		if (t === "object" || isObj(sub.properties)) {
			if (prefix && sub.additionalProperties !== false) open.push(path);
			walkSchema(path, sub, reader, out, open);
		} else if (t === "array") {
			const items = sub.items ?? {};
			if (isObj(items.properties)) walkSchema(`${path}[]`, items, reader, out, open);
			else {
				const j = judgeSchema(`${path}[]`, items, reader);
				out.push({ field: `${path}[]`, ...j, accepts: `a list, each item ${j.accepts}` });
			}
		} else {
			out.push({ field: path, ...judgeSchema(path, sub, reader) });
		}
	}
}

/** One field of an example event. With no schema, the value is all there is to go on. */
function judgeValue(name: string, v: unknown, reader: string): Judged {
	const leaf = name.replace(/^.*\./, "").replace(/\[\]$/, "");
	const model = reader === "model";
	const risky: Tone = model ? "bad" : "warn";
	if (typeof v === "number" || typeof v === "boolean" || v === null) {
		const what = v === null ? "an empty value" : typeof v === "number" ? "a number" : "true or false";
		return {
			type: v === null ? "null" : typeof v,
			verdict: "data",
			accepts: what,
			why: `The example holds ${what}, which can't carry an instruction. Only a schema can make sure the next message does too.`,
			tone: "good",
			words: false,
			problem: null,
		};
	}
	const text = String(v);
	if (URL_TEXT.test(text))
		return {
			type: "string",
			verdict: "link",
			accepts: "text with a link",
			why: model
				? "The value contains a link, and the sender chose where it points. A model reading it may follow it or pass it on."
				: "The value contains a link, and the sender chose where it points. Check it before anything follows it.",
			tone: risky,
			words: true,
			problem: "link",
		};
	if (IMPERATIVE_TEXT.test(text))
		return {
			type: "string",
			verdict: "free text",
			accepts: "an instruction",
			why: model
				? "The value tells the reader to do something. A model reading it may do what it says."
				: "The value tells the reader to do something. Only code reads it, but it is still an order, not a fact.",
			tone: risky,
			words: true,
			problem: "words",
		};
	if (PROSE.test(leaf) || /\s\S+\s/.test(text))
		return {
			type: "string",
			verdict: "free text",
			accepts: "a sentence",
			why: "The value is a sentence. With no schema, nothing stops the next one from being an instruction.",
			tone: risky,
			words: true,
			problem: "words",
		};
	return {
		type: "string",
		verdict: "unclear",
		accepts: "one word",
		why: "Today the value is a single word, but with no schema any text fits here. Write the schema down to limit it.",
		tone: "warn",
		words: false,
		problem: "token",
	};
}

function walkValue(prefix: string, v: Record<string, unknown>, reader: string, out: Omit<Finding, "event">[]): void {
	for (const [name, sub] of Object.entries(v)) {
		const path = prefix ? `${prefix}.${name}` : name;
		if (isObj(sub)) walkValue(path, sub, reader, out);
		else if (Array.isArray(sub)) {
			for (const item of sub.slice(0, 1)) {
				if (isObj(item)) walkValue(`${path}[]`, item, reader, out);
				else out.push({ field: `${path}[]`, ...judgeValue(`${path}[]`, item, reader) });
			}
		} else out.push({ field: path, ...judgeValue(path, sub, reader) });
	}
}

/**
 * A tool definition, or a list of them, in the shapes model APIs take: `{name, input_schema}`, `{name, parameters}`
 * or `{type: "function", function: {name, parameters}}`, and MCP's `{name, inputSchema}`. Null when the input isn't one.
 */
function toolDefs(v: unknown): [string, Schema][] | null {
	const one = (t: unknown): [string, Schema] | null => {
		if (!isObj(t)) return null;
		const f = isObj(t.function) ? t.function : t;
		const schema = f.input_schema ?? f.parameters ?? f.inputSchema;
		return typeof f.name === "string" && isSchema(schema) ? [f.name, schema] : null;
	};
	const listed = mcpTools(v);
	if (listed) {
		// A list that says it is tools is read as tools, so a broken entry is named rather than the whole list
		// falling through to being judged as one example message.
		for (const [i, t] of listed.entries())
			if (!one(t)) throw new InputError(`Tool ${i + 1} in the list has no name, or no inputSchema with properties.`);
		return listed.map(one) as [string, Schema][];
	}
	const list = Array.isArray(v) ? v : [v];
	const defs = list.map(one);
	return defs.length > 0 && defs.every((d) => d !== null) ? (defs as [string, Schema][]) : null;
}

/**
 * The tools of an MCP `tools/list` result, `{tools: [...]}`, or of the JSON-RPC response that carries it,
 * `{result: {tools: [...]}}`. Null when the input is neither. `nextCursor` and the rest are ignored.
 */
function mcpTools(v: unknown): unknown[] | null {
	const result = isObj(v) && isObj(v.result) ? v.result : v;
	if (!isObj(result) || !Array.isArray(result.tools)) return null;
	if (result.tools.length === 0) throw new InputError("That tool list is empty, so there is nothing to check.");
	return result.tools;
}

function schemaName(key: string, s: Schema): string {
	const typeProp = s.properties?.type;
	if (typeProp && typeProp.const !== undefined) return String(typeProp.const);
	if (typeProp?.enum?.length === 1) return String(typeProp.enum[0]);
	const title = (s as { title?: unknown }).title;
	return typeof title === "string" ? title : key;
}

/** Everything the linter reads from one pasted contract. Exported for the tests. */
export function lint(
	contract: unknown,
	reader: string,
): { mode: "schema" | "example" | "tool"; events: EventReport[] } {
	const reports: EventReport[] = [];
	let mode: "schema" | "example" | "tool" = "schema";
	let entries: [string, Schema][] = [];
	const calls = toolDefs(contract);
	if (calls) {
		for (const [name, schema] of calls) {
			const fields: Omit<Finding, "event">[] = [];
			const open: string[] = [];
			walkSchema("", schema, reader, fields, open);
			reports.push({
				name,
				shape: "call",
				shapeWhy: "A tool is a request by design, so its name isn't judged.",
				hasId: true,
				hasSource: true,
				closed: schema.additionalProperties === false && open.length === 0,
				findings: fields.map((f) => ({ event: name, ...f })),
			});
		}
		return { mode: "tool", events: reports };
	}
	if (isSchema(contract)) entries = [[schemaName("event", contract), contract]];
	else if (isObj(contract) && Object.values(contract).length > 0 && Object.values(contract).every(isSchema)) {
		entries = Object.entries(contract as Record<string, Schema>).map(([k, s]) => [schemaName(k, s), s]);
	} else if (isObj(contract) && (isObj(contract.$defs) || isObj(contract.definitions))) {
		const defs = (isObj(contract.$defs) ? contract.$defs : contract.definitions) as Record<string, unknown>;
		entries = Object.entries(defs)
			.filter(([, s]) => isSchema(s))
			.map(([k, s]) => [schemaName(k, s as Schema), s as Schema]);
	} else mode = "example";

	if (mode === "schema") {
		for (const [name, s] of entries) {
			const fields: Omit<Finding, "event">[] = [];
			const open: string[] = [];
			walkSchema("", s, reader, fields, open);
			const top = Object.keys(s.properties ?? {});
			const { shape, why } = nameShape(name);
			reports.push({
				name,
				shape,
				shapeWhy: why,
				hasId: top.some((k) => ID_NAME.test(k)),
				hasSource: top.some((k) => SOURCE_NAME.test(k)),
				closed: s.additionalProperties === false && open.length === 0,
				findings: fields.filter((f) => f.field !== "type").map((f) => ({ event: name, ...f })),
			});
		}
		return { mode, events: reports };
	}

	const examples = Array.isArray(contract) ? contract : [contract];
	for (const [i, ev] of examples.entries()) {
		if (!isObj(ev)) throw new InputError(`Item ${i + 1} is not an object.`);
		const name = typeof ev.type === "string" ? ev.type : typeof ev.kind === "string" ? ev.kind : `event ${i + 1}`;
		const fields: Omit<Finding, "event">[] = [];
		walkValue("", ev, reader, fields);
		const { shape, why } = nameShape(name);
		reports.push({
			name,
			shape,
			shapeWhy: why,
			hasId: Object.keys(ev).some((k) => ID_NAME.test(k)),
			hasSource: Object.keys(ev).some((k) => SOURCE_NAME.test(k)),
			closed: null,
			findings: fields.filter((f) => f.field !== "type" && f.field !== "kind").map((f) => ({ event: name, ...f })),
		});
	}
	return { mode, events: reports };
}

/**
 * The risk column, in a word, so the table reads without relying on colour alone. A field that is data is
 * "Constrained", not "None": its schema limits what it can hold, which is not the same as proving it safe.
 */
const risk = (f: Finding) =>
	f.tone === "good"
		? "Constrained"
		: f.problem === "ref" || f.problem === "token"
			? "Unknown"
			: f.tone === "bad"
				? "High"
				: "Medium";

/** One problem: where it is, what is wrong in a few words, and the change, with a severity word for the table. */
type Fix = { where: string; problem: string; todo: string; tone: Tone; severity: string; rank: number };

/** The field's own name, for a change that names it rather than saying "this field" on every row. */
const leafOf = (f: Finding) => f.field.replace(/^.*\./, "").replace(/\[\]$/, "");

/**
 * One concrete change per problem, worst first. The rank orders problems of the same tone by how directly they let
 * an instruction through: a command or a link before free text, free text before a string that is merely unlimited,
 * and the envelope last.
 */
function fixes(result: ReturnType<typeof lint>, model: boolean, at: (f: Finding) => string): Fix[] {
	const out: Fix[] = [];
	const tool = result.mode === "tool";
	const example = result.mode === "example";
	const sev = (t: Tone) => (t === "bad" ? "High" : "Medium");
	for (const e of result.events) {
		if (e.shape === "command") {
			const tone: Tone = model ? "bad" : "warn";
			out.push({
				where: e.name,
				problem: "a command named as an event",
				todo: "Rename it for what happened, and let the agent that owns the action decide what to do.",
				tone,
				severity: sev(tone),
				rank: 0,
			});
		}
		if (e.shape === "unclear")
			out.push({
				where: e.name,
				problem: "neither a fact nor an order",
				todo: "Name it for what happened, in the past tense.",
				tone: "warn",
				severity: "Medium",
				rank: 6,
			});
		for (const f of e.findings) {
			const leaf = leafOf(f);
			const todo =
				f.problem === "link"
					? `Replace ${leaf} with an ID the receiver looks up itself, or remove it.`
					: f.problem === "words"
						? tool
							? `Replace ${leaf} with typed fields the caller fills in, such as an ID with a pattern or a list of topics.`
							: model
								? `Remove ${leaf}. If its words really have to travel, keep them out of anything a model reads.`
								: `Only code reads ${leaf} today. Remove it, or limit it, before a model ever reads these messages.`
						: f.problem === "any"
							? `Give ${leaf} a type, then a pattern, a format or a list of allowed values.`
							: f.problem === "loose"
								? `Limit ${leaf} to what it should hold: an enum, a pattern, or a format such as date.`
								: f.problem === "ref" && f.ref
									? `Paste the schema it points to, ${f.ref}, and check that one too.`
									: f.problem === "ref"
										? `Check ${leaf} by hand.`
										: null;
			if (!todo) continue;
			const rank = { link: 1, words: 2, any: 3, loose: 4, ref: 5 }[
				f.problem as "link" | "words" | "any" | "loose" | "ref"
			];
			out.push({
				where: at(f),
				problem: `${example ? "holds" : "accepts"} ${f.accepts}`,
				todo,
				tone: f.tone,
				severity: risk(f),
				rank,
			});
		}
		if (e.closed === false)
			out.push({
				where: e.name,
				problem: "fields it doesn't list",
				todo: "Add \"additionalProperties\": false, so a sender can't add fields the schema doesn't list.",
				tone: "warn",
				severity: "Medium",
				rank: 7,
			});
		if (e.shape !== "call" && !e.hasId)
			out.push({
				where: e.name,
				problem: "no id field",
				todo: "Add an id, so the receiver can drop a message it has already handled.",
				tone: "warn",
				severity: "Medium",
				rank: 8,
			});
		if (e.shape !== "call" && !e.hasSource)
			out.push({
				where: e.name,
				problem: "no source field",
				todo: "Add a source, so the receiver knows who sent the message.",
				tone: "warn",
				severity: "Medium",
				rank: 9,
			});
	}
	if (example)
		out.push({
			where: "the whole message",
			problem: "an example, not a schema",
			todo: "Write a schema. An example shows today's values, not what each field allows.",
			tone: "warn",
			severity: "Medium",
			rank: 10,
		});
	const order = (t: Tone) => (t === "bad" ? 0 : 1);
	return out
		.map((f, i) => ({ f, i }))
		.sort((a, b) => order(a.f.tone) - order(b.f.tone) || a.f.rank - b.f.rank || a.i - b.i)
		.map(({ f }) => f);
}

const cell = (text: string, tone?: TextTone, mono?: boolean): Cell => ({
	text,
	...(tone && tone !== "normal" ? { tone } : {}),
	...(mono ? { mono } : {}),
});
const md = (s: string) => s.replace(/\|/g, "\\|");
const plural = (k: number, one: string, many = `${one}s`) => `${n(k)} ${k === 1 ? one : many}`;

export default {
	run(input: Input): Output {
		const raw = input.contract.trim();
		if (!raw)
			return {
				kind: "error",
				message: "Paste a tool list, a tool definition, a JSON Schema for your events, or one example event.",
				input: "contract",
			};
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			// The parser's own message differs between engines, so it would make the answer depend on the browser.
			return {
				kind: "error",
				message: "That isn't JSON. Look for a missing value, a trailing comma or an unquoted key.",
				input: "contract",
			};
		}
		let result: ReturnType<typeof lint>;
		try {
			result = lint(parsed, input.reader);
		} catch (e) {
			if (e instanceof InputError) return { kind: "error", message: e.message, input: "contract" };
			throw e;
		}
		if (result.events.length === 0)
			return {
				kind: "error",
				message:
					"Nothing to check. Paste a tool list, an object with `properties`, a map of them, or an example event.",
				input: "contract",
			};

		const model = input.reader === "model";
		const all = result.events.flatMap((e) => e.findings);
		const many = result.events.length > 1;
		const at = (f: Finding) => (many ? `${f.event}.${f.field}` : f.field);
		const todo = fixes(result, model, at);

		/*
		 * The scope line: what was read, and the two counts a reviewer asks first. It replaced a headline that said
		 * "1 of 4 tools can pass an instruction" above a list flagging two, because it counted high risk only. Here the
		 * count is every field that takes any text, split by risk in the note, so it agrees with the findings above it.
		 */
		const anyText = all.filter((f) => f.verdict !== "data" && f.problem !== "ref").length;
		const high = all.filter((f) => risk(f) === "High").length;
		const medium = all.filter((f) => risk(f) === "Medium").length;
		const unknown = all.filter((f) => risk(f) === "Unknown" && f.problem !== "ref").length;
		const noun = result.mode === "tool" ? "tool" : result.mode === "schema" ? "event type" : "message";
		const schemas = result.events.filter((e) => e.closed !== null);
		const closed = schemas.filter((e) => e.closed).length;
		const scope: Field[] = [
			{ label: "Checked", value: `${plural(result.events.length, noun)}, ${plural(all.length, "field")}` },
			{
				label: result.mode === "example" ? "Hold text" : "Accept any text",
				value: `${anyText} of ${all.length}`,
				...(high || medium || unknown
					? {
							note: join(
								[
									high ? `${high} high risk` : "",
									medium ? `${medium} medium` : "",
									unknown ? `${unknown} unknown` : "",
								].filter(Boolean),
							),
						}
					: {}),
			},
			...(schemas.length
				? [{ label: "Refuse extra fields", value: `${closed} of ${plural(schemas.length, "schema")}` }]
				: []),
		];

		const subject = result.mode === "tool" ? "Tool" : result.mode === "schema" ? "Event" : "Message";
		/*
		 * Every field, constrained ones muted, so the rows that need a look stand out without a colour per row.
		 */
		const fieldTable: Output = {
			kind: "table",
			caption: "Every field",
			columns: [
				{ label: subject, mono: true, wrap: "none" },
				{ label: "Field", mono: true, wrap: "none", rowHeader: true },
				{ label: result.mode === "example" ? "Holds" : "Accepts", wrap: "prose" },
				{ label: "Risk", wrap: "none" },
				{ label: "Why", wrap: "prose" },
			],
			rows: all.map((f) => {
				const quiet = f.tone === "good" ? "muted" : undefined;
				return [
					cell(f.event, quiet, true),
					cell(f.field, quiet, true),
					cell(f.accepts, quiet),
					cell(risk(f), quiet ?? f.tone),
					cell(f.why, quiet),
				];
			}),
		};

		/*
		 * ⚠️ The findings come FIRST: they are the answer, and the first part is what a card shows. Each problem is
		 * said once, with its change beside it. This used to be a verdict banner, a separate fix list and a row of
		 * counts, which described the same two fields three times.
		 */
		const parts: Output[] = [];
		if (todo.length)
			parts.push({
				kind: "table",
				role: "findings",
				caption: todo.length === 1 ? "1 problem" : `${todo.length} problems, worst first`,
				columns: [
					{ label: "Risk", wrap: "none" },
					{ label: "Where", mono: true, wrap: "none" },
					{ label: "Problem", wrap: "prose" },
					{ label: "Change", wrap: "prose" },
				],
				rows: todo.map((t) => [
					cell(t.severity, t.tone),
					cell(t.where, undefined, true),
					cell(t.problem),
					cell(t.todo),
				]),
			});
		parts.push({ kind: "fields", role: "answer", fields: scope }, fieldTable);

		if (input.also === "markdown") {
			const accepts = (f: Finding) =>
				md(f.pattern ? f.accepts.replace(f.pattern, () => `\`${f.pattern}\``) : f.accepts);
			const summary = scope.map((f) => `${f.label}: ${f.value}${f.note ? ` (${f.note})` : ""}`).join(". ");
			const lines = [
				`**${summary}.**`,
				"",
				...(todo.length
					? [
							"Problems, worst first:",
							"",
							...todo.map((t, i) => `${i + 1}. ${t.severity}, \`${t.where}\` ${md(t.problem)}: ${md(t.todo)}`),
							"",
						]
					: []),
				`| ${subject} | Field | ${result.mode === "example" ? "Holds" : "Accepts"} | Risk | Why |`,
				"|---|---|---|---|---|",
				...all.map((f) => `| \`${f.event}\` | \`${f.field}\` | ${accepts(f)} | ${risk(f)} | ${md(f.why)} |`),
			];
			parts.push({ kind: "code", lang: "markdown", source: lines.join("\n") });
		}
		return { kind: "group", parts };
	},
} satisfies Tool<Input>;
