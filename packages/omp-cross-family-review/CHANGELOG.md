# Changelog

## Unreleased

- Enforce strict QA/reviewer eligibility for the feature publication gate, using the runtime-effective implementer reference and blocking model exhaustion with diagnostics. Preserve canonical-family comparison, resolved-id deduplication and explicit fallback policy (#280).

- Make `reviewer` and `security-reviewer` avoid both the parent and `@task` model families while keeping `triage-reviewer` relative to the parent only.

- Apply the existing cross-family model ordering and role fallbacks to `triage-reviewer`, alongside the generic `reviewer` and `security-reviewer` roles.
