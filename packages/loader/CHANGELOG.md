# Changelog

## Unreleased

- Read the atomically committed station envelope without `.state.lock` during
  one-second idle polling, so multiple OMP sessions do not contend on read-only
  selection. Activation still rechecks generation and cache presence and publishes
  the plugin lease under the station lock before importing code (#913).
