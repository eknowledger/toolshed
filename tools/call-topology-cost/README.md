# Call topology cost

## What it does

Add people to a voice call and someone has to copy each voice for every listener. Where that copy is made decides
what the call costs, and who pays:

| Pattern | Who makes the copies | What grows with the number of people, N |
|---|---|---|
| **Mesh** | Every client, for every other client | Each client sends N-1 streams and receives N-1 |
| **SFU** (selective forwarding) | A server that forwards packets without decoding them | The server sends N(N-1) streams, or K(N-1) if it forwards only the K loudest |
| **MCU** (mixer) | A server that decodes everyone, mixes, and encodes one mix per listener | N decodes, N mixes and N encodes on the server, every frame |
| **Server is the peer** | Nobody: one user talks to one service | One stream each way, per user |

Pick the number of participants and the tool compares all four side by side: each client's upload and download,
the server's traffic in and out, and the server's operations every frame. The pattern you pick is drawn as a picture
of its streams, and gets its own list of changes that would make it cheaper.

## How to use it: an example

Say you are planning a ten-person stand-up on an SFU, and want the server's bandwidth with the packets a browser
really sends, not the bare 120 B.

**1. Enter it.**

| Input | You enter | Why |
|---|---|---|
| Participants | `10` | Everyone on the call |
| Draw the traffic for | SFU | The pattern you are planning |
| Codec | Opus at 32 kb/s, 20 ms frames | The default voice stream |
| Packet | SRTP and post 4's two extensions, over IPv4 | Every WebRTC packet is encrypted, and post 4's offer asks for the audio level and the MID |

**2. Press Run, and read the comparison.** All four patterns, in kb/s. The client columns are one device; the
server columns are the whole call.

| Pattern | Client up | Client down | Server in | Server out |
|---|---|---|---|---|
| Mesh | 496.8 | 496.8 | none | none |
| SFU (picked) | 55.2 | 496.8 | 552 | 4968 |
| MCU | 55.2 | 55.2 | 552 | 552 |
| Peer, per user | 55.2 | 55.2 | 55.2 | 55.2 |

**3. Read the picture.** The SFU you picked, as streams: `10 clients --10 x 55.2 kb/s--> SFU --90 x 55.2 kb/s--> 10 clients`,
the SFU forwarding without decoding and each listener hearing 9 voices.

**4. Read what would make it cheaper.**

| Change | What it saves | What it costs |
|---|---|---|
| Forward only the 3 loudest | The server's output falls from 4968 to 1490.4 kb/s, each listener's from 496.8 to 165.6. | Quieter voices are not heard while three others are louder. Senders must write the audio level. |
| Send 40 ms frames | Each stream falls from 55.2 to 43.6 kb/s, because the headers are sent half as often. | 20 ms more delay, and each lost packet takes 40 ms of sound. |

In plain words: the server's 5 Mb/s comes from copying every voice to nine listeners. Forwarding only the three
loudest cuts it by more than two thirds, and a speaker picker needs nothing but the one byte of loudness each sender
already writes.

**5. Read the server's work and the packet.** *Server operations every 20 ms frame* puts them in named columns:
the SFU does 10 decrypts and 90 encrypts; the MCU does 10 of each. *One stream* adds that the SFU sends 4500 packets
a second.
*One packet*, at the bottom, itemises the 138 B: 80 B of sound, 12 B RTP, 8 B UDP, 20 B IPv4, 10 B SRTP tag, 8 B of
header extensions. Headers are 58 B of every 138, which is why longer frames help. Pick *AES-GCM and four extensions,
over IPv6* and the same packet is 172 B, 92 of them headers, and the server sends 6192 kb/s.

## How it counts

