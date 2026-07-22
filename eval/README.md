# eval/ — embedding model comparison harness

Reproduces the evaluation behind the current model choice
(see [docs/embedding-model-eval.md](../docs/embedding-model-eval.md)). Use it
before any future model swap.

## Setup

1. `cp eval/queries.example.ts eval/queries.ts` and fill in ~15 known-answer
   queries against YOUR indexed history (session IDs from `bun run src/cli.ts
   search` / `stats`), plus 3+ off-corpus negative controls. `queries.ts` is
   gitignored — it references your private sessions.
2. `bun run eval/build-corpus.ts` — snapshots your history into
   `eval/corpus.json` (gitignored) using the exact production chunking, so all
   candidates see identical chunks.

## Run

```bash
bun run eval/run-model.ts <modelKey>   # one per candidate, see eval/models.ts
```

Each run loads the model (q8), embeds the full corpus (reports ms/chunk), runs
the test set, and writes `eval/results-<modelKey>.json`. Compare with your
favorite script: top-1/top-3 hit rate over positives, and worst-case
separation = (min top-1 score across true hits) − (max score across negatives).

Add new candidates to `eval/models.ts` — get doc/query prefixes and pooling
from the model's official card, and verify an ONNX q8 export actually exists
in the repo (don't trust "transformers.js" tags alone; load it once).
