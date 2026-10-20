# SDP explainer

## What it does

The answer comes first, in the shape the input calls for. For one description, what it sets up, grouped as transport,
security and media, with a first line saying whether these checks found anything; when they found something to fix,
the problems lead, each located by its line. For a pair, whether the two settle a call. Then every line, and last, how
it was read.

A WebRTC call starts with two blobs of text, an offer and an answer, written in SDP. Each line is read by a different
part of the call, and the order they are written in (RFC 8866's) is not the order the call uses them in. Paste one and
the tool shows every line, what it sets in one sentence, and which phase reads it:

| Phase | Lines |
|---|---|
| Session | `v=`, `o=`, `s=`, `t=` |
| ICE (path) | `c=`, `a=group`, `a=ice-options`, `a=ice-ufrag`, `a=ice-pwd`, `a=ice-lite`, `a=candidate`, `a=end-of-candidates` |
| DTLS (keys) | `a=fingerprint`, `a=setup`, `a=tls-id` |
| RTP (streams) | `m=`, `a=mid`, `a=msid`, `a=msid-semantic`, `a=ssrc`, `a=ssrc-group`, `a=extmap`, `a=extmap-allow-mixed`, the direction attributes, simulcast's `a=rid` and `a=simulcast`, `a=bundle-only`, and a data channel's `a=sctp-port` and `a=max-message-size` |
| Codec | `a=rtpmap`, `a=fmtp`, `a=ptime`, `a=maxptime` |
| RTCP (feedback) | `a=rtcp`, `a=rtcp-mux`, `a=rtcp-mux-only`, `a=rtcp-rsize`, `a=rtcp-fb` |

A line the model does not know is **Other**, and the tool says so rather than guessing at it, as RFC 8866 tells a
parser to ignore an attribute it does not understand.

**SRTP has no line.** Its keys come from DTLS, which runs on the media path after ICE has found it. The only trace of
it in the SDP is the profile name `UDP/TLS/RTP/SAVPF` and the fingerprint, which is a hash of a certificate and not a
key.

A candidate's priority is decoded into its type preference, local preference and component, the way the ICE
pair ranker decodes it.

## How to use it: an example

Say you are adding simulcast to a video call: the browser should send three copies of the camera, small, medium and
full size, so a server can forward each viewer the one that fits. You have the offer and want to know it says that.

**1. Paste the offer.** It's the **Simulcast video and a data channel** sample. The lines that matter:

```
m=video 9 UDP/TLS/RTP/SAVPF 96 97
a=rid:q send
a=rid:h send
a=rid:f send
a=simulcast:send q;h;f
m=application 9 UDP/DTLS/SCTP webrtc-datachannel
```

**2. Press Run, and read the summary.**

```
This SDP       Offer (a=setup:actpass), 2 media sections
               No problems found by these checks, and 1 note.
Transport
  ICE          full, ufrag Ab3d
  Candidates   none yet
  BUNDLE       mid 0 1
Security
  DTLS role    either; the answerer chooses
  Fingerprints sha-256
               2 fingerprints
Media
  Sections     video mid 0; application mid 1
  Codecs       VP8/90000 pt 96, rtx/90000 pt 97
  rtcp-mux     yes
```

**3. Read the note under it.** One row, worth knowing and nothing to fix:

```
Worth knowing, nothing to fix
note   line 8   no a=tls-id: RFC 8842 asks for one, but Chrome, Firefox and aiortc never send it, and all of them
                accept a description without it
```

**4. Read the lines.** `a=simulcast:send q;h;f` reads *"Simulcast: this side will send 3 encodings, q, h, f, each one a
separate copy of the same source at its own resolution or bitrate"*, and each `a=rid` line is one of those encodings.
The data channel section is read as SCTP inside the DTLS connection, so it isn't held to the audio rules.

**5. Break it on purpose.** Delete `a=rid:f send` and Run again. Now the problems lead, and the error is first:

```
What to fix, worst first
error  line 32  m= section 1: a=simulcast names rid f, which no a=rid line in this section declares (RFC 8853
                section 5.1)
note   line 8   no a=tls-id: ...
```

The summary under it says *"1 error found by these checks: a WebRTC stack may refuse it."* A receiver must not use that encoding, so the server would only ever
see two copies.

Paste the answer into the second box, and the result leads with what the two settle: who controls ICE, who sends the
DTLS ClientHello, and which codec both list.

## What it checks

| Severity | Check | Source |
|---|---|---|
| error | the first line is not `v=0` (the whole input is refused) | RFC 8866 section 5.1 |
| error | the profile is not `UDP/TLS/RTP/SAVPF`, or `UDP/DTLS/SCTP` for a data channel | RFC 9429 section 5.1.2; RFC 8841 section 4.2 |
| error | no `c=` line in the section or the session | RFC 8866 section 5.7 |
| error | no `a=mid` | RFC 9429 section 5.2.1 |
| error | a ufrag under 4 or a password under 22 characters | RFC 8839 section 5.4 |
| warning | a ufrag or password with a character outside letters, digits, `+` and `/` | RFC 8839 section 5.1 |
| error | no `a=fingerprint` | RFC 9429 section 5.1.2 |
| note | no `a=tls-id` anywhere in the description, said once | RFC 8842 sections 5.2 and 5.3 |
| error | no `a=rtcp-mux`, except in a data channel section, which has no RTCP | RFC 5761; RFC 8834 section 4.5 |
| error | Opus not written `opus/48000/2` | RFC 7587 section 7 |
| error | a server-reflexive, peer-reflexive or relayed candidate without `raddr` and `rport` | RFC 8839 section 5.1 |
| note | a priority that does not decode to RFC 8445's recommended type preference, or to its own component | RFC 8445 section 5.1.2 |
| warning | candidates, but none at the `m=` port and `c=` address | RFC 8839 section 4.2.1.2 |
| warning | no candidates, and not port 9 with `IN IP4 0.0.0.0`, unless the section is bundle-only with port 0 | RFC 9429 section 5.2.1; RFC 9143 section 6 |
| error | `a=simulcast` names a rid no `a=rid` line declares, or in the other direction | RFC 8853 section 5.1 |
| error | `a=ice-lite` inside a media section | RFC 8839 section 5.3 |
| error | ICE-lite with a candidate that is not a host | RFC 8445 section 2.5 |
| error | BUNDLE names a mid no section has | RFC 9143 |
| note | `a=ice-lite` in an offer, which a JSEP endpoint never sends | RFC 9429 section 5.2.1 |

An error is a MUST broken. A warning is a SHOULD, or a value real stacks accept anyway. A note is a decoded oddity.
A missing line is reported on its section's `m=` line, since it has no line of its own.

**Why `a=tls-id` is only a note.** RFC 8842 does ask every offer and answer for one. But the stacks that make the calls
don't write it: libwebrtc, which Chrome and Safari use, has no `tls-id` in its SDP code
([`webrtc_sdp.cc`](https://github.com/webrtc-sdk/webrtc/blob/db3ba7af86dd6d48174ed35387d11c0794f1a21b/pc/webrtc_sdp.cc),
a mirror of the m125 release), nor does Firefox's
([`SdpAttribute.h`](https://github.com/mozilla/gecko-dev/blob/5836a062726f715fda621338a17b51aff30d0a8c/dom/media/webrtc/sdp/SdpAttribute.h)),
and the aiortc answer among the samples, a real capture, has none. Version 1 warned on every section of every such
description, which buried the problems that do stop a call.

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
| Simulcast video and a data channel | Constructed: one VP8 source sent as three rids, `q`, `h` and `f`, and an SCTP data channel, both bundled |
| A broken offer | Constructed: Alice's offer with five mistakes, which the checks report as six errors |

All the addresses are from the documentation ranges, and the credentials are made up.

## What it does not do

- **Check a fingerprint.** It has no certificate, so it can only say a fingerprint is present and whether the two
  sides' differ. The DTLS handshake does the real check, and ends the call on a mismatch.
- **Guess at an attribute it does not know**, or at a codec parameter. Those are named as unknown.
- **Validate everything in RFC 8866.** The checks are the ones that stop a WebRTC call, not a full grammar.

Lines are trimmed and blank ones dropped, so CRLF, LF and a description copied with an RFC's indentation all read the
same.

## References

- [RFC 8866](https://www.rfc-editor.org/rfc/rfc8866): SDP
- [RFC 9429](https://www.rfc-editor.org/rfc/rfc9429): JSEP, what a browser puts in an offer and an answer
- [RFC 8839](https://www.rfc-editor.org/rfc/rfc8839): ICE's SDP attributes
- [RFC 8842](https://www.rfc-editor.org/rfc/rfc8842): DTLS in SDP, and `a=tls-id`
- [RFC 5763](https://www.rfc-editor.org/rfc/rfc5763): DTLS-SRTP's SDP, the fingerprint and `a=setup`
- [RFC 5764](https://www.rfc-editor.org/rfc/rfc5764): DTLS-SRTP, how the keys are made
- [RFC 9143](https://www.rfc-editor.org/rfc/rfc9143): BUNDLE
- [RFC 5761](https://www.rfc-editor.org/rfc/rfc5761): RTP and RTCP on one port
- [RFC 7587](https://www.rfc-editor.org/rfc/rfc7587): Opus over RTP
- [RFC 8285](https://www.rfc-editor.org/rfc/rfc8285): RTP header extensions
- [RFC 4585](https://www.rfc-editor.org/rfc/rfc4585): RTCP feedback
- [RFC 8445](https://www.rfc-editor.org/rfc/rfc8445): ICE, for candidate priorities and roles
- [RFC 8853](https://www.rfc-editor.org/rfc/rfc8853): simulcast
- [RFC 8851](https://www.rfc-editor.org/rfc/rfc8851): `a=rid`
- [RFC 8841](https://www.rfc-editor.org/rfc/rfc8841): data channels in SDP