- **One packet** is the codec payload, bitrate x frame length / 8 (80 B at 32 kb/s in 20 ms frames), plus 12 B of
  RTP, 8 B of UDP and 20 B of IPv4 or 40 B of IPv6 (RFC 8200's fixed header, with no extension headers). The SRTP tag
  is 10 B for AES_CM_128_HMAC_SHA1_80 (RFC 3711's default 80-bit tag) and 16 B for AEAD_AES_128_GCM (RFC 7714).
- **Header extensions** are in RFC 8285's one-byte form: a 4-byte header (`BE DE` and a length), then one byte of ID
  and length per extension plus its data, padded to a multiple of 4. The data is 1 byte for the audio level
  (RFC 6464), 1 for a MID of `0` (RFC 8843), 2 for a transport-wide sequence number and 3 for abs-send-time. So the
  audio level alone is 8 B, adding the MID still 8, adding the sequence number 12, and adding abs-send-time 16.
- **The presets** fill those in. *Codec* sets the bitrate and frame length, with G.711 at 64 kb/s (RFC 3551).
  *Packet* sets the IP version, the tag and the extensions. Change any of them and the preset shows Custom.
- **An SFU** decrypts every incoming packet with its sender's keys and encrypts each copy with its receiver's, so it
  does one decrypt per participant and one encrypt per copy sent, and never decodes (RFC 7667 section 3.7). With the
  loudest K forwarded, each of the K speakers receives the other K-1, and everyone else receives K: K(N-1) in all.
- **An MCU** decodes every stream and builds one mix per listener, leaving out the listener's own voice, "as this would
  result in an echo" (RFC 7667 section 3.6.1). With two people a "mix" is one voice, so it counts no mixing.
- **The server that is the other peer** decrypts and decodes what the user says, and encodes and encrypts its reply.
- **What would make it cheaper** is computed from the same counts: the three loudest instead of everyone, or the
  next longer frame. Switching pattern is not listed, because the comparison already prices every switch. Sorted by
  what each takes off the busiest flow: the server's output, or a mesh device's upload.
- **The SRTP tag left out** changes only the packet size, as post 1 counts it. The decrypt and encrypt counts stay,
  because WebRTC always encrypts.

## What it assumes

- **Everyone talks all the time.** No silence suppression (DTX), so these are the busiest case.
- **Mesh runs one encoder per connection**, as RFC 7667 section 3.4 draws it. A client that shares one encoder across
  its connections does one encode instead of N-1, but still encrypts N-1 times with N-1 keys.
- **Not modelled:** video, simulcast, RTCP, link-layer headers such as Ethernet's, the CPU each operation costs (that depends on the machine and the codec
  mode), and anything a server does besides media.

## References

- [RFC 7667](https://www.rfc-editor.org/rfc/rfc7667): RTP topologies, including mesh (section 3.4), the mixer (3.6.1)
  and the selective forwarding middlebox (3.7).
- [RFC 6464](https://www.rfc-editor.org/rfc/rfc6464): the audio level a client writes in its header.
- [RFC 8285](https://www.rfc-editor.org/rfc/rfc8285): the one-byte header extension form.
- [RFC 3711](https://www.rfc-editor.org/rfc/rfc3711) and [RFC 7714](https://www.rfc-editor.org/rfc/rfc7714): SRTP's
  80-bit HMAC tag and AES-GCM's 16-byte tag.
- [RFC 8200](https://www.rfc-editor.org/rfc/rfc8200): the 40-byte IPv6 header.
- [RFC 8843](https://www.rfc-editor.org/rfc/rfc8843): the MID header extension.
- [Transport-wide congestion control](https://datatracker.ietf.org/doc/html/draft-holmer-rmcat-transport-wide-cc-extensions-01):
  the 16-bit transport-wide sequence number.
- [abs-send-time](https://webrtc.googlesource.com/src/+/refs/heads/main/docs/native-code/rtp-hdrext/abs-send-time/README.md):
  a 3-byte send timestamp.
- [RFC 3551](https://www.rfc-editor.org/rfc/rfc3551): G.711 at 64 kb/s.
