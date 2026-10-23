# Native OMP agents

A4S owns one canonical definition per retained generic role, directly in the native project discovery root [`.omp/agents/`](../.omp/agents/). Start OMP from this checkout and invoke the unprefixed name through `task`.

| Role | Specialization | Tool authority |
|---|---|---|
| [`explorer`](../.omp/agents/explorer.md) | Sourced facts, evidence, uncertainty | Read-only inspection |
| [`judge`](../.omp/agents/judge.md) | Premises, conflicting evidence, proposed scope | Read-only assessment |
| [`implementer`](../.omp/agents/implementer.md) | Authorized scoped changes and assigned validation | Read, edit, write, commands |
| [`reviewer`](../.omp/agents/reviewer.md) | Candidate evaluation against explicit criteria | Read-only inspection/checks |
| [`debugger`](../.omp/agents/debugger.md) | Reproduction and causal diagnosis; authorized fixes | Read, edit, write, commands |
| [`generalist`](../.omp/agents/generalist.md) | Bounded work without a better specialization | Read, edit, write, commands |

CSV `tools` frontmatter uses native OMP names, including `glob` for file discovery. Read-only roles constrain shell use to non-mutating inspection. Each role returns status, result, evidence and risks through its final response, or the caller's supplied structured schema. Mutating assignments include the exact existing targeted test command. Repository/operator policy remains authoritative; role definitions add neither project permission nor automatic lifecycle gates.

OMP's native precedence is project `.omp/agents`, user `$PI_CODING_AGENT_DIR/agents` (normally `~/.omp/agent/agents`), extension-package agents, other plugin providers, then bundled definitions. A matching name is not provenance: record task `agentSource`, the child `session_init` and the selected prompt, tools and resolved model. Compare the prompt to the canonical definition to distinguish same-named sources. Restart OMP to select changed definitions.

The lifecycle's `plan-reviewer` and `triage-reviewer` are owned by [`@a4s/issue-lifecycle`](../packages/issue-lifecycle/). Generic `reviewer` remains independent and serves [`gpt-quota-audit`](../skills/gpt-quota-audit/SKILL.md), which additionally requires an independently verified model outside the audited provider. The lifecycle owns its current admission contract.

## Private consumer installation

Installation is an explicit operator action, separate from this source change. Use a native project root in a private checkout, pointing to this canonical source. Existing destinations must be resolved by the operator before installation; `ln -s` fails rather than overwriting them.

```sh
A4S_ROOT="$(pwd)" # run from the selected A4S revision
CONSUMER="/path/to/private-project"
mkdir -p "$CONSUMER/.omp/agents"
for role in explorer judge implementer reviewer debugger generalist; do
  ln -s "$A4S_ROOT/.omp/agents/$role.md" "$CONSUMER/.omp/agents/$role.md"
done
```

For an expressly authorized user-wide installation, the supported destination is `${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/agents/<role>.md`; use the same canonical targets. A project definition takes precedence over a user definition. No global links are applied by A4S installation scripts or by this migration.

To validate the project installation without changing the production profile, use a temporary project and a temporary native profile outside the checkout. Copy only the existing configuration and symlink the operator-authorized authentication database; credential files stay in place. Adjust model routes only in that temporary config to authorized tool-capable models (for example `openai-codex/gpt-6.1-sol` or Anthropic). A configured cross-family reviewer also needs an eligible model outside the parent/task families.

```sh
A4S_ROOT="$(pwd)"
SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/a4s-agents.XXXXXX")"
SMOKE_AGENT_DIR="$SMOKE_ROOT/agent"
SMOKE_SESSIONS="$SMOKE_ROOT/sessions"
CONSUMER="$SMOKE_ROOT/project"
mkdir -p "$SMOKE_AGENT_DIR" "$CONSUMER/.omp/agents"
cp "$HOME/.omp/agent/config.yml" "$SMOKE_AGENT_DIR/config.yml"
ln -s "$HOME/.omp/agent/agent.db" "$SMOKE_AGENT_DIR/agent.db"
for role in explorer judge implementer reviewer debugger generalist; do
  ln -s "$A4S_ROOT/.omp/agents/$role.md" "$CONSUMER/.omp/agents/$role.md"
done
cp "$A4S_ROOT/package.json" "$CONSUMER/package.json"
PI_CODING_AGENT_DIR="$SMOKE_AGENT_DIR" \
PI_CODING_AGENT_SESSION_DIR="$SMOKE_SESSIONS" \
  omp --no-extensions --cwd "$CONSUMER" --mode json --tools task,wait \
  -e "$A4S_ROOT/packages/issue-lifecycle" \
  -e "$A4S_ROOT/packages/review-routing" \
  -p 'Invoke task using agent=explorer to read package.json and report its name with evidence; do not edit files. Use wait until that child delivers its completed result.'
# Retain the child initialization, task source and actual tool results before cleanup.
rm -r "$SMOKE_ROOT"
```

