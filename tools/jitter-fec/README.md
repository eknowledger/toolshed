# Jitter and FEC simulator

A voice stream sends a 20 ms frame every 20 ms, and the receiver plays each one at a fixed time: when it was sent,
plus the trip, plus a jitter buffer. This tool runs a minute of that stream over a network that delays each packet
by a different amount and loses some, and says what the listener gets for every frame: the frame itself, a copy
rebuilt from a later packet, or 20 ms the decoder made up.

## The model

- **Delay.** Every packet takes the one-way delay plus an extra delay drawn from an exponential distribution with
  the jitter as its mean. A packet that arrives after its slot is as good as lost (RFC 7005 section 3).
- **Loss.** A two-state Gilbert model. With a burst length of 1 each loss is independent; with 3, a loss takes three
  packets on average, at the same overall rate.
- **Copies.** Opus in-band FEC carries a lower-bitrate copy of frame n-1 inside packet n (RFC 7587 section 3.3).
  RED carries whole earlier frames (RFC 2198), here one or two. A copy only helps if the packet carrying it arrives
  before the missing frame's slot, so reaching back k packets needs at least 20k ms of buffer.

## Reading the charts

1. **Arrivals.** Each packet's trip, for the first five seconds, against the time it had. Points above the line
   arrived too late to play.
2. **The buffer's trade.** The same minute replayed at every buffer from 0 to 200 ms: how many frames arrive too
   late, and how many are still concealed after the copies. Every millisecond of buffer is added to every frame.
3. **What each scheme buys.** Only the frames that missed their slot, split into rebuilt and concealed, for each
   scheme on the same network. Opus FEC and one RED copy reach the same packet and rebuild the same frames; they
   differ in quality and cost, which the readout says.

## What it deliberately does not model

- **FEC on every packet.** Real Opus re-encodes only frames it judges important, so this is the most FEC can do.
- **Correlated delay.** Real queues delay neighbouring packets together, which bunches late packets like a burst.
- **An adaptive buffer.** libwebrtc's moves its target with the delay it measures; this one is fixed.
- **Quality.** A rebuilt frame counts as rebuilt, whether it came from a lower-bitrate FEC copy or a full RED copy.

## References

- [RFC 7005 section 3](https://www.rfc-editor.org/rfc/rfc7005#section-3): fixed and adaptive de-jitter buffers
- [RFC 7587 section 3.3](https://www.rfc-editor.org/rfc/rfc7587#section-3.3): Opus in-band FEC over RTP
- [RFC 2198](https://www.rfc-editor.org/rfc/rfc2198): RTP payload for redundant audio data
