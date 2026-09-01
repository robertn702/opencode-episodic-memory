# Release guide

Semver while 0.x: breaking changes bump minor, fixes bump patch.

## Checklist

1. `git checkout main && git pull` — clean tree.
2. Bump `version` in `package.json`.
3. `bun install && bun run typecheck && bun test && bun run spikes/plugin-harness.ts`
   (`prepublishOnly` remains a backstop for manual directory publishes; the
   workflow publishes a preverified tarball and runs these gates explicitly).
4. `bash spikes/pack-smoke.sh` — packs the tarball and verifies it cleanly
   installs, imports, and executes the packaged Node-sidecar embedding from a
   clean dir. First run on a machine downloads the ~110MB model.
5. Commit the version bump and push the reviewed commit to `main`.
6. `git tag vX.Y.Z && git push origin vX.Y.Z` — the tag must exactly match
   `package.json`. `.github/workflows/publish-npm.yml` repeats all release gates,
   publishes through npm Trusted Publishing, then creates the GitHub release.
7. `gh run watch` — confirm both the `publish` and `release` jobs succeed.

## One-time trusted publishing setup

The workflow uses GitHub Actions OIDC and must not have an npm token or
`NODE_AUTH_TOKEN`. Configure the npm package's Trusted Publisher with:

- Provider: GitHub Actions
- Organization/user: `robertn702`
- Repository: `opencode-episodic-memory`
- Workflow filename: `publish-npm.yml`
- Environment: `npm-publish`
- Permitted action: `npm publish`

The equivalent npm CLI command requires npm 11.15.0 or newer, package write
access, account-level 2FA, and a supported interactive authentication method:

```bash
npx npm@^11.15.0 trust github opencode-episodic-memory \
  --file publish-npm.yml \
  --repo robertn702/opencode-episodic-memory \
  --env npm-publish \
  --allow-publish \
  --registry https://registry.npmjs.org \
  --yes
```

Before pushing a release tag, apply these GitHub repository controls:

1. Create the `npm-publish` environment, disable administrator bypass, require
   the release maintainer's approval, and restrict deployment to selected tags
   matching `v*`, with no branch rule. This is intentionally a solo-maintainer
   confirmation gate, so self-approval remains enabled; it is not an independent
   review control.
2. Protect `v*` tag creation, updates, deletion, and non-fast-forward changes.
   Bypass access should be limited to repository administrators who cut releases.
3. Protect `main` from deletion and force pushes and require changes through a
   pull request.
4. Restrict Actions to `actions/*` and `oven-sh/setup-bun`, and require actions
   to be pinned to full commit SHAs.

The workflow checks out the immutable triggering commit, validates the tag,
package identity, repository URL, and registry, and gives `contents: write`
only to the post-publish GitHub release job. It publishes a single prepacked
tarball and compares its exact `dist.integrity` against registry.npmjs.org.
If npm accepts a version but the client loses the response, rerunning the
workflow safely continues only when the registry integrity matches; a mismatch
fails without creating a GitHub release. Before creating or accepting an
existing GitHub release, the workflow also peels the current tag and verifies
that it still resolves to the exact commit that produced the npm artifact.

## After publishing

- Dogfood: update the plugin entry in `~/.config/opencode/opencode.json` to
  the just-published version — `"opencode-episodic-memory@X.Y.Z"` — then
  restart OpenCode and run an `episodic_search`. The version MUST be pinned:
  OpenCode's npm plugin cache short-circuits on any existing install and
  never re-resolves a bare name / `@latest` (upstream bug
  anomalyco/opencode#25293; even `--force` doesn't help), so an unpinned
  entry silently runs the first version ever installed.
- If the embedding model or a transformers.js major changed, state
  index-validity in the release notes (cosine-verified compatible, or
  "rebuild required").
- Keep semantic embedding in the default Node 20+ sidecar. Do not change the
  default to `EPISODIC_EMBED_MODE=inline`: affected OpenCode/Bun hosts can crash
  during native-addon shutdown when Transformers.js loads in the embedded Bun
  process.

Do not add changesets; they remain unnecessary for a single 0.x package.
