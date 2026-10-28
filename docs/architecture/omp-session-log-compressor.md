# OMP session-log compressor (#688)

**Decision: descartar.**

The hypothesis was that an OMP session-log compressor, integrated as a hygiene
skill, reduces context size without losing useful information. The source post
describes a different mechanism: upstream `omp gc --compress` applies the
disk's own transparent compression (macOS and Windows), is lossless, and leaves
every session readable as before. Reported disk use fell from 20.3 GB to 5.8 GB.
Logical transcript bytes, which are what a model context loads, stay the same.

## Evidence

A synthetic OMP-shaped JSONL (session header, user text, assistant tool call
with `usage`, and a 20,000-line tool result) measured:

| View | Bytes |
| --- | ---: |
| Logical JSONL | 120619 |
| gzip store (`mtime=0`) | 502 |
| Bytes after decompress | 120619 |

Decompressed bytes match the original SHA-256
`d9d1eb350d89167f25d3bc34db23b0eb7e04d887700e2f5b0a870015444e8223`. Stored size
drops. Context size does not.

`skills/cost-analyzer` builds its ledger by reading each OMP session JSONL,
including per-turn `usage` on assistant messages. A shortened replacement log
would drop that accounting or the tool results a resumed session still reads.
`skills/workspace-hygiene` inventories worktrees, branches, stashes and Orca
contexts. `@a4s/context-management` compacts an in-memory transcript through an
explicit scorer; the catalog keeps it a library, not an installed OMP session
compressor. OMP already compacts live context and keeps the original session
record.

A new skill therefore fails the hypothesis: disk compression does not shrink
context, and a context shrink that still feeds cost-analyzer and resume is the
existing session file plus the existing compaction paths. This spike does not
vendor `omp gc`, change a Dagu pin, or rewrite session logs.

## Dogfood

Station admission is blocked by the Dagu pin hold. This CloudAgent change is
the docs decision only. No `omp gc --compress --apply` run, and no session
directory was modified.
