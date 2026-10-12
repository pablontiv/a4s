# Disposable retrospective analysis

This directory contains local analytical receipts, not a production cost-analyzer extension. Source logs and Git refs were not modified.

- Read `report.md` for findings and limitations; open `curves.html` for curves.
- `source-manifest.json` hashes analyzed streams after the run; the event cutoff is fixed in the script.
- `summary.json` records the local Git ref and commit snapshot used for each repository. No remote freshness or deployment claim is made.
- Run `python3 test_yield_probe_20261010.py` in this directory for the 15 probe regression checks.
- Run `python3 yield_probe_20261010.py` to re-evaluate against currently available source logs and local refs. The date cutoff stays fixed, but evolving logs/refs can change results. Original results are captured in the CSV and JSON receipts. The script imports the existing classifier from this checkout without changing it.
- Report curves show the 18 streams with the most matched characters; `turns.csv` contains all observed steps.
- Do not use the descriptive proxy yields as comparative rankings or install candidate contexts as compaction policies.

Verified Faux-provider fixture sources are excluded and retained as an audit list in `excluded-fixtures.csv`. Operational event counts are therefore smaller than raw session-file counts.
