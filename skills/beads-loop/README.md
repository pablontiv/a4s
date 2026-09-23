# Beads autonomous loop verification

`SKILL.md` is the operational agent workflow. This document is a human-run verification procedure for a disposable repository; provider commands below are fixture setup and inspection only.

## Read-only Pi dispatch smoke probe

From the A4S repository root, run either explicit mode:

```sh
python3 skills/beads-loop/tests/smoke_pi_dispatch.py --print
python3 skills/beads-loop/tests/smoke_pi_dispatch.py --headed
```

`--print` starts an offline, sessionless Pi process with only this skill loaded, asks it to execute the adapter's read-only `prime` command, and succeeds only when the last non-empty stdout line is a versioned terminal JSON envelope. `--headed` starts the same isolated Pi configuration in a PTY, dispatches `/skill:beads-loop`, waits only for the `Beads Autonomous Loop` heading, and then interrupts Pi before the workflow runs. Neither mode selects or claims work, finalizes a Bead, or changes provider state. Captured stdout, stderr, and PTY transcript data exist only below a `tempfile.TemporaryDirectory()` for the duration of the probe.

## Disposable two-terminal procedure

Start in this A4S checkout and prepare an absolute adapter path plus a temporary target repository:

```sh
A4S_ROOT="$(git rev-parse --show-toplevel)"
BEADS_LOOP_ADAPTER="$(cd "$A4S_ROOT/skills/beads-loop/scripts" && pwd -P)/beads_loop.py"
case "$BEADS_LOOP_ADAPTER" in /*) ;; *) echo "adapter path is not absolute" >&2; exit 1;; esac

TARGET="$(mktemp -d)"
git -C "$TARGET" init -q
git -C "$TARGET" config user.name race-worker
git -C "$TARGET" config user.email race@example.test
(
  cd "$TARGET" &&
  bd init --non-interactive --skip-agents --skip-hooks --prefix manual
)
PASS_ID="$(cd "$TARGET" && bd create "manual pass" --priority 0 --silent \
  --description "Complete the disposable pass verification." \
  --acceptance "The pass finalization records repository-relative evidence.")"
printf 'TARGET=%s\nBEADS_LOOP_ADAPTER=%s\nPASS_ID=%s\n' \
  "$TARGET" "$BEADS_LOOP_ADAPTER" "$PASS_ID"
```

Copy the three printed values into both terminals and export the same actor:

```sh
export TARGET="..."
export BEADS_LOOP_ADAPTER="..."
export PASS_ID="..."
export BEADS_ACTOR="race-worker"
cd "$TARGET"
```

Run this command concurrently in terminal A and terminal B:

```sh
python3 "$BEADS_LOOP_ADAPTER" claim
```

Exactly one envelope must have `kind: "claimed"` for `PASS_ID`; the other must have `kind: "no_ready"`. Both commands run with the disposable target as CWD while invoking the adapter by its absolute path.

In either terminal, record pass evidence and finalize the claimed Bead:

```sh
mkdir -p reports/beads-loop
printf 'PASS: manual validation completed.\n' > reports/beads-loop/pass.md
python3 "$BEADS_LOOP_ADAPTER" finalize \
  --bead "$PASS_ID" \
  --verdict pass \
  --evidence reports/beads-loop/pass.md
bd show "$PASS_ID" --json
```

The final envelope and inspection must show `status: "closed"`, the `race-worker` assignee, and notes containing `PASS evidence=reports/beads-loop/pass.md`.

Create and claim a second Bead, then exercise evidence-bound failure:

```sh
FAIL_ID="$(bd create "manual fail" --priority 0 --silent \
  --description "Complete the disposable fail verification." \
  --acceptance "The fail finalization records repository-relative evidence.")"
python3 "$BEADS_LOOP_ADAPTER" claim
printf 'FAIL: intentional manual verification failure.\n' > reports/beads-loop/fail.md
python3 "$BEADS_LOOP_ADAPTER" finalize \
  --bead "$FAIL_ID" \
  --verdict fail \
  --evidence reports/beads-loop/fail.md
bd show "$FAIL_ID" --json
```

The final envelope and inspection must show `status: "blocked"`, the `race-worker` assignee, and notes containing `FAIL evidence=reports/beads-loop/fail.md`.

Finally, verify the terminal state:

```sh
python3 "$BEADS_LOOP_ADAPTER" prime
```

The envelope must have `kind: "no_ready"`. Remove the disposable target when inspection is complete:

```sh
rm -rf "$TARGET"
```
