# RTP / RTCP inspector

## Why this rather than the others

Every free browser decoder for RTP shows a flat list of field names and values beside the packet, or
wants a pcap file. Neither tells you *which bytes* a field is. That matters when you are reconciling a
capture against a log, or checking whether a header extension is where you think it is: the question is
usually "is this offset what I expect", not "what is the sequence number".

So the bytes are always one scroll away, with every named range one field and the legend naming each one. What
comes first is what the packet says: who it reports on and what it lost, or what it asks the sender to do.

## How to use it: an example

Say a voice call sounds a little rough and you've copied one RTCP packet out of Wireshark: the receiver report the
server sent back to the caller. You also know when it arrived, `d8f1:4ccc` on the caller's NTP clock, read off the
same capture.

**1. Paste it, and the arrival time.** This is the **Server's receiver report** sample:

| Input | You enter |
|---|---|
| Packet | `81 c9 00 07 7a 3b 9c 5d 1f 2e 3d 4c 06 00 00 06 00 00 04 e1 00 00 00 82 d8 f0 40 00 00 00 fd 70 81 ca ...` |
| RTP clock rate | `48 kHz: Opus`, because the call is Opus |
| Report arrived at (A) | `d8f1:4ccc` |

**2. Press Run, and read the top two parts.**

```
Packet   RTCP compound, 60 bytes: RR from 0x7A3B9C5D, then SDES

RR #1 reports on 1 stream, lost since its last report
Reports on   Lost (interval)   Cum. lost   Jitter           RTT
0x1F2E3D4C   6/256 = 2.34%     6           130 = 2.708 ms   59.998 ms
```

The loss is the 8-bit fraction the packet carries, 6/256, so you can check it yourself. It is not coloured: between
2% and 10% the loss-based rule browsers use holds the bitrate where it is, and it only cuts the rate over 10%, which
the table marks when it happens.

Jitter of 2.7 ms is how much the packets' spacing wobbles on arrival; a jitter buffer of a few tens of milliseconds
absorbs it easily. It needs the clock rate, because the packet counts it in RTP timestamp units.

**3. Check the round trip's arithmetic, at the bottom.** It is A - LSR - DLSR: the time the report arrived, minus the
sender report it answers, minus the 990.0 ms the server held it.

```
Round trip   59.998 ms
             A - LSR - DLSR = 0xD8F1:4CCC - 0xD8F0:4000 - 0x0000:FD70 = 3932 / 65536 s
```

No clock had to agree with any other to get it. Between the table and that arithmetic sit the bytes, with each field
marked in its own colour, and the field list, one group per sub-packet.

**A feedback message reads the same way.** Press **NACK**:

```
Packet           RTCP, 16 bytes: NACK
Asks again for   3 packets: 100, 101 and 103
                 On stream 0x1F2E3D4C. Resend them if they are still in the send buffer; otherwise the
                 receiver conceals the gap.
```

The four bytes `00 64 00 05` say all of that: PID `0x0064` is packet 100, and the mask `0b0000000000000101` adds
100 + 1 and 100 + 3. **Transport-wide feedback** decodes every packet's arrival time and draws it, so a packet that
never came is a gap in the line: here 7 of 8 arrived, about 20 ms apart, and packet 106 is missing.

## What it handles

- **RTP fixed header**: version, padding, extension and CSRC-count bits, marker, payload type, sequence,
  timestamp, SSRC, and the CSRC list.
- **Header extensions**, both RFC 8285 forms. The one-byte form encodes length as `len - 1`, which is the
  usual place to go wrong. An unrecognised profile is reported as profile-specific rather than decoded as
  though it were one of the two.
- **Padding**, subtracted from the payload. A decoder that ignores the count reports padding as data.
- **RTCP**: SR and RR with report blocks, SDES with its items, BYE with its optional reason, APP's name, and
  compound packets. The length field is words **minus one**, and reading it as plain words silently loses every
  sub-packet after the first.
