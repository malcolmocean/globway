#!/usr/bin/env bash
# Pull Mark's latest source into protocol-source/ and show what changed.
#
# v1 keeps the upstream markdown VENDORED under protocol-source/ (see the design
# doc for the eventual three-branch upstream/upstreamable/site model). This script
# refreshes the vendored copy and reports the diff so you + an agent can re-apply
# any curation that the changes affect. Content identity is anchor-keyed, so most
# updates need no re-curation — only sections whose anchors changed.
set -euo pipefail

UPSTREAM="${1:-https://github.com/meditationstuff/protocol_1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Cloning $UPSTREAM ..."
git clone --depth 1 "$UPSTREAM" "$TMP/up" >/dev/null 2>&1
NEW_COMMIT="$(git -C "$TMP/up" rev-parse HEAD)"
OLD_COMMIT="$(cat "$ROOT/protocol-source/UPSTREAM_COMMIT.txt" 2>/dev/null || echo none)"

echo "Old upstream: $OLD_COMMIT"
echo "New upstream: $NEW_COMMIT"

# Refresh vendored markdown + build inputs
cp "$TMP"/up/*.md "$ROOT/protocol-source/"
cp "$TMP"/up/header.html "$ROOT/protocol-source/" 2>/dev/null || true
echo "$NEW_COMMIT" > "$ROOT/protocol-source/UPSTREAM_COMMIT.txt"

echo
echo "Regenerating content + checking for anchor changes ..."
( cd "$ROOT" && node scripts/build-content.mjs )

echo
echo "Done. Review changes with: git -C \"$ROOT\" diff -- protocol-source"
echo "Then rebuild the site (npm run build) and re-apply curation where needed."
