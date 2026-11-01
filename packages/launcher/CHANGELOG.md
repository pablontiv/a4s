# Changelog

## Unreleased

- Read atomically committed `state.json` without an exclusive lock for advisory
  observers. Locked activation and commit paths still repair derived resource
  links; durable atomic state replacement is unchanged (#913).
- Report elapsed lock wait and every distinct acquisition record observed during
  timeout polling. Acquisition metadata is diagnostic, not proof that the last
  acquirer still owns the lock; the default deadline remains 10 seconds (#913).
