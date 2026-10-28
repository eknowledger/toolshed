# Metric cardinality calculator

A metric is not one time series. It is one per combination of its label values, times however many series its
type writes for each combination, times every process that exposes it. Each factor is easy; the product is the
number people get wrong, usually by an order of magnitude, and it is the number a Prometheus server's memory and a
vendor's bill are both counted in.

The product of the label values is the same wherever the metric is stored. What one label set writes, whether each
process gets its own copy, the limits worth knowing and the unit of the bill are not, so the first input is **Where
the metric is stored**: self-hosted Prometheus, the three managed Prometheus services, or the custom metrics of
CloudWatch, Azure Monitor and Google Cloud Monitoring. The provider table below quotes the rule behind each one.

## How to use it: an example

Leave *Where the metric is stored* at **Prometheus, self-hosted**. A Go service exposes one request-duration histogram with three labels. Its routes, methods and statuses take 12, 3
and 6 values, but most routes only ever see one or two methods and a few statuses, so about a quarter of the 216
combinations actually occur. It runs on 20 pods. Choose **Go client_golang** under *Client library*, which fills in
11 buckets and no `_created`, and list the labels, one row each:

| Label | Values |
|---|---|
| route | 12 |
| method | 3 |
| status | 6 |

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

### The same metric on a managed Prometheus

Now choose **Amazon Managed Service for Prometheus** and set *Scrape or write interval* to 30 s. This is the sample
*Same, Amazon Prometheus*. The series are the same 15,120, because the service stores what the client
writes, and so are the changes. What moves is the quiet row, which now counts what Amazon bills:

| Label sets | Samples ingested |
|---|---|
| 54, where Prometheus's guide aims for fewer than 10 | 1.31 billion a month |

That is 15,120 series x 2,592,000 seconds in a 30-day month / 30 s. Type your price per 10 million samples into
*Your price per billing unit* and a *Bill* appears beside it. The method notes add the workspace's default quota of
50,000,000 active series, shared by every metric there, so it is noted rather than flagged.

Choose **Google Cloud Managed Service for Prometheus** instead and the answer is 1,080 series, because Google stores
each classic histogram as one distribution series. The samples don't fall, though: Google bills each scrape of
a distribution as 2 samples plus 1 per bucket with a count in it, 12 buckets here, so the answer is "Up to 1.31
billion a month", the same as Amazon's at most.

### A CloudWatch custom metric with dimensions

An API on Lambda emits a latency metric through the Embedded Metric Format, with dimensions `operation` (6 values),
`status` (3) and `customer` (200), and about half of the combinations occur. Twelve instances publish it. Choose
**Amazon CloudWatch custom metrics, including EMF**, or press the sample *CloudWatch EMF, per customer*:

```text
1,800 custom metrics
6 operation x 3 status x 200 customer values x 50% that occur x 1 metric per label set
```

| Change | Metrics after | Saves |
|---|---|---|
| Without customer | 9 | 1,791 (over 99%) |
| Without operation | 300 | 1,500 (83%) |
| Without status | 600 | 1,200 (67%) |

and *Billed as* 1,800 metric-months. Two factors from the Prometheus answer are gone. A histogram is one metric and the
twelve instances are not a factor, because CloudWatch treats each unique combination of dimensions as one metric,
whatever it holds and whoever publishes it. The method
notes say so, and say to list a host as a label if each instance adds one. The `customer` dimension is the bill:
dropping it leaves 9 metrics.

## The inputs

- **Where the metric is stored**, one of seven backends, described in the table below. The default is self-hosted
  Prometheus.
- **Labels and their values**: one row per label (or dimension), its name and how many values it takes. An empty
  list is a metric with no labels. Prometheus's naming rule is checked only on the Prometheus backends, and a refusal
  is shown under the row it is about.
- **Metric type**. A summary's quantile count is part of the type: Python's prometheus_client writes summaries
  with no quantiles, and three (0.5, 0.9, 0.99) is a typical configuration elsewhere.
- **Client library** fills in the bucket count and whether `_created` is written with that library's defaults:
  Python's 14 buckets and `_created`, the same with `PROMETHEUS_DISABLE_CREATED_SERIES`, or Go's 11 buckets.
  Change either afterwards and it shows Custom.
