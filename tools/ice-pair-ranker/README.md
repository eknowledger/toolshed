# ICE pair ranker

## What it answers

Two computers trying to reach each other each list the addresses they might be reached at, their *candidates*, and ICE
tries them in pairs until one works. Given both lists, which pairs does ICE form, which does it drop, in what order does
it try the rest, and is there anything in the lists that will stop the call connecting?

Paste the candidates however you have them: `a=candidate` lines, a whole offer or answer, the JSON of an
RTCIceCandidate or a list of them, or the JSON of `getStats()`, which holds both sides in one paste.

## How to use it: an example

Say a call between two browsers takes a while to connect, and you want to see what ICE had to work with. In the browser
console of one side, run:

```js
copy(JSON.stringify([...(await pc.getStats()).values()]))
```

**1. Paste it into Local candidates, leave Remote candidates empty, and press Run.** The report holds the local
candidates and the remote ones the other side sent. The "From getStats()" sample is a report like that.

**2. Read the order.** It comes first, because the answer is a list:

```
Computed check order, highest priority first. Local side controls
#  Local                       Remote                      Route
1  host 7f3c1b2e-...local:50004  host 3b9e2f10-...local:61000  direct
2  host 7f3c1b2e-...local:50004  srflx 198.51.100.77:40100     direct
3  srflx 192.0.2.10:54321      host 3b9e2f10-...local:61000  direct
4  srflx 192.0.2.10:54321      srflx 198.51.100.77:40100     direct
5  host 7f3c1b2e-...local:50004  relay 198.51.100.51:49200     TURN
...
9  relay 198.51.100.50:49152   relay 198.51.100.51:49200     TURN
```

Each row also has its pair priority, the number the order is sorted by. In plain words: each side has three
candidates, so there are nine pairs, and none is dropped. The first check is between the two machines' own addresses,
the last five go through a TURN server. It is the order RFC 8445 computes, not one this tool watched happen.

**3. Read what to look at.**

| Severity | What we found | What it means and what to do |
|---|---|---|
| Note | 1 remote host candidate is an mDNS name, ending in .local. | A name like that only resolves on the same local network. Across the internet, the reflexive or relayed pairs carry the call. |
| Note | 1 local reflexive candidate does not say which host address it was learned from. | Browsers hide it as raddr 0.0.0.0. Its pairs are kept here; if the host it came from is listed, the browser prunes them. |

The first row matters most. The first check, host to host, goes to a `.local` name, which only means something on
the other machine's own network. Across the internet that pair fails, and the call is carried by a server-reflexive or
relayed pair further down the list. A warning, such as no relay on either side behind two NATs, comes straight after
the order instead of here.

**4. Read the grid for the shape.** When both sides have two candidates or more, the grid puts local candidates down
the side and remote ones across the top, and each cell is the pair's place in the order: `1 2 5` for the host row,
`3 4 7` for the srflx row, `6 8 9` for the relay row. The fields at the end give each candidate's priority, decoded,
and the formula that prices a pair.

**Compare with the post's call.** Press "Two browsers", where the same three-and-three are typed as lines with their
real addresses. Now the srflx candidate names its base, `raddr 192.168.1.42 rport 50004`, so its three pairs are
recognised as copies of the host's and dropped: 6 checks instead of 9. The pruned table under the order lists the
three, each with the address it is really sent from, `192.168.1.42:50004`, and the check it duplicates.

## How it works

ICE never checks every candidate against every other in any order. RFC 8445 builds a checklist in four steps, and this
tool shows each one:

1. **Pair.** Every local candidate with every remote one that has the same component, the same transport and the
   same address family. An mDNS name, the `.local` address a browser shows instead of its private IP, pairs with
   either family, since only resolving it would say which. TCP candidates pair active with passive.
2. **Price.** Each pair gets `2^32 * min(G, D) + 2 * max(G, D) + (G > D ? 1 : 0)`, where G is the controlling
   agent's candidate priority and D the controlled one's. So the same two candidates can rank differently depending
   on which side controls, by exactly the last term.
3. **Prune.** A server-reflexive or peer-reflexive local candidate is replaced by its base, the host address its
   packets really leave from. A pair that then duplicates a higher-priority pair is dropped, because it would send
   the same check. This is why a server-reflexive candidate is never checked on its own: its job is to tell the
   other side where to send.
4. **Limit.** Past 100 pairs, the default in section 6.1.2.5, the lowest are dropped.

What is left, highest priority first, is the order the checks run in.

**What to look at** lists what in the candidates can stop or slow a call: no relayed candidate on either side, so no
fallback when UDP is blocked; an ICE-lite side set as controlling, which RFC 8445 forbids; type preferences that put a
relay ahead of a direct path; more than 100 pairs; mDNS names; hidden bases; candidates with nothing to pair with; and
the same candidate pasted twice.

## What it reads, and what it does not

- **Priorities are taken as given**, not recomputed: they are what the two agents exchanged. Each is also broken
  into its type preference, local preference and component, so a line whose priority does not match its type shows.
- **The base of a reflexive candidate** is found from its `raddr` and `rport`. A browser often hides those (`raddr
  0.0.0.0 rport 0`); then the base cannot be found and the pair is kept, which is the cautious reading.
- **getStats() has no component**, because a bundled call with rtcp-mux has only one, so its candidates are component 1.
- **Not read**: chrome://webrtc-internals' own dump format, which stores each statistic as a time series rather than
  as one report. Copy getStats() from the console instead.
- **Not modelled**: which checks succeed. That depends on the networks in between, and no list of candidates says.
  Nor the frozen and waiting states, or triggered checks, which change when checks run but not their priority order.

## References

- [RFC 8445 section 6.1](https://www.rfc-editor.org/rfc/rfc8445#section-6.1): roles, and forming, pricing, pruning and
  limiting the checklist
- [RFC 8839 section 5.1](https://www.rfc-editor.org/rfc/rfc8839#section-5.1): the candidate attribute's syntax
- [RFC 6544 section 6.2](https://www.rfc-editor.org/rfc/rfc6544#section-6.2): pairing TCP candidates
- [W3C webrtc-stats](https://www.w3.org/TR/webrtc-stats/#dom-rtcicecandidatestats): the candidate entries of getStats()
