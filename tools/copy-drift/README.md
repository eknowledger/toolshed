# Copy drift

## What it is for

Two functions look alike, and someone wants to merge them. Or two copies have to stay alike and nobody is sure they
have. The usual rules decide by counting copies ("three strikes, then refactor") or by taste. Neither looks at the one
thing that settles it: whether the copies have been **changing together**.

Paste the two functions and, if you have them, each one's `git log`, then press **Run**. The tool answers in this
order:

1. **The answer**, in one line: how many of the counted commits changed only one copy, which are the ones to read.
   Fewer than 5 changes since both existed is too early to tell.
2. **The counts as bars**: commits that changed both copies, only A and only B since both existed.
3. **The commits to read**: every one-sided commit, newest first.
4. **The current differences**, line by line, and whether each is only in names, strings or numbers or in what the
   code does, with how alike the two are beside them.
5. **The history**: a chart of the counts over time, every counted commit, and how the count was made.

Without a history, it says how alike the two are, shows where they differ straight after, and asks for the logs.

## How to use it: an example

The first sample is httpx's sync and async `Client._send_single_request`, at httpx `b5addb6`. Each copy's history came
from

```sh
git log --no-patch --format='%h %cI %s' -L 1001,1034:httpx/_client.py    # sync, copy A
git log --no-patch --format='%h %cI %s' -L 1717,1749:httpx/_client.py    # async, copy B
```

with **Count from** set to `e107e0f`, where the sync copy got its current name, and **Ignore** set to `8e36f2b`, a
29-file TLS change. Press **Run** and the result opens with:

```text
Since e107e0f
7 of 22 commits changed only one copy. Read those first.
Each is either a change the other copy missed, or a reason the two differ.

Both     15
A only    1
B only    6
```

Then the seven commits to read, newest first, which start:

| Copy | Commit | Date | Subject |
|---|---|---|---|
| B | 4189b7f | 2025-02-27 | fix typo (#3519) |
| B | 4b5a92e | 2023-04-12 | set logging request lines to INFO level for async method also (#2656) |
| A | f1157db | 2023-03-20 | Use standard logging style (#2547) |

and below them *Current differences: 6 lines, 2 in what the code does and 4 only in names, strings or numbers*, the
`def` and the `await` being the two, with the copies 99.6% alike once names are set aside and 95.6% as written.

In plain words: the two methods are almost the same code, and most of the time a change to one went to the other in
the same commit. But seven commits changed only one. Reading them is the work the tool cannot do: `f1157db` changed the
sync copy's logging line and `4b5a92e` brought the same change to the async copy 23 days later, so that pair was the
copies falling out of step and catching up. A merge would have made that one commit. The method at the bottom says
"Left out: 23 at or before the count starts, 1 ignored": 22 commits where the traced lines were other code, `e107e0f`
itself, and the TLS sweep.

Clear **Count from** and run again, and the counts jump to 29 together and 15 one-sided, because `git log -L` traced
the lines back into code that was neither method. That is why the count starts where the younger copy began.

## What it chose for you

Three settings were inputs in 1.x and are now fixed, each stated at the bottom of the result:

| Setting | Now | Why |
|---|---|---|
| Language | Read from the code | Python is recognised by `def`; Go, Rust, Kotlin, Swift, Java, C# and C by `func`, `fn`, `fun`, `#include` or a typed declaration; JavaScript and TypeScript by `function`, `=>`, `===` or `const x =`. The three lexers differ only in keywords, comments and strings |
| Compare | Bodies only | A wrapper and the method it wraps share a body under different parameter lists. The line diff still shows the signatures |
| Near-duplicate at | 85% alike, names set aside | The threshold the companion `cochange.py` uses |

## Getting the history

For each copy, with its first and last line numbers as they are now:

```sh
git log --no-patch --format='%h %cI %s' -L 1001,1034:httpx/_client.py
```

`-L` follows a range of lines back through every commit that changed it. Git's default log format also works, and
the patches `-L` prints without `--no-patch` are ignored. `--oneline` does not work: it has no dates, and the rule
below needs them.

## How it decides

**Alike.** Every identifier, string and number becomes a placeholder, so `get(url)` and `head(link)` are the same
code, and the two token streams are compared with Python difflib's ratio: twice the matched tokens over the total.
The matching is difflib's own algorithm, ported, with autojunk off, so this figure and `difflib` agree. Only the **body** is
compared, leaving out the signature (and in Python the docstring). Two functions at or above 85% alike are treated as
copies.

**Since both existed.** Only commits after the younger copy's first commit count. A change made while there was only
one copy is not a one-sided change, and counting it is the most common way a count like this goes wrong. A commit in
both listings is **together**; the rest are **only A** or **only B**.

⚠️ `git log -L` can reach back further than the copy. It follows lines, not functions: if the same lines used to be
something else, their history comes too. httpx's sync `Client._send_single_request` traces back into 2019, months
before httpx had a sync client again. When a history starts earlier than its copy, put the commit that made the copy
in **Count from**.

**Ignore** takes subject words (`format`, `lint`) and commit hashes, for sweeping commits that touched both copies
for reasons that say nothing about them: a reformat, a rename across the tree, a licence header.

**The answer** states one rule: fewer than 5 changes since both existed is too early to tell. Past that it gives the
count of one-sided changes and does not name the pair "mostly together" or "drifting apart", because the counts do
not settle that. Reading the one-sided commits does.

## What it cannot tell you

**Whether a one-sided change was a mistake.** One copy changing alone is either a missed update (the other copy needed
it too) or a sign the two do different jobs. Only reading the diff tells which. In httpx's two `_send_single_request`
methods, four of the seven one-sided changes were the copies falling out of step and three were cosmetic.

**Whether "together" means "the same".** A commit can touch both copies and change them differently. httpx's
`fd60b18` reformatted both proxy error messages in one commit and dropped the `f` prefix from one of them, which then
printed `{proxy.url.scheme!r}` literally for 18 months. The line diff is where that shows.

**How many files a commit touched**, which is what the companion `cochange.py` uses to set sweeping commits aside
automatically. Here they have to be named in **Ignore**.

Languages are lexed, not parsed. Python's tokens follow Python 3.12's `tokenize`, f-strings included. JavaScript and
TypeScript, and the C family, use one keyword list each; the C-family list is the union of C, C++, C#, Java, Go, Rust,
Kotlin and Swift, so a name that is a keyword in any of them is a keyword here. A template literal is one string.

## The samples

- **httpx: the two `_send_single_request`**: the sync and async copies at httpx `b5addb6`, counted from `e107e0f`,
  where the sync copy got its current name, with the 29-file `8e36f2b` ignored. 15 together, 1 only sync, 6 only async.
- **httpx: `httpx.get` and `Client.get`**: 88% alike in body, with 12 of 15 changes one-sided, 3 together.
- **Two retry helpers (made up)**: no history, to show the line diff on its own.
- **A history without dates**: what `--oneline` gets you.
