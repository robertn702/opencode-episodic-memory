#!/usr/bin/env bash
# Verify the actual publish artifact before `npm publish`: pack the tarball,
# install it into a clean dir exactly the way OpenCode installs npm plugins
# (bun install, postinstalls untrusted), then import the plugin entry and run
# a real embedding. This is the check that caught @opencode-ai/plugin being a
# devDependency — dependency-placement bugs only surface from a clean install.
set -euo pipefail

cd "$(dirname "$0")/.."

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "== npm pack =="
TGZ=$(npm pack --pack-destination "$WORK" | tail -1)
echo "packed: $TGZ"

mkdir -p "$WORK/cache"
cat > "$WORK/cache/package.json" <<EOF
{ "dependencies": { "opencode-episodic-memory": "file:$WORK/$TGZ" } }
EOF

echo "== clean install =="
(cd "$WORK/cache" && bun install --silent)

echo "== import plugin entry =="
(cd "$WORK/cache" && bun -e "
const m = await import('opencode-episodic-memory');
if (typeof m.EpisodicMemory !== 'function') throw new Error('EpisodicMemory export missing');
console.log('exports ok:', Object.keys(m).join(', '));
")

echo "== opencode server-entrypoint resolution =="
# Mirrors the resolution OpenCode's plugin loader performs (./server export,
# then main). Without this, a package can import fine yet be silently skipped
# by OpenCode. Run against the clean-installed artifact, not the repo source.
bun run spikes/verify-opencode-entrypoint.ts "$WORK/cache/node_modules/opencode-episodic-memory"

echo "== embed smoke (downloads ~110MB model on first run) =="
(cd "$WORK/cache" && bun -e "
const { embedQuery } = await import('./node_modules/opencode-episodic-memory/src/embed.ts');
const [v] = await embedQuery('pack smoke test');
const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
if (v.length !== 768 || Math.abs(norm - 1) > 1e-3) {
  throw new Error('bad embedding: dims=' + v.length + ' norm=' + norm);
}
console.log('embed ok: dims', v.length, 'norm', norm.toFixed(4));
")

echo "PACK SMOKE OK"
