# A4S

Repositorio reducido a las extensiones verificadas, los agentes y los skills distribuidos por sus paquetes.

## Extensiones

- [`packages/context-expert/`](packages/context-expert/): núcleo compartido y adaptadores de Context Expert para Pi/Pion y Claude.
- [`packages/orca-omp-integration/`](packages/orca-omp-integration/): contratos de lifecycle y routing explícito de modelos para coordinadores OMP que usan workers de Orca.
- [`packages/omp-cross-family-review/`](packages/omp-cross-family-review/): selección cross-family de modelos para subagentes revisores de OMP.
- [`packages/omp-dagu/`](packages/omp-dagu/): widget, despertar dirigido de la sesión coordinadora y guard OMP para Dagu, agente `triage-reviewer` y skill `dagu-feature`.
- [`packages/pi-tool-row-presentation/`](packages/pi-tool-row-presentation/): presentación configurable de tool rows para Pi/Pion.
- [`packages/synagent/core/`](packages/synagent/core/): adaptadores de mensajería Synagent para Pi, OMP y Claude.
- [`packages/synagent/bus/`](packages/synagent/bus/): bus MQTT requerido por Synagent.

Los plugins de Claude están publicados en [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json).

## Agentes

Los agentes para Pi, Claude y Superpowers están en [`agents/`](agents/).

## Refine

- Skill: [`skills/refine/SKILL.md`](skills/refine/SKILL.md)
- Configuración: [`.workspace/config/refine.json`](.workspace/config/refine.json)

## Sprint Planning

- Skill: [`skills/sprint-planning/SKILL.md`](skills/sprint-planning/SKILL.md): una sesión es un sprint. Ordena los issues de la sesión (Sprint Goal) o de todo el backlog (Product Goal) contra un objetivo confirmado por el operador y verificado con checks de sí o no, encola el Sprint Backlog en Dagu y cierra con un Sprint Review. La sesión decide el orden; Dagu ejecuta la cola.

## Skills de coste

- Auditoría de cuota: [`skills/gpt-quota-audit/SKILL.md`](skills/gpt-quota-audit/SKILL.md).
- Análisis de coste y resultados: [`skills/cost-analyzer/SKILL.md`](skills/cost-analyzer/SKILL.md).

## Dagu feature

- Skill: [`packages/omp-dagu/skills/dagu-feature/SKILL.md`](packages/omp-dagu/skills/dagu-feature/SKILL.md): ciclo de issue con un DAG de Dagu propiedad del repo, con un solo run por issue.
- Template: [`packages/omp-dagu/skills/dagu-feature/feature.yaml`](packages/omp-dagu/skills/dagu-feature/feature.yaml)
- Bootstrap: [`packages/omp-dagu/skills/dagu-feature/dagu-feature-bootstrap.yaml`](packages/omp-dagu/skills/dagu-feature/dagu-feature-bootstrap.yaml)

## Flujo de issues

a4s usa su propio ciclo `dagu-feature`, versionado en [`.workspace/dagu/dags/feature.yaml`](.workspace/dagu/dags/feature.yaml). El gate local es `npm ci && npm test && npm run typecheck`, y `main` exige el check `validate` de [`.github/workflows/ci.yml`](.github/workflows/ci.yml). Cada issue se lleva con un run desde el clone (no desde un worktree), limpio y en `main`. El DAG crea el worktree del issue en `.workspace/worktrees/issue-<n>`:

Los renders `feature`, `poc`, `discovery` y `reconcile` adoptan
`@a4s/omp-dagu@0.3.8`, source
`pablontiv/a4s@fe5d444e9c9133d5bac3d2aeef054fee56d01fdb`, bootstrap
`bootstrap-a4s-v0-3-8` y Dagu `2.20.1` (#271). Su identidad se consulta con
`node packages/omp-dagu/bin/dagu-feature-bundle.ts .`.

```sh
n=<issue>
dagu enqueue --run-id "a4s-issue-$n" .workspace/dagu/dags/feature.yaml -- \
  ISSUE="$n" PRIMARY="$(git rev-parse --show-toplevel)" BRANCH="dagu/issue-$n"
```

El checkpoint `implement`, la reconciliación de `await_merge` y la recuperación de fallos siguen [`packages/omp-dagu/skills/dagu-feature/SKILL.md`](packages/omp-dagu/skills/dagu-feature/SKILL.md).

Antes de actualizar la rama del PR, el candidato local pasa `GATE` y recibe
dos PASS independientes de QA y reviewer, distintos del implementador y de otra
familia efectiva (verificada en JSONL con `ctx.models.family`). Los veredictos
están ligados a SHA/run/iteración/intento; un FAIL vuelve a `implement` con
hallazgos y cada corrección o rebase renueva ambas evidencias. `auto_merge`
permanece ligado al SHA admitido. El control es **advisory mientras la TUI tenga
acceso al store de Dagu**; el protocolo ejecutable está en el skill.

## Verificación

```sh
npm ci
npm test
npm run typecheck
```

La historia completa anterior a esta reducción queda en la rama `legacy`.
