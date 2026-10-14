# A4S

Repositorio reducido a las extensiones verificadas, los agentes y los skills `refine` y `dagu-feature`.

## Extensiones

- [`packages/context-expert/`](packages/context-expert/): núcleo compartido y adaptadores de Context Expert para Pi/Pion y Claude.
- [`packages/orca-omp-integration/`](packages/orca-omp-integration/): contratos de lifecycle y routing explícito de modelos para coordinadores OMP que usan workers de Orca.
- [`packages/omp-cross-family-review/`](packages/omp-cross-family-review/): selección cross-family de modelos para subagentes revisores de OMP.
- [`packages/pi-tool-row-presentation/`](packages/pi-tool-row-presentation/): presentación configurable de tool rows para Pi/Pion.
- [`packages/synagent/core/`](packages/synagent/core/): adaptadores de mensajería Synagent para Pi, OMP y Claude.
- [`packages/synagent/bus/`](packages/synagent/bus/): bus MQTT requerido por Synagent.

Los plugins de Claude están publicados en [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json).

## Agentes

Los agentes para Pi, Claude y Superpowers están en [`agents/`](agents/).

## Refine

- Skill: [`skills/refine/SKILL.md`](skills/refine/SKILL.md)
- Configuración: [`.workspace/config/refine.json`](.workspace/config/refine.json)

## Dagu feature

- Skill: [`skills/dagu-feature/SKILL.md`](skills/dagu-feature/SKILL.md): ciclo de issue con un DAG de Dagu propiedad del repo, con un solo run por issue.
- Template: [`skills/dagu-feature/feature.yaml`](skills/dagu-feature/feature.yaml)
- Bootstrap: [`skills/dagu-feature/dagu-feature-bootstrap.yaml`](skills/dagu-feature/dagu-feature-bootstrap.yaml)

## Flujo de issues

a4s usa su propio ciclo `dagu-feature`, versionado en [`.workspace/dagu/dags/feature.yaml`](.workspace/dagu/dags/feature.yaml). El gate local es `npm ci && npm test && npm run typecheck`, y `main` exige el check `validate` de [`.github/workflows/ci.yml`](.github/workflows/ci.yml). Cada issue se lleva con un run desde el clone (no desde un worktree), limpio y en `main`. El DAG crea el worktree del issue en `.workspace/worktrees/issue-<n>`:

```sh
n=<issue>
dagu enqueue --run-id "a4s-issue-$n" .workspace/dagu/dags/feature.yaml -- \
  ISSUE="$n" PRIMARY="$(git rev-parse --show-toplevel)" BRANCH="dagu/issue-$n"
```

El checkpoint `implement`, la reconciliación de `await_merge` y la recuperación de fallos siguen [`skills/dagu-feature/SKILL.md`](skills/dagu-feature/SKILL.md).

## Verificación

```sh
npm ci
npm test
npm run typecheck
```

La historia completa anterior a esta reducción queda en la rama `legacy`.
