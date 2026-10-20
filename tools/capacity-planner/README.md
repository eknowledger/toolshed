# Queueing capacity planner

Requests arrive at some rate, each takes some time, and somebody wants to know how many workers to run.
The usual answer is a utilisation target: "keep it under 80%". That is not an answer. 80% of two servers
and 80% of two hundred behave nothing alike, because what decides the waiting is queueing, and queueing
depends on how many places there are to queue at.

## What it computes

Erlang C for an **M/M/c queue**: Poisson arrivals, exponential service times, `c` identical servers,
first come first served, and a queue nobody gives up on. Given a rate, a mean service time and a target, it
reports the smallest `c` that meets the target, the count one below it and one above, the p99 wait at each,
and draws the curve either side of it.

The target is a share of requests, and it applies to one of two things:

- **waiting at all**, with the wait limit at 0. This is Erlang C, the chance that every server is busy when a
  request arrives;
- **waiting longer than the limit**, when you set one. Most latency budgets are written this way: "no more
  than 1% of requests queue for more than 10 ms". It is the M/M/c waiting-time tail,
  `P(wait > t) = C x exp(-(c x mu - lambda) x t)`, where `C` is Erlang C, `mu` is one server's rate and
  `lambda` the arrival rate.

The p99 wait comes from the same tail, inverted: `ln(C / (1 - p)) / (c x mu - lambda)`, or zero when
more than that share of requests never wait at all.

The **offered load**, in erlangs, is `rate x service time`. It is the number of servers that would be
busy if nothing ever queued, and it is why requests per second cannot size anything on its own: 100/s of
10 ms work and 10/s of 100 ms work are the same erlang and want the same capacity.

The curve is the reason for the chart. Waiting does not rise smoothly with load. It is flat, and then it
is a cliff, and one more server moves the cliff.

## How to use it: an example

Say an API takes 500 requests a second, each takes 20 ms of a worker's time on average, and the budget is
that no more than 1 request in 100 queues for longer than 10 ms.

**1. Enter it.**

| Input | You enter | Why |
|---|---|---|
| Arrivals | `500` | Requests per second at the busy hour |
| Service time | `20` | The mean time a worker spends on one, not the p99 |
| Target | `1` | 1% of requests may break the limit |
| Wait limit | `10` | The queueing budget, in ms |

**2. Press Run, and read the number.**

```
Servers needed
15 servers
With 14, 2.36% of requests wait longer than 10 ms, over your 1% target. With 15, 0.84%.

500 requests/s x 20 ms = 10.00 erlangs of load
```

The number comes with the step that decides it: 14 workers break the budget and 15 keep it. The line under it is
the offered load, the one quantity the whole answer turns on.

**3. Read the table to see the step.**

| Servers | Your 1% target | Waits over 10 ms | Wait at all | p99 wait |
|---|---|---|---|---|
| 14 | Misses | 2.36% | 17.41% | 14.3 ms |
| 15 | Fewest that meet it | 0.84% | 10.20% | 9.3 ms |
| 16 | Headroom | 0.29% | 5.73% | 5.8 ms |

In plain words: with 15 workers, one request in ten has to queue, but almost all of those wait a few
milliseconds. The p99 wait, 9.3 ms, sits just inside the 10 ms budget, which is what the target asked for. One
worker fewer and the p99 is 14.3 ms, past the budget, although 14 workers are only 71% busy. That is why "keep it
under 80% busy" is not a sizing rule.

**4. Read the chart.** It draws the chance of waiting longer than 10 ms for every count from the fewest that keep
up, 11, to 18, on a log scale, with your 1% target across it. The curve is flat and then a cliff, and the answer is
where it crosses the line. Under the chart, the method notes give the mean wait at 15 servers, 408 µs: an average
over every request, most of which never wait, which is why it is not the number to size by.

**5. Compare with "nobody waits".** Set the wait limit back to `0` and Run. The answer becomes 19 servers:
keeping 99% of requests from queueing at all costs four more workers than keeping them from queueing for
more than 10 ms. Which of the two is the real requirement is worth asking before buying the four.

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
