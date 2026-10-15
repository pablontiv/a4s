# OMP Dagu

Paquete OMP para operar el ciclo de issues de Dagu: distribuye el widget de progreso, el guard de triage, el agente `triage-reviewer` y el skill `dagu-feature` con sus plantillas. Requiere Node.js >=22.19.0 y Dagu 2.19.2 con autenticación local `none`.

## Instalación

Desde el clon primario de a4s en `main` (no desde un worktree de issue, que se elimina al cerrar el run), retirar los links anteriores e instalar el paquete único:

```sh
omp plugin uninstall @a4s/omp-dagu-status @a4s/omp-triage-guard
omp plugin link "$(git rev-parse --show-toplevel)/packages/omp-dagu"
```

Para usar un checkout sin cambiar la configuración global:

```sh
DAGU_URL=http://127.0.0.1:8080 omp -e /ruta/a/a4s/packages/omp-dagu
```

Usar el directorio completo permite que OMP descubra las dos extensiones, `agents/triage-reviewer.md` y `skills/dagu-feature/`. `DAGU_URL` es la raíz del servidor (por defecto `http://127.0.0.1:8080`).

## Widget de progreso

La extensión de status observa los runs activos del repositorio de la sesión mediante REST y SSE y muestra una línea por run en un widget `aboveEditor`, debajo de los todos. Resuelve el repositorio desde `origin`, también en linked worktrees, y consulta runs `running`, `queued` y `waiting` de las últimas 48 horas con la etiqueta `workspace=<repo>`.

Cada línea identifica el DAG y el issue, muestra el progreso por nodos y el paso actual. La CLI `gh` es opcional y añade el slug del título. La primera observación es silenciosa; las transiciones posteriores a `waiting`, `succeeded`, `failed` o `aborted` generan una notificación deduplicada. Las caídas de REST o SSE muestran una reconexión con backoff sin interrumpir la sesión.

```text
dagu · feature #169 mostrar-dag-y-titulo-del-issue ▰▰▱▱▱▱ 2/5 gate running
```

El paquete usa `fetch` y un parser SSE propios, sin dependencias runtime externas. La extensión solo observa; las acciones humanas y la reconciliación pertenecen a Dagu y al operador.

## Guard de triage y agente

El paquete distribuye `triage-reviewer` con `structured: true`, el JSON Schema de la decisión, `tools: []`, `spawns: []` y modelo `@slow`.

1. Intentar completar `triage` con `POC=no`. El guard responde `TRIAGE_REVIEW_REQUIRED` con el marcador de generación y la plantilla fija.
2. Ejecutar `task agent=triage-reviewer` con el alcance, el marcador completo y la plantilla.
3. Repetir la completion con el id asignado en `--input REVIEW=<id>` cuando la decisión sea `poc: "no"`. Una decisión `yes` mantiene triage en espera con la pregunta propuesta.

La aprobación pertenece a un DAG, run y generación; se consume tras una completion exitosa y se conserva si la completion falla. Volver a triage exige otra revisión. El guard exige que la completion de triage esté sola en su tool call. `POC=yes` pasa directamente.

Con `@a4s/omp-cross-family-review` cargado, `triage-reviewer` conserva la selección cross-family; `reviewer` sigue disponible para code review.

## Skill dagu-feature

OMP resuelve `skill://dagu-feature` y `skill://dagu-feature/feature.yaml` desde `skills/dagu-feature/` dentro del paquete. `SKILL.md`, `feature.yaml`, `poc.yaml`, `reconcile.yaml` y `dagu-feature-bootstrap.yaml` permanecen juntos para conservar sus enlaces relativos y las rutas `$SKILL_DIR/<archivo>` del bootstrap.

## Desarrollo

```sh
npm test --workspace @a4s/omp-dagu
npm run typecheck --workspace @a4s/omp-dagu
```

El gate completo del repositorio es:

```sh
npm ci && npm test && npm run typecheck
```

Las pruebas cubren el parser SSE, progreso, identidad y títulos de issues, resolución de repositorios/worktrees, transiciones y avisos del widget, además de la correlación nativa y el contrato estructurado del guard de triage.
