# Changelog

## Unreleased

- Keep station inventory, HTTP/git work, per-run and process probes, artifact
  verification and recursive cache deletion outside `.state.lock`. Recheck the
  state envelope and lease/tick directory stamps before promotion, rollback or
  collection commits; detach collected builds atomically before deleting them.
  Resolve first-tick history and process identity before committing bindings and
  leases (#913).
- Read atomically committed `state.json` without an exclusive lock for advisory
  observers and selection snapshots. Locked activation/commit paths still repair
  derived resource links and recheck generation, receipt and cache metadata.
- Report elapsed lock wait and every distinct acquisition record observed during
  timeout polling. Acquisition metadata is diagnostic, not proof that the last
  acquirer still owns the lock; the default deadline remains 10 seconds.
