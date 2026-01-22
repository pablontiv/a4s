# Changelog

## 0.2.0

- Require strict cross-family eligibility for every configured review agent, including security, triage and planning reviewers; block unresolved parent identity/family and exhausted candidate chains with excluded families, evaluated identities/families and eligibility causes (#350).
- Make `orderReviewModels` uniformly strict and migrate the Dagu quality guard to its four-argument API. Preserve eligible candidate order, aliases, thinking suffixes, resolved-id deduplication and the strict selection note.
- Verify real reviewer and triage-reviewer blocks before child execution on OMP 18.12.5 with process-local same-family candidates and roles.

## 0.1.1

- Apply parent-relative cross-family model selection to the structured planning reviewer (#292).

## Unreleased

- Share quality implementer bindings across module instances so the spawn hook sees bindings made by `@a4s/omp-dagu`, which OMP loads as a separate extension graph (#374).

- Enforce strict QA/reviewer eligibility for the feature publication gate, using the runtime-effective implementer reference and blocking model exhaustion with diagnostics. Preserve canonical-family comparison, resolved-id deduplication and explicit fallback policy (#280).

- Make `reviewer` and `security-reviewer` avoid both the parent and `@task` model families while keeping `triage-reviewer` relative to the parent only.

- Apply the existing cross-family model ordering and role fallbacks to `triage-reviewer`, alongside the generic `reviewer` and `security-reviewer` roles.
