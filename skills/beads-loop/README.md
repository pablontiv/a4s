# Beads loop

Invoke `/skill:beads-loop` from a Beads repository.

The skill reads the canonical ready graph directly with `bd`, atomically claims
all eligible independent work, projects the active wave into Pi todos, and runs
parallel workers when the harness supports them. It recalculates readiness after
each wave; real `blocks` edges, not Pi todos or manual parking states, govern
when dependent work becomes executable.

Maintainers verify the skill contract and the optional read-only adapter with:

```sh
python3 -m unittest discover -s tests -p 'test_*.py' -v
```
