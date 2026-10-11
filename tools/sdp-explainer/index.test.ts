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
	[/^(m=|a=(mid|msid|msid-semantic|ssrc|ssrc-group|extmap|extmap-allow-mixed|sendrecv|sendonly|recvonly|inactive)(:|$))/, "RTP (streams)"],
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
			const chart = parts(tool.run({ sdp, other: "", show: "all" })).find((p) => p.kind === "series");
			assert.ok(chart?.kind === "series");
			assert.equal(
				chart.chart.series.reduce((n, s) => n + (s.points[0] ?? 0), 0),
				lines,
				`${label}: the bar is as long as the SDP`,
			);
			assert.ok(chart.chart.series.every((s) => s.stack === "phase" && s.shape === "bar"));
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
		assert.match(table.caption ?? "", /SRTP has no line: its keys come from DTLS, and the only trace in the SDP is the profile name UDP\/TLS\/RTP\/SAVPF and the fingerprint/);
		const last = table.rows.at(-1)!;
		assert.equal(cellText(last[3]), "Other");
		assert.match(cellText(last[2]), /does not guess/);
		const chart = out.find((p) => p.kind === "series");
		assert.ok(chart?.kind === "series" && chart.chart.series.some((s) => s.label === "Other" && s.points[0] === 1));
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
		assert.deepEqual(
			clean.map((p) => p.kind),
			["fields", "series"],
		);
	});
});
