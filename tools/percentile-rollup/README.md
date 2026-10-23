# Percentiles across hosts

## What it does

Paste a latency histogram for each instance, from Prometheus, Google Cloud Monitoring, AWS X-Ray or a KQL or
CloudWatch Logs Insights query, or raw latencies for each host, and press **Run**. It shows the p99 of the whole
service, how far off that number can be, and how wrong the averaged per-instance p99 a dashboard often shows really
is, in which direction. The format is detected from what you paste.

| Output | What it is | Does it roll up? |
|---|---|---|
| **The two methods, side by side** (the answer) | First row: summed across instances edge by edge, then estimated the way `histogram_quantile` does, with the bucket it falls in, which is all the buckets can claim. For raw latencies: the p99 of every measurement together, exact. Second row: the average of each instance's own p99, and how far off it is, in which direction | The first row does. The second does not, and the tool says so |
| **The share slower than each edge** | A chart, both axes logarithmic, with the percentile's line. Where the curve crosses it is the bucket the answer falls in, which is why the answer is a range | |
| **At or under the threshold, mean, requests** | The share of requests at or under your threshold, the mean (`_sum` over `_count`, or the count-weighted mean of the raw values) and the total | Yes, exactly, when there is a bucket edge at the threshold |
| **What to change** | Stop averaging per-instance quantiles; add bucket edges where the p99 falls, or at your threshold, when the buckets are too coarse to say. For Prometheus, the query that pools correctly, on its own | |

Then each instance on its own, slowest first, and the exact share at or under every bucket edge.

## How to use it: an example

Four instances of a pricing service share the traffic equally. Host 4 stalls on 2% of its requests. A dashboard
averages the four hosts' p99s. To check it, paste each instance's bucket counts from the histogram,
`http_request_duration_seconds`, with the Prometheus client's default edges. This is the tool's first sample:

```text
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{instance="host-1",le="0.005"} 0
http_request_duration_seconds_bucket{instance="host-1",le="0.01"} 599
http_request_duration_seconds_bucket{instance="host-1",le="0.025"} 18306
http_request_duration_seconds_bucket{instance="host-1",le="0.05"} 24790
http_request_duration_seconds_bucket{instance="host-1",le="0.1"} 24896
...
http_request_duration_seconds_bucket{instance="host-4",le="0.5"} 24765
http_request_duration_seconds_bucket{instance="host-4",le="1"} 24954
...
http_request_duration_seconds_bucket{instance="host-4",le="+Inf"} 24954
http_request_duration_seconds_sum{instance="host-4"} 745.317
http_request_duration_seconds_count{instance="host-4"} 24954
```

Leave **Percentile** at p99 and **Threshold** at `0.1`, which is 100 ms because the edges are in seconds. The tool
answers:

| Method | p99 | What you can claim |
|---|---|---|
| Sum the buckets, then estimate | about 50 ms | somewhere in 25 ms to 50 ms |
| Average of the instances' p99s | 149.2 ms | 2.99x the pooled value, too high |

The chart under it shows why it is a range: 0.915% of requests are slower than 50 ms and 26.74% slower than 25 ms,
so the 1% line is crossed somewhere inside that bucket. Then 99.517% at or under 100 ms, exactly 99,517 of 100,000;
a mean of 23.42 ms, exactly; and, worst first:

| What to do | Why |
|---|---|
| Stop averaging per-instance p99s | Sum the buckets first, then estimate, with the query below. |
| Add bucket edges between 25 ms and 50 ms | The p99 can be anywhere in that bucket, a range of 25 ms, which is 50% of the estimate. |

```text
histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))
```

The pooled value is rounded to a tenth of the bucket's order of magnitude, 1 ms in a 25 ms bucket, because the
buckets support no more than that.

In plain words: the dashboard's averaged p99 says 149 ms, three times the real figure. Host 4's own p99 is about
449 ms, because 2% of its requests stall, and averaging gives it a quarter of the weight. But stalled requests are
only 0.5% of the service's traffic, so the service's p99 never reaches them. The real p99 is about 50 ms, and with
these edges we can only say it is between 25 and 50 ms. The share under 100 ms needs no estimate: there is an edge
at 0.1, so 99.517% is exact.

The second sample moves 70% of the traffic onto host 4. Now stalls are 1.4% of requests, the pooled p99 is about
370 ms (somewhere between 250 and 500 ms), and the averaged one, 152 ms, is too low. Same hosts, same kind of stall,
wrong in the other direction. What decides it is how the traffic is split, which an averaged percentile cannot know.

