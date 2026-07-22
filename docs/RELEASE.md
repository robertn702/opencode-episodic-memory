# Release guide

Semver while 0.x: breaking changes bump minor, fixes bump patch.

## Checklist

1. `git checkout main && git pull` — clean tree.
2. Bump `version` in `package.json`.
3. `bun install && bun run typecheck && bun test && bun run spikes/plugin-harness.ts`
   (`prepublishOnly` also runs typecheck + tests as a backstop).
4. `bash spikes/pack-smoke.sh` — packs the tarball and verifies it installs
   and embeds from a clean dir, the way OpenCode installs npm plugins. First
   run on a machine downloads the ~110MB model.
5. `npm publish` (first time: `npm login` first).
6. `git tag vX.Y.Z && git push origin vX.Y.Z`
7. `gh release create vX.Y.Z --generate-notes`

## After publishing

- Dogfood: swap the local-path plugin entry in
  `~/.config/opencode/opencode.json` for the bare package name, restart
  OpenCode, run an `episodic_search`.
- If the embedding model or a transformers.js major changed, state
  index-validity in the release notes (cosine-verified compatible, or
  "rebuild required").

## Optional future hardening

Configure npm trusted publishing (OIDC) + a GitHub Actions publish workflow
once release cadence justifies it; skip changesets — overkill for a single
0.x package.
