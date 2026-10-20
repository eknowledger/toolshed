# Retry amplification calculator

A retry count in a config file looks like a small number: 2 here, 3 there. Down a chain of calls it is an exponent.
A layer that retries wraps everything below it, so code that makes 3 attempts through a proxy that makes 3 makes
9, and the next call down sees all 9 of them, each making its own.

Give it how deep the chain is and how many retries each layer makes, then press Run. **Mesh** fills the proxy
retries with a mesh's default: Istio 2, Linkerd 1 (once retries are turned on for a route; it makes none until then),
None 0. Change the number and the select shows Custom. It answers in this order:

1. **Calls at the bottom**: for one user request, when the bottom service is failing every call.
   `(1 + code retries) x (1 + proxy retries)` per call, to the power of the depth, times the client's tries.
2. **What to change**, the biggest cut first. Each row is the same arithmetic run again with that one change made,
   so it says how many calls the change leaves at the bottom: a retry budget, retrying only at the top of the chain,
   retrying in the code or the proxy but not both, and a client that stops retrying the whole request. A change that
   would not lower the number is not offered.
3. **The numbers beside it**: tries per call; the calls that reach the bottom on average when it fails only some
   share of calls, which is the extra load on a service that is already failing (at 50% failure, 3 deep with 2
   retries each, it doubles); and the share of user requests that still fail, if failures were independent. They
   rarely are: a failing service fails many calls in a row, so treat that as the best case.
4. **The tree** of every try one user request causes. Only the first try at each service is followed down, because
   every other try sends exactly the same calls below it; each of those says how many it sends. Past four tries at
   one service, the rest are drawn as one node.
5. **A table** of what each service in the chain receives.

## How to use it: an example

Three calls in a row, frontend to checkout to pricing to inventory, on a mesh with Istio's default of 2 retries per
call, and inventory is down. Enter **Calls deep** 3, **Mesh** Istio, which fills **Proxy retries per call** with 2,
everything else 0, **Bottom fails**
100%, **Retry budget** None, and press Run (or press the sample *Istio's default over gRPC, bottom down*).

The answer:

> **Calls at the bottom**: 27 calls reach the bottom service for one user request while it is down.
> *3 tries per call, 3 calls deep, if every layer retries the error it gets.*

What to change:

| Change | Calls at the bottom | Why it works |
|---|---|---|
| Turn on a retry budget of 20%, Envoy's default share once it is enabled. | 1.728 calls reach the bottom instead of 27. | A budget allows retries only while they are a small share of a layer's requests. Envoy's always allows 3 at once, so at low traffic it does not bind. |
| Retry only at the top of the chain, and let every call below it fail fast. | 3 calls reach the bottom instead of 27. | 3 calls in a row each retry, so their tries multiply: 3 to the power of 3. |

And beside it: **Tries per call** 3, **When the bottom fails 100%** 27 calls, **User requests that still fail** 100%.
The tree shows checkout tried 3 times, pricing 9 and inventory 27, and the table lists 1, 3, 9 and 27.

In plain words: two retries per call looks harmless in one config file, but three of them in a row turn one request
into 27 at a service that is already down, and every one of them fails. The retries add load exactly when the
bottom can least take it, and they cannot help, because it is down. A budget, or retries at one layer only, takes it
back to a handful. Try *Code that retries inside the mesh* to see the same chain with a client library that also
retries twice: 9 tries per call, 729 at the bottom. Or set **Mesh** to Linkerd: 1 retry per call, 2 tries, and 8
calls reach the bottom instead of 27.

## Retry layers that are easy to miss

- **The mesh.** Istio retries twice by default, on connection failures, refused streams and gRPC `UNAVAILABLE`.
  Not on an HTTP 503, unless you add it. Linkerd retries nothing until a route is configured to, and then once,
  unless the configuration gives a count.
- **A client library** with its own retry policy, inside a service's code.
- **The app or browser** at the top, retrying the whole request.
- **A load balancer or gateway** in front of it all.

## Where it stops being true

- Failures are independent, and only at the bottom. Real failures are correlated, and an overloaded service in
  the middle fails on its own too.
- A layer retries only failures it sees. If a service in the middle turns a downstream failure into something its
  caller's policy does not retry (an HTTP 503 under Istio's defaults, say), the multiplication stops there. This is
  the worst case: every layer passes the failure up in a form the next one retries.
- The retry budget is a simple cap of `1 + budget` per layer. Envoy measures it over concurrent requests, and the
  SRE book's version over a client's recent requests, so the capped numbers are a ceiling.
- Timeouts are not modelled. The timeout-budget tool covers whether the retries can fit in the time at all.
