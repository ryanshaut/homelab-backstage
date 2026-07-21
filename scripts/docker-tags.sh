#!/usr/bin/env bash
set -euo pipefail

# Generates Docker tags from Git state.
#
# Rules:
# 1) Exact semver tag (vX.Y.Z on HEAD):
#    - X.Y.Z
#    - X.Y
#    - latest
#    - sha-<shortsha>
# 2) Otherwise:
#    - infer next patch from latest semver tag (or 0.1.0 when no tags exist)
#    - emit a dev tag with commit count and branch hint
#    - emit branch channel tag and sha tag

latest_semver_tag() {
  git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n 1
}

is_semver_tag() {
  [[ "${1:-}" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]
}

sanitize_branch() {
  local raw="$1"
  echo "$raw" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's#[^a-z0-9._-]+#-#g; s#^-+##; s#-+$##'
}

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"
if [[ "$branch" == "HEAD" ]]; then
  branch="detached"
fi
branch="$(sanitize_branch "$branch")"
sha="$(git rev-parse --short=12 HEAD 2>/dev/null || echo nogit)"

exact_tag="$(git describe --tags --exact-match 2>/dev/null || true)"
latest_tag="$(latest_semver_tag || true)"

if is_semver_tag "$exact_tag"; then
  version="${exact_tag#v}"
  major_minor="$(echo "$version" | cut -d. -f1,2)"

  {
    echo "$version"
    echo "$major_minor"
    echo "latest"
    echo "sha-$sha"
  } | awk '!seen[$0]++'
  exit 0
fi

if is_semver_tag "$latest_tag"; then
  # shellcheck disable=SC2001
  latest_no_v="$(echo "$latest_tag" | sed 's/^v//')"
  major="$(echo "$latest_no_v" | cut -d. -f1)"
  minor="$(echo "$latest_no_v" | cut -d. -f2)"
  patch="$(echo "$latest_no_v" | cut -d. -f3)"
  next_patch="$((patch + 1))"
  base_version="$major.$minor.$next_patch"
  commits_since_tag="$(git rev-list "$latest_tag"..HEAD --count 2>/dev/null || echo 0)"
else
  base_version="0.1.0"
  commits_since_tag="$(git rev-list HEAD --count 2>/dev/null || echo 0)"
fi

if [[ "$branch" == "main" || "$branch" == "master" ]]; then
  dev_version="$base_version-dev.$commits_since_tag"
  branch_channel="edge"
else
  dev_version="$base_version-dev.$commits_since_tag-$branch"
  branch_channel="branch-$branch"
fi

{
  echo "$dev_version"
  echo "$branch_channel"
  echo "sha-$sha"
} | awk '!seen[$0]++'
