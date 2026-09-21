# Queueing capacity planner

Requests arrive at some rate, each takes some time, and somebody wants to know how many workers to run.
The usual answer is a utilisation target: "keep it under 80%". That is not an answer. 80% of two servers
and 80% of two hundred behave nothing alike, because what decides the waiting is queueing, and queueing
depends on how many places there are to queue at.

## What it computes

Erlang C for an **M/M/c queue**: Poisson arrivals, exponential service times, `c` identical servers,
first come first served, and a queue nobody gives up on. Given a rate, a mean service time and a target
for how often an arrival may queue at all, it reports the smallest `c` that meets the target, and draws
the curve either side of it.

The **offered load**, in erlangs, is `rate x service time`. It is the number of servers that would be
busy if nothing ever queued, and it is why requests per second cannot size anything on its own: 100/s of
10 ms work and 10/s of 100 ms work are the same erlang and want the same capacity.

The curve is the reason for the chart. Waiting does not rise smoothly with load. It is flat, and then it
is a cliff, and one more server moves the cliff.

## Where it stops being true

A capacity number that quietly assumes the wrong world is worse than no number.

- **Exponential service times.** Real work has a tail. A heavier tail queues worse than this predicts, so
  read the answer as a floor rather than a forecast. Kingman's formula is the next step when the
  variability is known.
- **Poisson arrivals.** Retries, batch jobs and thundering herds all break this, and all of them break it
  in the direction that needs more servers.
- **Identical servers with no setup cost.** No cold starts, no scaling lag, no cache warmth.
- **An unbounded queue.** Real systems shed load, and shedding changes the arrival process.

## The simulation

"Formula and simulation" runs a seeded Monte Carlo of the same queue: exponential interarrival and service
times, each arrival assigned to whichever server frees up first, the first tenth discarded as warmup. It
is there to disagree. Both numbers are reported side by side, and if they diverge by more than sampling
error then one of them is wrong.

The seed is fixed, which is what keeps the tool a pure function of its inputs and its fixtures
reproducible.
