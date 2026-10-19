# Backscroll historical supplement

## Corrected historical availability

| Harness inferred from indexed source path | Indexed records | Source paths | First record (UTC) | Source paths now missing |
|---|---:|---:|---|---:|
| claude | 141,592 | 1,538 | 2026-07-14T04:11:05Z | 943 |
| codex | 59,922 | 1,048 | 2026-06-29T19:14:07Z | 5 |
| opencode | 32,640 | 1 | 2026-05-15T09:48:48-06:00 | 0 |
| pi | 319,011 | 2,654 | 2026-05-11T02:18:45Z | 2 |

Window: 10 May–10 October 2026 at 19:42:10 America/Mexico_City, represented above in UTC.

These are a raw indexed corpus census, not a new yield calculation. Source-path counts do not establish independent sessions. No missing provider file was opened or reparsed as a fallback. Indexed rows were queried with SQLite read-only mode after CLI preflight; sources were not modified.

## Decisions supported by this evidence

1. Use Backscroll as the historical discovery/census layer, including retained records whose original files no longer exist. The earlier raw-file availability statement (Claude only since September) was incomplete: indexed Claude records extend to July.
2. Extend five-month historical investigation by month and harness, not one pooled ranking. Pi coverage is uneven (July has only five observed source paths); OpenCode appears in May/June, Claude from July, and Codex from late June.
3. Recalculate with the current classifier; do not recycle historical scenario totals. An exact indexed context exposes a September classifier using directory-name heuristics (`a4s`, `bead-hs`, `review`, `worktrees`) alongside tool signals. These heuristics are absent from the current cost-analyzer classifier.
4. Use indexed context to recover task intent, paths, commands, and explicit coordination evidence. Cross-check delivery against Git. Native usage, context size, and full write content require separate evidence; Backscroll normalization is not a byte-complete session replay.
5. Exclude fixtures, duplicates, search echoes, and unprovable scenario labels before comparing cohorts. Frequency or an old assistant recommendation is not accepted outcome evidence.

## Exact historical evidence

- CLI discovery: `backscroll search S4 --all-projects --content-type text --after 2026-05-10 --before 2026-10-11 --robot --fields minimal --limit 3 --max-tokens 1400`.
- Selected anchor UUID: `6f82bb96-7e97-4953-99d6-8826f718411c`, source `/Users/pones/.claude/projects/-Users-Shared/8ccf2ed3-ba17-4422-a014-8e9d249627b9.jsonl`, ordinal 104.
- Exact drill-down: `backscroll context --uuid 6f82bb96-7e97-4953-99d6-8826f718411c --before 2 --after 2 --robot --max-tokens 2000`.
- Neighbor ordinal 102 contains the executed classifier and directory heuristics; ordinal 103 its reported output. This is method provenance, not validation of the older assistant causal interpretation.

## Indexed representation limits

The tables expose search text, source identity, timestamps, origin, and tool-event projections. They do not expose native usage/context-token counters. Indexed tool strings are formatted search records; at least one Write record examined is exactly 4,000 characters. This representation must not be treated as the original full model tool-output string without verifying serialization completeness.

See `backscroll-census.json` for monthly counts, source availability, search-echo counts, and inspected schema fields. The earlier three-week yield receipts remain unchanged; this supplement corrects corpus availability and informs expansion, not their numerators.
