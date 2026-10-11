# SDP explainer

## What it does

A WebRTC call starts with two blobs of text, an offer and an answer, written in SDP. Each line is read by a different
part of the call, and the order they are written in (RFC 8866's) is not the order the call uses them in. Paste one and
the tool shows every line, what it sets in one sentence, and which phase reads it:

| Phase | Lines |
|---|---|
| Session | `v=`, `o=`, `s=`, `t=` |
| ICE (path) | `c=`, `a=group`, `a=ice-options`, `a=ice-ufrag`, `a=ice-pwd`, `a=ice-lite`, `a=candidate`, `a=end-of-candidates` |
| DTLS (keys) | `a=fingerprint`, `a=setup`, `a=tls-id` |
| RTP (streams) | `m=`, `a=mid`, `a=msid`, `a=msid-semantic`, `a=ssrc`, `a=ssrc-group`, `a=extmap`, `a=extmap-allow-mixed`, the direction attributes |
| Codec | `a=rtpmap`, `a=fmtp`, `a=ptime`, `a=maxptime` |
| RTCP (feedback) | `a=rtcp`, `a=rtcp-mux`, `a=rtcp-mux-only`, `a=rtcp-rsize`, `a=rtcp-fb` |

A line the model does not know is **Other**, and the tool says so rather than guessing at it, as RFC 8866 tells a
parser to ignore an attribute it does not understand.

**SRTP has no line.** Its keys come from DTLS, which runs on the media path after ICE has found it. The only trace of
it in the SDP is the profile name `UDP/TLS/RTP/SAVPF` and the fingerprint, which is a hash of a certificate and not a
key.

The chart is one horizontal bar per description, its lines stacked by phase, for the question "what is this mostly
about". A candidate's priority is decoded into its type preference, local preference and component, the way the ICE
pair ranker decodes it.

## What it checks

| Severity | Check | Source |
|---|---|---|
| error | the first line is not `v=0` (the whole input is refused) | RFC 8866 section 5.1 |
| error | the profile is not `UDP/TLS/RTP/SAVPF` | RFC 9429 section 5.1.2 |
| error | no `c=` line in the section or the session | RFC 8866 section 5.7 |
| error | no `a=mid` | RFC 9429 section 5.2.1 |
| error | a ufrag under 4 or a password under 22 characters | RFC 8839 section 5.4 |
| warning | a ufrag or password with a character outside letters, digits, `+` and `/` | RFC 8839 section 5.1 |
| error | no `a=fingerprint` | RFC 9429 section 5.1.2 |
| warning | no `a=tls-id` | RFC 8842 sections 5.2 and 5.3 |
| error | no `a=rtcp-mux` | RFC 5761; RFC 8834 section 4.5 |
| error | Opus not written `opus/48000/2` | RFC 7587 section 7 |
| error | a server-reflexive, peer-reflexive or relayed candidate without `raddr` and `rport` | RFC 8839 section 5.1 |
| note | a priority that does not decode to RFC 8445's recommended type preference, or to its own component | RFC 8445 section 5.1.2 |
| warning | candidates, but none at the `m=` port and `c=` address | RFC 8839 section 4.2.1.2 |
| warning | no candidates, and not port 9 with `IN IP4 0.0.0.0` | RFC 9429 section 5.2.1 |
| error | `a=ice-lite` inside a media section | RFC 8839 section 5.3 |
| error | ICE-lite with a candidate that is not a host | RFC 8445 section 2.5 |
| error | BUNDLE names a mid no section has | RFC 9143 |
| note | `a=ice-lite` in an offer, which a JSEP endpoint never sends | RFC 9429 section 5.2.1 |

An error is a MUST broken. A warning is a SHOULD, or a value real stacks accept anyway. A note is a decoded oddity.
A missing line is reported on its section's `m=` line, since it has no line of its own.

## Two descriptions as a pair

Paste the other side's description too and the tool reads what the two settle between them:

| Field | Rule |
|---|---|
| ICE roles | One side lite: the full agent controls. Both full, or both lite: the offerer controls (RFC 8445 section 6.1.1) |
| ClientHello sent by | The side whose `a=setup` resolves to active (RFC 5763 section 5). Two `actpass` are two offers, and settle nothing |
| Codec agreed | Payload types both list with the same encoding |
| BUNDLE | The same mids grouped on both sides |
| rtcp-mux | On both |
| Fingerprints | Present on both, and different |

## The samples

Only one of them is a capture, and it is not a browser's:

| Sample | Made how |
|---|---|
| Alice's offer | Constructed: the series' running example, a full agent with three candidates |
| Alice's offer, before gathering | Constructed: trickle ICE, port 9 and `0.0.0.0`, no candidates yet |
| The assistant's answer | Constructed: ICE-lite, one host candidate, `a=setup:active` |
| aiortc's answer | **Captured** from aiortc answering Alice's offer: three fingerprints, `recvonly`, no `a=tls-id` |
| RFC 9429's example offer | RFC 9429 section 7.1's offer, with its layout undone: blank lines removed and the wrapped fingerprint joined into one line |
| A broken offer | Constructed: Alice's offer with five mistakes, which the checks report as six errors |

All the addresses are from the documentation ranges, and the credentials are made up.

## What it does not do

- **Check a fingerprint.** It has no certificate, so it can only say a fingerprint is present and whether the two
  sides' differ. The DTLS handshake does the real check, and ends the call on a mismatch.
- **Guess at an attribute it does not know**, or at a codec parameter. Those are named as unknown.
- **Validate everything in RFC 8866.** The checks are the ones that stop a WebRTC call, not a full grammar.
- **Show more than 72 characters of a line** in the table. A longer one, a SHA-512 fingerprint say, is cut; the input
  box has it whole.

Lines are trimmed and blank ones dropped, so CRLF, LF and a description copied with an RFC's indentation all read the
same.

## References

- [RFC 8866](https://www.rfc-editor.org/rfc/rfc8866): SDP
- [RFC 9429](https://www.rfc-editor.org/rfc/rfc9429): JSEP, what a browser puts in an offer and an answer
- [RFC 8839](https://www.rfc-editor.org/rfc/rfc8839): ICE's SDP attributes
- [RFC 8842](https://www.rfc-editor.org/rfc/rfc8842), [RFC 5763](https://www.rfc-editor.org/rfc/rfc5763),
  [RFC 5764](https://www.rfc-editor.org/rfc/rfc5764): DTLS-SRTP and its SDP
- [RFC 9143](https://www.rfc-editor.org/rfc/rfc9143): BUNDLE
- [RFC 5761](https://www.rfc-editor.org/rfc/rfc5761): RTP and RTCP on one port
- [RFC 7587](https://www.rfc-editor.org/rfc/rfc7587): Opus over RTP
- [RFC 8285](https://www.rfc-editor.org/rfc/rfc8285): RTP header extensions
- [RFC 4585](https://www.rfc-editor.org/rfc/rfc4585): RTCP feedback
- [RFC 8445](https://www.rfc-editor.org/rfc/rfc8445): ICE, for candidate priorities and roles
