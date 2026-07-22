// Example known-answer test set. Copy to eval/queries.ts (gitignored) and fill
// in YOUR OWN: ~15 queries whose correct target session you know from your
// indexed history (get session IDs via `bun run src/cli.ts stats` / search),
// plus 3+ negative controls — topics NOT in your corpus, where a good model
// returns low, well-separated scores.
//
// `expect` = session IDs whose appearance in top-k counts as a hit (list
// forks/duplicates of the same conversation too). `negative: true` marks
// off-corpus controls.
export interface TestQuery {
  q: string;
  expect?: string[]; // session ids
  negative?: boolean;
}

export const QUERIES: TestQuery[] = [
  // Positives: natural-language topic queries -> known session id(s)
  { q: "how we fixed the login redirect loop", expect: ["ses_XXXXXXXXXXXXXXXXXXXXXXXX"] },
  { q: "database migration strategy discussion", expect: ["ses_YYYYYYYYYYYYYYYYYYYYYYYY"] },
  { q: "choosing a naming scheme for worktrees", expect: ["ses_ZZZZZZZZZZZZZZZZZZZZZZZZ"] },
  // ...aim for ~15 covering distinct topics/projects...

  // Negatives: topics that are NOT in your history
  { q: "kubernetes ingress migration", negative: true },
  { q: "fine-tuning a diffusion model on TPUs", negative: true },
  { q: "sourdough starter feeding schedule", negative: true },
];
