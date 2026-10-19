# Global Pi steering archive

Frozen, byte-identical copies of global Pi context files removed because their
scope was specific to another project. This is historical evidence, not active
A4S steering or a second decision log.

`~/.pi/agent/APPEND_SYSTEM.md` is intentionally absent under ADR 0042 until a
new explicit Operator instruction. Neither this archive nor the canonical A4S
source authorizes restoring or projecting it globally.

- Source: `[REDACTED:home]/.pi/agent/AGENTS.md`
- Captured: 2026-09-24
- Archived file: `pi-agent-AGENTS-2026-09-18.md`
- SHA-256: `c4d31f5b719c5bc6076afca4cc537efdf6a91f450b0ab8c6bb2cce950b25908b`
- Reason: the file described only `pi-auto-router` Bead `par-6li`, yet Pi
  applied it from the agent directory to every project.

The cleanup preserves only the global steering explicitly retained by the
operator. The following autoloaded extensions were removed after a byte-identical
copy was verified:

- `herdr-agent-state.ts` from `~/.pi/agent/extensions/`, SHA-256
  `9b1c41cd72520fc2abe5f2a2aec995c12a926cce844df472c7fd5fcae4f4dbfa`
- `moshi-hooks.ts` from `~/.pi/agent/extensions/`, SHA-256
  `e2fd81d9028712f0e25f69e28ba49aba7542f43e07c0971af45d7e93f2f9ce4b`

Global registration of the `pi-auto-router` extensions was also removed from
`~/.pi/agent/settings.json`; their vendor source files were not deleted. Restore
an archived hook only by copying it back to its source path after verifying its
SHA-256.
