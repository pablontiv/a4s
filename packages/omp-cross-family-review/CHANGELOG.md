# Changelog

## Unreleased

- Make `reviewer` and `security-reviewer` avoid both the parent and `@task` model families while keeping `triage-reviewer` relative to the parent only.

- Apply the existing cross-family model ordering and role fallbacks to `triage-reviewer`, alongside the generic `reviewer` and `security-reviewer` roles.
