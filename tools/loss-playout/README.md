# Loss and playout simulator

A voice call sends a small frame of audio every 20 ms, and the receiver plays each one at a fixed time. One
frame is lost. This tool answers what that costs the listener over UDP and over TCP: which frames still arrive
before they have to play, and how much audio has to be concealed.

The short answer is that UDP loses the one frame, and TCP loses the one frame plus every frame queued behind it
while it waits for the resend. The numbers show how many that is.

## The model

Every number follows from a handful of rules, so every result can be checked by hand.

- Frames 1 to N are sent every `frame` ms: frame n leaves at `n x frame`.
- Each takes `delay` ms to arrive. Every frame takes exactly the same time: there is no jitter.
- Frame n has to play by `n x frame + delay + buffer`. Arriving at or before that time is on time.
- One frame, `lost`, is dropped once.
- **UDP** never delivers the lost frame. The decoder conceals it, and every other frame arrives on time.
- **TCP** delivers in order. Frames before the loss go up as they arrive. The lost frame and everything after it
  go up at whichever is later, their own arrival or the moment the resent copy arrives (`resend + delay`).
  That is the whole mechanism: a frame can arrive in time and still be held behind the gap.
- **Fast retransmit** resends when the third duplicate ACK gets back to the sender: frame `lost + 3` arrives,
  and its ACK takes another `delay` to return. That needs three frames after the loss; with fewer, it cannot
  fire and the timer resends instead.
- **The timeout** resends `rto` ms after the lost frame was sent. 200 ms is Linux's default minimum; RFC 6298
  recommends 1 s. The timer is always running, so when it would fire before the third duplicate ACK (60 ms
  frames with a 200 ms timer, for instance) the fast-retransmit row resends on the timer too.
- A frame is **missed** if it never arrives or arrives after its playout time. Concealed audio is missed frames
  times the frame size.

At the defaults (20 ms frames, 30 ms each way, 40 ms of buffer, frame 5 lost):

| | Missed | Concealed |
|---|---|---|
| UDP | frame 5 | 20 ms |
| TCP, fast retransmit | frames 5 to 8, all released at 250 ms | 80 ms |
| TCP, 200 ms timeout | frames 5 to 12, released at 330 ms | 160 ms |

A bigger buffer changes the TCP rows and not the UDP one. At 120 ms, fast retransmit's repair arrives exactly on
frame 5's deadline and nothing is missed, while the timeout still costs frames 5 to 8. That buffer is also 80 ms
of extra delay on every word of the call, which is the trade.

## Reading the chart

Each line is when the application gets a frame. A frame plays if its point is on or under the deadline line.
UDP runs parallel to the deadline with one gap. The TCP lines go flat from the lost frame to where they rejoin
their own arrival times: that flat stretch is the queue being held, and every frame on it above the deadline is
audio nobody hears.

## What it deliberately does not model

- **Jitter.** Every frame takes the same time. Real paths vary, which is what the buffer is for, and variation
  makes both transports worse.
- **RACK.** Current Linux detects loss with RACK (RFC 8985), which can resend sooner than three duplicate ACKs.
  The fast-retransmit row is the classic rule, not the newest one.
- **The congestion window.** A loss also halves how much TCP will send, which can delay frames after the repair.
  Voice is so little data that this rarely binds, and it is left out.
- **Timer restarts.** The timer is modelled from the lost frame's own send time. Real TCP restarts it as other
  data is acknowledged, which only makes the timeout later, so the timeout row is a best case.
- **More than one loss,** or a loss of the resent copy.
- **The end of the run.** Misses are counted up to frame N. With a long timeout the stall runs past the last
  frame, and a longer run would miss more.

## References

- [RFC 5681 section 3.2](https://www.rfc-editor.org/rfc/rfc5681#section-3.2): fast retransmit and the three
  duplicate ACKs.
- [RFC 6298](https://www.rfc-editor.org/rfc/rfc6298): computing the retransmission timer, and the 1 s minimum.
