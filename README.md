# toolshed

Small, exact tools for systems questions. Each one shows how it got its answer.

| Tool | Answers |
|---|---|
| [`capacity-planner`](tools/capacity-planner) | How many servers keep the wait under a target, and what the queue does either side of that number |
| [`loss-playout`](tools/loss-playout) | One voice frame is lost: over UDP and over TCP, which frames still play on time, and how much audio has to be concealed |
| [`rtcp-inspector`](tools/rtcp-inspector) | What an RTP or RTCP packet actually contains, byte by byte, including the fields nobody checks by eye |
| [`tcp-throughput`](tools/tcp-throughput) | What one TCP connection can carry over a given path, and whether the window or the loss is the limit |

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
