# toolshed

Small, exact tools for systems questions. Each one shows how it got its answer.

| Tool | Answers |
|---|---|
| [`agent-tool-schema-linter`](tools/agent-tool-schema-linter) | Which fields of the tools an agent can call, an MCP server's tool list included, and of the events agents send each other are data, and which carry someone else's words to a model |
| [`call-topology-cost`](tools/call-topology-cost) | Where a voice call's cost lands for mesh, an SFU, an MCU and a server that is the other peer: upload, download, server traffic and work per frame, with real packet sizes, and what would make it cheaper |
| [`capacity-planner`](tools/capacity-planner) | How many servers keep the wait under a target, at all or past a limit, the p95 and p99 wait there, and what the queue does either side of that number |
| [`copy-drift`](tools/copy-drift) | Whether two copies of a function have been changing together or drifting apart, from their git history, and where they differ once names are set aside |
| [`fan-out-tail`](tools/fan-out-tail) | How many pages a rare slow call reaches when a page waits for N calls to one backend or several, which backend to fix first, and which of a call's percentiles a page's p99 really is |
| [`ice-pair-ranker`](tools/ice-pair-ranker) | Which ICE candidate pairs a call checks, in what order, which are pruned because they would send the same check, and what in the candidates will stop it connecting, from SDP, candidate JSON or getStats() |
| [`jitter-fec`](tools/jitter-fec) | Which frames of a voice stream play, which are rebuilt from a copy in a later packet, and which are made up, over a network that delays and loses packets, and which buffer and protection would fix it |
| [`llm-timeout-check`](tools/llm-timeout-check) | How long one agent task can run before its SDK and loop settings stop it, when the model is silent, trickling or overloaded, and what to set when that is too long |
| [`loss-playout`](tools/loss-playout) | One voice frame is lost: over UDP and over TCP, which frames still play on time, and how much audio has to be concealed |
| [`metric-cardinality`](tools/metric-cardinality) | How many time series one metric really writes, given its labels, type, client library and targets, which change saves the most, and what keeping them costs |
| [`overload-queue`](tools/overload-queue) | What a service does for a minute of more requests than it can answer: who is answered in time, who waits for nothing, and whether it recovers |
| [`percentile-rollup`](tools/percentile-rollup) | A service's p99 from per-instance histograms (Prometheus, Google Cloud Monitoring, AWS X-Ray, or a KQL or Logs Insights query) or raw latencies, how far off the bucket edges let it be, and which way the averaged per-instance p99 is wrong |
| [`pr-split-cost`](tools/pr-split-cost) | How much the wait for a first review grows with a PR's size on your repository, and what splitting a change into k PRs costs in waiting |
| [`retry-amplification`](tools/retry-amplification) | How many calls reach the bottom service for one user request when every layer retries, and the extra load while it fails |
| [`rtcp-inspector`](tools/rtcp-inspector) | What an RTP or RTCP packet says, byte by byte: the loss and round trip in its reports, and the NACK, PLI, FIR, REMB, TWCC and RFC 8888 feedback a call sends |
| [`sdp-explainer`](tools/sdp-explainer) | What each line of a WebRTC offer or answer sets, which phase of the call reads it, and which rule it breaks |
| [`state-machine-analyzer`](tools/state-machine-analyzer) | Every state of a machine against every event: which cells nobody decided, which states can't be reached or left, and a test per cell |
| [`stun-decoder`](tools/stun-decoder) | What a STUN message says and what to fix, attribute by attribute, with the addresses un-XORed and its integrity checked, TURN long-term credentials included, from hex or a Wireshark dump |
| [`tcp-throughput`](tools/tcp-throughput) | What one TCP connection can carry over a given path, how much of the link that is, and whether the window or the loss is the limit |
| [`timeout-budget`](tools/timeout-budget) | A call chain's worst case when the bottom hangs, whether it fits the caller's deadline, and which retries can never finish |

### A worked example, in seven steps

`salam-1` to `salam-7` are one small tool at seven stages, not seven tools: a greeting for a name written in
Arabic, which grows one part of toolbench at a time. Step 1 is one input and one line of text. By step 7 it has a
form with a select and a toggle, a result in six parts with a chart and a byte view among them, samples,
fixtures, a worker with a timeout, and names a host stylesheet can select. Each step is a complete tool that passes `pnpm check` on its own.

