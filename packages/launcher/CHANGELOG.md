# Changelog

## Unreleased

- Add receipt-bound `station-recovery retire --reason` for abandoned terminal
  runs, including legacy PATH/tool drift without recovery pin evidence. Preserve
  receipt/snapshot bytes and audit the reason, native status and timestamps;
  reject Waiting rather than invent a native abort contract (#922).
- Read atomically committed `state.json` without an exclusive lock for advisory
  observers. The operator `a4s state` command and locked activation/commit paths
  still repair derived resource links; durable atomic state replacement is
  unchanged (#913).
- Report elapsed lock wait and every distinct acquisition record observed during
  timeout polling. Acquisition metadata is diagnostic, not proof that the last
  acquirer still owns the lock; the default deadline remains 10 seconds (#913).
