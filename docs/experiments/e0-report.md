# E0 Attach and Transport Experiment Report

## Verdict
- PASS-macOS

## Tested revision and environment
- Tested commit: dc357429382b64f6e417873f64b73decd4a476d3
- Run ID: 20260902T012719Z-071e
- Started at: 2026-09-02T01:27:19.435Z
- OS: darwin 25.6.0
- Architecture: arm64
- Node: v26.8.1
- Pi: 0.84.4
- Transport: unix_socket
- Endpoint pattern: /tmp/a4s-e0/20260902T012719Z-071e-{scenario}-{trial}-{suffix}/a4sd.sock
- Trials per scenario: 20

## Procedure
- Recorded environment, events, and summary artifacts for the selected run.
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
- environment.json: 9250120836f80cb821c6670279758594663c18a1e0f7898fd6093c56ee3acb44
- events.jsonl: 259711fda16ac0e03e84bd303fde2a11ea7edac38be8e60bf256c5da00fe1107
- summary.json: 4b625319b97fc528a4483d97565b131d670cd9b53b3a9505e3e780f9186ddbe4

## Anomalies and failed prior runs
- Anomalies: none
- Failed prior runs: none

## Platform coverage
- macOS: PASS
- linux: NOT RUN
- Windows: NOT RUN

## Decision
- PASS

