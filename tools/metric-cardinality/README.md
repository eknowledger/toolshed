# Metric cardinality and cost

A metric is not one time series. It is one per combination of its label values, times however many series its
type writes for each combination, times every process that exposes it. Each factor is easy; the product is the
number people get wrong, usually by an order of magnitude, and it is the number a Prometheus server's memory and a
vendor's bill are both counted in.

## How to use it: an example

A Go service exposes one request-duration histogram with three labels. Its routes, methods and statuses take 12, 3
and 6 values, but most routes only ever see one or two methods and a few statuses, so about a quarter of the 216
combinations actually occur. It runs on 20 pods. Choose **Go client_golang** under *Client library*, which fills in
11 buckets and no `_created`, and enter:

```text
route 12
method 3
status 6
```

with *Targets* 20 and *Combinations that occur* 25%, then press **Run**. The answer starts with the number and
the multiplication that makes it:

```text
15,120 series
12 route x 3 method x 6 status values x 25% that occur x 14 series per label set x 20 targets
```

Then each change on its own, fewest series first, drawn as bars against the 15,120 now and listed in a table:

| Change | Series after | Saves |
|---|---|---|
| Native histogram | 1,080 | 14,040 (93%) |
| Without route | 1,400 | 13,720 (91%) |
| Without status | 2,520 | 12,600 (83%) |
| Without method | 5,040 | 10,080 (67%) |

and a quieter row of what it costs to keep:

| Label sets | Samples | Disk |
|---|---|---|
| 54, where Prometheus's guide aims for fewer than 10 | 1,008 a second | 1.3 GB to 2.6 GB |

In plain words: one histogram on this service is fifteen thousand series, and nearly all of that is two
multipliers. Each label set costs 14 series because the histogram writes one per bucket (11 buckets, `le="+Inf"`,
`_sum` and `_count`, which the method notes spell out), and each of the 20 pods writes its own copy. Switching to a
native histogram or dropping `route` each takes away about nine tenths of it. A row like "Without route" counts
dropping the label; grouping its values into a few leaves something between that and today.

Choose **Counter** instead and the same labels are 1,080 series, which is the cost of the buckets made visible.

## The inputs

- **Labels and their values**: one label per line, its name and how many values it takes (`route 12`,
  `route=12` and `route: 12` all work). Empty is a metric with no labels.
- **Metric type**. A summary's quantile count is part of the type: Python's prometheus_client writes summaries
  with no quantiles, and three (0.5, 0.9, 0.99) is a typical configuration elsewhere.
- **Client library** fills in the bucket count and whether `_created` is written with that library's defaults:
  Python's 14 buckets and `_created`, the same with `PROMETHEUS_DISABLE_CREATED_SERIES`, or Go's 11 buckets.
  Change either afterwards and it shows Custom.
- **Targets**, **Combinations that occur**, **Scrape interval**, and an optional **Price per 1,000 series**.

Retention is not an input: the disk figure is for Prometheus's default 15 days. Double it for 30.

## What it computes

- **Label sets**: the product of each label's value count, times the share of combinations that actually occur.
  Prometheus calls this the metric's cardinality, and its instrumentation guide aims for under 10 and says to
  investigate anything over 100.
- **Series per label set**, by type:
  - classic histogram: one per bucket, plus `le="+Inf"`, `_sum` and `_count`;
  - summary: one per quantile, plus `_sum` and `_count`;
  - counter and gauge: one;
  - native histogram: one, with its buckets carried inside each sample;
  - plus `_created` for counters, histograms and summaries when the client writes it. prometheus_client for
    Python does by default, which is why its default histogram is 18 series, not 17.
- **Targets**: every scraped process gets its own `instance` label, so each one multiplies the total.
- **Samples and disk**: one sample per series per scrape. Disk uses the 1 to 2 bytes per sample the Prometheus
  storage documentation gives, over 15 days.
- **Bill**: only if you enter your vendor's price per 1,000 active series, in dollars. The tool ships no price,
  because prices change and differ by plan.

The answer comes in that order: the series count with its multiplication; each change the reader can make (a
native histogram, dropping each label, no `_created`), scored by the same arithmetic with the change made and
sorted by the series it leaves; the label sets, samples, disk and bill; and how the per-label-set count was reached,
with how to make each change. Only the label sets carry a tone, because they are the one number Prometheus's guide
judges.

## Where it stops being true

- **The product is a ceiling.** Most routes never return most status codes. Set "Combinations that occur" if you
  know the share, or read the answer as the worst case.
- **Series churn is not counted.** A label whose values change (a pod name, a build ID) leaves old series behind
  for the retention period, and those count against memory until they go stale.
- **Native histograms** cost one series but a larger sample, so the disk estimate understates them.
- **Created timestamps**: newer Prometheus servers can read `_created` as metadata rather than storing it as a
  series. The toggle is there for whichever your setup does.
