# Changelog

## Unreleased

- Read the atomically committed station envelope without `.state.lock` during
  one-second idle polling, so multiple OMP sessions do not contend on read-only
  selection. Prepare artifact verification and process identity outside the lock,
  then recheck generation/cache presence and publish the plugin lease in a short
  station transaction (#913).
