# Changelog

## Unreleased

- Use root Node and shared development-tool requirements and workspace-local hot-reload identity; remove duplicated host-version text without changing CLI model-override routing.

## 0.1.0

- Establish the canonical private workspace `@a4s/orca-integration` at `packages/orca-integration` (#423), updating package metadata, loader examples, root scripts, workspace lock metadata and CI selection coverage together.
- Preserve the OMP–Orca boundary implementation, extension discovery/reload shim, bound-Run detection, reclaimable-worker guard, concrete model resolution, terminal reuse semantics and Pi-named host dependencies.
- Verify the relocated workspace: `npm test --workspace @a4s/orca-integration` passed all 21 tests; `npm run typecheck --workspace @a4s/orca-integration` passed. The targeted CI selection suite passed all 6 tests.
- Record the real OMP–Orca smoke as PASS on `dagu/issue-423` at `1fcb05d2c15519c476a0f12cceba5ab5a1e0482e`, based on the [operator's runtime evidence](https://github.com/pablontiv/a4s/issues/423#issuecomment-6357832625): concrete responsibility-role resolution, fresh-worker argument rejection, a disposable worker with matching requested/effective model, reclaimable-worker guarding and exact projected release, and inertness outside a bound Run.
- Replace the earlier blocked acceptance status with that operator-reported result in the [verification record](README.md#issue-423-verification), addressing the retained reviewer finding. The implementation job reran all 21 workspace tests, typechecking and all 6 targeted CI tests successfully; it did not repeat worker launches or alter the production profile.
