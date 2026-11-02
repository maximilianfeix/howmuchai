#!/usr/bin/env bash
# Commits and pushes the data checkout. Never force-pushes: on a rejected push it rebases onto the
# remote and tries again (up to 5 times). A real conflict aborts with a non-zero exit, so a
# workflow failure (and its alert) is the result, never lost data.
#   scripts/push-data.sh <data-dir> <commit message>
set -euo pipefail
dir="$1"; msg="$2"
cd "$dir"
git config user.name >/dev/null || git config user.name "github-actions[bot]"
git config user.email >/dev/null || git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
if git diff --cached --quiet; then
  echo "no data changes"
  exit 0
fi
git commit -q -m "$msg"
branch=$(git rev-parse --abbrev-ref HEAD)
for attempt in 1 2 3 4 5; do
  if git push -q origin "HEAD:$branch"; then
    echo "pushed on attempt $attempt"
    exit 0
  fi
  echo "push rejected, rebasing (attempt $attempt)"
  git fetch -q origin "$branch"
  if ! git rebase -q "origin/$branch"; then
    git rebase --abort || true
    echo "::error::data branch conflict that cannot be rebased; nothing was pushed" >&2
    exit 1
  fi
  sleep $((attempt * 2))
done
echo "::error::could not push data after 5 attempts" >&2
exit 1
