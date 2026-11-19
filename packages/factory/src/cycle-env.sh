# Sourced by every step of the factory DAGs (bash). Resolves the run's paths once:
# explicit params win; otherwise the A4S_* values from Dagu's base config `env:`
# (Dagu does not expand ${VAR} in param defaults, so this cannot live in the YAML).
PRIMARY="${PRIMARY:-${A4S_PRIMARY:-}}"
FACTORY="${FACTORY:-${A4S_FACTORY:-}}"
T3_HOME="${T3_HOME:-${A4S_T3_HOME:-}}"
STATE="${STATE:-${A4S_STATE:-}}"
for _p in PRIMARY FACTORY T3_HOME STATE; do
  if [ -z "${!_p}" ]; then
    echo "factory: $_p is empty; set A4S_$_p in Dagu's base config or pass $_p" >&2
    exit 1
  fi
done
unset _p
if [ -n "${ISSUE:-}" ]; then
  WT="$PRIMARY/.workspace/worktrees/issue-$ISSUE"
  BRANCH="factory/issue-$ISSUE"
  ISSUE_STATE="$STATE/$ISSUE"
fi
