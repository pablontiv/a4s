# E0 Attach and Transport Experiment Report

## Verdict
- PASS-macOS

## Tested revision and environment
- Tested commit: f72633eeb69586cdb543fdfc59aecf5524fe2267
- Run ID: 20260902T035117Z-661e
- Started at: 2026-09-02T03:51:17.048Z
- OS: darwin 25.6.0
- Architecture: arm64
- Node: v26.8.1
- Pi: 0.84.4
- Transport: unix_socket
- Endpoint pattern: /tmp/a4s-e0/20260902T035117Z-661e-{scenario}-{trial}-{suffix}/a4sd.sock
- Trials per scenario: 20

## Procedure
- Reproduction command: `npm run e0 -- --trials 20`.
- Recorded environment, events, and summary artifacts for the selected run.
- Raw artifacts remain local and ignored by design; the hashes below bind this report to the retained files.
- Verified scenario verdicts and platform coverage from the generated summary.

## Results by scenario
- S1: planned=20, executed=20, passed=20, failed=0
- S2: planned=20, executed=20, passed=20, failed=0
- S3: planned=20, executed=20, passed=20, failed=0
- S4: planned=20, executed=20, passed=20, failed=0
- S5: planned=20, executed=20, passed=20, failed=0

## Delivery invariants
- S1: deliveries=20, logicalProcesses=20, acknowledgements=20, duplicateFrames=0, unhandledErrors=0
- S2: deliveries=20, logicalProcesses=20, acknowledgements=20, duplicateFrames=0, unhandledErrors=0
- S3: deliveries=20, logicalProcesses=20, acknowledgements=20, duplicateFrames=20, unhandledErrors=0
- S4: deliveries=20, logicalProcesses=20, acknowledgements=20, duplicateFrames=0, unhandledErrors=0
- S5: deliveries=20, logicalProcesses=20, acknowledgements=20, duplicateFrames=20, unhandledErrors=0

## Protocol-error results
- No protocol errors were observed in the recorded run artifacts.

## Artifacts and SHA-256 hashes
- environment.json: 6366e6219ef74345ee904c9ee571daab0cdd9f62ab44a6473024a61cbe65f446
- events.jsonl: 4a77975db54ec58adf5cea77f30fc774887b1a3fe576f722336be1259acf78f8
- summary.json: abd3c6a50f7c59ce324e79c02b77bcf7c1698a2aeff36b4ea3330615678c6896

## Anomalies and failed prior runs
- Anomalies:
  - 20260902T011357Z-696d discarded: OS version was recorded as darwin node.
  - 20260902T012719Z-071e discarded: repeated ACKs produced protocol errors contrary to the E0 specification.
  - 20260902T014920Z-a99e discarded: report generator emitted a duplicate trailing terminator.
  - 20260902T015339Z-f048 discarded: post-PR review found missing receive-boundary address and strict UTF-8 validation.
- Failed prior runs: none

## Platform coverage
- macOS: PASS
- linux: NOT RUN
- Windows: NOT RUN

## Decision
- PASS-macOS
