# Salam, step 3: more than one answer

The third step of the Salam example, which grows one tool through every part of toolbench. The greeting is still the first thing in the
result, and four more parts follow it in one `group`:

1. **The greeting**, as `text`.
2. **The counts**, as `fields`: letters, the pieces the name is written in, and the UTF-8 bytes it takes.
3. **Letter by letter**, as a `table`: each letter's name, code point, UTF-8 bytes, and whether it joins the next.
4. **The bytes**, as `bytes`, with one highlighted run per letter.

A piece is a run of letters written joined. Six letters never join the letter after them: **ا د ذ ر ز و**, with
the hamza forms of alif and waw and ta marbuta, and a hamza on its own joins neither neighbour. So **أحمد** is
written in two pieces, **أ** and **حمد**.

A short vowel or a shadda is not a letter: it is counted with the letter it sits on, and costs two more bytes.
