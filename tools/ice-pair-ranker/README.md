## What it does

Two computers trying to reach each other each list the addresses they might be reached at, their *candidates*, and ICE tries them in pairs until one works. This tool takes both lists and shows what ICE will do with them, starting with one plain sentence: how many checks run, which pairs are dropped and why, and which come last.

ICE never checks every candidate against every other in any order. RFC 8445 builds a checklist in three steps, and
this tool shows each one:

1. **Pair.** Every local candidate with every remote one that has the same component, the same transport and the
   same address family. An mDNS name, the `.local` address a browser shows instead of its private IP, pairs with
   either family, since only resolving it would say which.
2. **Price.** Each pair gets `2^32 * min(G, D) + 2 * max(G, D) + (G > D ? 1 : 0)`, where G is the controlling
   agent's candidate priority and D the controlled one's. So the same two candidates can rank differently depending
   on which side controls, by exactly the last term.
3. **Prune.** A server-reflexive or peer-reflexive local candidate is replaced by its base, the host address its
   packets really leave from. A pair that then duplicates a higher-priority pair is dropped, because it would send
   the same check. This is why a server-reflexive candidate is never checked on its own: its job is to tell the
   other side where to send, and it comes back as the local side of the pair that works, learned from the answer.

What is left, highest priority first, is the order the checks run in. The heatmap draws it as a grid, local
candidates down and remote ones across, each cell its place in the order.

## What it reads, and what it does not

- **Priorities are taken as given**, not recomputed: they are what the two agents exchanged. Each is also broken
  into its type preference, local preference and component, so a line whose priority does not match its type shows.
- **The base of a reflexive candidate** is found from its `raddr` and `rport`. A browser often hides those (`raddr
  0.0.0.0 rport 0`); then the base cannot be found and the pair is kept, which is the cautious reading.
- **Not modelled**: which checks succeed. That depends on the networks in between, and no list of candidates says.
  Nor the frozen and waiting states, or triggered checks, which change when checks run but not their priority order.

## References

- [RFC 8445 section 6.1.2](https://www.rfc-editor.org/rfc/rfc8445#section-6.1.2): forming, pricing and pruning the checklist
- [RFC 8839 section 5.1](https://www.rfc-editor.org/rfc/rfc8839#section-5.1): the candidate attribute's syntax
