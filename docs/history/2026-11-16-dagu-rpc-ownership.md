# Dagu-owned RPC probe — 2026-11-16

Historical observation, not a current-contract guarantee or operator authorization. The [headless triage pre-pilot contract](../../packages/omp-dagu/README.md#headless-triage-pre-pilot-920) remains authoritative.

On 2026-11-16 at 05:00 UTC, an isolated Dagu 2.26.0 parent/child run (`issue-920-rpc-live`) successfully owned one real OMP 18.20.3 RPC child for its entire lifetime. `scripts/probe-role-rpc.py`, under the same cleanup guard, used `anthropic/claude-haiku-4-5` and a host-owned tool gate to keep the role busy. All eleven command IDs were acknowledged individually; `steer` and `follow_up` appeared in their respective queues and then in assistant replies. `abort` returned an acknowledgement, an `aborted` prompt result and host-tool cancellation. The session ID/file stayed unchanged, stdin EOF exited 0, and both Dagu runs succeeded in 5.7 seconds. The test home was removed after recording these results.

This proves that a Dagu step can own and drain the RPC channel; it does not add a supervisor transport/daemon, retire Tern, or complete the live-issue pilot. To reproduce after authorization, run the probe inside `role-guard.py --runtime-seconds 135 --log <private-path> --`, in an isolated Dagu child step with a 150-second timeout and a longer parent `dag.run`. Pass `--model <available-model> --state <private-directory>` to the probe; it writes its assertions and command/event evidence there.

The RPC contract and cleanup behavior were checked against the installed-version source directories `~/.opensrc/repos/github.com/can1357/oh-my-pi/v18.20.3` and `~/.opensrc/repos/github.com/dagu-org/dagu/v2.26.0`, not an unversioned repository snapshot.
