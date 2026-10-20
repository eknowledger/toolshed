# Jitter and FEC simulator

A voice stream sends a 20 ms frame every 20 ms, and the receiver plays each one at a fixed time: when it was sent,
plus the trip, plus a jitter buffer. This tool runs a minute of that stream over a network that delays each packet
by a different amount and loses some, and says what the listener gets for every frame: the frame itself, a copy
rebuilt from a later packet, or 20 ms the decoder made up.

## How to use it: an example

Say a call sounds choppy. On its path a packet picks up about 30 ms of extra delay on average, about 1% of
packets are lost, and the receiver's buffer waits 40 ms. The question is what to change.

**1. Enter what you see.**

| Input | You enter | Why |
|---|---|---|
| Jitter | `30` | The average extra delay a packet picks up |
| Jitter buffer | `40` | How long past the normal trip the receiver waits |
| Loss | `1` | 1% of packets never arrive |
| Burst length | `1` | Losses are independent of each other |
| Protection | Opus in-band FEC | What the call already negotiated |

The **Jittery path** sample is exactly this.

**2. Press Run, and read the three numbers at the top.**

```
Concealed              Longest gap                        Playout delay
15.1%                  120 ms                             70 ms
9.1 s made up in 60 s  6 frames in a row were made up.    40 ms of it is the buffer
```

In plain words: about one frame in seven is a guess by the decoder, which a listener hears as a call that keeps
breaking up, and the worst stretch is 120 ms long.

**3. Read the chart under them: the buffer's trade.** It replays the same minute at every buffer from 0 to 200 ms.
The line for concealed frames crosses the dashed 1% line at the mark labelled *shallowest under 1%*, 90 ms, well to
the right of *this run* at 40 ms.

**4. Read what to change.**

| Change | Made-up audio after | Delay | What it costs |
|---|---|---|---|
| Raise the buffer to 80 ms and switch to RED, 2 copies | 0.4% | 40 ms more on every frame | Two full copies, about three times the audio bitrate. |
| Raise the buffer to 90 ms | 0.6% | 50 ms more on every frame | Nothing extra sent. |

Each row is the same minute of network replayed with that change. Waiting 50 ms longer fixes it with nothing extra
sent; three times the bitrate buys back 10 ms of it.

**5. Read the protections side by side, and the counts under them.**

| Protection | Recovered | Concealed | Longest gap | What it sends |
|---|---|---|---|---|
| None | 0% | 28.3% | 120 ms | Nothing extra sent. |
| Opus FEC (this run) | 13.2% | 15.1% | 120 ms | A lower-bitrate copy, paid for inside the Opus bitrate. |
| RED, 1 copy | 13.2% | 15.1% | 120 ms | A full copy, so about twice the audio bitrate. |
| RED, 2 copies | 13.2% | 15.1% | 120 ms | Two full copies, about three times the audio bitrate. |

On a phone, what each sends sits under its name.

```
Played on time        Rebuilt from a copy   Lost by the network   Arrived too late
71.7%                 13.2%                 0.9%                  27.3%
2152 of 3000 frames   395 frames            28 packets            820 packets, after 70 ms
```

A copy halves what no protection leaves, and a second RED copy adds nothing at this buffer. The counts say why:
27.3% of packets arrived too late against 0.9% lost by the network. The packets got there, after their slot, and so
did most of the copies.

**6. Try it.** Set the buffer to `90` and Run. Concealed drops to 0.6%, and the playout delay goes from 70 ms to
120 ms.

## What the result says, in order

1. **The answer**: the share of the audio the decoder made up, the longest run of it, and how long after sending
   every frame plays. Not coloured: the 1% line the advice aims at is this tool's choice, not a standard, so it is
   drawn on the buffer chart instead.
2. **The buffer's trade**, the chart the decision turns on (see below).
3. **What to change**, when there is something to: every buffer and protection the tool tried on the same minute
   that would make up less, or reach under 1% with less delay. Opus FEC and one RED copy reach back the same packet,
   so where they tie the table keeps the cheaper one. When nothing reaches 1%, it says how close the best setting
   gets.
4. **The protections**, all four at this run's buffer, with what each costs on the wire.
5. **Where the frames went**: played, rebuilt, lost by the network, and arrived too late.
6. **The charts of single frames and packets**, then the protections as bars.

## The model

- **Delay.** Every packet takes the one-way delay plus an extra delay drawn from an exponential distribution with
  the jitter as its mean. A packet that arrives after its slot is as good as lost (RFC 7005 section 3).
- **Loss.** A two-state Gilbert model. With a burst length of 1 each loss is independent; with 3, a loss takes three
  packets on average, at the same overall rate.
- **Copies.** Opus in-band FEC carries a lower-bitrate copy of frame n-1 inside packet n (RFC 7587 section 3.3).
  RED carries whole earlier frames (RFC 2198), here one or two. A copy only helps if the packet carrying it arrives
  before the missing frame's slot, so reaching back k packets needs at least 20k ms of buffer.

## Reading the charts

1. **The buffer's trade.** The same minute replayed at every buffer from 0 to 200 ms, or further when the buffer
   is deeper: how many frames arrive too late, and how many are still concealed after the copies. The marks show
   this run's buffer and the shallowest one that gets under 1% made up. Every millisecond of buffer is added to every
   frame.
2. **What Alice hears.** The first five seconds, a row per second and a column per 20 ms frame, with only the
   incidents drawn: frames rebuilt from a copy and frames made up by the decoder. An empty stretch is audio that
   played as sent. When nothing went wrong in those five seconds, the chart is left out.
3. **Arrivals.** Each packet's trip, for the first five seconds, against the time it had. Points above the line
   arrived too late to play.
4. **What each scheme buys.** Only the frames that missed their slot, split into rebuilt and concealed, for each
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
