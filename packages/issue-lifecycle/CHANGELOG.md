# Changelog

## Unreleased

- Render identity-bound snapshot `run` scripts as literal block scalars after the
  station-shell preamble. Flow styles escaped quotes, so the verbatim
  `"$A4S_BIN" role-jobs stage implement` text that role dispatch authorizes
  against disappeared, and every non-PoC feature run failed at `implement`.
- Add the `primary-guard` extension to the package's OMP registrations and release
  artifacts. It blocks covered tool destinations in a primary Git checkout with
  `PRIMARY_WRITE_BLOCKED`, directing implementation to the feature issue worktree.
  Realpath-based Git directory comparison allows linked worktrees (including
  nested `.workspace/worktrees/` checkouts) and paths outside Git; unresolved
  destinations fail closed.
- Normalize `write` destinations with OMP's own path and internal-URI resolution,
  including hashline wrappers and archive/SQLite containers. Check `edit` paths,
  hashline headers, `MV` and legacy rename destinations, and expand `ast_edit`
  directories/globs to their real files. Inner `write xd://<tool>` dispatches use
  the same tool guard.
- Check applied LSP rename/code-action request files, plus explicit file-rename
  destinations. OMP does not expose the resulting WorkspaceEdit destinations in
  `tool_call`: applied LSP edits remain uncovered beyond those request paths.
  Arbitrary `bash`, `eval`, and `debug` code is not covered; primary cleanliness
  still relies on `start_gate`/`close_gate`. Protection applies only to sessions
  loading the package. This is not a filesystem sandbox.
- Load native artifact extensions through OMP's own module graph loader so path
  resolution uses the running host. Install the matching launcher/loader and
  restart OMP for the new registration set; pinned historical artifacts keep
  their original registrations and are not retroactively guarded.

The package is now named `@a4s/issue-lifecycle` (formerly `@a4s/omp-dagu`).