- **Targets**, **Combinations that occur**, **Scrape or write interval**, and an optional **Your price per billing
  unit**. The price is per whatever the backend bills, which the *Bill* note names: 1,000 active series a month for
  self-hosted (or a vendor that bills series), 10 million samples on Amazon's or Azure's managed Prometheus, 1
  million samples on Google's, a metric-month on CloudWatch, a MiB on Cloud Monitoring. The tool ships no price,
  because prices change and differ by region and tier.

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
- **Targets**: every scraped process gets its own `instance` label, so each one multiplies the total. On Cloud
  Monitoring each writes to its own monitored resource, which multiplies it too. On CloudWatch and Azure custom
  metrics they share a series unless a label tells them apart, so targets are left out of the product.
- **Samples and disk**: one sample per series per scrape. Disk uses the 1 to 2 bytes per sample the Prometheus
  storage documentation gives, over 15 days.
- **Billing**, per backend: active series (self-hosted), samples ingested a month (the managed Prometheus
  services), metric-months (CloudWatch), MiB ingested a month (Cloud Monitoring), nothing yet (Azure custom metrics,
  free in preview). A month is 30 days. **Bill** appears only if you enter your price for that unit.
- **Limits**: a provider's limit is flagged in red only when this metric alone breaks it; otherwise the method notes
  name it. Most are shared by every metric in a workspace or subscription, so a metric under one can still help push
  the total over.

The answer comes in that order: the series count with its multiplication; each change the reader can make (a
native histogram, dropping each label, no `_created`), scored by the same arithmetic with the change made and
sorted by the series it leaves; the label sets, samples, disk and bill; and how the per-label-set count was reached,
with how to make each change. Only the label sets carry a tone, because they are the one number Prometheus's guide
judges, and only on the Prometheus backends, because it is Prometheus's guide.

## Where the metric is stored: the rule behind each backend

Checked on 2026-10-19 against each provider's own documentation and pricing pages. Only what those pages state is
modelled; where they are silent, the method notes say so.

| Backend | One label set writes | Billed per |
|---|---|---|
| Prometheus, self-hosted | By type | 1,000 active series, at a vendor's price |
| Amazon Managed Prometheus | By type | 10 million samples |
| Azure managed Prometheus | By type | 10 million samples |
| Google Managed Prometheus | By type; a histogram is 1 | 1 million samples |
| CloudWatch custom metrics | 1 | metric-month |
| Azure custom metrics | 1 | free in preview |
| Cloud Monitoring custom metrics | 1; a summary by its parts | MiB ingested |

Targets multiply on every backend except CloudWatch and Azure custom metrics. The exact rules, quoted:

