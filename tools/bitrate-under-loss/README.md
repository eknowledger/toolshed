# Bitrate under loss

## What it does

A voice sender over UDP hears nothing back from the network. What it learns about loss comes from the receiver, in
an RTCP receiver report every few seconds, as one byte: the share of packets lost since the last report, in 256ths.
This tool runs two minutes of a sender that acts on those reports and nothing else, and shows what that costs:

| Network | What happens | What it shows |
|---|---|---|
| **The squeeze** | The path carries 100 kb/s, then 30 kb/s from 30 s to 60 s, then 100 again | How long the sender keeps sending into a narrower pipe before a report tells it, and how slowly it climbs back |
| **The radio link** | Plenty of capacity, but 5% random loss from 20 s and 15% from 40 s, none from 60 s | Loss that is not congestion: sending less does not reduce it, and the rule cannot tell the difference |

Change how often the reports come and watch three things move: how many packets are lost before the first back-off,
the lowest rate the sender reaches, and how long it takes to get back to its ceiling once the loss stops. The table
lists every report: the fraction it carried, what the rule did, and the rate after.

## How it counts

- **The rule** is the loss-based controller of Google Congestion Control, as draft-ietf-rmcat-gcc-02 section 6
  states it, run once on every report, on the loss the report carries (p = fraction / 256):

  | Reported loss | New estimate |
  |---|---|
  | above 10% | As(i) = As(i-1) x (1 - 0.5p) |
  | 2% to 10% | As(i) = As(i-1), unchanged |
  | below 2% | As(i) = 1.05 x As(i-1) |

- **The estimate is the wire rate.** Opus gets what is left after 40 B of IPv4, UDP and RTP on every packet: 16 kb/s
  at 20 ms frames, 8 at 40 ms, 5.33 at 60 ms. Opus is held between 6 kb/s, its floor (RFC 6716 section 2.1.1), and
  the ceiling, which is also where it starts. So at 20 ms frames and a 32 kb/s ceiling the wire rate runs from 22 to
  48 kb/s.
- **The reported fraction** is RFC 3550's, `(lost << 8) / expected` truncated (appendix A.3), so it moves in steps of
  1/256 and never rounds up: sending 32.28 kb/s into 30 loses 1 - 30 / 32.28 = 7.06%, which reports as 18/256 =
  7.03%, and the radio link's 5% reports as 12/256 = 4.69%.
- **The network** is one bottleneck with no queue: whatever is sent above its capacity is lost, a share of
  1 - capacity / rate, compounded with the radio link's random loss. The model steps 20 ms at a time and counts
  expected packets rather than drawing them, so nothing is random and the same inputs always give the same run.

This is a port of `backoff_sim.py`, the demo of the post *The receiver talks back*, and its fixtures are that
script's output. The tests check the chart against the script's per-second CSV, second by second.

## What it assumes

- **A model, not Chrome.** It runs the draft's rule as written. libwebrtc's own loss-based code ramps up by time
  rather than per report, about 8% a second, and can hand over to a newer loss estimator; neither is modelled.
- **Only the loss-based half.** GCC also has a delay-based controller that watches queues grow before anything is
  lost. Section 7 of the draft says to leave it disabled when the receiver sends only RTCP receiver reports, which is
  the case modelled here. On a real path a queue fills before packets drop, so a delay-based controller would react
  sooner than this one.
- **Reports at a fixed interval.** RFC 3550 randomises the interval between 0.5 and 1.5 times its nominal value, so
  that reports from many receivers do not synchronise; this tool does not, so that runs repeat exactly.
- **Not modelled:** the feedback per packet that browsers add (transport-wide congestion control, RFC 8888), the
  delay a report takes to arrive, and any change the codec makes besides its bitrate.

## References

- [draft-ietf-rmcat-gcc-02 section 6](https://datatracker.ietf.org/doc/html/draft-ietf-rmcat-gcc-02#section-6):
  the loss-based controller, and [section 7](https://datatracker.ietf.org/doc/html/draft-ietf-rmcat-gcc-02#section-7)
  on running it alone. An Internet-Draft, intended as Experimental, that expired in January 2017 and never became
  an RFC; the RMCAT working group has since concluded.
- [RFC 3550 section 6.4.1](https://www.rfc-editor.org/rfc/rfc3550#section-6.4.1): the report block and its 8-bit
  fraction lost, and [appendix A.3](https://www.rfc-editor.org/rfc/rfc3550#appendix-A.3) for how it is computed.
- [RFC 6716 section 2.1.1](https://www.rfc-editor.org/rfc/rfc6716#section-2.1.1): Opus bitrates, from 6 to
  510 kb/s.
- [RFC 7587 section 5](https://www.rfc-editor.org/rfc/rfc7587#section-5): Opus over RTP and congestion control,
  including longer packets as a way to send fewer headers.
