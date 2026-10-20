# Timeout budget checker

Every call in a chain has a per-try timeout and some retries, and they are usually set by different people at
different times: one in the service's code, one in a client library, one left at the mesh's default. Nothing checks
that they agree. When they do not, a caller gives up on a try while the service it called is still retrying further
down, and those retries are work nobody is waiting for, on a system that is already struggling.

Write the chain one call per line, top first:

```text
frontend -> checkout    none   2
checkout -> pricing     1s     2
pricing -> inventory    500ms  2
```

That is a caller, the service it calls, the per-try timeout (`ms`, `s`, or `none`), and the number of retries. A `#`
starts a comment. Press Run, and it answers, for the worst case of the bottom service hanging:

1. **A banner, only when the chain cannot finish inside the deadline you set**: how long it can take, against how
   long whatever calls the top of the chain waits. When it fits, the answer is one quiet line instead: the worst case,
   inside the deadline, with every retry able to finish.
2. **The calls whose tries cannot fit**, the deadline first. A call is listed when its tries, with their backoff, do
   not all fit inside one try of the call above it, or inside the deadline for the top call. Each row says what the
   caller allows, what the call's tries need, how many of them fit, and the longest per-try timeout that would make
   them fit. The caption counts the rows.
3. **Other changes**: the other ways out for each of those calls (fewer retries, or more room above), and a row for
   each call with no timeout, because it waits forever on a hung callee; Istio sets no HTTP timeout by default. Fix
   from the top down: a shorter timeout on one call changes what fits under it, so run it again after each change.
4. **The chain**, drawn top to bottom, as you wrote it. Each arrow is one call with its per-try timeout and tries, and
   each service says how long its own calls can take. A call whose tries do not fit is red and thick, and the first of
   them is highlighted.
5. **A table** of each call: per try, tries, worst case, and how many of its own tries fit inside one try of its
   caller ("Fit above"), toned on the same call the second part lists.
6. **What it assumes**, last: the bottom hangs and every layer retries a timed-out try, the backoff, and the tries a
   fast failure would make at the bottom if every layer retried it. That last number is the product of everyone's
   tries, which is the retry amplification tool's question. Istio's default retry policy does not retry an HTTP 503,
   so there it is 1.

The rule it checks is the one in the SRE book's advice on deadlines: each layer's tries, with their backoff, should fit
inside one try of the layer above, so timeouts shrink going down the chain.

## How to use it: an example

The chain above, with the app at the top giving up after 2 seconds and 25 ms between tries, Istio's base backoff.
Paste it, set **Top caller waits** to 2000 ms and **Backoff between tries** to 25 ms, and press Run (or press the sample
*Timeouts set by hand, every timeout retried*).

The answer, in red, because 9.20 s overruns the 2 s you set:

> **When the bottom hangs**: Can take 9.20 s; the caller gives up after 2.00 s

Then the calls whose tries cannot fit:

| Call | Allowed | Needs | Fit | Set per-try to |
|---|---|---|---|---|
| `frontend -> checkout` | 2.00 s | 9.20 s | 0/3 | 650 ms or less |
| `pricing -> inventory` | 1.00 s | 1.55 s | 1/3 | 316 ms or less |

And the other ways out, under **Other changes. Fix the top one first, then run again.**:

| Call | Change |
|---|---|
| `frontend -> checkout` | Or let the caller wait at least 9.20 s. |
| `pricing -> inventory` | Or do not retry it, or give checkout -> pricing at least 1.55 s per try. |

The chain draws frontend's call and pricing's call in red. The detail table under it gives each call's per try, tries,
worst case and fit, and the last part notes that a bottom failing fast instead would see 27 tries if every layer
retried the error.

In plain words: when inventory hangs, pricing tries it three times at 500 ms each, which takes 1.55 s, but checkout
gives pricing only 1 s per try, so two of pricing's three tries run for nobody. Checkout's three tries of pricing take up to
3.05 s, and frontend, with no timeout, tries checkout three times: 9.2 s for a request the app gave up on after 2.
The 650 ms and 316 ms are what make each call fit on its own. To make the whole chain fit, shrink the timeouts going
down: the sample *Timeouts that shrink going down* uses 1.8 s with no retry, 800 ms with one, and 225 ms with two, for a
worst case of 1.48 s, which the tool gives as one quiet line with no banner and no table of changes.

## Where it stops being true

- **The worst case assumes every layer retries a try that timed out.** A layer only retries what its policy names.
  Envoy retries a per-try timeout only when `retry_on` includes `gateway-error`, `5xx` or `reset`, and Istio's
  default includes none of them: set a `perTryTimeout`, leave `retryOn` alone, and the timed-out try is simply not
  retried. Measured with Envoy 1.39.3 in mainlog-code's `service-mesh/retry_chain.py`: 1 try with Istio's default,
  3 with `gateway-error` added.
- Backoff is one fixed wait before each retry. Envoy's is random and grows from a 25 ms base: 0 to 24 ms before the
  first retry, and before the second 0 to 74 ms by its documentation, 0 to 49 ms in the 1.39.3 code. So leave a
  little room rather than fitting a chain exactly.
- The services' own work is not counted: only time spent waiting on the call below.