- **Prometheus, self-hosted.** The instrumentation guide's under 10 label sets, and investigate anything over 100
  ([instrumentation](https://prometheus.io/docs/practices/instrumentation/#do-not-overuse-labels)); 1 to 2 bytes a
  sample on disk ([storage](https://prometheus.io/docs/prometheus/latest/storage/#operational-aspects)).
- **Amazon Managed Service for Prometheus.** "Active series per workspace: 50,000,000", adjustable
  ([quotas](https://docs.aws.amazon.com/prometheus/latest/userguide/AMP_quotas.html)). "Amazon Managed Service for
  Prometheus counts each metric sample ingested"; for native histograms "each populated bucket (a bucket with
  non-zero observations) counts as 0.25 of a metric sample"
  ([pricing](https://aws.amazon.com/prometheus/pricing/)). Storage and query samples are billed separately and not
  sized here.
- **Azure Monitor managed service for Prometheus.** Per workspace, "Active time series with metrics that have been
  reported in the last ~12 hours: 1,000,000" and "Events per minute ingested: 1,000,000", both raisable on request
  ([limits](https://learn.microsoft.com/en-us/azure/azure-monitor/fundamentals/service-limits)). Billed on "Metric
  samples ingested", per 10 million; query samples separately
  ([pricing](https://azure.microsoft.com/en-us/pricing/details/monitor/)).
- **Google Cloud Managed Service for Prometheus.** "Prometheus histogram metrics are converted to the analogous
  Cloud Monitoring `Distribution` type"
  ([exemplars](https://cloud.google.com/stackdriver/docs/managed-prometheus/exemplars)). "Active time series from
  Prometheus per monitored resource: 1,000,000" ([quotas](https://cloud.google.com/monitoring/quotas)); "a minimum
  scrape interval of 5 seconds" ([overview](https://cloud.google.com/stackdriver/docs/managed-prometheus)). Samples
  are counted as "1 for each point" of a scalar, and for a fixed-bucket distribution "2 for each point written to a
  time series, plus 1 for each histogram bucket that has a non-zero count"; an exponential one is 2 plus 1/8 per
  non-zero bucket ([pricing](https://cloud.google.com/stackdriver/pricing)).
- **Amazon CloudWatch custom metrics, including EMF.** "CloudWatch treats each unique combination of dimensions as
  a separate metric, even if the metrics have the same metric name", and "You can assign up to 30 dimensions to a
  metric" ([concepts](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch_concepts.html#Dimension)).
  An EMF DimensionSet "MUST NOT contain more than 30 dimension keys", and EMF "will by design create a custom metric
  corresponding to each unique dimension combination"
  ([EMF](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html)).
  "All custom metrics ... are prorated by the hour"; PutMetricData requests, and EMF's log ingestion, are billed on
  top and not sized here ([pricing](https://aws.amazon.com/cloudwatch/pricing/)).
- **Azure Monitor custom metrics.** "An active time series is any unique combination of metric, dimension key, or
  dimension value"; "Total active time series in a subscription per region: 50,000"; "Dimension keys per metric:
  10"; ingested "at a fixed 60-second interval"; "Native custom metrics are also free during the preview", and they
  "won't be made generally available"
  ([custom metrics](https://learn.microsoft.com/en-us/azure/azure-monitor/metrics/metrics-custom-overview)).
- **Google Cloud Monitoring custom metrics.** "Labels per custom, external, and workload metric descriptor: 30";
  "Active time series from custom metrics per monitored resource: 200,000"; points "at least 5 seconds apart";
  "Histogram buckets per custom distribution metric: 200" ([quotas](https://cloud.google.com/monitoring/quotas)).
  Billed on bytes: "8 bytes for each data point" of a scalar and "80 bytes for each data point" of a distribution,
  with the first 150 MiB a month free ([pricing](https://cloud.google.com/stackdriver/pricing)).

What the tool does not claim, because those pages don't say:

- **Google Managed Prometheus and `_created`.** Whether its collector stores `_created` as a series is not on the
  pages checked, so the toggle decides, and the method notes say so.
- **Native histograms on Azure's managed Prometheus.** Its limits and pricing pages don't mention them, so the
  samples are not counted for that case. On Amazon's they depend on how many buckets have counts, which no input
  says, so they are not counted either.
- **Tiers and free allowances.** Every provider prices in volume tiers that vary by region. The bill is your price
  times the count; Google's free 150 MiB is noted, not subtracted.
- **Summaries on Cloud Monitoring custom metrics.** There is no summary type there; the tool counts `_sum`,
  `_count` and each quantile as separate series, which is how Google maps a summary written over OTLP.

Left out: OpenTelemetry (OTLP) ingestion into these backends, such as Azure Monitor's OpenTelemetry metrics. It is a
different path from the seven above, and how each provider counts an OTLP histogram was not checked for this
version.

## Where it stops being true

- **Shared limits.** A workspace or subscription limit is judged against this one metric, which is only useful
  when it alone breaks it. The rest of your metrics count against the same limit.
- **The product is a ceiling.** Most routes never return most status codes. Set "Combinations that occur" if you
  know the share, or read the answer as the worst case.
- **Series churn is not counted.** A label whose values change (a pod name, a build ID) leaves old series behind
  for the retention period, and those count against memory until they go stale.
- **Native histograms** cost one series but a larger sample, so the disk estimate understates them.
- **Created timestamps**: newer Prometheus servers can read `_created` as metadata rather than storing it as a
  series. The toggle is there for whichever your setup does.
