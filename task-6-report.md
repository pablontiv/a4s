# Task 6 Report

## RED
Test added: `a passed trial with no Delivery evidence fails the verdict`

Before fix, it failed as expected:

```text
✖ a passed trial with no Delivery evidence fails the verdict (6.626958ms)
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ 'PASS-macOS'
- 'FAIL-macOS'
```

## GREEN
After requiring unique Delivery count to equal executed selected trials:

```text
✔ a passed trial with no Delivery evidence fails the verdict (4.993125ms)
✔ EvidenceRecorder writes environment, events, and a PASS summary (11.069416ms)
✔ one failed trial makes the run fail (6.394875ms)
✔ duplicate physical sends with one logical process preserve PASS verdict (5.772ms)
✔ a lost Delivery fails the verdict (6.909625ms)
✔ an unacknowledged Delivery fails the verdict (5.244583ms)
```

## Validation
- `npm test -- --runInBand test/evidence.test.ts`
- `npm test`
- `npm run typecheck`