### A cloud example: Google Cloud Monitoring

A service on Cloud Run is rolling out a new revision as a canary, with 4% of the traffic. The canary has a slow path:
5% of its requests take 0.6 to 1.4 seconds. A dashboard charts each revision's p99 and the alert averages them. To
check it, list the time series of `run.googleapis.com/request_latencies` for the hour with `projects.timeSeries.list`,
aligned with `ALIGN_DELTA` so each revision keeps its distribution, and paste the JSON. This is the sample
**Cloud Monitoring**; its counts and bucket layout are illustrative, not from a real
project:

```json
{
  "timeSeries": [
    {
      "metric": { "type": "run.googleapis.com/request_latencies", "labels": { "response_code_class": "2xx" } },
      "resource": { "type": "cloud_run_revision", "labels": { "revision_name": "checkout-00041-xoq", ... } },
      "metricKind": "DELTA",
      "valueType": "DISTRIBUTION",
      "points": [{ "value": { "distributionValue": {
        "count": "38400",
        "bucketOptions": { "exponentialBuckets": { "numFiniteBuckets": 20, "growthFactor": 1.5, "scale": 1 } },
        "bucketCounts": ["0", "0", "0", "0", "0", "0", "10", "402", "4533", "14717", "14224", "4140", "371", "3"]
      } } }],
      "unit": "ms"
    },
    ... the canary, checkout-00042-bem, with 1,600 requests
  ]
}
```

The exponential bucket options are turned into edges: bucket i ends at 1 x 1.5^i ms, so 1, 1.5, 2.25 and on to
3325.3 ms, with an overflow bucket above. Set **Threshold** to `100`, because this metric is in milliseconds. The tool
answers:

| Method | p99 | What you can claim |
|---|---|---|
| Add the distributions, then estimate | about 94 ms | somewhere in 86.5 ms to 129.7 ms |
| Average of the series' p99s | 683.6 ms | 7.26x the pooled value, too high |

with 98.825% to 99.813% under 100 ms, a range because there is no bucket edge at 100 ms; a mean of 42.29 ms, exactly,
each distribution's mean weighted by its count; and 40,000 requests in 2 series of 22 buckets each.

Then, worst first: stop averaging per-series p99s, because a REDUCE_SUM across the series keeps a distribution and a
p99 per series cannot be combined; and, for a metric you write yourself, use finer buckets between 86.5 and 129.7 ms,
and a boundary at 100 ms.

In plain words: the averaged p99 says 684 ms and would page someone. The canary's own p99 is about 1.28 seconds, but
its slow requests are only 0.2% of the service's traffic, so the service's p99 is about 94 ms. The canary still has a
problem worth rolling back for; the service as a whole does not have a 684 ms p99.

## What you can paste

| Input | Read as |
|---|---|
| `..._bucket{instance="a",le="0.05"} 120` lines, from a `/metrics` page or a query result | Prometheus buckets, one histogram per `instance` label. Other labels, such as `method`, are added together within an instance, as `sum by (instance, le)` would |
| `{instance="a",le="0.05"} 120`, labels with no metric name | The Prometheus console's table for a `sum by (instance, le)` query. Read the same way, with no unit, because there is no metric name to take it from |
| Bucket lines with no `instance` label, under a `host 1:` line, blocks separated by a blank line | Prometheus buckets, one histogram per block: paste each instance's `/metrics` excerpt in turn |
| A CSV with a header `instance,le,count` (or `le,count` for one instance) | Prometheus buckets. A CSV has no metric name, so its values are shown in its own units |
| `_sum` and `_count` lines | Used for the exact mean, when every instance has both |
| The Prometheus query API's JSON, `{"status": "success", "data": {"resultType": "vector", ...}}` | Prometheus buckets, from an instant query such as `sum by (instance, le) (increase(x_bucket[1h]))`. Amazon Managed Service for Prometheus and Azure Monitor's managed Prometheus answer with this same JSON |
| Google Cloud Monitoring's `timeSeries.list` JSON for a DISTRIBUTION metric | One histogram per time series, named by the labels that differ between them. Linear, exponential and explicit bucket options are all turned into edges; the series' `unit` gives the unit |
| AWS X-Ray's `GetTimeSeriesServiceStatistics` or `GetServiceGraph` JSON | The `ResponseTimeHistogram` of each period or each service. These are response times in seconds and how many requests took each one, so they are ranked exactly, like raw latencies, rather than estimated inside a bucket |
| A KQL or Logs Insights result of a duration bin and a count, as CSV or as the query API's JSON | One histogram per instance column. The bin width is read from the spacing of the bin values |
| Anything else: `host 1: 12 14 15`, a blank line, `host 2: 18 21` | Raw latencies, one group per block |

