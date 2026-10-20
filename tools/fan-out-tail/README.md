# Fan-out tail latency calculator

## What it does

A request that fans out to several calls, to shards, backends or one service called many times, and waits for all of
them, is slow whenever any one of those calls is slow. Calls that are slow only 0.5% of the time make 9.54% of
requests slow once a request makes 20 of them. This tool gives you that number, and works backwards to the percentile
each call needs for your request to meet its own target.

| Input | What to enter |
|---|---|
| **Calls per request** | How many calls one request makes and waits for |
| **Each call is slow** | The share of calls over your latency limit, such as `0.5%`. Or the percentile at that limit: `p99` means 1% of calls are over it |
| **Your target** | The percentile you promise for the whole request, such as `p99` |
| **Several dependencies (optional)** | Leave it empty for one kind of call. Fill it in when a request calls services with different tails; it then replaces the first two inputs |

"Slow" means over one limit, the time your request can afford to wait. If your target is a p99 under 300 ms, a call
is slow when it takes longer than 300 ms, and you read each call's share of slow calls off its own latency dashboard.

Press **Run** after changing the inputs. **Start again (defaults)** puts every input back as it was.

## How to use it: an example

A search request fans out to 20 shards and waits for all of them. Each shard is over your 300 ms limit 0.5% of the
time. Your target is a p99 under 300 ms. Enter:

| Input | Value |
|---|---|
| Calls per request | `20` |
| Each call is slow | `0.5%` |
| Your target | `p99` |

The tool answers:

```text
Requests that wait for a slow call
9.54%
1 - (1 - 0.5%)^20  ·  a p99 target allows 1%

For p99 on the request, each call needs p99.95. Your calls are at p99.5.
```

Then a curve of slow requests against calls per request, with 20 marked: at 50 calls the same shards would slow
22.2% of requests, and at 100, 39.4%.

In plain words: one search in ten waits for a slow shard, nearly ten times what a p99 target allows. For 99% of searches to
stay under 300 ms, each shard has to stay under it 99.95% of the time, about 1 call in 2,000 slow at most, which is a
stricter percentile than most dashboards show.

### Several dependencies

A checkout service calls 12 dependencies: pricing 20 times, once per item in the basket, promotions twice, the
session cache three times, and the other nine once each. Leave the first two inputs as they are and enter, under
**Several dependencies (optional)**:

```text
cart 1 0.1%
pricing 20 0.5%
inventory 1 1%
tax 1 0.2%
shipping quotes 1 2%
payments 1 0.5%
fraud check 1 1%
user profile 1 0.1%
promotions 2 0.5%
loyalty 1 0.3%
recommendations 1 1%
session cache 3 0.1%
```

The tool answers:

```text
Requests that wait for a slow call
16.1%
1 - (1 - 0.1%) × (1 - 0.5%)^20 × ... × (1 - 0.1%)^3  ·  34 calls to 12 dependencies  ·  a p99 target allows 1%

For p99 on the request, each of the 34 calls needs p99.97. Fix pricing first: its 20 calls slow 9.54% of requests on their own.
```

| Dependency | Calls | Slow calls | Without it |
|---|---|---|---|
| pricing | 20 | 0.5% | 7.26% |
| shipping quotes | 1 | 2% | 14.4% |
| inventory | 1 | 1% | 15.3% |
| fraud check | 1 | 1% | 15.3% |
| recommendations | 1 | 1% | 15.3% |

The table, "Fix first: slow requests without each one, top 5 of 12", shows the five that matter most. Shipping quotes has the worst share, 2%, but pricing does more damage
because every checkout calls it 20 times: without its slow calls, slow checkouts would fall from 16.1% to 7.26%, and
without shipping quotes' only to 14.4%.

## Writing a dependency

One per line, or several on a line separated by commas. The name comes first, then the calls per request, then the
share of slow calls. The calls are optional and default to one.

| You write | It means |
|---|---|
| `pricing 20 0.5%` | 20 calls per request, 0.5% of them slow |
| `pricing: 20 calls, 0.5%` | The same |
| `tax 0.2%` | 1 call, 0.2% slow |
| `shards 20 p99` | 20 calls, and your limit sits at each call's p99, so 1% are slow |
| `auth 3x p99.9` | 3 calls, 0.1% slow |

A line starting with `#` is a comment.

## Where the formulas come from

A request is under your limit only if every one of its calls is. If the calls are independent, the chance that none
of them is slow is the product of each call's chance of being fast:

- with n calls, each slow a share q of the time, a share 1 - (1 - q)^n of requests have a slow call. With several
  dependencies, n_i calls to dependency i at q_i each, it is 1 - (1 - q_1)^n_1 × (1 - q_2)^n_2 × ...;
- working backwards, for a share p of requests to be fast, each of n calls has to be fast with probability p^(1/n).
  With 20 calls and a p99 target that is 0.99^(1/20), a call's p99.95.

Dean and Barroso give the best-known example in [The Tail at Scale](https://cacm.acm.org/research/the-tail-at-scale/)
(CACM, 2013): 100 servers, each slow one time in a hundred, and 63% of requests are slow. The sample "The Tail at
Scale: 100 servers at their p99" is that example, and the tool gives 63.4%.

## What it assumes

- **Independent calls.** This is the one to doubt. Calls that share a host, a network path, a lock or a
  garbage-collection pause are slow together. That bunches the slow calls into fewer requests, so fewer requests are
  slow than this says, but the ones that are slow are hit harder. Measure your own requests, and use this as the
  baseline to compare against.
- **One limit for every call.** The same answer holds whether the calls run in parallel or one after another, because
  either way a request that waits for a slow call is late.
- **The request waits for all of them.** A request that can answer without a slow call, or that sends a hedged second
  request after a timeout, does better. Those are the remedies The Tail at Scale describes.
- **Working backwards holds every call to the same share.** You can give one dependency more room than another, as
  long as the product of their chances of being fast stays at your target.
