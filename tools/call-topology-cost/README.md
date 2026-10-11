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

Pick the number of participants and the tool shows each client's upload and download, the server's traffic in and
out, and the server's operations every frame, for all four. The fields show the pattern you choose; the chart and the
table show all of them side by side.

## How it counts

- **One packet** is the Opus payload, bitrate x frame length / 8 (80 B at 32 kb/s in 20 ms frames), plus 12 B of RTP,
  8 B of UDP and 20 B of IPv4. The SRTP tag (10 B for AES_CM_128_HMAC_SHA1_80, 16 B for AES-GCM) and the RFC 6464
  audio-level extension (8 B on the wire) are added when chosen.
- **An SFU** decrypts every incoming packet with its sender's keys and encrypts each copy with its receiver's, so it
  does one decrypt per participant and one encrypt per copy sent, and never decodes (RFC 7667 section 3.6.2). With the
  loudest K forwarded, each of the K speakers receives the other K-1, and everyone else receives K: K(N-1) in all.
- **An MCU** decodes every stream and builds one mix per listener, leaving out the listener's own voice, "as this would
  result in an echo" (RFC 7667 section 3.6.1). With two people a "mix" is one voice, so it counts no mixing.
- **The server that is the other peer** decrypts and decodes what the user says, and encodes and encrypts its reply.

## What it assumes

- **Everyone talks all the time.** No silence suppression (DTX), so these are the busiest case.
- **Mesh runs one encoder per connection**, as RFC 7667 section 3.4 draws it. A client that shares one encoder across
  its connections does one encode instead of N-1, but still encrypts N-1 times with N-1 keys.
- **Not modelled:** video, simulcast, RTCP, the CPU each operation costs (that depends on the machine and the codec
  mode), and anything a server does besides media.

## References

- [RFC 7667](https://www.rfc-editor.org/rfc/rfc7667): RTP topologies, including mesh (section 3.4), the mixer (3.6.1)
  and the selective forwarding middlebox (3.7).
- [RFC 6464](https://www.rfc-editor.org/rfc/rfc6464): the audio level a client writes in its header.
