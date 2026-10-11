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
import tool, { rows } from "./index.ts";

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
			const out = tool.run({ participants: 2, pattern: "peer", loudest: 0, bitrate: 32, frame, srtp: "0", level: false });
			assert.equal(out.kind, "group");
			const fields = out.kind === "group" && out.parts[0]?.kind === "fields" ? out.parts[0].fields : [];
			const size = Number(fields.find((f) => f.label === "Packet")?.value.replace(" B", ""));
			const per = Number(fields.find((f) => f.label === "Per stream")?.value.replace(" kb/s", ""));
			assert.equal(size, (32 * Number(frame)) / 8 + 40);
			assert.ok(Math.abs(per - (size * 8 * (1000 / Number(frame))) / 1000) < 0.01, `frame ${frame}`);
		}
	});
});
