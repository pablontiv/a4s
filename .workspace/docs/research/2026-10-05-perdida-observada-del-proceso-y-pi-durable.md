---
tipo: research
fecha: '2026-10-05'
estado: draft
title: 'Braindump: pérdida observada del proceso y Pi Durable'
---

# Braindump: pérdida observada del proceso y Pi Durable

> Estado: **braindump / boceto**. Este documento no es una especificación ni un ADR.
> Resume evidencia observada y propone un solo experimento.

## Pregunta

¿Hemos observado casos reales donde se pierde el proceso de trabajo? ¿Puede Pi Durable ayudar a reducir esa pérdida?

Aquí, "proceso" puede significar ejecución, estado, continuidad de entrega u objetivo semántico. Estas categorías no son equivalentes.

## Resultado conservador de Backscroll

La búsqueda encontró **14 grupos causales sólidos** en un corpus de:

- 6,173 archivos;
- cerca de 547,988 mensajes;
- 5,403 sesiones;
- 690 identificadores de proyecto.

La unidad de conteo es un episodio o grupo causal, no un mensaje, una coincidencia lexical ni una sesión completa.
Un grupo puede contener varios fallos relacionados.
La recuperación ocurrió en muchos casos. Por eso, el conteo no implica 14 pérdidas permanentes.

Clasificación de los 14 grupos:

| Clase | Grupos |
| --- | ---: |
| Proceso interrumpido o bloqueado | 5 |
| Estado perdido y reconstruido | 3 |
| Continuidad detenida sin pérdida semántica | 1 |
| Entrega o callback perdido | 3 |
| Objetivo o instrucción semántica perdida | 2 |

Esta clasificación es una interpretación conservadora de evidencia observada.
No demuestra una causa común para todos los grupos.

## Casos representativos

### 1. A4S, 2026-09-18: tres workers interrumpidos

Una interrupción de API o DNS afectó a tres workers.
Un worker no produjo artefacto, otro dejó una edición parcial y el tercero no entregó resultado final.
El episodio muestra pérdida de ejecución y de entrega, con resultados distintos por worker.

Fuentes:

- `/Users/pones/.pi/agent/sessions/--Users-Shared-harness-a4s--/2026-09-18T13-24-51-954Z_01a0b4b0-f872-7268-80c6-153dc8d5e15b.jsonl`
- `/Users/pones/.claude/projects/-Users-Shared-harness-a4s/fdcbe713-8a2d-4b94-9904-a5780a3965d9.jsonl`

### 2. A4S, 2026-10-03: contexto de extensión obsoleto

Pi terminó después de reemplazar la sesión y conservar un contexto de extensión obsoleto. El registro dice exactamente:

> `pi exiting due to uncaughtException: Error: This extension ctx is stale after session replacement or reload.`

Fuente:

- `/Users/pones/.pi/agent/sessions/--Users-Shared-harness-a4s--/2026-10-03T00-38-40-566Z_01a0ff32-e4b5-73d4-81c6-7b3c26b6b62c.jsonl`

### 3. Pi, 2026-08-21: continuidad detenida

En 8 de 33 compactaciones, el operador respondió `continua/continue`.
El diagnóstico fue pérdida de continuidad, no pérdida del contexto almacenado. Este caso separa el estado disponible de la capacidad de seguir sin otra señal.

Fuente:

- `/Users/pones/.pi/agent/sessions/--Users-Shared-vendor-pi--/2026-08-21T05-07-00-049Z_01a022b7-1951-7799-93c1-87251807824b.jsonl`

### 4. Handbook, 2026-09-08: callbacks perdidos

Dos callbacks se perdieron en el transporte. La sesión recuperó los resultados desde reportes durables.
No hizo redispatch, redo ni resend. El diagnóstico registrado fue `the event never reached my input — transport loss`.

Fuente:

- `/Users/pones/.pi/agent/sessions/--Users-Shared-harness-handbook--/2026-09-07T19-35-20-832Z_01a07d5e-3400-7f3b-9b58-d903ff9ac537.jsonl`

### 5. Rootline, versioning y orca dispatch, 2026-08-05/06

Varios prompts desaparecieron durante el inicio de TUI o MCP, aunque el sistema indicó aceptación. La lección registrada fue `input_accepted is not proof of delivery`.
La evidencia sostiene una carrera de entrega. No prueba que un checkpoint de tarea corrija por sí solo esa carrera.

Fuentes:

- `/Users/pones/.claude/projects/-Users-Shared-harness-rootline-gnhf-worktrees-you-are-the-orchestr-17c79c/883f0c40-da5d-4dce-8b80-5ba44b3e7909.jsonl`
- `/Users/pones/.codex/archived_sessions/rollout-2026-08-05T15-59-48-019fd3f0-9948-72f2-b687-67418e4b6f40.jsonl`
- `/Users/pones/.claude/projects/-Users-Shared-harness-orca-dispatch-kit-gnhf-worktrees-you-are-the-orchestr-7f5444/be831a20-6b6e-4884-a928-ed9d29257f01.jsonl`

