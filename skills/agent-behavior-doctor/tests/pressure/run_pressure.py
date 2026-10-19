from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path


COMMAND_ENV = "AGENT_BEHAVIOR_DOCTOR_PRESSURE_COMMAND_JSON"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenarios", type=Path, required=True)
    parser.add_argument("--skill", type=Path, required=True)
    parser.add_argument("--reference", type=Path, action="append", default=[])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    encoded_command = os.environ.get(COMMAND_ENV)
    if not encoded_command:
        raise SystemExit(f"{COMMAND_ENV} is required")
    command = json.loads(encoded_command)
    if not isinstance(command, list) or not command or not all(isinstance(value, str) for value in command):
        raise SystemExit(f"{COMMAND_ENV} must be a non-empty JSON string array")

    payload = json.loads(args.scenarios.read_text(encoding="utf-8"))
    skill = args.skill.read_text(encoding="utf-8")
    references = "\n\n".join(
        f'<loaded-reference name="{path.name}">\n{path.read_text(encoding="utf-8")}\n</loaded-reference>'
        for path in args.reference
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as stream:
        for scenario in payload["scenarios"]:
            prompt = (
                "The following repository skill and references are explicitly loaded and govern this response. "
                "Do not use ambient skills. Follow the skill's exact output contract.\n\n"
                f"<loaded-skill>\n{skill}\n</loaded-skill>\n\n"
                f"{references}\n\n"
                f"Scenario:\n{scenario['prompt']}\n\n"
                "Diagnose the scenario now without asking a clarifying question."
            )
            result = subprocess.run([*command, prompt], capture_output=True, text=True, timeout=180)
            stream.write(json.dumps({
                "scenario": scenario["id"],
                "returncode": result.returncode,
                "stdout": result.stdout,
                "stderr": result.stderr,
            }, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
