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
- **Loss percentage**, derived from the 8-bit fraction: `fraction / 256`. Above 5% it is marked, above
  10% marked harder. That is the one number in a report block you cannot check by eye.

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
- **Clock rates.** The RTP timestamp is shown as the integer it is. Converting it to seconds needs the
  clock rate, which is in the signalling and not in the packet.
- **Validation beyond structure.** A structurally valid packet with nonsense values decodes fine, which
  is correct: the tool reports what the bytes say.

## References

- [RFC 3550](https://www.rfc-editor.org/rfc/rfc3550), RTP and RTCP
- [RFC 8285](https://www.rfc-editor.org/rfc/rfc8285), a general mechanism for RTP header extensions
- [RFC 3551](https://www.rfc-editor.org/rfc/rfc3551), the static payload types
