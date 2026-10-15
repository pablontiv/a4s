# OMP Triage Guard

Extensión de OMP que exige un reviewer terminado antes de completar `triage` con `POC=no`.

## Instalación global

Desde el clon primario de a4s en `main` (el worktree de issue se elimina al cerrar el run):

```sh
omp plugin link "$(git rev-parse --show-toplevel)/packages/omp-triage-guard"
```

## Uso

1. Intentar `dagu human-task complete feature --run-id <run> --step triage --input POC=no`. El guard identifica DAG/run y devuelve `TRIAGE_REVIEW_REQUIRED` con un marcador de generación y la plantilla fija.
2. Ejecutar `task agent=reviewer` con el alcance del issue, el marcador completo y la plantilla en su assignment. Solo esa invocación queda vinculada al triage y recibe el `outputSchema` de decisión. Las demás reviews conservan sus contratos. La correlación usa el índice del spawn y el id realmente asignado por OMP, incluidos ids saneados o con sufijo de colisión.
3. Esperar el resultado final y repetir la completion. Con `poc: "no"`, el guard indica el argumento exacto `--input REVIEW=<id>` que hay que pasar explícitamente; solo acepta el id del reviewer completado para ese DAG/run/generación. Con `poc: "yes"`, bloquea y muestra la pregunta propuesta.

El guard inspecciona conservadoramente el texto original de bash/eval: `human-task`, `complete`, `triage` y `POC=no` (también entre comillas o junto a puntuación) activan el control. Se normalizan continuaciones de línea. Los falsos positivos requieren una review; sustituciones `$(...)` y separadores de shell siguen protegidos. Una completion de triage va sola en su tool call: si el texto contiene más de un `human-task`, el guard devuelve `TRIAGE_SINGLE_COMPLETION`. No se reescriben programas Python/JS ni strings anidados, por lo que `subprocess`, `!cmd`, `Bun.$` y `sh -c` conservan su sintaxis.

La aprobación se retira tras una completion exitosa; una completion fallida conserva la aprobación para reintentar. Volver a triage en el mismo run exige una review de la nueva generación, y los resultados tardíos de generaciones anteriores se ignoran. `session_start` y `session_switch` (new/resume) reinician todo el estado.

Plantilla fija (`REVIEW_PROMPT`, exportada por `src/index.ts`):

> Review the triage scope supplied by the parent. A PoC is required when implementation depends on an unexercised external or runtime behavior that could change the implementation path. Reusing behavior already demonstrated proceeds directly. Reproducing a bug is not a PoC. Reply with one JSON line: {"poc":"yes or no","behavior":"...","question":"...","reason":"..."}.

Mantener `task.structured: true` (predeterminado de OMP). El guard acepta la línea JSON pedida y el objeto JSON con indentación que serializa el executor, conservando la salida completa junto a la decisión. Éxito síncrono: `tool_result task`, `agent=reviewer`, `exitCode=0`, sin error/aborto. El acuse asíncrono registra cada job/id desde el feedback nativo de spawn y `progress[]`; `details.async.jobId` solo representa el primer job de un batch. La entrega final se registra mediante `message_end` custom `async-result` o `tool_result wait`, correlacionando job, agente, envelope reviewer y `status=completed`, sin exigir un exitCode que esas rutas no incluyen.

`POC=yes` pasa directamente. El flujo documentado reconoce comandos literales y quoting habitual; no es una frontera de seguridad contra evasión deliberada mediante programas dinámicos, scripts externos, rutas absolutas o la API de Dagu.

## Desarrollo

```sh
npm test --workspace @a4s/omp-triage-guard
npm run typecheck --workspace @a4s/omp-triage-guard
```
