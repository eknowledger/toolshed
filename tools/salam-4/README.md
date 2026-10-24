# Salam, step 4: a manifest that says more

The fourth step of the Salam example, which grows one tool through every part of toolbench. The code is step 3's, unchanged. What changes is
the manifest and the fixtures:

- **Samples**, three example names under the form: one with a shadda, one in two words, and one in Latin letters,
  which the tool refuses. The refused one is the sample most worth shipping, because nobody types a broken input
  on purpose.
- **A live card**: `"card": "live"`, with the name marked `primary`, so a compact card shows the name and Run.
- **Links**, help text and tags, which the page around the tool shows.
- **Six fixtures** in `cases.json`, each an input and the exact result it must give, including both errors.

The letters, pieces and bytes are explained in step 3's help.
