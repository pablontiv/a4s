# AgentEvals semantic veto

This adapter runs the `agentevals==0.0.9` asynchronous trajectory judge after two structural gates pass. It uses an authenticated Pion `ModelRuntime`. It does not create a Pion session or agent.

## Gate inputs

The structural receipt must contain this exact object shape:

```json
{"schema":"a4s.structural-receipt/v1","status":"PASS"}
```

The independent witness receipt must contain this exact object shape:

```json
{"schema":"a4s.worker-witness-receipt/v1","status":"PASS"}
```

Any other schema, status, or field blocks judge creation. The exact uppercase value `PASS` is required.

The trajectory file must contain only a `trajectory` array:

```json
{"trajectory":[]}
```

The criteria file is trusted UTF-8 text. The caller must pass its trusted SHA-256 digest through `--criteria-sha256`.

## Judge path

The adapter calls `create_async_trajectory_llm_as_judge`. The trusted prompt contains `{outputs}`. The adapter passes the trajectory through `outputs` only.

`PionModelClient` implements the asynchronous `chat.completions.create` interface used by AgentEvals. Each call starts `pion_judge_bridge.mjs` in a separate process group. The adapter applies a timeout and kills the process group on cancellation or failure.

The Node bridge creates only `ModelRuntime`. It does not load sessions, extensions, MCP servers, skills, or repository context. `ModelRuntime` owns provider authentication. The bridge never writes a credential or token to stdout. The bridge calls `completeSimple` with `maxRetries: 0`, an `AbortSignal`, and the structured `judge_result` tool.

The bridge verifies the requested provider and model. It verifies the response provider, model, `toolUse` stop reason, and exact tool argument schema. Any error blocks the gate.

## Result

The adapter writes canonical JSON through an atomic replacement. It also prints the same JSON. `VETO` and `ERROR` set `blocking` to `true`.

The result records SHA-256 hashes for all inputs. It records only the judge key and boolean score. It does not persist the judge comment or reasoning.

## Install

Install the complete pinned Python dependency set with hash verification:

```sh
python3 -m pip install --require-hashes -r evals/agentevals_veto/requirements.txt
```

`requirements.in` records the direct AgentEvals requirement. `requirements.txt` records the compatible transitive set and artifact hashes generated for Python 3.12.

The root `package-lock.json` pins the Pion runtime dependency graph.

## Run

```sh
python3 -m evals.agentevals_veto.adapter \
  --structural-receipt structural-receipt.json \
  --witness-receipt witness-receipt.json \
  --trajectory trajectory.json \
  --criteria trusted-criteria.txt \
  --criteria-sha256 "$TRUSTED_CRITERIA_SHA256" \
  --provider "$APPROVED_PROVIDER" \
  --model "$APPROVED_MODEL" \
  --timeout-seconds 60 \
  --output semantic-result.json
```

Exit code `0` means `PASS`. Exit code `1` means `VETO`. Exit code `2` means `ERROR`.

## Test

The focused tests use a deterministic fake bridge. They do not import AgentEvals. They do not call a model or external service.

```sh
python3 -m unittest discover -s evals/agentevals_veto/tests -t . -p "test_*.py" -v
node --check evals/agentevals_veto/pion_judge_bridge.mjs
```
