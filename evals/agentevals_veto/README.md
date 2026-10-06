# AgentEvals semantic veto

This isolated adapter runs `agentevals==0.0.9` only after a structural result has status `PASS`. It does not run an agent. The configured AgentEvals judge can call a model, so operators must provide the approved model and credentials outside this repository.

## Inputs

The structural result is a JSON object with a `status` field. Only the exact value `PASS` opens the semantic gate.

The trajectory is a JSON object with these fields:

```json
{
  "inputs": {"request": "optional evaluator inputs"},
  "outputs": {"response": "required evaluator outputs"},
  "trajectory": []
}
```

`inputs` is optional. `outputs` must be an object. `trajectory` must be an array. No other top-level field is accepted.

The criteria file is UTF-8 text. The caller must pass its trusted SHA-256 digest through `--criteria-sha256`. The adapter compares the digest before it creates the judge.

## Result

The adapter writes canonical JSON through an atomic replacement. It also prints the same JSON. The result status is `PASS`, `VETO`, or `ERROR`. Both `VETO` and `ERROR` set `blocking` to `true`. A structural status other than `PASS`, a timeout, an exception, an unexpected evaluator key, or a non-boolean score produces a blocking `ERROR`.

The result records SHA-256 hashes for the structural result, trajectory, and criteria. It does not copy those inputs. It normalizes the judge comment, removes control characters, converts whitespace to one line, and limits the comment to 1,000 characters before persistence.

Expected AgentEvals output uses key `trajectory_accuracy` and a boolean `score`.

## Run

Install the exact dependency in an isolated environment:

```sh
python -m pip install -r evals/agentevals_veto/requirements.txt
```

Run the adapter:

```sh
python -m evals.agentevals_veto.adapter \
  --structural-result structural-result.json \
  --trajectory trajectory.json \
  --criteria trusted-criteria.txt \
  --criteria-sha256 "$TRUSTED_CRITERIA_SHA256" \
  --model "$APPROVED_MODEL" \
  --timeout-seconds 60 \
  --output semantic-result.json
```

Exit code `0` means `PASS`. Exit code `1` means `VETO`. Exit code `2` means `ERROR`.

## Test

The focused tests inject a fake judge. They do not import AgentEvals. They do not call a model or an external service.

```sh
python -m unittest discover -s evals/agentevals_veto/tests -t . -p "test_*.py" -v
```