### 6. Wiki, 2026-08-05: estado temporal reconstruido

Un archivo temporal de monitor se perdió al reiniciar la sesión.
El registro resume el ciclo como `created, lost on session restart, rebuilt`: hubo pérdida real de estado temporal, seguida por reconstrucción.

Fuente:

- `/Users/pones/.claude/projects/-Users-Shared-wiki/d208e3fd-bbc3-41f7-bf30-bdec1182d1fc.jsonl`

## Near-miss recuperado

A4S agotó el contexto dos veces en siete minutos el 2026-10-05. La sesión se recuperó.
Lo trato como un near-miss recuperado, no como pérdida permanente confirmada.

Fuente:

- `/Users/pones/.claude/projects/-Users-Shared-harness-a4s/8547165e-ecc4-4f16-9a38-8dc7b0cb2b3e.jsonl`

## Tres problemas distintos

1. **Ejecución y estado durables.** El proceso cae, una llamada falla o un worker cambia. La tarea debe conservar un punto de reanudación seguro.
2. **Presión de la ventana de contexto.** El historial supera lo que el modelo puede recibir. La compactación reduce el contexto enviado.
3. **Memoria semántica y restricciones críticas.** Un resumen puede omitir el objetivo, una prohibición o un criterio de aceptación.

Resolver el primer problema no resuelve automáticamente los otros dos.
La compactación puede perder detalle semántico. Un almacenamiento durable tampoco garantiza que el modelo aplique la instrucción correcta.

## Qué es Pi Durable

Pi Durable es el paquete y runtime experimental `@earendil-works/pi-durable`. Es independiente del agente de programación Pi.

Usa almacenamiento persistente SQLite o JSONL, commits atómicos, máquinas de estado durables para tareas y checkpoints.
Ofrece `resume()`, deduplicación de solicitudes y reglas de replay para tools.

Ante presión de contexto, usa compactación. Los mensajes antiguos permanecen almacenados.
El modelo recibe un resumen y los mensajes recientes.
El resumen es una transformación con pérdida. Esto no crea contexto infinito.

Pi Durable no exige un event store ni event sourcing. La recuperación usa checkpoints.
`watchEvents()` es observación opcional derivada del estado confirmado, no la fuente necesaria de recuperación.

Los efectos externos aún requieren idempotencia o reconciliación. Un checkpoint no puede deshacer por sí solo un efecto externo ya ejecutado.

Fuentes autoritativas:

- <https://github.com/earendil-works/pi/blob/main/packages/durable/README.md>
- <https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md>
- <https://earendil.com/posts/pi-durable/>
- <https://registry.npmjs.org/@earendil-works%2fpi-durable/latest>

## Ajuste observado

**Ajuste fuerte:** interrupción por crash o API, checkpoints, reanudación, deduplicación de solicitudes y tools seguras para replay.

**Ajuste parcial:** compactación y contexto, concurrencia de reintentos y reemplazo de workers. Pi Durable aporta mecanismos, pero A4S debe definir identidad, correlación y aceptación.

**No es automático:** carrera de entrega de prompts, cola durable de callbacks, leases o fencing, errores del renderer, limpieza de worktrees y deriva semántica del objetivo. Estos puntos requieren otros contratos o evidencia.

## Un solo experimento recomendado

Probar solo este recorrido:

`worker cae a mitad de tarea -> nuevo proceso abre el mismo storage -> resume desde checkpoint -> no repite efectos inseguros -> entrega un resultado correlacionado`.

El experimento debe usar un efecto externo controlado y una clave de idempotencia.
Debe demostrar la reanudación y la ausencia de repetición insegura, sin ampliar el alcance hacia una arquitectura general.

A4S sigue como dueño autoritativo de compromisos, aceptación y estado final del trabajo.
Pi Durable es un runtime candidato para ejecución durable.

## Límites y desconocidos

- Backscroll usó búsqueda lexical. Puede omitir formulaciones distintas o clasificar coincidencias ambiguas.
- Los conteos describen una instantánea sincronizada. La indexación activa puede cambiar el total después del corte.
- Los archivos de sesión muestran registros observados. No siempre prueban intención humana, causalidad completa o pérdida permanente.
- La clasificación causal contiene inferencia. Los casos citados conservan la evidencia más fuerte, no toda la salida cruda.
- Pi Durable es experimental. Su interfaz y sus garantías pueden cambiar.
- No ejecutamos una integración de A4S con Pi Durable.
- No ejecutamos una prueba de conformidad contra su spec.
- Aún no sabemos si el experimento propuesto cubre los límites reales de efectos externos de A4S.
