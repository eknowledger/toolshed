# LLM timeout check

## What it answers

How long can one agent task run before anything in its settings stops it, and what should you set if that's too
long? It checks three ways a model call goes wrong:

| Failure | What the provider does | What stops it by default |
|---|---|---|
| **Silent** | Accepts the connection and sends nothing | The read timeout, once per attempt, then the retries |
| **Trickling** | Answers 200 and streams slowly | Only `max_tokens`: every token restarts the read timeout |
| **Overloaded** | Refuses at once with 429 or 529 | The SDK's backoff between retries |

Each is worked out for one attempt, one call with its retries, and one task of up to the turn limit, and judged
against how long the task may take: a person in a chat, or a job's own deadline. Where it's too long, the tool
names the one setting that fixes it.

**Stack** fills in your SDK's defaults, so you only type what you changed:

| Stack | Read timeout | Retries | Turns |
|---|---|---|---|
| Anthropic or OpenAI Python SDK, 1.13.0 and 3.28.0 | 600 s | 2 | left as it is: neither SDK has a turn limit, so enter your loop's |
| OpenAI Agents SDK 0.23.1 | 600 s | 2, from the OpenAI client it creates | 10, its `max_turns` |
| Custom | | | |

The two Python SDKs share one choice because their defaults are the same. Edit any of the numbers afterwards and Stack switches to Custom, or to whichever stack the numbers still match.
None of the three sets an attempt deadline.

## How to use it: an example

Say you run a support chat. Your agent uses the Anthropic Python SDK and you never changed its timeout. It makes up
to 10 model calls to answer one question, and a customer will wait about 2 minutes before giving up.

**1. Enter what you run.**

| Input | You enter | Why |
|---|---|---|
| Stack | *Anthropic or OpenAI Python SDK* | It fills Read timeout with `600` and Retries with `2`, the SDK's defaults |
| Attempt deadline | `0` | You don't wrap the call in your own time limit |
| Turns | `10` | Your agent stops after 10 calls |
| max_tokens | `4096` | What you pass to the API |
| Acceptable wait | `120` | 2 minutes, the customer's patience |

**2. Press Run, and read the top line.**

```
Worst case for one task
5.7 h
A model that trickles its answer can keep a 10-turn task running this long, which is over the 2 min you can wait.
```

In plain words: if the model starts answering very slowly, your agent can keep a customer waiting almost six
hours, and nothing in your settings stops it.

**3. Read what to set**, worst first:

| Failure | What to set | Worst case | What ends it |
|---|---|---|---|
| Trickling | Set an attempt deadline of 3 s or less. | 5.7 h | Only max_tokens ends it, because every token restarts the read timeout. |
| Silent | Set an attempt deadline of 3 s or less. | 5 h | The read timeout ends each attempt, then the SDK retries. |
| Overloaded | Nothing. It fits the wait. | 15 s | The SDK gives up after its retries and their backoff. |

A model that says nothing is cut off after 600 s and retried twice, on every turn. A slow answer is ended only by
its length. A model that refuses at once costs only the short waits between retries, so that one is fine. The fix
for both slow cases is the same: give each attempt its own time limit.

**4. Read the numbers under it.** For the worst case, trickling:

```
One attempt                     34.1 min   4,096 tokens at 2 tokens a second.
One call, with its retries      34.1 min   Not retried, because the provider answered 200.
Cost of the worst-case trickle  $1.01      10 calls of 4,700 input tokens, at $4 and $20 per million tokens, ...
```

**5. Read the chart to see why.** Look at the Trickling column:

- the diamond, one call, sits at about 2,000 s: one slow answer of 4,096 tokens at 2 tokens a second takes 34 minutes;
- the triangle, the whole task, sits at about 20,000 s: 10 calls like that is 5.7 hours;
- both are far above the red dashed line, your 2 minutes.

The read timeout never helps here. It only fires when the model goes quiet for 600 s, and a slow stream is never
quiet that long: every token restarts the clock.

