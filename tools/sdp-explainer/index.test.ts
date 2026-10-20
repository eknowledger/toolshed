/**
 * Properties of the SDP explainer that single fixtures cannot pin.
 *
 *   pnpm test
 *
 *  - every line of every sample is in the line table exactly once, under one of the six phases or Other, and the
 *    phase a line gets agrees with the spec's table, written out again here rather than imported;
 *  - the phase counts the chart stacks add up to the number of non-blank lines, counted from the raw text;
 *  - CRLF and LF give identical results, since a description copied from a capture has one and from a page the other;
 *  - the broken offer has its six errors and nothing else;
 *  - a candidate's priority decodes as RFC 8445 section 5.1.2.1 builds it, checked against hand-built values;
 *  - an attribute the model does not know is Other and is not given a meaning.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Output } from "@toolbench/sdk";
import tool, { decodePriority, explain, PHASES, phaseOf } from "./index.ts";

const manifest = JSON.parse(readFileSync(new URL("./tool.json", import.meta.url), "utf8")) as { samples: { label: string; input: { sdp: string } }[] };
const SAMPLES = manifest.samples.map((s) => ({ label: s.label, sdp: s.input.sdp }));
const sample = (label: string) => SAMPLES.find((s) => s.label === label)!.sdp;

const parts = (out: Output) => (out.kind === "group" ? out.parts : [out]);
const cellText = (c: unknown) => (typeof c === "object" && c !== null && "text" in c ? String((c as { text: unknown }).text) : String(c));

/** The spec's phase table, by line prefix, kept apart from the tool's so the two can disagree. */
const SPEC: [RegExp, string][] = [
	[/^[vost]=/, "Session"],
	[/^(c=|a=(group|ice-options|ice-ufrag|ice-pwd|ice-lite|candidate|end-of-candidates)(:|$))/, "ICE (path)"],
	[/^a=(fingerprint|setup|tls-id)(:|$)/, "DTLS (keys)"],
	[/^(m=|a=(mid|msid|msid-semantic|ssrc|ssrc-group|extmap|extmap-allow-mixed|sendrecv|sendonly|recvonly|inactive|rid|simulcast|bundle-only|sctp-port|max-message-size)(:|$))/, "RTP (streams)"],
	[/^a=(rtpmap|fmtp|ptime|maxptime)(:|$)/, "Codec"],
	[/^a=(rtcp|rtcp-mux|rtcp-mux-only|rtcp-rsize|rtcp-fb)(:|$)/, "RTCP (feedback)"],
];

