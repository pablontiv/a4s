---
name: gh-communication-style
description: "Trigger: creating or drafting GitHub issues, PRs, PR bodies, review replies, cross-link comments, or any gh post. Applies an evidence-first posting style and follows publication gates from workspace config."
license: Apache-2.0
metadata:
  author: "pablontiv"
  updated: "2026-09-30"
  version: "1.0"
---

## Activation Contract

Load before drafting ANY text destined for GitHub: issues, PR titles/bodies, review-thread replies, and cross-reference comments. This skill supplies tone, structure, evidence, and posting technique. It does not define publication authority.

## Publication Authority

- Read the applicable integrated `.workspace/config.yaml` before publishing. Its communication and external-effect gates are the only authority for whether text must be shown or approved; this skill adds no gate and grants no authorization.
- Never treat a standing instruction as authorization beyond what config permits. It cannot replace a presentation or approval that config requires, and this skill cannot infer, cache, or expand publication authority.
- Under the current A4S config, obtain explicit approval before publishing a new issue or a substantive issue/PR comment that changes commitments, scope, authority, or an external party's expected action. Show the complete exact text when requesting that approval. Routine factual status, evidence, and closure updates inside an authorized task need no separate approval.
- Under the current A4S config, pull requests, including their titles and descriptions, need no prior approval. Do not add a presentation or approval gate to them.

## Style and Evidence Rules

- GitHub artifacts default to English, neutral professional register. For replies inside an existing non-English thread, match the thread's language.
- Read the TARGET repo's real `.github/ISSUE_TEMPLATE/*`, `PULL_REQUEST_TEMPLATE.md`, and `CONTRIBUTING.md` before drafting. Never assume a generic format; field names, labels, and CI gates differ per repo.
- Every claim verified before posting: cite `file:line`, commit SHAs, or checkable commands. No unverified assertions.
- Honest checklists: never tick an unmet item; annotate deferrals inline (e.g. "deferring to CI", "no triage rights — maintainer: `type:feature`").
- No AI attribution, no `Co-Authored-By`. Conventional Commits format for PR titles.
- Fork contributors cannot apply labels; `gh issue create --label` fails silently. Note maintainer-owed labels explicitly in the body.
- Issue-form templates apply their `labels:` only through the web form. Creating via API or `gh issue create --body`/`--body-file` bypasses the form, so the issue lands with none of them. Use the web form when the auto-labels matter; otherwise list every missing label in the body, including the ones the template would have applied.
- A defect report names the SYMPTOM. Never name the remedy in the title or in Expected Behavior: a title that states a fix gets implemented as written, and a wrong frame ships a wrong mechanism that passes review. Put the design proposal in a separate comment so it can be rejected without invalidating the defect.

## Decision Gates

| Situation | Action |
|---|---|
| Multi-defect finding | ONE umbrella issue enumerating defects + declared chained-PR series; never issue-per-fix |
| Issue-first repo | Issue → wait `status:approved` → PR (local work may start earlier) |
| Review feedback received | Verify technically first; accept/refute with evidence; reply per-thread (`.../comments/{id}/replies`), never top-level |
| Fix landed for a review comment | Reply "Fixed in `<sha>` — <what changed>"; no gratitude, no performative agreement |
| Sibling issue in another repo | Cross-link with explicit disposition ("independent — neither blocks the other") |
| Prior/related issues exist | Include related-work dispositions (what each is, why in/out of scope) |

## Execution Steps

1. Read target repo templates + CONTRIBUTING; extract required fields, labels, size budgets, CI gates.
2. Search existing issues/PRs for duplicates and related work; record dispositions.
3. Draft with the evidence-dense structure: problem with verified refs → proposed solution with exact paths → alternatives considered/deliberate exclusions with rationale → additional context (cross-links, out-of-scope table). For defect reports the proposed-solution step moves out of the body into its own comment; the body stops at the symptom.
4. Measure blast radius before proposing a remedy that changes accepted behavior: count the call sites, fixtures, or invocations it would break, and post the number. "This breaks N of M" reframes the decision from which option is cleaner to what the cleaner option costs.
5. Apply the publication gate from the applicable integrated `.workspace/config.yaml`. Under the current A4S config, present the complete exact draft and wait for explicit approval for a new issue or a substantive issue/PR comment that changes commitments, scope, authority, or expected external action. Routine factual status, evidence, and closure updates inside an authorized task need no separate approval. Do not add that gate for a pull request, its title, or its description. A standing instruction never replaces an approval required by config.
6. When the applicable config permits posting, post; verify linkage (`Closes #N` registered) and report the URL.

## Output Contract

Return: posted URL(s), linkage verification, labels still owed by maintainer, and any pending cross-link comments.
