# Repo Sharing Guide

This guide covers the two repo-polish tasks that should not be automated blindly on a live public repository:

1. rewriting git history to remove previously committed secret-bearing files
2. choosing and adding the final repository license

## 1. History Scrub Guide

Use this only if you are ready to rewrite the public history of `main`.

### What this changes

- rewrites commit SHAs
- invalidates old branch bases, links, and local clones
- requires a force-push to GitHub

### Sensitive paths to remove from history

- `.env`
- `docs/Flow Frontend/.env`
- `docs/verification/bearer-proof-env.sh`
- `docs/verification/bearer-proof-env.json`

### Recommended workflow

1. Rotate any exposed credentials first.
2. Make sure no one else is actively pushing to the repo.
3. Create a fresh mirror clone.
4. Run `git-filter-repo` against the mirror clone.
5. Force-push the rewritten history back to GitHub.
6. Have every collaborator re-clone or hard-reset to the new history.

### Suggested commands

```bash
brew install git-filter-repo
git clone --mirror https://github.com/<you>/Flow.git Flow-history-clean.git
cd Flow-history-clean.git
git filter-repo \
  --path .env --invert-paths \
  --path "docs/Flow Frontend/.env" --invert-paths \
  --path docs/verification/bearer-proof-env.sh --invert-paths \
  --path docs/verification/bearer-proof-env.json --invert-paths
git push --force --mirror origin
```

### After the rewrite

- Open GitHub and confirm `main` still points to the expected latest commit.
- Re-run CI.
- Re-create or refresh any open local branches.

## 2. License Selection Guide

This repository is currently marked `UNLICENSED` in package metadata to avoid granting rights by accident before you choose a real public license.

### Common choices

- `MIT`: simplest and most permissive
- `Apache-2.0`: permissive, but includes explicit patent language
- `All rights reserved / private`: no public reuse rights granted

### Recommended decision rule

- Choose `MIT` if your goal is portfolio visibility and low-friction reuse.
- Choose `Apache-2.0` if you want a more formal open-source license with patent language.
- Stay effectively private if you want employers to read the code but not reuse it.

### After you choose

1. Add a root `LICENSE` file with the selected text.
2. Replace `UNLICENSED` in both package files with the real SPDX identifier.
3. Mention the license once in the root README if you want that visible immediately.
