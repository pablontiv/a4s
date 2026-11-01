# Changelog

## Unreleased

- Keep full station inventory, per-run HTTP/git work and process probes, artifact
  verification and recursive cache deletion outside `.state.lock`. Recheck the
  state envelope and lease/tick directory stamps before promotion, rollback or
  collection commits; detach collected builds atomically before deleting them.
  Resolve first-tick history and process identity before committing bindings and
  leases (#913).
- Validate prepared inventory inputs before initialization, promotion, rollback
  and each GC deletion: Git config/ref metadata, receipt listings and stat tuples,
  SQLite/WAL/SHM inputs, and Dagu's run/status list must remain unchanged. A changed
  input or a list/stat recheck exceeding one second aborts with a retryable error;
  no per-run HTTP, Git subprocess or executable hash runs under the lock (#913).
- Keep receipt-referenced caches when a run is missing or might still resume
  after failure/abort, even after the pending-admission window. Only verified
  terminal readers or explicitly released admissions can stop retaining them.
- Read atomically committed `state.json` without an exclusive lock for advisory
  observers and selection snapshots. Locked activation/commit paths still repair
  derived resource links and recheck generation, receipt and cache metadata.
- Report elapsed lock wait and every distinct acquisition record observed during
  timeout polling. Acquisition metadata is diagnostic, not proof that the last
  acquirer still owns the lock; the default deadline remains 10 seconds.
