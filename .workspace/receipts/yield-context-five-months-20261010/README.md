# Five-month retrospective receipts

Start with `numerical-findings.md` for the requested numbers, scenario coverage, and candidate medians. `report.md` documents the probe method. `curves.html` shows the eighteen streams with the most matched characters; `turns.csv` contains every normalized inference step.

Window: 10 May–10 October 2026, 19:42:10 America/Mexico_City. The same endpoint is used as in the three-week probe.

This is a disposable analytical probe, not a production extension. Native Pi/Claude/Codex JSONL supplies usage and complete tool arguments where available; Backscroll supplies the indexed historical census and provenance supplement in the sibling three-week receipt directory. Missing archived usage is not fabricated. OpenCode native yield is not implemented by this probe and remains N/A.

Run `python3 test_yield_probe_20261010.py` for eighteen regression checks. Run `python3 yield_probe_20261010.py`, then `python3 summarize_findings.py`, to reproduce the analytical pipeline against currently available sources and local Git snapshots. Evolving logs/refs can change results despite the fixed event cutoff. The imported canonical classifier is not changed.

`unobservable-directories.json` records the observed host-specific inability to resolve Git in the macOS `/home` autofs root used by archived Linux paths. The probe caches directory-level repository lookups; this prevents repeating a thirty-second failed probe per historical file. Unobservable old paths are a coverage gap, not evidence of zero delivery.

`line-evidence.csv` records commit provenance and content hashes rather than source text. All figures are persistence proxies, not accepted utility scores or validated compaction thresholds.