- **Feedback**, the messages a WebRTC call sends between reports:
  - **Generic NACK** (205, FMT 1, [RFC 4585 section 6.2.1](https://www.rfc-editor.org/rfc/rfc4585#section-6.2.1)):
    each entry's PID and 16-bit mask BLP, turned into the list of sequence numbers asked for, wrapping past 65535.
  - **PLI** (206, FMT 1, [section 6.3.1](https://www.rfc-editor.org/rfc/rfc4585#section-6.3.1)): no body at all; the
    media source SSRC is the stream that needs a keyframe.
  - **FIR** (206, FMT 4, [RFC 5104 section 4.3.1](https://www.rfc-editor.org/rfc/rfc5104#section-4.3.1)): each stream
    asked for a keyframe and its command sequence number.
  - **REMB** (206, FMT 15 with the identifier `REMB`,
    [draft-alvestrand-rmcat-remb-03](https://datatracker.ietf.org/doc/html/draft-alvestrand-rmcat-remb-03)): the
    bitrate as an 18-bit mantissa times 2 to a 6-bit exponent, and the streams it covers. FMT 15 without the identifier
    is reported as application layer feedback rather than read as REMB.
  - **TWCC** (205, FMT 15,
    [draft-holmer-rmcat-transport-wide-cc-extensions-01](https://datatracker.ietf.org/doc/html/draft-holmer-rmcat-transport-wide-cc-extensions-01)):
    base sequence, status count, the reference time in 64 ms steps, both kinds of status chunk, and every receive
    delta in 250 microsecond steps, signed when it is large. Each packet's arrival is listed and charted, a lost one as a
    gap. The chunks stop at the status count, since a vector can hold more statuses than there are packets. Where the
    draft's prose and its own example disagree on what a one-bit 0 means, the example, and libwebrtc, win: 0 is not
    received.
  - **RFC 8888 congestion control feedback** (205, FMT 11, [RFC 8888 section 3.1](https://www.rfc-editor.org/rfc/rfc8888#section-3.1)),
    the standards-track successor to TWCC: per stream, each packet's received bit, its echoed ECN mark, and its
    arrival as an offset before the report timestamp in 1/1024 s. A packet marked congested (ECN CE) is called out,
    since a router sets that mark instead of dropping the packet.
- **What it says, first.** What the packet is, in one line, and what it asks for when it asks for something
  (these packets again, a keyframe, a bitrate ceiling), then the report blocks or the feedback as a table. A
  compound that does not start with a report is marked there, because RFC 3550 lets a receiver drop all of it.
  Loss is judged against the loss-based rule browsers use
  ([draft-ietf-rmcat-gcc-02 section 6](https://datatracker.ietf.org/doc/html/draft-ietf-rmcat-gcc-02#section-6)):
  over 10% the sender cuts its rate, from 2% to 10% it holds, so 5% and more is worth a look. That rule is about
  senders, not something the packet says, so it is a note on the table rather than a headline.
- **Loss percentage**, derived from the 8-bit fraction: `fraction / 256`. Above 5% it is marked, above
  10% marked harder. That is the one number in a report block you cannot check by eye, so it is shown as
  the fraction it is, `6/256 = 2.34%`: the field is truncated to 256ths, which is why 6 lost of 250 reads 2.34%
  rather than 2.40%.
- **The SR's NTP timestamp** as seconds since 1900 with a decimal fraction, and as a UTC date to the
  millisecond. The low 32 bits are a binary fraction, in 1/2^32 of a second, so `ee69d8f0 40000000` is
  3999914224.25 s, 07:17:04.250. Its middle 32 bits are shown too, `0xD8F04000`, because that is what a
  receiver report answering this SR carries as LSR, which is how an SR and its answer are matched.
- **LSR and DLSR** in NTP's short format, 16 bits of seconds and 16 of fraction, as RFC 3550 writes them
  (`0xD8F0:4000`), and DLSR in milliseconds: 64880 is 64880 / 65536 s = 990.0 ms, how long the receiver held the SR.
- **The round trip**, if you give the time the report arrived, A, as the middle 32 bits of your own NTP clock:
  `A - LSR - DLSR`, modulo 2^32 (RFC 3550 section 6.4.1). No clock synchronisation is needed, because A and LSR
  are both the SR sender's clock and DLSR is a duration. RFC 3550's own Figure 2 (A `0xb710:8000`, LSR
  `0xb705:2000`, DLSR `0x0005:4000`) gives 6.125 s here, as it does in the RFC. An LSR of zero means the
  receiver had no SR to answer, so there is no round trip, and an A earlier than LSR + DLSR is called negative
  rather than read as an 18-hour trip.

Hex is read however you paste it: one run, spaced, colon-separated, `0x`-prefixed, upper or lower case,
or a dump from Wireshark's Copy as Hex Dump, `tcpdump -X`, `xxd` or `hexdump -C`, with its offsets and its text
column. On a dump line only the hex is read: the text column's punctuation used to be refused, and its letters a to
f read as bytes. Anything else that is not a hex digit or a separator is named rather than filtered out, because
filtering turns "hello there" into three stray `e`s and then complains about an odd digit count.

**A whole frame works too.** Wireshark copies the Ethernet, IP and UDP headers with the packet, so those are
stripped when the whole chain checks out (Ethernet type IPv4 or IPv6, one VLAN tag at most, IP protocol UDP, a UDP
length that fits), and the field list says which were stripped and the two ports.

**The RTP clock rate** is optional, because it lives in the signalling, never in the packet. Choose it and RTP
timestamps read as seconds of media, and a report block's jitter as milliseconds: 130 units at Opus's 48 kHz is
2.708 ms.

## What it does not handle

- **The rarer feedback messages**: SLI, RPSI, TMMBR and TMMBN, and APP's data. Their headers are parsed, the
  message is named, and the body is reported as undecoded rather than guessed at.
- **Payloads.** What the payload means is decided by the payload type, and for dynamic types (96 to 127)
  only the signalling knows. A tool that guessed would be wrong quietly.
- **Encryption.** SRTP is not decrypted; there is no key here to do it with.
- **A clock rate you didn't give.** Without one, the RTP timestamp and the jitter are shown as the integers they
  are, rather than converted at a guessed rate.
- **A, for you.** The arrival time is not in the packet; it is your clock when the report came in, so the
  round trip is only computed when you supply it.
- **Validation beyond structure.** A structurally valid packet with nonsense values decodes fine, which
  is correct: the tool reports what the bytes say.

## References

- [RFC 3550](https://www.rfc-editor.org/rfc/rfc3550), RTP and RTCP; [section 6.4.1](https://www.rfc-editor.org/rfc/rfc3550#section-6.4.1)
  for the SR, the report block and the round trip, and [section 4](https://www.rfc-editor.org/rfc/rfc3550#section-4)
  for the NTP timestamp format
- [RFC 8285](https://www.rfc-editor.org/rfc/rfc8285), a general mechanism for RTP header extensions
- [RFC 3551](https://www.rfc-editor.org/rfc/rfc3551), the static payload types
- [RFC 4585](https://www.rfc-editor.org/rfc/rfc4585), feedback, NACK and PLI; [RFC 5104](https://www.rfc-editor.org/rfc/rfc5104), FIR
- [draft-alvestrand-rmcat-remb-03](https://datatracker.ietf.org/doc/html/draft-alvestrand-rmcat-remb-03), REMB, and
  [draft-holmer-rmcat-transport-wide-cc-extensions-01](https://datatracker.ietf.org/doc/html/draft-holmer-rmcat-transport-wide-cc-extensions-01), TWCC
- [RFC 8888](https://www.rfc-editor.org/rfc/rfc8888), congestion control feedback
- [draft-ietf-rmcat-gcc-02](https://datatracker.ietf.org/doc/html/draft-ietf-rmcat-gcc-02#section-6), the loss thresholds
