/**
 * Properties of the call topology cost tool that single fixtures cannot pin.
 *
 *   pnpm test
 *
 *  - the stream counts agree with a count made the slow way, by listing every copy of every voice, for N = 2 to 30
 *    and every K: the formulas are the claim, so they are checked against something that is not a formula;
 *  - the SFU never decodes, and an MCU's work grows with N while an SFU's packets grow with N(N-1);
 *  - one stream's rate is the packet size times its packet rate, whatever the frame length.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import type { InputSpec } from "@toolbench/sdk";
import tool, { extensionBytes, rows } from "./index.ts";

const manifest = JSON.parse(readFileSync(new URL("./tool.json", import.meta.url), "utf8")) as { inputs: InputSpec[] };
const base = { participants: 3, pattern: "sfu", loudest: 0, codec: "opus32", bitrate: 32, frame: "20", packet: "bare", ip: "4", srtp: "0", ext: "none" };
/** The method part of one run, which carries the packet and the stream, the defaults overridden by `values`. */
function methodOf(values: Record<string, string | number>) {
	const out = tool.run({ ...base, ...values } as typeof base);
	assert.equal(out.kind, "group");
	const part = out.kind === "group" ? out.parts.find((p) => p.role === "method") : undefined;
	assert.ok(part?.kind === "fields", "a method part");
	return part.fields;
}

/** Who hears whom: every speaker in `talking` reaches every participant but themselves. */
function copies(n: number, talking: number) {
	let toListeners = 0;
	let maxDown = 0;
	for (let listener = 0; listener < n; listener++) {
		let heard = 0;
		for (let speaker = 0; speaker < talking; speaker++) if (speaker !== listener) heard++;
		toListeners += heard;
		maxDown = Math.max(maxDown, heard);
	}
	return { toListeners, maxDown };
}

describe("call-topology-cost", () => {
	it("counts the same copies as listing them one by one", () => {
		for (let n = 2; n <= 30; n++) {
			for (let k = 1; k <= n; k++) {
				const [mesh, sfu, mcu] = rows(n, k);
				const c = copies(n, k);
				assert.equal(sfu!.serverOut, c.toListeners, `SFU out, N=${n} K=${k}`);
				assert.equal(sfu!.down, c.maxDown, `SFU down, N=${n} K=${k}`);
				assert.equal(sfu!.server!.protect, c.toListeners, `SFU encrypts, N=${n} K=${k}`);
				const all = copies(n, n);
				assert.equal(mesh!.up * n, all.toListeners, `mesh copies, N=${n}`);
				assert.equal(mcu!.serverOut, n, `MCU out, N=${n}`);
			}
		}
	});

	it("never decodes on an SFU, and decodes once per participant on an MCU", () => {
		for (let n = 2; n <= 30; n++) {
			const [, sfu, mcu] = rows(n, n);
			assert.equal(sfu!.server!.decode, 0);
			assert.equal(sfu!.server!.encode, 0);
			assert.equal(mcu!.server!.decode, n);
			assert.equal(mcu!.server!.encode, n);
		}
	});

	it("rates a stream as its packet size times its packets a second", () => {
		for (const frame of ["10", "20", "40", "60"]) {
			const fields = methodOf({ participants: 2, pattern: "peer", bitrate: 32, frame });
			const size = Number(fields.find((f) => f.label === "One packet")?.value.replace(" B", ""));
			const per = Number(fields.find((f) => f.label === "One stream")?.value.replace(" kb/s", ""));
			assert.equal(size, (32 * Number(frame)) / 8 + 40);
			assert.ok(Math.abs(per - (size * 8 * (1000 / Number(frame))) / 1000) < 0.01, `frame ${frame}`);
		}
	});

	it("pads header extensions to 4 bytes, as RFC 8285 lays them out", () => {
		assert.equal(extensionBytes([]), 0);
		assert.equal(extensionBytes([1]), 8); // BE DE 00 01, ID+len, level, 2 bytes of padding: post 6's figure
		assert.equal(extensionBytes([1, 1]), 8);
		assert.equal(extensionBytes([1, 1, 2]), 12);
		assert.equal(extensionBytes([1, 1, 2, 3]), 16);
		assert.equal(extensionBytes([3]), 8); // abs-send-time alone: 4 + 4, no padding
	});

	it("gives every packet preset the bytes its label and its parts say", () => {
		const packet = manifest.inputs.find((i) => i.id === "packet");
		const ext = manifest.inputs.find((i) => i.id === "ext");
		assert.ok(packet?.type === "select" && ext?.type === "select");
		for (const option of ext.options) {
			const stated = /(\d+) B$/.exec(option.label);
			if (!stated) continue;
			const fields = methodOf({ ext: option.value });
			assert.equal(Number(fields.find((f) => f.label === "One packet")?.value.replace(" B", "")) - 120, Number(stated[1]), option.label);
		}
		for (const option of packet.options) {
			if (!option.sets) continue;
			const sets = option.sets as Record<string, string>;
			const expected = 80 + 12 + 8 + (sets.ip === "6" ? 40 : 20) + Number(sets.srtp) + ({ none: 0, level: 8, "level-mid": 8, "level-mid-twcc": 12, "level-mid-twcc-abs": 16 } as Record<string, number>)[sets.ext ?? "none"]!;
			assert.equal(Number(methodOf(sets).find((f) => f.label === "One packet")?.value.replace(" B", "")), expected, option.label);
		}
	});

	it("leads with all four patterns, draws the picked one, and never suggests a change that saves nothing", () => {
		for (const pattern of ["mesh", "sfu", "mcu", "peer"]) {
			for (const participants of [2, 3, 10]) {
				const out = tool.run({ ...base, pattern, participants });
				assert.equal(out.kind, "group");
				const parts = out.kind === "group" ? out.parts : [];
				assert.equal(parts[0]?.role, "comparison");
				assert.equal(parts[0]?.kind === "table" && parts[0].rows.length, 4);
				assert.equal(parts[1]?.kind, "graph");
				assert.ok(!parts.some((p) => p.role === "verdict" || p.role === "stats"), "no banner, no tiles");
				const actions = parts.find((p) => p.role === "actions");
				if (actions?.kind === "table") for (const row of actions.rows) assert.match(String(row[1]), /falls from/);
			}
		}
	});
});
