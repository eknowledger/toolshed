# State machine analyzer

## What it answers

Is this state machine finished? A machine is usually drawn as its happy path, a dozen arrows. Written as a table,
every state against every event the code can observe, most cells are an event arriving where nobody expected it: a
late reply, the user changing their mind, a webhook delivered twice, the model going down. Each of those cells needs
a decision, and each decision is a test.

You write the states and what each event does in them. The tool shows:

| Output | What it tells you |
|---|---|
| **Coverage** | One line: how many state and event pairs are decided, how many are not, and a conflict or a state that can't be reached or left, when there is one |
| **The grid** | Every event against every state, each cell in words or a symbol: `→ search`, `stay`, a faint `✕` for reject. A red `?` is undecided. The events open in the most states come first |
| **The graph** | The states and the moves between them, laid out along the happy path, with each arrow labelled by its events. A state that can't be reached or left is amber |
| **Gaps** | States that can't be reached, states that can't be left, and cells two rules disagree about, by line |
| **Text to copy** | Under **Also write**: the grid as a markdown table with the gaps as a list, for your docs; or a pytest skeleton, one test per cell, failing where no rule decides |

It's for anything that reacts to events: an agent workflow, a webhook handler, a protocol, an order's lifecycle.

## How to use it: an example

Say you're building a dinner-booking agent. It gathers the day, time and party size, searches for a table, asks the
user to confirm, books it, pays the deposit, and texts the group. You've drawn the happy path, and you have a `degraded` state for
when the model is down, but no arrows to it yet.

**1. Write what you drew.** Each state is a line ending in a colon. Its rules go beneath it.

```text
gather:
  slots_complete -> search
  slots_missing  -> stay
search:
  slot_free -> confirm
  none_free -> gather
confirm:
  user_yes -> book
  user_no  -> gather
book:
  committed -> stay
  unknown   -> stay
  refused   -> gather
  paid      -> notify
notify:
  sent        -> done
  send_failed -> report
report:
  told -> done
degraded:

events: user_revises, slot_gone, model_unavailable, model_back
```

The last line lists four events your code can observe that no rule mentions yet: the user changing the request, the
restaurant giving the table away, and the model going down and coming back.

**2. Press Run, and read the top of the result.** One coverage line:

```text
Decided    13 of 119 pairs   7 states x 17 events: 10 moves and 3 stays. It starts at gather and ends at done.
Undecided  106               Marked ? in the table, most open events first.
Shape      degraded can't be reached or left
```

In plain words: there are 119 moments your agent can be in, and you've decided what happens in 13 of them. If the
user says "make it 8 instead" at any point, nothing says what the agent does. `done` has no rules of its own, so it's
where the machine ends rather than a row.

**3. Read the grid.** Events run down the side, states across, the events open in the most states first. The first
rows look like this:

```text
Event              gather    search     confirm  book  notify  report  degraded
user_revises       ?         ?          ?        ?     ?       ?       ?
slot_gone          ?         ?          ?        ?     ?       ?       ?
model_unavailable  ?         ?          ?        ?     ?       ?       ?
model_back         ?         ?          ?        ?     ?       ?       ?
slots_complete     → search  ?          ?        ?     ?       ?       ?
slots_missing      stay      ?          ?        ?     ?       ?       ?
```

`→ search` is a move to search, `stay` keeps the machine where it is, and `?`, in red, is a cell no rule decides. The
four events no rule mentions come first, `?` from end to end, and the `degraded` column is `?` all the way down. Ties
keep the order you wrote them in, so a finished machine reads in its written order.

**4. Look at the graph.** The happy path runs left to right and is highlighted: gather, search, confirm, book,
notify, done. `report` hangs off notify, and `degraded` sits on its own, amber, with the note *can't be reached or
left*: no arrow goes in and none comes out. The `stay` rules aren't drawn, because they don't move the machine; the
grid shows them.

**5. Read the gaps.**

| Gap | Where | Why |
|---|---|---|
| Can't be reached | `degraded` | Nothing leads here from gather, the start. |
| No way out | `degraded` | No event moves it to another state. |

You drew a box for the model being down, but no arrow goes in and none comes out.

**6. Decide some cells, and Run again.** Add:

```text
gather, notify:
  model_unavailable -> degraded   # these states need the model
degraded:
  model_back -> back
```

`back` returns to the state the machine came from. Now Decided is 16 (13 moves and 3 stays), Undecided 103, the gaps
table is gone, and `user_revises` and `slot_gone` lead the grid, still `?` in every state. In the
graph, `degraded` loses its amber, and dashed arrows labelled `model_back, back` run from it to gather and notify, the
two states it can return to.

**7. Beware the one-line fix.** Adding this decides every cell:

```text
every state:
  anything else -> reject
```

Undecided drops to 0 and Decided reads `13 moves, 3 stays and 103 rejects`. That is honest only if you mean it: rejecting
`user_revises` in `confirm` means ignoring a user who changes the time while being asked to confirm it. The sample
**Dinner booking, every cell decided** makes each of those decisions on purpose: 32 move, 22 stay, 6 defer and 59
reject.