describe("sdp-explainer", () => {
	it("puts every line of every sample in exactly one phase, the one the spec's table gives", () => {
		for (const { label, sdp } of SAMPLES) {
			const lines = sdp.split("\n").filter((l) => l.trim());
			const out = tool.run({ sdp, other: "", show: "all" });
			const table = parts(out).find((p) => p.kind === "table" && p.caption?.startsWith("Every line"));
			assert.ok(table?.kind === "table", label);
			assert.equal(table.rows.length, lines.length, `${label}: one row per line`);
			table.rows.forEach((row, i) => {
				const line = lines[i]!;
				const spec = SPEC.filter(([re]) => re.test(line)).map(([, p]) => p);
				assert.ok(spec.length <= 1, `${label}: the spec's table is ambiguous for ${line}`);
				assert.equal(cellText(row[3]), spec[0] ?? "Other", `${label}: ${line}`);
				assert.equal(phaseOf(line), spec[0] ?? "Other");
			});
		}
	});

	it("stacks phase counts that add up to the line count", () => {
		for (const { label, sdp } of SAMPLES) {
			const m = explain(sdp);
			const lines = sdp.split(/\r?\n/).filter((l) => l.trim()).length;
			const total = [...PHASES, "Other" as const].reduce((n, p) => n + m.counts[p], 0);
			assert.equal(total, lines, label);
			const method = parts(tool.run({ sdp, other: "", show: "all" })).find((p) => p.role === "method");
			assert.ok(method?.kind === "fields");
			assert.equal(method.fields.find((f) => f.label === "Lines")?.value, String(lines), `${label}: the count is the SDP's`);
		}
	});

	it("reads CRLF and LF the same", () => {
		for (const { label, sdp } of SAMPLES) {
			const crlf = sdp.replace(/\n/g, "\r\n");
			for (const show of ["all", "problems"]) {
				assert.deepEqual(tool.run({ sdp: crlf, other: "", show }), tool.run({ sdp, other: "", show }), `${label}, ${show}`);
			}
			assert.deepEqual(tool.run({ sdp: crlf, other: crlf, show: "all" }), tool.run({ sdp, other: sdp, show: "all" }), label);
		}
	});

	it("finds the broken offer's six errors and nothing else", () => {
		const problems = explain(sample("A broken offer")).problems;
		assert.deepEqual(
			problems.map((p) => [p.severity, p.message]),
			[
				["error", "m= section 1: no c= line (RFC 8866 section 5.7)"],
				["error", "m= section 1: no a=mid (RFC 9429 section 5.2.1)"],
				["error", "m= section 1: ice-pwd is 21 characters, at least 22 (RFC 8839 section 5.4)"],
				["error", "m= section 1: no a=rtcp-mux (RFC 5761; RFC 8834 section 4.5)"],
				["error", "candidate 2 (srflx) has no raddr/rport (RFC 8839 section 5.1)"],
				["error", "BUNDLE names mid 0, which no m= section has (RFC 9143)"],
			],
		);
		// And the other five samples, which are meant to be sound, have no error between them.
		for (const { label, sdp } of SAMPLES.filter((s) => s.label !== "A broken offer")) {
			assert.ok(!explain(sdp).problems.some((p) => p.severity === "error"), label);
		}
	});

	it("decodes priorities as RFC 8445 section 5.1.2.1 builds them", () => {
		const build = (type: number, local: number, component: number) => 2 ** 24 * type + 2 ** 8 * local + (256 - component);
		const hand: [number, number, number, number][] = [
			[2130706431, 126, 65535, 1], // Alice's host
			[1694498815, 100, 65535, 1], // her server-reflexive
			[16777215, 0, 65535, 1], // her relay
			[2113929471, 126, 0, 1], // RFC 9429 section 7.1's RTP host candidate
			[2113929470, 126, 0, 2], // and its RTCP one
			[1862270975, 110, 65535, 1], // a peer-reflexive one
		];
		for (const [p, type, local, component] of hand) {
			assert.equal(build(type, local, component), p);
			assert.deepEqual(decodePriority(p), { type, local, component }, String(p));
		}
		const rows = parts(tool.run({ sdp: sample("RFC 9429's example offer, unwrapped"), other: "", show: "all" })).find((p) => p.kind === "table" && p.caption?.startsWith("Every line"));
		assert.ok(rows?.kind === "table");
		const host = rows.rows.find((r) => cellText(r[1]).includes("2113929471"));
		assert.match(cellText(host?.[2]), /type preference 126, local preference 0, component 1/);
	});

	it("says SRTP has no line, and gives an unknown attribute no meaning", () => {
		const sdp = `${sample("Alice's offer")}\na=x-made-up:42`;
		const out = parts(tool.run({ sdp, other: "", show: "all" }));
		const table = out.find((p) => p.kind === "table" && p.caption?.startsWith("Every line"));
		assert.ok(table?.kind === "table");
		const method = out.find((p) => p.role === "method");
		assert.ok(method?.kind === "fields");
		assert.match(method.fields.find((f) => f.label === "SRTP")?.note ?? "", /its keys come from DTLS; the only trace is the profile UDP\/TLS\/RTP\/SAVPF and the fingerprint/);
		const last = table.rows.at(-1)!;
		assert.equal(cellText(last[3]), "Other");
		assert.match(cellText(last[2]), /does not guess/);
		assert.match(method.fields.find((f) => f.label === "Lines")?.note ?? "", /Other 1$/);
	});

	it("filters to the lines with a problem, and draws no empty table", () => {
		const broken = parts(tool.run({ sdp: sample("A broken offer"), other: "", show: "problems" }));
		const table = broken.find((p) => p.kind === "table" && p.caption?.startsWith("The lines with a problem"));
		assert.ok(table?.kind === "table");
		assert.deepEqual(
			table.rows.map((r) => cellText(r[0])),
			["5", "7", "17", "23"],
		);
		const clean = parts(tool.run({ sdp: sample("Alice's offer"), other: "", show: "problems" }));
		// What this SDP is, and how it was read: no line table and no empty list of problems.
		assert.deepEqual(
			clean.map((p) => p.role),
			["answer", "method"],
		);
	});
});

