## Why this rather than the others

Every free browser decoder for RTP shows a flat list of field names and values beside the packet, or
wants a pcap file. Neither tells you *which bytes* a field is. That matters when you are reconciling a
capture against a log, or checking whether a header extension is where you think it is: the question is
usually "is this offset what I expect", not "what is the sequence number".

So the byte view is the point. Every named range in it is one field, and the legend names each one.

## What it handles

- **RTP fixed header**: version, padding, extension and CSRC-count bits, marker, payload type, sequence,
  timestamp, SSRC, and the CSRC list.
- **Header extensions**, both RFC 8285 forms. The one-byte form encodes length as `len - 1`, which is the
  usual place to go wrong. An unrecognised profile is reported as profile-specific rather than decoded as
  though it were one of the two.
- **Padding**, subtracted from the payload. A decoder that ignores the count reports padding as data.
- **RTCP**: SR and RR with report blocks, SDES with its items, BYE with its optional reason, and compound
  packets. The length field is words **minus one**, and reading it as plain words silently loses every
  sub-packet after the first.
- **Where the bytes go**: one stacked bar of the packet as pasted, header, CSRC list, extension, payload and
  padding for RTP, or one segment per sub-packet for a compound RTCP packet. Only the pasted bytes count: the UDP
  and IP headers around them are not in the input, so they are not guessed.
- **Loss percentage**, derived from the 8-bit fraction: `fraction / 256`. Above 5% it is marked, above
  10% marked harder. That is the one number in a report block you cannot check by eye, so it is also shown as
  the fraction it is, `6/256 = 2.34%`: the field is truncated to 256ths, which is why 6 lost of 250 reads 2.34%
  rather than 2.40%.
- **The SR's NTP timestamp** as seconds since 1900 with a decimal fraction, and as a UTC date to the
  millisecond. The low 32 bits are a binary fraction, in 1/2^32 of a second, so `ee69d8f0 40000000` is
  3999914224.25 s, 07:17:04.250. Its middle 32 bits are shown too, `0xD8F04000`, because that is what a
  receiver report answering this SR carries as LSR, which is how an SR and its answer are matched.
- **LSR and DLSR** in NTP's short format, 16 bits of seconds and 16 of fraction, as RFC 3550 writes them
  (`0xD8F0:4000`), and DLSR in seconds: 64880 is 64880 / 65536 = 0.990 s, how long the receiver held the SR.
- **The round trip**, if you give the time the report arrived, A, as the middle 32 bits of your own NTP clock:
  `A - LSR - DLSR`, modulo 2^32 (RFC 3550 section 6.4.1). No clock synchronisation is needed, because A and LSR
  are both the SR sender's clock and DLSR is a duration. RFC 3550's own Figure 2 (A `0xb710:8000`, LSR
  `0xb705:2000`, DLSR `0x0005:4000`) gives 6.125 s here, as it does in the RFC. An LSR of zero means the
  receiver had no SR to answer, so there is no round trip, and an A earlier than LSR + DLSR is called negative
  rather than read as an 18-hour trip.

Hex is read however you paste it: one run, spaced, colon-separated, `0x`-prefixed, upper or lower case,
or a Wireshark dump with line offsets and an ASCII gutter. Anything that is not a hex digit or a
separator is named rather than filtered out, because filtering turns "hello there" into three stray
`e`s and then complains about an odd digit count.

## What it does not handle

- **APP (204), RTPFB (205) and PSFB (206).** Their headers are parsed and their bodies are reported as
  undecoded rather than guessed at. These are the obvious next additions.
- **Payloads.** What the payload means is decided by the payload type, and for dynamic types (96 to 127)
  only the signalling knows. A tool that guessed would be wrong quietly.
- **Encryption.** SRTP is not decrypted; there is no key here to do it with.
- **Clock rates.** The RTP timestamp and the interarrival jitter are shown as the integers they are.
  Converting either to seconds needs the clock rate, which is in the signalling and not in the packet: 130
  units of jitter is 2.708 ms at Opus's 48 kHz.
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