The samples cover Prometheus, Google Cloud, AWS X-Ray and Azure KQL.
The cloud samples' numbers are illustrative, generated to show the effect, and not taken from a real account.

Bucket counts must be **cumulative**: each counts every request at or under its edge, so they never fall from one
edge to the next. Per-bucket counts are refused with a message saying so. Every instance needs a `le="+Inf"` bucket,
which holds its total, and every instance must use the same edges, because buckets only add edge by edge.

A metric whose name ends in `_seconds` is shown in milliseconds below one second, and so are X-Ray's response times,
which are in seconds. A Cloud Monitoring series uses its `unit`, and a bin column named `DurationMs` or `@duration` is
read as milliseconds. Units are otherwise yours: the threshold is in the same units as the edges, or the measurements.

Prometheus buckets count requests **at or under** an edge. Cloud Monitoring's buckets and `bin()` count those **under**
it, because their lower bound is inclusive and their upper bound exclusive, so the tool says "under" for them. For
latencies measured to a fraction of a millisecond the difference is a handful of requests at most.

For raw latencies, a comma between two digits is refused, because `1,204` could be one number or two, and so is a
unit stuck to a number, such as `18ms`.

## What each cloud provider exports, and what the tool does with it

The question for each export is whether it carries **counts per bucket**, which add up across instances and minutes,
or **percentiles already worked out**, which do not. Pooling the second kind is the mistake this tool exists to show,
so when it is pasted the tool refuses it, says why, and names the export that has the counts.

