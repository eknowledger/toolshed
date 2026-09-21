# TCP throughput ceiling

Somebody provisions a 1 Gb/s circuit between two continents, copies a file, and gets 6 Mb/s. Nothing is
broken. A single TCP connection has two ceilings that have nothing to do with the link rate, and on a long
path the lower one sits far below what was paid for.

## The two ceilings

**The window.** A sender may have at most one window of unacknowledged data in flight. It sends a window,
then waits a full round trip for the acknowledgement, so it cannot exceed `window / RTT`. A 64 KB window —
the largest TCP could express before window scaling — caps an 80 ms path at about 6.5 Mb/s however fat the
pipe is.

**The loss.** Congestion control reads loss as an instruction to slow down, so a steady loss rate holds
throughput near `MSS / (RTT x sqrt(p))`. The square root is the part that surprises people: a hundredth of a
percent of loss is not a hundredth of a problem. Distance and loss compound rather than add, because RTT
appears once on its own and again inside every recovery.

The answer is the lower of the two, and **which one binds is the diagnosis**. A window ceiling is a
configuration problem and can be fixed this afternoon. A loss ceiling means finding the loss, and no amount
of tuning moves it.

## Reading the chart

Against **loss**, the two lines cross. The window ceiling is flat, because loss does not change it; the loss
ceiling falls as the square root of loss. Left of the crossing the window binds and a larger one helps; right
of it loss binds and a larger window changes nothing.

Against **round-trip time**, they never cross, and that is the more useful thing to know. Both ceilings are
proportional to `1 / RTT`, so distance divides them both by the same number and their ratio does not move.
**Distance makes everything slower without changing the diagnosis.** A path that is window limited at 2 ms is
still window limited at 250 ms; it is just 125 times slower. Only the loss rate decides which fix works.

That is why the default chart is against loss: the RTT view shows the damage, the loss view shows the cause.

## Where it stops being true

A ceiling quoted without its assumptions is worse than no number.

- **One connection.** Ten parallel streams see roughly ten times this. Half of what a CDN does is turn one
  long path into many short ones.
- **Reno-shaped congestion control.** The `sqrt(p)` law is the classic result for additive-increase,
  multiplicative-decrease. CUBIC does better on long paths and BBR markedly so, because it models the path
  instead of reacting to loss.
- **Steady, random loss.** Bursty loss, or loss from a shallow buffer rather than congestion, behaves
  differently.
- **A ceiling, not a forecast.** A real transfer lands at or below this, never above.

The constant is `sqrt(3/2)`, about 1.22, which falls out of integrating the sawtooth a Reno sender traces:
halve the window on loss, add a segment per round trip, average the shape.
