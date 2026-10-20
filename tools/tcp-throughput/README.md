# TCP throughput ceiling

Somebody provisions a 1 Gb/s circuit between two continents, copies a file, and gets 6 Mb/s. Nothing is
broken. A single TCP connection has two ceilings that have nothing to do with the link rate, and on a long
path the lower one sits far below what was paid for.

## How to use it: an example

Say you copy a large file between two offices 80 ms apart, over a 1 Gbit/s circuit, and it crawls. You measured
0.1% loss on the path, and the receiving server's window is 64 KB.

**1. Enter the path.**

| Input | You enter | Why |
|---|---|---|
| Round-trip time | `80` | What `ping` says |
| Packet loss | `0.1` | One packet in a thousand |
| Receive window | `64` | The largest TCP could express before window scaling |
| Link speed | `1000` | The circuit you're paying for |

**2. Press Run, and read the limits.**

```
One connection tops out at 5.65 Mbit/s, 0.57% of the link

Limit             Ceiling        Status
Packet loss       5.65 Mbit/s    Sets the limit
Receive window    6.55 Mbit/s    Next
Link              1.00 Gbit/s
```

In plain words: nothing is broken. One TCP connection on this path cannot go faster than about 5.65 Mbit/s,
whatever the circuit can carry, and the reason is the loss. The window is the next limit, only a little higher.

**3. Read what fixing it buys.**

```
Cut loss below 0.074%     6.55 Mbit/s    Then the receive window is the limit.
To fill the link          1.00 Gbit/s    A window of at least 9.54 MB, and loss below 0.0000032%,
                                         about one packet in 31 million.
```

The first line is the surprise: fixing the loss on its own buys less than a megabit, because the 64 KB window binds
right above it. The second is the other surprise: a classic TCP sender needs a nearly perfect path to fill a gigabit
at 80 ms. That's why the practical answers are a bigger window together with a congestion control that doesn't read
every loss as congestion, or several connections side by side.

**4. Read the chart.** Against loss, the window line is flat and the loss line falls. Where they cross is where the
diagnosis changes: left of it a bigger window helps, right of it only less loss does. The axis is logarithmic,
because the two are often a hundred times apart, and the labelled line across it is your link. Under the chart, the
method notes name the two formulas and the loss model behind them.

## The two ceilings

**The window.** A sender may have at most one window of unacknowledged data in flight. It sends a window,
then waits a full round trip for the acknowledgement, so it cannot exceed `window / RTT`. A 64 KB window,
the largest TCP could express before window scaling, caps an 80 ms path at about 6.5 Mb/s however fat the
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
