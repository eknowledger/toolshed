/**
 * The globals a tool is allowed to use.
 *
 * ⚠️ `tsconfig.json` here sets `lib: ["ES2023"]` with no DOM, so a tool cannot reach for `document` or
 * `window`: it runs in a Web Worker where neither exists, and in plain Node during fixtures. That
 * exclusion is deliberate and worth keeping.
 *
 * But it also removes globals that are genuinely universal, present in browsers, workers and Node
 * alike. Adding `"DOM"` back to `lib` to get them would hand back `document` as well, which is the
 * thing being prevented. So they are declared here instead: an allowlist rather than a blanket.
 *
 * Add to this only when the global really does exist everywhere a tool runs.
 */
declare class TextDecoder {
	constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
	readonly encoding: string;
	decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string;
}

declare class TextEncoder {
	readonly encoding: string;
	encode(input?: string): Uint8Array;
	encodeInto(source: string, destination: Uint8Array): { read: number; written: number };
}

/**
 * `AbortSignal`, because a tool receives one: `ctx.signal` is how the runtime cancels a slow run, and a
 * tool that ignores it cannot be stopped. Present in browsers, workers and Node since 15.
 *
 * Only the two members a tool has any business touching. `throwIfAborted` is the one to reach for inside a
 * loop, since it turns cancellation into the same rejection the runtime already expects; checking
 * `aborted` and returning a partial result instead would report an incomplete answer as a complete one.
 */
declare interface AbortSignal {
	readonly aborted: boolean;
	throwIfAborted(): void;
}
