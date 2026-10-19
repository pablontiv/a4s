# a4s-ann — Epic closure evidence

- **Epic:** `a4s-ann` — Alinear roadmap con paridad Rootline y compensar CI bloqueado
- **Children:** `a4s-wca`, `a4s-785`, `a4s-am1`, `a4s-v10`, `a4s-4im`, `a4s-l7y`, `a4s-y8f`, `a4s-mka`, `a4s-92g`. All are closed after this PR, with evidence in `reports/<id>.md`.
- **Related root task:** `a4s-c1n` (Superpowers roles in Claude Code), closed.

## Success criteria

| Criterion | Evidence |
|---|---|
| The 8 task children are closed with `reports/<id>.md` | Bead notes of each child; `reports/a4s-{wca,785,am1,v10,4im,l7y,y8f,mka}.md` |
| `test/ci-local.sh` is green on main after the last merge | 19/19 on `f4b3d8f`. The result on the merge commit of this PR is appended to the epic's notes |
| ADRs 0047 and 0048 are accepted; rootline is clean | `.workspace/docs/adr/0047-*`, `0048-*` (plus 0049); rootline 144/144 |
| `loop.md`, `tree.md`, and `plan.md` include the approved behaviors | See `reports/a4s-92g.md` "Coverage" |

The final review (`reports/a4s-92g.md`) states `epic_closable: yes`. Its two LOW findings are left open as optional follow-ups; they are not closure criteria.