| Export | Read? | Why |
|---|---|---|
| Google Cloud Monitoring, a DISTRIBUTION metric from `timeSeries.list` | **Yes** | Each point holds `bucketOptions` and per-bucket `bucketCounts`, with an underflow bucket first and an overflow bucket last ([Distribution](https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/TypedValue)). A DELTA series' points are added up; a CUMULATIVE series' newest point already holds the rest |
| Google Cloud Monitoring, a series aligned with `ALIGN_PERCENTILE_99` | No, refused | The aligner turns each distribution into one number, "a GAUGE metric with valueType DOUBLE" ([Aligner](https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.alertPolicies)). Ask for `ALIGN_DELTA` instead |
| AWS X-Ray, `GetTimeSeriesServiceStatistics` and `GetServiceGraph` | **Yes** | `ResponseTimeHistogram` is a list of `Value` and `Count`, "the value of the entry" and "the prevalence of the entry" ([HistogramEntry](https://docs.aws.amazon.com/xray/latest/api/API_HistogramEntry.html), [GetTimeSeriesServiceStatistics](https://docs.aws.amazon.com/xray/latest/api/API_GetTimeSeriesServiceStatistics.html), [GetServiceGraph](https://docs.aws.amazon.com/xray/latest/api/API_GetServiceGraph.html)). The service graph's `client` node stands for the callers and is left out |
| Amazon CloudWatch metrics, `GetMetricData` or `GetMetricStatistics` | No, refused | They return one statistic per period, such as `p99` or `Average`, and no histogram ([MetricDataResult](https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_MetricDataResult.html)). CloudWatch "needs raw data points to calculate" percentiles ([statistics](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Statistics-definitions.html)), so ask it for the p99 over the whole window instead. Its percentile rank, `PR(:0.1)`, gives the share at or under a threshold. Publishing with `Values` and `Counts` ([MetricDatum](https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_MetricDatum.html)) sends a distribution in, but nothing returns one |
| CloudWatch Logs Insights, a query counting requests per duration bin | **Yes** | `bin()` in Logs Insights rounds only `@timestamp`, so bin a duration with `floor()` ([functions](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax-operations-functions.html)): `fields floor(@duration / 10) * 10 as bucket_ms \| stats count(*) by bucket_ms`. Paste the CSV, or the JSON from `GetQueryResults` ([results](https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_GetQueryResults.html)) |
| CloudWatch Logs Insights, `pct(@duration, 99)` | No, refused | One percentile per group, which does not pool ([stats](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax-Stats.html)) |
| Amazon Managed Service for Prometheus | **Yes**, as Prometheus | It answers the Prometheus-compatible query API with PromQL ([query APIs](https://docs.aws.amazon.com/prometheus/latest/userguide/AMP-onboard-query-APIs.html)), so its JSON is the Prometheus query API's |
| Azure Monitor managed service for Prometheus | **Yes**, as Prometheus | Its workspace answers `/api/v1/query` ([PromQL API](https://learn.microsoft.com/en-us/azure/azure-monitor/metrics/prometheus-api-promql)) |
| Azure Application Insights, the requests table through KQL | **Yes** | `bin()` "rounds values down to an integer multiple of a given bin size" ([bin](https://learn.microsoft.com/en-us/kusto/query/bin-function)), so `AppRequests \| summarize requests = sum(ItemCount) by AppRoleInstance, bin(DurationMs, 10)` is a histogram per instance. `DurationMs` is in milliseconds and `ItemCount` is "the number of telemetry items represented by a single sample item" ([AppRequests](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/tables/apprequests)): sum it rather than counting rows, or sampling undercounts. Paste the CSV export, or the query API's `tables` JSON ([response format](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/api/response-format)). In the classic schema the columns are `duration`, `itemCount` and `cloud_RoleInstance` |
| Azure KQL `percentile()` or `percentiles()` per instance | No, refused | One estimate per group ([percentile](https://learn.microsoft.com/en-us/kusto/query/percentiles-aggregation-function)), which does not pool |
| Azure Monitor metrics, such as a request duration metric | No, refused | Platform metrics and Application Insights standard metrics offer five basic aggregations, sum, count, average, min and max ([aggregation](https://learn.microsoft.com/en-us/azure/azure-monitor/metrics/metrics-aggregation-explained)), and no distribution |

## How to get each one

| From | Query, then paste |
|---|---|
| Prometheus, or a managed Prometheus | `sum by (instance, le) (increase(http_request_duration_seconds_bucket[1h]))` as an instant query: the JSON, or the console's table |
| Google Cloud Monitoring | `projects.timeSeries.list` with a `filter` on the metric type, `aggregation.perSeriesAligner` set to `ALIGN_DELTA` and an `aggregation.alignmentPeriod` covering the window. To choose what a series is, add `aggregation.crossSeriesReducer` set to `REDUCE_SUM` with the `aggregation.groupByFields` to keep |
| AWS X-Ray | `aws xray get-time-series-service-statistics --entity-selector-expression 'service("checkout")' --period 60` with a start and end time, for one histogram per minute |
| CloudWatch Logs Insights | `filter @type = "REPORT" \| fields floor(@duration / 10) * 10 as bucket_ms \| stats count(*) by bucket_ms` for Lambda, whose `@duration` is in milliseconds ([sample queries](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax-examples.html)). A column name ending in `ms` tells the tool the unit. Add your instance field to the `by` clause for one histogram each |
| Azure Log Analytics | `AppRequests \| where TimeGenerated > ago(1h) \| summarize requests = sum(ItemCount) by AppRoleInstance, bin(DurationMs, 10)` |

## How the estimate is made

`histogram_quantile` finds the bucket the rank falls in, the 99,000th request of 100,000 for a p99, and assumes the
requests in that bucket are spread evenly between its two edges. The first bucket's lower edge is 0. If the rank is
in the `+Inf` bucket, Prometheus returns the highest finite edge, and so does this tool, with a warning that the true
value has no upper bound. See [histogram_quantile](https://prometheus.io/docs/prometheus/latest/querying/functions/#histogram_quantile).

So the estimate is only as fine as the edges around it. The share at or under an edge, on the other hand, is exact,
which is why the advice is to put a bucket edge at every threshold you promise.

For raw latencies the answer uses **nearest rank**, the smallest measurement with at least p% at or below it, which
is always a measurement you observed. The last table gives **linear interpolation** beside it, what numpy and R
return by default. On a small or lumpy sample they disagree, and a p99 from a tool using one is not comparable with a
p99 from a tool using the other.

## What it does not do

- **It does not fix the averaged number.** There is no correction that recovers a true percentile from per-instance
  percentiles. Keep the buckets, with the same edges everywhere, which add up.
- **It does not read native histograms**, Prometheus's newer sparse kind. Paste classic `le` buckets.
- **It does not pool percentiles.** A CloudWatch p99 per minute, an Azure Monitor average, a KQL `percentile()` per
  instance: each is refused with a message naming the export that has the counts.
- **It does not guess a bin width it cannot see.** A log query's bins must sit on one grid, and at least two distinct
  bins are needed to read its width from the spacing.
- **It treats every raw measurement as one request.** If your groups are already summaries, paste the raw values or
  the buckets instead.
