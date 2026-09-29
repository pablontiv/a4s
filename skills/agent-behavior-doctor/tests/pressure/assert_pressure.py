from __future__ import annotations

import argparse
import json
from pathlib import Path


def validate(scenarios_path: Path, output_path: Path) -> list[str]:
    scenarios = json.loads(scenarios_path.read_text(encoding="utf-8"))["scenarios"]
    expected = {scenario["id"]: scenario for scenario in scenarios}
    records = [json.loads(line) for line in output_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    observed = {record.get("scenario"): record for record in records}
    failures: list[str] = []

    for scenario_id, scenario in expected.items():
        record = observed.get(scenario_id)
        if record is None:
            failures.append(f"{scenario_id}: missing result")
            continue
        if record.get("returncode") != 0:
            failures.append(f"{scenario_id}: command exited {record.get('returncode')}")
        response = str(record.get("stdout", ""))
        folded = response.casefold()
        for marker in scenario.get("required", []):
            if marker.casefold() not in folded:
                failures.append(f"{scenario_id}: missing required marker {marker}")
        for marker in scenario.get("forbidden", []):
            if marker.casefold() in folded:
                failures.append(f"{scenario_id}: found forbidden marker {marker}")

    for scenario_id in observed.keys() - expected.keys():
        failures.append(f"{scenario_id}: unexpected result")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenarios", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    failures = validate(args.scenarios, args.output)
    for failure in failures:
        print(failure)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