describe("rules real stacks follow, and offers they really send", () => {
	const offer = sample("Simulcast video and a data channel");
	const problems = (sdp: string) => explain(sdp).problems.map((p) => `${p.severity}: ${p.message}`);

	it("a missing a=tls-id is one note for the description, not a warning on every section", () => {
		const found = problems(offer).filter((p) => p.includes("tls-id"));
		assert.equal(found.length, 1, "two sections, one note");
		assert.ok(found[0]!.startsWith("note:"));
		assert.deepEqual(problems(sample("Alice's offer")).filter((p) => p.includes("tls-id")), [], "and nothing when a section has one");
	});

	it("a data channel section is held to RFC 8841, not to the audio rules", () => {
		assert.deepEqual(problems(offer).filter((p) => !p.includes("tls-id")), []);
		const broken = offer.replace("UDP/DTLS/SCTP webrtc-datachannel", "UDP/TLS/RTP/SAVPF webrtc-datachannel");
		assert.ok(problems(broken).some((p) => p.includes("not UDP/DTLS/SCTP")));
	});

	it("a bundle-only section's port 0 is not a missing candidate", () => {
		const bundled = offer.replace("m=application 9 UDP/DTLS/SCTP", "m=application 0 UDP/DTLS/SCTP").replace("a=sctp-port:5000", "a=bundle-only\na=sctp-port:5000");
		assert.deepEqual(problems(bundled).filter((p) => p.includes("port 9")), []);
		// Port 0 without bundle-only is a rejected section, and the placeholder rule still applies.
		assert.ok(problems(offer.replace("m=application 9 UDP/DTLS/SCTP", "m=application 0 UDP/DTLS/SCTP")).some((p) => p.includes("port 9")));
	});

	it("every name a=simulcast lists needs an a=rid line in the same direction", () => {
		const undeclared = problems(offer.replace("a=rid:f send\n", ""));
		assert.ok(undeclared.some((p) => p.startsWith("error:") && p.includes("names rid f")));
		const wrongWay = problems(offer.replace("a=rid:f send", "a=rid:f recv"));
		assert.ok(wrongWay.some((p) => p.startsWith("error:") && p.includes("rid f is declared recv")));
		// A paused encoding, ~f, is still the encoding f.
		assert.deepEqual(problems(offer.replace("send q;h;f", "send q;h;~f")).filter((p) => p.includes("rid")), []);
	});

	it("explains simulcast and the legacy SIM group", () => {
		const what = (line: string) => explain(`v=0\nm=video 9 UDP/TLS/RTP/SAVPF 96\n${line}`).lines.at(-1)!.what;
		assert.match(what("a=simulcast:send q;h;~f"), /send 3 encodings, q, h, f, with f paused/);
		assert.match(what("a=rid:h send max-width=640"), /rid h, one encoding this side will send, limited to max-width=640/);
		assert.match(what("a=ssrc-group:SIM 1 2 3"), /^Legacy simulcast: SSRCs 1, 2, 3/);
	});

	it("leads with the problems when there are any to fix, otherwise with what the SDP sets up", () => {
		for (const { label, sdp } of SAMPLES) {
			const out = parts(tool.run({ sdp, other: "", show: "all" }));
			const roles = out.map((p) => p.role ?? p.kind);
			const fixable = explain(sdp).problems.some((p) => p.severity !== "note");
			assert.deepEqual(roles.slice(0, 2), fixable ? ["findings", "answer"] : ["answer", roles[1]], label);
			for (const gone of ["verdict", "stats", "actions", "series"]) assert.ok(!roles.includes(gone), `${label}: ${roles.join(",")}`);
			// A description that parses is not good news: the summary carries no tone, the problems carry theirs.
			const answer = out.find((p) => p.role === "answer");
			assert.ok(answer?.kind === "fields" && answer.fields.every((f) => f.tone === undefined), label);
		}
	});

	it("leads a pair with what the two settle between them", () => {
		const out = parts(tool.run({ sdp: sample("Alice's offer"), other: sample("The assistant's answer"), show: "all" }));
		assert.equal(out[0]?.id, "pair");
		assert.ok(out[0]?.kind === "fields");
		assert.deepEqual([out[0].fields[0]?.label, out[0].fields[0]?.value], ["These two", "settle a call"]);
	});

	it("shows every line whole, however long", () => {
		const out = parts(tool.run({ sdp: sample("RFC 9429's example offer, unwrapped"), other: "", show: "all" }));
		const table = out.find((p) => p.kind === "table" && p.caption?.startsWith("Every line"));
		assert.ok(table?.kind === "table");
		const longest = sample("RFC 9429's example offer, unwrapped").split("\n").reduce((a, l) => Math.max(a, l.trim().length), 0);
		assert.ok(longest > 72);
		assert.ok(table.rows.some((r) => cellText(r[1]).length === longest), "the longest line is in the table whole");
	});
});