| Step | Adds |
|---|---|
| [`salam-1`](tools/salam-1) | One text input, a `text` result, and the `error` every tool must declare |
| [`salam-2`](tools/salam-2) | A select and a toggle, and an error that points at the first non-Arabic character |
| [`salam-3`](tools/salam-3) | A `group` of `fields`, a `table` and `bytes`: the name's letters, how they join, their UTF-8 bytes |
| [`salam-4`](tools/salam-4) | The manifest's samples, a live card, links and help, and six fixtures. The code is step 3's |
| [`salam-5`](tools/salam-5) | Each letter's abjad value, added up and drawn as a bar chart |
| [`salam-6`](tools/salam-6) | A count that grows with the name, so a worker and a three-second timeout |
| [`salam-7`](tools/salam-7) | `role` on two parts, for the page's own stylesheet |

They are built on [toolbench](https://github.com/eknowledger/toolbench), which turns a tool
directory into a working interface in a page. Each tool here is a plain TypeScript module with a
manifest: no framework imports beyond types, no DOM, no network.

## Running one

There is no build step. A tool is a function, and its tests run it:

```sh
pnpm install
pnpm test        # each tool's own tests
pnpm fixtures    # the framework's contract test: manifest, declared kinds, every fixture, every sample
pnpm check       # everything, the same set CI runs
```

To see one in a browser, embed it with toolbench. The framework's README covers that; this repository
deliberately ships no host, so there is nothing here to keep in step with a runtime version.

## What a tool directory contains

```
tools/<id>/
  tool.json       the manifest: inputs, what run() can return, links, examples
  index.ts        the tool: a function of its inputs
  cases.json      fixtures: input in, expected output out
  README.md       what it is for, and what it deliberately does not do
  index.test.ts   the properties a fixture cannot express
```

Five files, and every one of them is required. The two that are easy to skip and worth insisting on:

- **`cases.json`** is how anyone else can tell the tool still works. A fixture is a claim about a specific
  input, derived by hand or from a reference implementation, not a snapshot of whatever the code did today.
- **`index.test.ts`** is for the claims a fixture cannot make. That the answer is always the lower of two
  ceilings. That doubling the load never reduces the number of servers. That two definitions of a percentile
  disagree in a specific direction. A fixture pins one point; these pin the shape.

`schema/tool.schema.json` gives an editor autocomplete and inline errors for `tool.json`. It is an aid, not
the authority: `@toolbench/sdk`'s `validate()` is, because it checks things a schema cannot, such as a sample
naming an input that does not exist. `pnpm schema` asserts the two agree, and that both reject a manifest
broken on purpose.

## Adding a tool

1. `tools/<id>/` with the five files above. The directory name is the id.
2. `pnpm check`. It will refuse a manifest that does not validate, a declared output kind no fixture
   exercises, a sample that throws, code that does not compile under `erasableSyntaxOnly`, and any import
   that reaches outside the tool's own directory.
3. Open a pull request. CI runs the same set.

### Two constraints that are not style preferences

**A tool may not import anything outside its own directory.** Node builtins and `@toolbench/sdk` types are
allowed; `../shared/helpers.ts` is not. A tool that reaches sideways cannot be read, copied or reviewed on
its own, and a consumer vendoring one directory would get something that does not compile. `pnpm isolation`
enforces it.

**A tool must run in three places**: a Web Worker, a browser main thread, and plain Node. Only one of those
has a bundler. Node runs TypeScript by stripping types, so anything that *emits* code (an enum, a namespace,
a decorator, a constructor parameter property) compiles through a bundler and fails in Node. `tsconfig.json`
sets `erasableSyntaxOnly` so the compiler refuses it here instead.

There is also no DOM in `lib`, on purpose. A tool cannot reach for `document` or `window`, because in a
worker neither exists. Globals that genuinely exist everywhere a tool runs are declared in `globals.d.ts`
as an allowlist.

## Using these in a site

Two honest options, and the difference matters more than it looks.

**Vendor a copy at a pinned commit.** Copy the directories you want, record the commit and a hash per file,
and derive any "view source" link from that commit rather than from a branch. A tool changing then appears
as a reviewable diff in your pull request.

**Depend on this repository.** Less work, and a tool changing appears as a lockfile hash.

⚠️ **A tool runs with the privileges of the page that embeds it.** Worker mode is concurrency, not a
sandbox: a tool in a worker still has `fetch` and can still reach the network. The tools here declare
`pure` and are pure, but you are not taking that on trust when you pin a commit and read the diff, which is
why the first option exists. See toolbench's `SECURITY.md`.

## Dates

Nothing here records when a tool was added or changed. `git log` already knows, so a consumer derives those
dates at build time. A date in a file is a date that goes stale silently.

## Licence

MIT. See [LICENSE](LICENSE).
