#!/bin/sh
# test/ci-local.sh: Run all applicable CI steps locally (non-Windows only)
# Mirrors .github/workflows/ci.yml and .github/workflows/test-model-optimizer.yml
# Prints PASS/FAIL for each step and exits non-zero if any step fails

set -u

# Track results
RESULTS=""
FAILED_STEPS=0
TOTAL_STEPS=0

# Helper function to run a step and track result
run_step() {
    step_name="$1"
    shift

    TOTAL_STEPS=$((TOTAL_STEPS + 1))
    echo ""
    echo "==== Step $TOTAL_STEPS: $step_name ===="

    if "$@"; then
        echo "✓ PASS: $step_name"
        RESULTS="${RESULTS}PASS | $step_name\n"
    else
        exit_code=$?
        echo "✗ FAIL: $step_name (exit code: $exit_code)"
        RESULTS="${RESULTS}FAIL | $step_name\n"
        FAILED_STEPS=$((FAILED_STEPS + 1))
    fi
}

# Helper function to check if a command exists
check_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "✗ FAIL: Required command not found: $1"
        echo "Please ensure $1 is installed and in PATH"
        return 1
    fi
}

echo "=== CI Local Test Suite ==="
echo "Running on $(uname -s)"
echo ""
echo "NOTE: Install steps are replaced by verification-only steps."
echo "NOTE: Windows steps are skipped on non-Windows platforms."
echo ""

# Check for required tools
echo "Checking required tools..."
check_command node || exit 1
check_command npm || exit 1
check_command python3 || exit 1
check_command rootline || exit 1
check_command sh || exit 1
echo "✓ All required tools found"
echo ""

# Store the repo root (parent of parent of test directory)
REPO_ROOT="$(cd "$(dirname "$0")" && cd .. && pwd)" || { echo "✗ FAIL: cannot compute REPO_ROOT"; exit 1; }

# Change to repo root for all commands
cd "$REPO_ROOT" || { echo "✗ FAIL: cannot cd to $REPO_ROOT"; exit 1; }

# Step 1: Install Node dependencies
run_step "Install Node dependencies" npm ci

# Step 2: Test runtime (macOS/Linux only)
run_step "Test runtime" npm test

# Step 3: Typecheck runtime
run_step "Typecheck runtime" npm run typecheck

# Step 4: Verify Python test dependencies (no install - verify only)
run_step "Verify Python test dependencies" sh -c '
    failed=0
    while IFS= read -r line; do
        line=$(echo "$line" | xargs)
        [ -z "$line" ] && continue
        if ! python3 -c "import importlib.metadata; pkg='\''${line%%==*}'\''; ver='\''"${line##*==}"'\''; assert importlib.metadata.version(pkg) == ver, f\"Expected {ver}, got {importlib.metadata.version(pkg)}\"" 2>/dev/null; then
            echo "✗ Requirement not met: $line"
            failed=1
        else
            echo "  ✓ $line"
        fi
    done < requirements-test.txt
    [ "$failed" -eq 0 ]
'

# Step 5: Verify pinned Rootline (no install - verify only)
run_step "Verify pinned Rootline" sh -c '
    echo "Rootline on PATH:"
    command -v rootline
    echo ""
    echo "Rootline version:"
    rootline --version
    echo ""
    echo "(CI pins commit 14ee8aa4d5067c7ff6d0708d79e3aaebf27b7a56)"
'

# Step 6: Test repository contract
run_step "Test repository contract" \
    python3 -m unittest discover -s test -p "test_*.py" -v

# Step 7: Test profile contract
run_step "Test profile contract" \
    python3 -m unittest discover -s profiles/pablontiv/tests -t profiles/pablontiv -p "test_*.py" -v

# Step 8: Test ADR workspace
run_step "Test ADR workspace" \
    python3 -m unittest discover -s skills/adr/tests -t skills/adr -p "test_*.py" -v

# Step 9: Test GitHub communication style
run_step "Test GitHub communication style" \
    python3 -m unittest discover -s skills/gh-communication-style/tests -t skills/gh-communication-style -p "test_*.py" -v

# Step 10: Validate governed knowledge
run_step "Validate governed knowledge" \
    sh -c 'rootline validate --all .workspace/docs -o json && rootline validate --all profiles/pablontiv -o json'

# Step 11: Test agent behavior doctor
run_step "Test agent behavior doctor" \
    python3 -m unittest discover -s skills/agent-behavior-doctor/tests -t skills/agent-behavior-doctor -p "test_*.py" -v

# Step 12: Test systemic issue triage
run_step "Test systemic issue triage" \
    python3 -m unittest discover -s skills/systemic-issue-triage/tests -t skills/systemic-issue-triage -p "test_*.py" -v

# Step 13: Test context-save
run_step "Test context-save" \
    python3 -m unittest discover -s skills/context-save/tests -t skills/context-save -p "test_*.py" -v

# Step 14: Test sweep
run_step "Test sweep" \
    python3 -m unittest discover -s skills/sweep/tests -t skills/sweep -p "test_*.py" -v

# Step 15: Test Mission Control health
run_step "Test Mission Control health" \
    python3 -m unittest discover -s skills/mission-control-health/tests -t skills/mission-control-health -p "test_*.py" -v

# Step 16: Test Herdr heartbeat H2 and reconciler
run_step "Test Herdr heartbeat H2 and reconciler" \
    python3 -m unittest discover -s skills/herdr/tests -t skills/herdr -p "test_*.py" -v

# Step 17: Test sweep assets
run_step "Test sweep assets" \
    sh skills/sweep/assets/test-assets.sh

# Step 18: Test context cleanup
run_step "Test context cleanup" \
    sh -c 'cd skills/remove-gentle-context && python3 -m unittest discover -s tests -t . -v'

# Step 19: Compile context cleanup CLI
run_step "Compile context cleanup CLI" \
    sh -c 'cd skills/remove-gentle-context && python3 -m py_compile scripts/cleanup.py'

# Step 20: Check context cleanup CLI
run_step "Check context cleanup CLI" \
    sh -c 'cd skills/remove-gentle-context && python3 scripts/cleanup.py --help'

# Step 21: Test model-optimizer (from test-model-optimizer.yml)
run_step "Test model-optimizer" \
    python3 -m unittest discover -s skills/model-optimizer/tests -t skills/model-optimizer -p "test_*.py" -v

# Step 21: Test Docs Northstar
run_step "Test Docs Northstar" \
    python3 -m unittest discover -s skills/docs-northstar/tests -t skills/docs-northstar -p "test_*.py" -v

# Print summary
echo ""
echo "=========================================="
echo "         PASS/FAIL SUMMARY TABLE"
echo "=========================================="
printf "Status | Step\n"
printf "%s\n" "-------|------"
printf '%b' "$RESULTS"
echo "=========================================="
echo "Total: $TOTAL_STEPS | Passed: $((TOTAL_STEPS - FAILED_STEPS)) | Failed: $FAILED_STEPS"
echo "=========================================="
echo ""

if [ "$FAILED_STEPS" -eq 0 ]; then
    echo "✓ All steps passed"
    exit 0
else
    echo "✗ $FAILED_STEPS step(s) failed"
    exit 1
fi
