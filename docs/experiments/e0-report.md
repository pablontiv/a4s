# E0 Attach and Transport Experiment Report

## Verdict
- PASS-macOS

## Tested revision and environment
- Tested commit: 404975831102da8c6a3730bcd2b6170351bf410c
- Run ID: 20260902T015339Z-f048
- Started at: 2026-09-02T01:53:39.641Z
- OS: darwin 25.6.0
- Architecture: arm64
- Node: v26.8.1
- Pi: 0.84.4
- Transport: unix_socket
- Endpoint pattern: /tmp/a4s-e0/20260902T015339Z-f048-{scenario}-{trial}-{suffix}/a4sd.sock
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
- environment.json: 21390def3ffb75f9b54db6c061d46ac622fd42f5d465fc8ec9c336c70c2e380e
- events.jsonl: 66f030e7fc531a55f2f7c3b86d3b2bfd70d054e15651398f02882d0cda0deee2
- summary.json: 8607f38176f54e4793f9f77e81d07c0f81e083b058a4f08a761f239fb922572d

## Anomalies and failed prior runs
- Anomalies:
  - 20260902T011357Z-696d discarded: OS version was recorded as darwin node.
  - 20260902T012719Z-071e discarded: repeated ACKs produced protocol errors contrary to the E0 specification.
  - 20260902T014920Z-a99e discarded: report generator emitted a duplicate trailing terminator.
- Failed prior runs: none

## Platform coverage
- macOS: PASS
- linux: NOT RUN
- Windows: NOT RUN

## Decision
- PASS
