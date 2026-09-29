# Public-repository rollout

This directory describes a future rollout. It does not authorize or perform any
remote mutation. The repository must remain private until every precondition in
[`desired-state.json`](desired-state.json) passes.

## Why publication is blocked

The operational repository currently contains historical paths, commit metadata,
reports, and many remote branches that were not created as a public artifact.
Changing only the visibility of `main` would expose Git history, branches, open
pull requests, issues, and other repository surfaces. Publication therefore
requires an explicit disclosure review of every ref and GitHub surface first.

The original A4S material is intentionally `UNLICENSED`. Public visibility is for
inspection and does not grant reuse rights. Existing per-file and per-directory
licenses continue to apply to their own artifacts.

## Required sequence

1. Start from a clean checkout whose `main` equals `origin/main`.
2. Review all Git refs and GitHub surfaces for secrets, private paths, personal
   metadata, internal topology, and operational evidence. Approve the exact
   digest of `cleanup-plan.json` before any destructive operation, execute it,
   and verify every postcondition. GitHub-managed pull-request refs require a
   separate purge or explicit disclosure decision.
3. Run `test/ci-local.sh` on the exact candidate commit and obtain an independent
   review of that same SHA. While Actions is blocked by billing or quota, retain
   evidence that affected jobs started with zero steps; never describe those
   jobs as passing. This temporary publication exception does not remove the
   nine checks from future `main` protection.
4. Reread collaborators, invitations, deploy keys, webhooks, installed apps,
   branch settings, Actions settings, and security features. Stop on any unknown
   or unexpected write-capable actor.
5. Confirm that `desired-state.json` still matches GitHub's current API. Render
   its exact HTTP requests without adding defaults and send the manifest's
   `api_version` as `X-GitHub-Api-Version`, then compute and present the manifest
   SHA-256 digest for explicit operator approval.
6. Apply requests in listed order. After every request, reread the affected
   setting and compare it with the request body. Stop after any failure or
   mismatch; do not retry automatically.
7. Perform the documented manual Issues operation and verify that both issue and
   pull-request creation are restricted to collaborators. `pablontiv` must still
   be the only collaborator.
8. Record the candidate commit, approved manifest digest, each response and
   reread result, the final visibility, and all unresolved findings.

## Integrity

`desired-state.json.sha256` and `cleanup-plan.json.sha256` contain digests of
reviewed payloads. Any change invalidates the corresponding digest and requires
new review and explicit approval. A digest is evidence of a payload, not
authorization by itself. `cleanup-plan.json` is descriptive and cannot delete or
rewrite refs on its own.
