#!/usr/bin/env bash
#
# Release helper: bump manifest.json to the given version, commit, tag, and push
# the tag (which triggers .github/workflows/release.yml to build the .xpi and
# publish the GitHub release).
#
# Usage: bash release.sh v0.3.0   (the leading "v" is optional)
#
set -euo pipefail

raw="${1:-}"
if [ -z "$raw" ]; then
  echo "usage: $0 <version>   e.g. $0 v0.3.0" >&2
  exit 1
fi

version="${raw#v}"
tag="v${version}"

if ! printf '%s' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
  echo "error: '$raw' is not a stable X.Y.Z version like v0.3.0" >&2
  exit 1
fi

cd "$(dirname "$0")"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: run this helper from a Git checkout" >&2
  exit 1
fi
if ! git symbolic-ref --quiet HEAD >/dev/null; then
  echo "error: check out a branch before releasing" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "error: commit or stash working-tree changes before releasing" >&2
  exit 1
fi

# Reject an upstream or unrelated push target before modifying any files.
push_url="$(git remote get-url --push --all origin)"
python3 - "$push_url" <<'PY'
import json, re, sys
from urllib.parse import urlparse
with open("manifest.json", encoding="utf-8-sig") as source:
    manifest = json.load(source)
update_url = manifest["applications"]["zotero"]["update_url"]
match = re.fullmatch(r"https://github\.com/([^/]+/[^/]+)/releases/download/release/updates\.json", update_url)
if not match:
    raise SystemExit("error: expected a GitHub release update URL in manifest.json")
remote = sys.argv[1]
if remote.startswith("git@github.com:"):
    repository = remote.removeprefix("git@github.com:")
else:
    parsed = urlparse(remote)
    if parsed.scheme not in ("https", "ssh") or parsed.hostname != "github.com":
        raise SystemExit("error: origin must have a single GitHub HTTPS or SSH push URL")
    repository = parsed.path.lstrip("/")
repository = repository.removesuffix(".git").rstrip("/")
if repository.lower() != match[1].lower():
    raise SystemExit("error: origin push target differs from the manifest update repository")
PY
python3 scripts/verify.py
node --check bootstrap.js

if git show-ref --verify --quiet "refs/tags/$tag"; then
  echo "error: tag $tag already exists" >&2
  exit 1
fi
remote_tag="$(git ls-remote --exit-code --tags origin "refs/tags/$tag" || test "$?" -eq 2)"
if [ -n "$remote_tag" ]; then
  echo "error: remote tag $tag already exists" >&2
  exit 1
fi

# Bump manifest.json version (portable; preserves key order and 2-space indent).
python3 - "$version" <<'PY'
import json, sys
path = "manifest.json"
with open(path, encoding="utf-8-sig") as f:
    data = json.load(f)
data["version"] = sys.argv[1]
with open(path, "w", encoding="utf-8", newline="\n") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
echo "manifest.json version -> $version"

# Commit the bump only if it actually changed something.
if ! git diff --quiet -- manifest.json; then
  git add manifest.json
  git commit -m "Release $tag"
else
  echo "manifest.json already at $version; tagging existing commit"
fi

# Make sure the tagged commit exists on the remote, then push the tag.
git push origin HEAD
git tag "$tag"
git push origin "$tag"

echo "Pushed $tag. GitHub Actions will build the .xpi and publish the release."
