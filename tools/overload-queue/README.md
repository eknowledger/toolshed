# Overload and queue simulator

For a minute, more requests arrive than a service can answer. Somebody has to hear "no". Capacity decides how many
people can be answered; what the service does with the request that does not fit decides whether that many actually
are, which ones, and whether the rest hear "no" at once or after waiting for nothing.

Give it seven numbers: the policy, workers, mean service time, the normal rate, the rate during the spike, the
client's timeout, and how many times it retries. Press Run. It simulates the spike, a minute before it and three
minutes after, runs every other policy at the same numbers, and answers in this order:

1. **What happened to the people who arrived during the spike**, one bar per policy, yours first: answered in time
   (a successful response within 10 s of their first try, retries included), refused at once by a full queue or a
   queue timeout, or kept waiting for nothing (their attempt timed out, or the answer came after they had given up).
2. **Every policy at these numbers**: the share answered, the median wait of those answered, the recovery (how long
   after the spike it was back to normal), and the wasted work: requests served after their client gave up.
3. **A chart** of the share answered on your policy, by when people first tried, 10 s at a time. "Back to normal"
   is the first window after the spike from which every window answers 90% or more.
4. **Whether a spike can leave it stuck**, beside what this run did. A queue that can hold people past their
   timeout (an unbounded one) gets stuck if, once everyone is timing out, the normal rate times the tries that fit
   in a person's 10 s is at least capacity: the queue then can't drain however long ago the spike ended. Within 15%
   of that line chance decides, and it says so. A bounded queue or a queue timeout says how long anyone can wait in
   it instead. If the normal rate alone is at or over capacity, it says that.
5. **What to change**, the worst problem first, when there is something to change: more workers if the normal rate
   alone is over capacity; fewer retries if a spike can leave the queue stuck; a better policy, if one in the
   comparison answers at least 5 points more people at the same capacity, with that policy's own numbers; and the
   fewest workers whose capacity is over the spike.
6. **The service's numbers**: capacity, the spike against it, the p99 wait of those answered, orders answered, and
   tries per person.

## How to use it: an example

A shop's sale. The service has 8 workers at 80 ms a request, so it answers 100 a second. It normally gets 70 a
second, and for one minute of the sale it gets 150. Clients wait 2 s and do not retry, and the service queues
everything. Enter **Policy** *Unbounded queue*, **Retries** 0, **Spike rate** 150, **Normal rate** 70, **Workers** 8,
**Service time** 80 ms, **Timeout** 2 s, and press Run (or press the sample *The sale, unbounded queue*).

The bars, as numbers:

| Policy | Answered in time | Refused at once | Waited for nothing |
|---|---|---|---|
| Unbounded queue (yours) | 8.4% | 0% | 91.6% |
| Skip the abandoned | 19.5% | 0% | 80.5% |
| Bounded queue | 67.1% | 32.9% | 0% |
| Bounded, orders first | 67.1% | 32.9% | 0% |
| Queue timeout (CoDel) | 64.4% | 35.6% | 0% |
| Newest first (LIFO + CoDel) | 64.3% | 35.7% | 0% |

The table under them:

| Policy | Answered | p50 | Recovery | Wasted |
|---|---|---|---|---|
| Unbounded queue (yours) | 8.4% | 1125 ms | 90 s | 14,309 |
| Skip the abandoned | 19.5% | 1961 ms | at once | 4,466 |
| Bounded queue | 67.1% | 550 ms | at once | 0 |
| Bounded, orders first | 67.1% | 549 ms | at once | 0 |
| Queue timeout (CoDel) | 64.4% | 98 ms | at once | 0 |
| Newest first (LIFO + CoDel) | 64.3% | 81 ms | at once | 0 |

Then, under the chart: **Once everyone times out** 70/s of tries against 100/s (*70/s times 1 try within 10 s. It
drains, so a spike cannot leave it stuck.*), and **This run** recovered 90 s after the spike. What to change:

| Change | What it does at these numbers |
|---|---|
| Switch to bounded queue. | 67.1% answered instead of 8.4%, and 0.0% wait for nothing instead of 91.6%. Back to normal: at once. |
| Or add workers for the spike. | 13 workers is the fewest whose capacity is over the 150/s spike. The capacity planner sizes them for a wait target. |

In plain words: the service could have answered two people in three, and it answered fewer than one in ten. The
queue grew past 2 s of work, so almost everyone waited out their timeout, and the service spent the spike answering
14,309 requests for people who had already left. A bounded queue tells the third it cannot serve "no" at once, and
serves the rest in time. Press *Unbounded, with 3 retries* to see the same sale never recover: 280/s of tries against
100/s, "a spike can leave it stuck", this run stuck to the end, and the first change becomes retrying less.

## The policies

| Policy | What it does with the request that does not fit |
|---|---|
| Unbounded queue | Queues it, first come first served, with no limit. Serves it when its turn comes, even if the client gave up long ago |
| Skip the abandoned | The same, but a worker skips a request whose client has already given up |
| Bounded queue | Refuses a new request at once when the queue is full |
| Bounded, orders first | The same, but an order makes room by turning away the newest queued request that isn't one |
| Queue timeout | Fail at Scale's CoDel variant, with its published values: as a request arrives, if the queue has not been empty in the last 100 ms it may wait 5 ms, otherwise 100 ms. Enforced as a worker picks it up |
| Newest first | Adaptive LIFO with the same timeout: while a queue is standing, serve the newest request first |

## The numbers it fixes, and why

| Input | Value | Why fixed |
|---|---|---|
| Spike length | 60 s | Long enough to fill any queue that is going to fill; the shares barely move beyond that |
| Patience | 10 s from the first try | It only matters with retries, where it caps how many tries a person sends |
| Backoff | about 1 s between tries, plus or minus 50% | A second-order effect next to the number of retries |
| Queue bound | a quarter of the timeout's worth of work: `timeout x capacity / 4` | The rule: a bound sheds only if the work it holds is shorter than the timeout. A quarter leaves room for the service time and for bursts. 50 at 2 s and 100/s |
| Orders | 1 request in 5 | Only the orders-first policy uses it |

## Where it stops being true

- **Exponential service times.** Real ones have a heavier tail, which makes every policy worse.
- **Poisson arrivals and a clean retry schedule.** Real clients retry in bursts, which is worse again.
- **One queue in front of one pool.** A chain of services that each retry multiplies the attempts at the bottom.
- **Nothing costs anything to refuse.** In a real service, saying no takes some work, and if it takes as much as
  saying yes, refusing saves nothing.

## The simulation

A discrete-event simulation, seeded, so the same inputs always give the same answer. It is the same model as
`backpressure/shed_sim.py` in [mainlog-code](https://github.com/eknowledger/mainlog-code), down to the random
generator and the order it is drawn in, so with the defaults it prints that script's numbers exactly. The fixtures
are those numbers.

A run is limited to about two million attempts, which is enough for rates in the low thousands a second. The shares
depend on the ratio of demand to capacity rather than the rates themselves, so a bigger service can be scaled down
with its workers.
