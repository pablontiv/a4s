# Changelog

## Unreleased

- Keep full station inventory, per-run HTTP/git work and process probes, artifact
  verification and recursive cache deletion outside `.state.lock`. Recheck the
  state envelope before promotion, rollback or collection commits; detach
  collected builds atomically before deleting them. Resolve first-tick history
  and process identity before committing bindings and leases (#913).
- Re-derive station decisions under the lock from current lease/tick records,
  receipt contract fields and SQLite schema/payload versions (including WAL).
  Compatible observer leases, observation rewrites and role-job row churn no
  longer invalidate promotion, rollback or GC preparation. Config Git/ref inputs
  must still match their prepared proof. Receipt stat tuples only trigger refreshes:
  unchanged files reuse prepared fields; new/rewritten receipts are parsed, and
  removed receipts drop their readers. GC retains new/changed receipts as possible
  readers regardless of the unlocked Dagu summary. Promotion and rollback keep
  their existing reader eligibility. Rechecks have a one-second total budget and
  fail closed with a retryable error. All Dagu HTTP, Git subprocesses and executable
  hashing stay outside the lock; GC terminal proof comes from the prepared list (#913).
- Keep receipt-referenced caches when a run is missing or might still resume
  after failure/abort, even after the pending-admission window. Only verified
  terminal readers or explicitly released admissions can stop retaining them.
- Read atomically committed `state.json` without an exclusive lock for advisory
  observers and selection snapshots. Locked activation/commit paths still repair
  derived resource links and recheck generation, receipt and cache metadata.
- Report elapsed lock wait and every distinct acquisition record observed during
  timeout polling. Acquisition metadata is diagnostic, not proof that the last
  acquirer still owns the lock; the default deadline remains 10 seconds.