**6. Try the fix and Run again.** Put `3` in Attempt deadline. Every mark drops under the red line, the worst case
becomes 1.8 min, and the top line turns green.

If 3 seconds is too short for your model to answer, that tells you something too: 10 turns with 2 retries each
can't fit in 2 minutes. Lower Turns to `4` and Retries to `1`, and the deadline it suggests rises to 14 s.

**For a background job** where an hour is fine, set Acceptable wait to `3600`. The same defaults are still far too
long, 5.7 hours, but now an attempt deadline of about 2 minutes is enough.

## How it counts

- **The read timeout limits each wait for the next chunk, not the call.** In the anthropic and openai Python
  SDKs, `timeout=600` is an httpx2 timeout whose `read` part is the longest wait for the next chunk. Measured
  against a local server with anthropic 1.13.0, `timeout=3.0` let a stream of 12 tokens 1.5 s apart run 18 s
  without an error.
- **Silent:** each attempt lasts the read timeout, or the attempt deadline if that is shorter. Between attempts the
  SDK waits 0.5 s doubling to 8 s. The SDKs shorten each wait by up to a quarter at random; the worst case is the
  unshortened wait.
- **Trickling:** fixed at 2 tokens a second, so one call lasts `max_tokens / 2` seconds unless the attempt deadline
  cuts it. A cut attempt is retried like a timeout, the conservative reading. A read timeout shorter than the gap
  between tokens fires mid-stream, after the 200, as a transport error the SDK doesn't retry.
- **Overloaded:** the refusals are immediate, so the call is just the backoff between retries.
- **A task** is up to `turns` calls at the worst case. That assumes the agent loop starts another turn after a
  failed call, as many hand-written loops do. A loop that stops at the first failure takes one call.
- **The suggested deadline** is the longest attempt deadline that fits the whole task, retries and backoff
  included, into the acceptable wait: `(wait - turns x backoff) / ((retries + 1) x turns)`, rounded down.
- **Cost** is a sense of scale only: the worst-case trickle, at 4,700 input tokens a call and Claude Opus 5.5's
  list price on 2026-10-11. The lower figure bills only calls that finish; the higher bills every cut-off attempt
  for what it streamed. No provider documents which happens.

## What it assumes

- **Worst cases, not forecasts.** The point is which limit, if any, is doing the work.
- **One call at a time.** No parallel tool calls and no queueing in front of the provider.
- **The SDK's own backoff.** A `retry-after` header from the provider replaces it, and the anthropic SDK accepts
  one of up to 4,294,967 s.
- Connect timeouts are left out: they bound only reaching the server, 5 s in both SDKs.

## References

- [httpx timeouts](https://www.python-httpx.org/advanced/timeouts/): "The read timeout specifies the maximum
  duration to wait for a chunk of data to be received". The SDKs use httpx2, its successor, with the same model.
- [anthropic-sdk-python 1.13.0, `_constants.py`](https://github.com/anthropics/anthropic-sdk-python/blob/v1.13.0/src/anthropic/_constants.py#L10-L15):
  `DEFAULT_TIMEOUT = httpx2.Timeout(timeout=10 * 60, connect=5.0)`, `DEFAULT_MAX_RETRIES = 2`, backoff 0.5 s to
  8 s.
- [openai-agents-python 0.23.1, `run_config.py`](https://github.com/openai/openai-agents-python/blob/v0.23.1/src/agents/run_config.py#L45):
  `DEFAULT_MAX_TURNS = 10`.
- AWS Builders' Library, [Timeouts, retries and backoff with jitter](https://builder.aws.com/content/3EumjoZascWd1oZiEgL8ORlv3qE/timeouts-retries-and-backoff-with-jitter).
- Written for the post *Circuit breakers for inference: what HTTP 200 misses*, whose companion code,
  `mainlog-code/agent-cost-control`, measured the SDK behaviour above.
