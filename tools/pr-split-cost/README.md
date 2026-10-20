# PR split cost

## What it does

"Keep pull requests small" is good advice until each small PR waits its turn for review. This tool measures how
much the wait for a first review grows with a PR's size on your own repository, and prices splitting a change into k
PRs, reviewed one after another, side by side, or by one reviewer in one sitting.

Paste one line per merged PR: its size in lines changed, and the hours from ready-for-review to the first review by
someone other than its author. The default is grafana/grafana's 857 most recently created merged PRs with such a
review. Then press Run.

| Output | What it is |
|---|---|
| **The three ways** | Expected waiting for a first review for your k pieces, reviewed each of the three ways, against one PR of the whole change, slowest first. *Fit says* is the multiple if size drives the pickup as the fit says; *If size does not matter* is the other end. The truth is somewhere between the two. Your pick is named in its row. "In one sitting" is shown muted rather than green, because its small number rests on an assumption about how the reviewer works |
| **How far to trust it** | Right under the comparison: how much of the variation in wait size explains, r squared, with r and the number of PRs. Below r = 0.3 it says the multiples are directional only |
| **The fit's numbers** | Elasticity e, the slope of a straight line through log(wait) against log(size), with a 95% bootstrap range; what doubling a PR does to its wait, 2^e; and the median wait on the fit for one PR of the whole change, with the mean beside it |
| **Charts** | The waiting multiple against k for the three ways, and the pasted PRs with the fitted line, both axes logarithmic |
| **What each way assumes, and markdown** | What each way rests on, what is measured, and a markdown version of the comparison to paste into a PR description or a design doc |

## How to use it: an example

Leave the default PRs in place: grafana's 857. Keep **The change** at 800 lines, **Split into** at 8 PRs and
**Reviewed** at "One after another", and press Run. The answer is the three ways, slowest first:

```text
8 PRs instead of one of 800 lines: the wait for a first review, as a multiple of the one PR's
Reviewed                       Fit says   If size does not matter
One after another (your pick)     4.76x                        8x
Side by side                      3.10x                     5.12x
In one sitting                    0.59x                        1x
```

and right under it, how far to trust that:

```text
Directional only: size explains 3.5% of the variation in wait across 857 PRs (r = 0.19). A correlation, not a cause.
```

then e = 0.25 (95% bootstrap range 0.16 to 0.34), doubling a PR multiplying its wait by 1.19, and one 800-line PR
waiting a median of 2.1 h on the fit, with a mean of 34.2 h.

In plain words: on grafana, if the eight pieces go through the queue one at a time, the feature waits about five to
eight times as long for review as one big PR would have. Opening them all at once helps, three to five times. Only a
reviewer who takes all eight together brings it back to one PR's wait or less, and that is a way of working the team
has to agree on, not something these PRs show. Size explains very little of any one PR's wait, which is why both ends
are on the screen.

Now pick "In one sitting" and press Run again: the numbers stay, and "(your pick)" moves to the muted row, 0.59x on
the fit and 1x, the same as one PR, if size does not matter. Try your own repository by pasting `split_cost.py --csv` output in place of the default.

## The three ways

- **One after another.** Each piece waits for its own first review, and the next isn't opened until the last is
  merged. Each piece is k times smaller, so it waits (1/k)^e as long, and there are k of them: **k^(1-e)** times one
  PR's wait. At e = 0.25 that is 4.76 for eight pieces. This is exact in expectation under the fit, whatever the
  scatter, because expected waits add. If size has no effect, it is k.
- **Side by side.** All k open at once, each picked up independently, and the change waits for the slowest. The
  slowest of k depends on how scattered the waits are, which e doesn't say, so the tool computes the expected largest
  of k exactly from the fit's own residuals. On the three repositories I measured, eight pieces side by side wait two
  to three and a half times as long as one PR, and about five times if size has no effect. Real pickups of one
  author's PRs opened together are not independent, and the dependence can go either way: PRs picked up on the same
  good day make the slowest of k smaller, and a reviewer who works through them one at a time makes it larger, closer
  to one after another. So this is neither an upper nor a lower bound; it is the independent case.
- **In one sitting.** One reviewer takes all k together, starting as soon as they would start one small piece. The
  change then waits for one pickup of a PR k times smaller: **k^(-e)**, under 1. If size has no effect, it is one
  pickup like any other, the same as one PR. So this way is no worse than one PR, and better only if size drives the
  pickup. The data doesn't measure it, which is why it is shown muted.

If one person reviews everything, it depends how they work through the pieces: taking them together is "in one
sitting"; treating each as its own item in their queue, one at a time, is closer to "one after another".

## What it assumes

- **Correlation, not cause.** The fit describes your history; it doesn't promise what your next PR will do. Anything
  that affects both a PR's size and how fast it is picked up shows up in e. That is why the tool shows both ends.
- **One line on log axes.** Size explains little of the wait on the repositories I've measured, r = 0.12 to 0.27.
  The data says how much it leaves unexplained, not what explains the rest.
- **Only the wait for a first review.** Rework, the second round, CI and merge conflicts are not counted, and a stack
  of PRs adds rebasing work this doesn't price.
- **Waits under three minutes count as three minutes**, so a log can be taken. Most of these are drafts reviewed
  before their author marked them ready. They can move e: on grafana, leaving them out takes it from 0.25 to 0.16.
- **Mean waits.** The multiples are of expected (mean) waits, because waits that follow one another add. Medians keep
  the same order of the three ways, with much larger multiples for the first two.

The script that fetches and fits the same data for any repository is `split_cost.py`, in the companion code for the
article this tool came from. Its `--csv` output pastes straight in.
