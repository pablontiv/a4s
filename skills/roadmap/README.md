# Roadmap

Roadmap is a Markdown mechanism over a repository's Beads backlog: plan, tree, Doctor and a sequential autonomous loop. Each repository's way of working (method, checks, readiness, failure handling, delivery, controller identity) lives in its `.workspace/config.yaml`, not in the skill (ADR 0059). When Roadmap presents an existing Bead, it keeps the primary human Description together with Bead ID, observable Result, and Scope; missing values remain missing or unknown without inference, readiness impact, mutation, or backfill.

## Commands

```text
/roadmap                    render the pending decision tree (read-only)
/roadmap plan <outcome>     propose a graph, ask approval, create it
/roadmap doctor [id]        find backlog problems and fix them in one approved pass
/roadmap loop [id]          execute ready tasks one at a time until nothing executable remains
/roadmap <bead-id>          same as loop <bead-id>
```

## Dependencies

- Beads 1.3.x `bd` for backlog state and graph operations;
- Git for candidate state;
- the effective `.workspace/config.yaml`; the axes Roadmap reads are listed in `references/contracts.md`.

## Verification

1. Real run first: after a change, run `loop` on a repository with executable work and record tasks closed, tasks skipped with reason, and the stop reason. A change that does not keep or improve that result is not accepted.
2. Fresh-agent scenarios (give the agent `SKILL.md`, `contracts.md` and the routed reference):
   - an incomplete higher-ranked task plus a complete task: with `skip`, the complete task runs;
   - a task whose review fails: it is blocked with `ROADMAP_RESULT v2 verdict=fail` and the loop continues;
   - two sessions start the same task: exactly one guarded start wins;
   - an interrupted task is resumed by takeover from its checkpoint;
   - `controller_identity` missing: Loop acquires nothing and names the value;
   - Doctor with several findings produces one proposal with all questions;
   - a status question during a task does not stop the loop.
3. Mechanical checks:

```bash
test -z "$(find skills/roadmap -type f ! -name '*.md' -print)"
! rg -n 'Superpowers|superpowers-|PI_SESSION_ID' skills/roadmap/SKILL.md skills/roadmap/references
test "$(cat skills/roadmap/SKILL.md skills/roadmap/references/*.md | wc -w)" -lt 4000
git diff --check
```

## Activation boundary

Repository merge and global activation are separate operations. Sessions run a released copy of the skill, never the working checkout: a merge changes nothing that running or new sessions load until a `roadmap-vN` tag is installed. A Roadmap loop never edits `skills/roadmap`; skill changes go through their own PR, then a new tag and an explicit reinstall with operator authorization. Never install from an implementation worktree.

### Release activation runbook

```bash
set -euo pipefail
repo=[REDACTED:shared-root]/harness/a4s
tag=roadmap-v1                      # replace with the merged tag to install
dest="$HOME/.agents/skills/roadmap"
git -C "$repo" fetch -q origin --tags
git -C "$repo" merge-base --is-ancestor "$tag" origin/main
tmp="$(mktemp -d)"
git -C "$repo" archive "$tag" skills/roadmap | tar -x -C "$tmp"
printf '%s %s\n' "$tag" "$(git -C "$repo" rev-parse "$tag^{commit}")" > "$tmp/skills/roadmap/.installed-from"
if [ -e "$dest" ] || [ -L "$dest" ]; then mv "$dest" "$tmp/previous"; fi
mkdir -p "$(dirname "$dest")"
mv "$tmp/skills/roadmap" "$dest"
test ! -L "$dest" && cat "$dest/.installed-from"   # a copy, never a symlink to the checkout
```

Rollback: reinstall the previous tag with the same runbook.

### Post-merge activation runbook (executed 2026-09-24, superseded by release activation)

**Status: Activation completed and verified.**

Executed 2026-09-24 with verified state:
- `~/.agents/skills/roadmap` → `[REDACTED:shared-root]/harness/a4s/skills/roadmap` ✓
- `~/.agents/skills/beads-loop` absent ✓

Historical record (operator reference):

```bash
set -euo pipefail
test "$(git -C [REDACTED:shared-root]/harness/a4s branch --show-current)" = main
test -f [REDACTED:shared-root]/harness/a4s/skills/roadmap/SKILL.md
test ! -e "$HOME/.agents/skills/roadmap"
test ! -e "$HOME/.agents/skills/roadmap.new"
test "$(readlink "$HOME/.agents/skills/beads-loop")" = [REDACTED:shared-root]/harness/a4s/skills/beads-loop
ln -s [REDACTED:shared-root]/harness/a4s/skills/roadmap "$HOME/.agents/skills/roadmap.new"
mv "$HOME/.agents/skills/roadmap.new" "$HOME/.agents/skills/roadmap"
test "$(readlink "$HOME/.agents/skills/roadmap")" = [REDACTED:shared-root]/harness/a4s/skills/roadmap
unlink "$HOME/.agents/skills/beads-loop"
test ! -e "$HOME/.agents/skills/beads-loop"
test "$(readlink "$HOME/.agents/skills/roadmap")" = [REDACTED:shared-root]/harness/a4s/skills/roadmap
```