In the temporary config, `disabledProviders: ["claude-plugins"]` excludes marketplace discovery, and `skills.customDirectories: ["<A4S_ROOT>/skills"]` loads independent repository skills. `--skills` filters names rather than loading paths. Keep session persistence and skill discovery enabled. Substitute each role with an appropriate bounded assignment; implementation/generalist mutation belongs in a disposable copy of an existing fixture, with its exact targeted test command. These observations prove candidate invocation, not production activation.

## Native verification for #429

OMP **18.12.6** completed all six roles in the candidate checkout and again in an isolated private project using the installation above. Each parent task transcript recorded **`agentSource=project`**. Each child's persisted `session_init` contained the corresponding canonical `.omp/agents/<role>.md` body as the exact role-prompt prefix, together with its tool list and resolved model. For the private project, all six installed links resolved to those same canonical files. These are actual child executions, not name-only discovery.

| Role | Repository child init ID | Private child init ID | Observed tools and bounded outcome |
|---|---|---|---|
| explorer | `a0aaed8c` | `7e088b6b` | `read`: sourced root package name `a4s` |
| judge | `927e723b` | `feb385d6` | `read`, `glob`, `grep`, read-only `bash`: assessed the proposed package rename against inspection-only authority; `mutation_allowed=false` |
| reviewer | `c66f0e65` | `01b8ea2b` | `read`, `grep`, read-only probes: inspected actual `classifyError` candidate, PASS with residual risks; independent quota-audit output-only attribution proposal rejected |
| implementer | `3249ff8c` | `1a2f5c35` | `read`, `grep`, `edit`, `bash`: added an EBUSY retryability assertion in a disposable copy of the existing logging fixture; `node --test test/logging.test.cjs`: **7 pass, 0 fail** |
| debugger | `45ba255d` | `0535db99` | `read`, `grep`, `bash`: reproduced the logger fixture, explained message omission and ETIMEDOUT retryability; same existing test command: **6 pass, 0 fail** |
| generalist | `29308ff7` | `42b0126a` | `read`, `grep`, `edit`, `bash`: changed the correlation fixture value and matching assertion in an isolated copy; same existing test command: **6 pass, 0 fail** |

All retained successful children resolved to `anthropic/claude-opus-5`. The independent reviewer used an `openai-codex/gpt-6.1-sol` parent and remained outside the audited OpenAI provider; the other completed role runs used Anthropic parents. Temporary model overrides selected authorized tool-capable routes. The private consumer additionally copied the repository's cross-family adoption policy into its own `.omp/config.yml`.

The command shape was the example above, with `--cwd` set to the candidate or private project and explicit candidate lifecycle/review-routing extensions. Each role received the table's assignment; mutating roles received their exclusive disposable path and exact existing targeted command. Final retries additionally set `--model`, `--thinking off`, `--no-title`, `--max-time 480` and an explicit isolated `--session-dir`. Parent/child session identifiers, exact expanded commands, source/prompt comparisons, actual tool results and outputs were retained as redacted execution evidence for the issue before deleting temporary profiles, projects and fixture copies. The production configuration and global agent links were unchanged.

Two runtime observations informed the successful commands: Codex runs could produce empty thinking streams and reach the time limit; and on this OMP version, asynchronous task completion requires exposing `wait` to the print-mode parent. With only `--tools task`, some parents returned a pending result and disposed their child. The maintained recipe therefore uses `--tools task,wait` and waits for the actual result.

Consumer checks: `npm exec --workspace @a4s/issue-lifecycle -- tsx --test test/triage-reviewer-verifier.test.ts` (**7 pass**); `npm test --workspace @a4s/review-routing` (**36 pass**); `python3 -m pytest skills/gpt-quota-audit/scripts -q` in an isolated pytest environment (**17 pass**). Root `npm test` passed (**654 pass, 28 existing skips, 0 fail**) and `npm run typecheck` passed across all eight workspaces. Native source files are unversioned root resources; package manifests and lockfile remain unchanged.

## Source preservation and ownership

Removed-host source is recoverable through the `legacy` archive published for [#420](https://github.com/pablontiv/a4s/issues/420), commit `61322e4890cd33c43ed6685bf1fb3f869bf36749`. The native role cutover is [#429](https://github.com/pablontiv/a4s/issues/429). Historical design documents remain with their owning components. Imported material retains the [MIT license](../LICENSES/handbook-MIT.txt); consumers supply compatible tools and validate native execution semantics.
