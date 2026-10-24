# Salam, step 1: hello

The first step of the Salam example, which grows one tool through every part of toolbench: a tool in its smallest form. It takes a name and
answers **أهلاً يا** followed by the name: "welcome", with the vocative **يا** that Arabic puts before a name when
it calls someone.

Nothing in this directory builds the form, the Run button or the result. The manifest declares one text input and
two result kinds, `text` and `error`, and the framework draws the rest. The `error` is there from the first step
because the validator insists on it: every tool can be given bad input, and an empty name is this one's.
