# Salam, step 6: a worker and a timeout

The sixth step of the Salam example, which grows one tool through every part of toolbench. It adds one more answer, the number of distinct
orders the name's letters can be written in, and it counts them one at a time.

The formula, n! over the factorial of each repeated letter's count, gives the same number at once. The tool counts
anyway, so that its running time grows with the name: 4 letters take a few milliseconds, the 12 letters of
**فاطمة الزهراء** (Fatima al-Zahra) take about a second and a half, and 14 letters take far longer than the three seconds the manifest
allows. That is why this step declares `"thread": "worker"` and `"timeoutMs": 3000`: a run past the limit is
stopped, and the tool says so instead of freezing the page.

Try **جمال عبد الناصر** to see it stop.
