# A4S

Repositorio reducido a las extensiones verificadas, los agentes y los skills distribuidos por sus paquetes.

## Extensiones

- [`packages/context-expert/`](packages/context-expert/): núcleo compartido y adaptadores de Context Expert para Pi y Claude.
- [`packages/omp-cross-family-review/`](packages/omp-cross-family-review/): selección cross-family de modelos para subagentes revisores de OMP.
- [`packages/omp-dagu/`](packages/omp-dagu/): widget, despertar dirigido de la sesión coordinadora y guard OMP para Dagu, agente `triage-reviewer` y skill `dagu-feature`.
- [`packages/synagent/core/`](packages/synagent/core/): adaptadores de mensajería Synagent para Pi, OMP y Claude.
- [`packages/synagent/bus/`](packages/synagent/bus/): bus MQTT requerido por Synagent.

Los plugins de Claude están publicados en [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json).

## Agentes

Los agentes para Pi, Claude y Superpowers están en [`agents/`](agents/).

## Refine

- Skill: [`skills/refine/SKILL.md`](skills/refine/SKILL.md)
- Configuración: [`.workspace/config/refine.json`](.workspace/config/refine.json)

## Dagu feature

- Skill: [`packages/omp-dagu/skills/dagu-feature/SKILL.md`](packages/omp-dagu/skills/dagu-feature/SKILL.md): ciclo de issue con un DAG de Dagu propiedad del repo, con un solo run por issue.
- Template: [`packages/omp-dagu/skills/dagu-feature/feature.yaml`](packages/omp-dagu/skills/dagu-feature/feature.yaml)
- Bootstrap: [`packages/omp-dagu/skills/dagu-feature/dagu-feature-bootstrap.yaml`](packages/omp-dagu/skills/dagu-feature/dagu-feature-bootstrap.yaml)

## Flujo de issues

a4s usa su propio ciclo `dagu-feature`, versionado en [`.workspace/dagu/dags/feature.yaml`](.workspace/dagu/dags/feature.yaml). El gate local es `npm ci && npm test && npm run typecheck`, y `dagu-14steps` exige el check `validate` de [`.github/workflows/ci.yml`](.github/workflows/ci.yml). Cada issue se lleva con un run desde el clone (no desde un worktree), limpio y en `dagu-14steps`. El DAG crea el worktree del issue en `.workspace/worktrees/issue-<n>`:

```sh
n=<issue>
dagu enqueue --queue a4s --labels "issue=$n,kind=feature" --run-id "a4s-issue-$n" .workspace/dagu/dags/feature.yaml -- \
  ISSUE="$n" PRIMARY="$(git rev-parse --show-toplevel)" BRANCH="dagu/issue-$n"
```

El checkpoint `implement`, el polling nativo de `await_merge` y la recuperación de fallos siguen [`packages/omp-dagu/skills/dagu-feature/SKILL.md`](packages/omp-dagu/skills/dagu-feature/SKILL.md).

## Verificación

```sh
npm ci
npm test
npm run typecheck
```

La historia completa anterior a esta reducción queda en la rama `legacy`.
