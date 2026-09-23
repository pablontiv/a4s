# Beads todo loop

Open Pi in a Beads repository and invoke:

```text
/skill:beads-loop
```

The skill uses a deterministic compact-JSON script to project the repository backlog into Pi todos. It reads full Bead text only for the active todo, records in-repository evidence, and closes or blocks the selected Bead without a lease.

## Verification

Maintainers run the unit tests plus disposable A4S and Homeserver-wrapper E2E fixtures. Never use a production backlog for E2E: the fixture owns all Beads state.
