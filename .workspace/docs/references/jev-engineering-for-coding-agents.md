# Jev Engineering for Coding Agents (reference)

Independent synthesis of design notes by Diogo Almeida (TypeSafe), compiled
Sep 2026. Not affiliated with or endorsed by TypeSafe. Archived here as the
theoretical source behind A4S's accepted Jev decisions; it authorizes no
migration or adoption on its own. Source conversion: `Jev-Engineering-for-Coding-Agents.pdf`.

## Core thesis

A coding agent is a while-loop around a model with a few tools. The leverage
is not in the loop but in what the harness assembles into context each turn.
**Jev** is the decision layer beside the model (not the model that writes
code): given explicit, typed state it returns typed answers — choice, score,
or noul decision, each with a probability — that the harness validates and
branches on without parsing prose.

## Six symptoms of the KV cache

Current agents inherit six design choices from KV-cache economics (reusing a
cached prefix is cheap; changing anything early invalidates it and forces
reprocessing):

1. **Routing fails** — handing back to the frontier model reprocesses context; routing priced per token, not per context rebuild, loses money.
2. **Tools crowd context** — full schemas must sit in the system message up front.
3. **Compaction is blind** — it compresses before the next question is known, so it discards what that question needed.
4. **Sub-agents are rare** — deciding what context to pass and merge back is expensive, so the model avoids them.
5. **Restarts** — discard good state with the bad.
6. **Batteries debate** — every built-in costs context permanently.

Where tokens actually go (input-heavy view): reading + searching + command
output ≈ two thirds of processed tokens; writing code is under a tenth. The
largest efficiency gain is smarter retrieval, not a better model or diff format.

## Proposed harness (one move)

Make state explicit and typed; let Jev decide context, routing, tools and
permissions per query.

- **Visibility ladder** — every context chunk gets a per-query visibility level: `hide / short / long / full`. Query-aware compression that never deletes state (a 2,400-line grep can be 12 hits for one query, invisible for the next).
- **Priced routing** — reuse-cache-or-rebuild is an explicit cost-aware decision; sub-agents get a small purpose-built context instead of the full transcript.
- **Tiered tool disclosure** — Tier 1 one-line snippets for 100s of tools, Tier 2 schema on demand for the chosen few, Tier 3 docs for a one-off; detail drops from context when done.
- **Conditional instructions** — AGENTS.md sections attach to conditions (file type, subdir), not to the session, and are immune to compaction while their condition holds.
- **Programmable permissions** — allow/ask/deny as queries over what a command touches (e.g. deny if it reads `~/.ssh` or `.env*`).
- **Security-aware routing** — a third axis beyond difficulty/cost: route by data sensitivity (open / standard / restricted / custom) so secrets never reach low-trust providers.
- **Background processing on shared retrieval** — read-only tasks (cross-model review, eval generation, explainers) share one retrieval pass and never contend for locks.

## Mapping to A4S

Already operationalized:

| Doc idea | A4S locus |
| --- | --- |
| Jev as typed decision client | `@a4s/typesafe` (`jev-1.13.0`, fail-closed) — ADR 0020 |
| Query-aware compaction, not lossy | Jev authority `keep/truncate/drop` — ADR 0013/0016, `pi-rule-compiler/compaction.ts` |
| Routing priced per rebuild | routing by task altitude — ADR 0017 → 0018 |
| Dedup subgoals before spawn | bead-before-dispatch — ADR 0019 |
| Tiered tool disclosure | skills snippet-first |
| Parallelism with read/write typing | correlated TASK_ACK + one orchestrator per repo |

Open gaps (candidate ADRs, not yet decided):

1. Extend compaction from `keep/truncate/drop` to the 4-level visibility ladder (`hide/short/long/full`).
2. Add the sensitivity/trust axis to routing (Table IV) — ADR 0018 routes by altitude+cost only.
3. Formalize permissions as programmable queries.
4. Conditional AGENTS.md fragments per subdir, immune to compaction.
5. Shared read-only retrieval pass for background skills (sweep, systemic-triage, cross-model review).