**8. Take it with you.** Set **Also write** to *The table as markdown* and Run. Under the gaps comes the grid as a
markdown table, starting `119 cells: 13 decided, 106 undecided.` and ending with the gaps as a list:

```text
Gaps:

- Can't be reached: degraded. Nothing leads here from gather, the start.
- No way out: degraded. No event moves it to another state.
```

Paste it into the design doc, and the open questions are in front of whoever reviews it. *A pytest skeleton* gives
the same cells as tests instead.

## The syntax

```text
gather:                          a state; the first one written is the start
  slots_complete -> search       a move: event -> next state
  slots_missing  -> stay         an outcome instead of a state
  user_yes, user_no -> confirm   several events at once
  slot_gone -> stay  # why       text after # is the reason, kept in the gaps and the tests
gather, search:                  a block for several states
every state:                     every state written anywhere
every state except book, notify: every state but these
  anything else -> reject        every event this state has no other rule for
events: model_back               an event no rule uses yet
# a comment                      a line starting with # is ignored
```

- **The outcomes**: `stay` (the event is expected and changes nothing), `defer` (hold it until the state's work
  finishes), `reject` (it shouldn't arrive here: log it and do nothing), `ignore` (it's irrelevant here), and
  `back` (return to the state the machine came from). The tool doesn't interpret the first four beyond counting and
  shading them.
- **The states** are every header. A target with no header of its own, like `done`, is where the machine ends. If a
  typo creates one, it shows up in the coverage line: `ends at done and serach`.
- **The events** are every event a rule names, plus any on an `events:` line, in the order first written.
- **Indentation is optional**, and spaces and blank lines don't matter. A state can appear as a header more than
  once; its rules are merged. Names are letters, digits, `_`, `.` and `-`, with no spaces, so `payment.succeeded` is
  fine.
- **The arrow** can be `->`, `=>` or `→`. `*` means the same as `anything else`.

## How it counts

- **The narrower rule wins.** A state's own header beats a block of two, which beats a block of five, which beats
  `every state`. A block that names its states beats an `every state` block of the same size. Any named event beats
  `anything else`. So you can write the general case once and the exceptions beneath their states, in any order.
- **A conflict** is two rules equally narrow that say different things about one cell. The cell counts as
  undecided, the gaps table names both lines and their reasons, and the coverage line says so. Two rules that say
  the same thing are not a conflict.
- **A move to the state itself** counts as `stay`.
- **Can't be reached**: no chain of moves from the start leads there. `back` adds nothing, because it only returns
  somewhere already reached.
- **No way out**: no event in that state moves the machine to another state, or `back`.
- **The graph** draws one arrow for each pair of states a move joins, labelled with its events (two, then a count,
  past three). A `back` is a dashed arrow to each state that moves into the one it's in, because those are where it
  can return. `stay`, `defer`, `reject` and `ignore` leave the machine where it is, so they're left out rather than
  drawn as loops: a finished machine has one on almost every state, 22 in the booking, and they'd bury the moves. The
  highlighted happy path starts at the first state and takes each state's first-written move to somewhere new, so
  an exception written later, like `committed -> report`, doesn't become the main line.
- **The coverage line**: decided and undecided pairs, then a conflict if there is one, or else a state that can't be
  reached or left. Nothing is added when the machine has neither.
- **The grid's order**: the events undecided in the most states first, ties in the order first written.
- **The grid's marks**: `→ state` for a move, `↩ back`, `stay`, `defer`, `ignore`, `✕` for reject, `?` for undecided,
  and `2 rules` for a conflict. `?` and `2 rules` are red and `defer` amber, because they're the cells that need
  someone; a move is green. A reject is a faint `✕` for the same reason: in a finished machine most cells are
  rejects, and writing each one out, or colouring it like a gap, would bury the moves and the gaps.
- **The markdown** is the same grid, word for word, under a line of counts and above the legend and the gaps, except
  that a reject reads `✕ reject`, because a pasted table travels without the grid around it. Paste it
  into a design doc or a pull request, and the table survives review.
- **The skeleton** has one case per cell, in row order, with the expected next state or outcome, and `None` where
  no rule decides, so that test fails until one does. You write `deliver`, which puts your machine in a state and
  delivers an event.

## What it assumes

- **A flat machine.** No nested or parallel states, apart from `back`, which Harel's statecharts call a history
  state.
- **Events are things code observes**: a tool's result, a user's reply, a webhook, a timer. Not phrases in a model's
  text, which would give a column for every way the model can say something.
- **It checks the table, not your code.** The skeleton is where the two meet.

## References

- D. Harel, [Statecharts: a visual formalism for complex systems](https://doi.org/10.1016/0167-6423(87)90035-9),
  Science of Computer Programming 8(3), 1987: hierarchy, concurrency and history states.
- Written for the post *What a state machine buys an agent*. Its booking samples are the table in
  `mainlog-code/agent-state-machines/booking.py`, cell for cell.
