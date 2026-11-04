# a4s sobre T3 Code con coordinador OMP: arquitectura y roadmap

Fecha: 2026-11-03. Estado: investigación alternativa. No reemplaza ni modifica el
[corte de la evaluación sobre T3](t3-code-evaluation.md). Este documento no cambia
código ni configuración de a4s.

Fuentes:

- Código de T3: `pingdotgg/t3code`, rama `main` (servidor 0.1.6), obtenido con `opensrc`.
- Código de OMP: `can1357/oh-my-pi`, rama `main`.
- Pruebas: corridas con T3 0.1.6 instalado y un coordinador OMP conectado por ACP, sobre un checkout local de a4s.
- Repo a4s: las rutas sin prefijo son de este repo, en el commit `1a396ea`.

## 1. Objetivo

El loop durable lo controlan Dagu y las extensiones; el LLM no puede cumplirlo
por su cuenta. Cada paso lo impone Dagu o una extensión.

```
Operador ──► Coordinador OMP (thread de T3, ACP)        ← identidad a4s
               │  a4s enqueue
               ▼
             Dagu (loop durable) ──a4s dictate──► thread del coordinador
               ▲                                     │ delegate_task
               │ resultado validado                  ▼
               └──────────── estado del run ◄── hijo OMP (rol, otro modelo)
```

1. El operador habla con el coordinador, que es un thread de T3 que corre OMP por ACP.
2. El coordinador encola el trabajo en Dagu con `a4s enqueue`.
3. Dagu le dicta cada paso al coordinador con un paso de shell (`a4s dictate`), no con `human.task`.
4. El coordinador delega con `delegate_task`. La extensión verifica rol, modelo y aislamiento.
5. El hijo entrega su resultado con una tool validada. El paso de Dagu espera, valida y sigue, reintenta o escala.
6. `human.task` queda solo para decisiones del operador.

### Por qué el bucle no puede vivir en una sesión

Las sesiones OMP durables de a4s ya tenían el control en Dagu y en la extensión
(`packages/issue-lifecycle/src/status/` inyectaba `[DAGU STATE] run=… step=…`).
Aun así, el bucle pasaba por una sola sesión larga. Cada estado entraba al
contexto y cada evento abría un turno:

| Sesión OMP (a4s) | Compactions | Inyecciones `dagu-state` | Nudges de todo | Mensajes del operador |
|---|---|---|---|---|
| U6 versionado (29-oct) | 42 | 510 | 60 | 44 |
| F0 bloqueo de versiones (1-nov) | 37 | 121 | 32 | 29 |
| Hoja de ruta (26-oct) | 27 | 24 | 22 | 133 |
| STAB estación (2-nov) | 11 | 65 | 17 | 8 |

Los mensajes del operador muestran el síntoma: no sabía en qué estado estaba una
integración ni si el trabajo estaba bloqueado, y no encontraba la sesión a la que se había
hecho un handover. Se revisaron los conteos y los últimos mensajes de esas cuatro
sesiones, no las sesiones completas.

El mecanismo actual tampoco es durable (`docs/architecture/issue-lifecycle.md:553-555`,
`status/index.ts:36-40, 220-229`):

- los avisos viven en la memoria del proceso de la extensión;
- al reiniciar, toma una línea base silenciosa y no vuelve a avisar las esperas que ya existían;
- un dueño detenido no recibe nada.

Conclusión: no basta con que el control esté fuera del LLM; tampoco el bucle puede
pasar por una sesión durable. Con T3, cada unidad de trabajo va a un thread
delegado corto, y al coordinador solo entra lo que pide una acción del LLM:
delegar, decidir o escalar.

### Relación con el patrón de aprendizaje de segundo orden

| Principio | Cómo lo aplica esta arquitectura |
|---|---|
| Metacomunicación tipada | Cada dictado termina en un resultado con schema. "No puedo decidir" es un valor de retorno, no una pregunta suelta. |
| La repetición como señal | Dagu cuenta los fallos en el mismo punto (`run:step:iteration`). Al llegar al umbral escala en lugar de aceptar otro intento. |
| Disenso con voz y sin autoridad | Ante una escalada, el coordinador delega a un observador de otra familia de modelos, que la extensión impone con `tool_call`. El observador registra observaciones, pero no ejecuta transiciones. |
| Meta-reglas con razón declarada | Los guards niegan con un `reason` explícito. |

Cambios respecto del corte: el coordinador y los hijos corren OMP en vez de Claude
(acuerdos 1 y 6 del corte), y Dagu dicta los pasos por el WebSocket de T3 (el corte,
§5, lo había descartado). El resto de los acuerdos se mantiene: trunk con merge local en `main` y push,
worktrees de T3, `delegate_task` y sin bus MQTT.

## 2. Validado en ejecución

| # | Prueba | Resultado |
|---|---|---|
| R1 | T3 corre OMP por ACP | Instancia `acpRegistry` con fuente local, `omp acp -e <extensión>`. El driver Pi/RPC no sirve: espera `agent_settled` y `clear_queue`. |
| R2 | El coordinador conoce su thread | T3 le pasa `T3_ACP_MCP_ENDPOINT`, `T3_ACP_MCP_AUTHORIZATION`, `T3_ACP_MCP_NODE` y `T3_ACP_MCP_ENTRYPOINT`. `ELECTRON_RUN_AS_NODE=1 $T3_ACP_MCP_NODE $T3_ACP_MCP_ENTRYPOINT acp-mcp-call orchestrator_capabilities '{}'` devuelve `parentThreadId`, que es el thread propio. Funciona desde la extensión y desde shells hijos, y se repite al retomar la sesión. |
| R3 | Validar el dictado al llegar | `before_agent_start` ve el prompt bajo ACP y puede inyectar un mensaje. `input` no se emite en ACP. |
| R4 | Negar una delegación | `tool_call` bloquea o reescribe la llamada. |
| R5 | Registrar el hijo | `tool_result` de `delegate_task` trae `taskId`, `childThreadId` y `childRunId`. |
| R6 | Tool de resultado con schema | `registerTool` con schema zod. |
| R7 | Impedir que se detenga sin resultado | `session_stop` con `{decision:"block", reason}` fuerza la continuación; `stop_hook_active` evita bucles y hay un tope de continuaciones. Funcionó en el coordinador y en un hijo OMP con `openai-codex/gpt-6.1-terra`, que quiso cerrar sin entregar y entregó. |
| R8 | "Terminó" o "espera a un hijo" | ✘ `agent_end.awaitingAsyncWork` no se marca con el `delegate_task` de T3. Lo cubren el `taskId` de R5 y el estado que lee el puente. |
| R9 | Aviso al coordinador | Cuando termina el hijo, el servidor de T3 le envía un mensaje al coordinador ("Delegated task … reached a terminal state"). No hace falta poll. |
| R10 | Retomar tras 30 min de inactividad | T3 cierra la sesión (`stopped`). El dictado siguiente hace `initialize` + `session/load` con el mismo id de sesión OMP. La extensión se recarga, se vuelve a asociar y el contexto se conserva. |
| B1 | Conexión del puente | `ws://127.0.0.1:3773/ws?orchestrationProtocol=2` con `Authorization: Bearer` de `t3 auth session issue`. Sin el parámetro responde 426 `orchestration_protocol_incompatible`. |
| B2 | Dictado idempotente | `orchestration.dispatchCommand` con `message.dispatch` y el mismo `commandId` devuelve la misma `sequence` sin crear un segundo run. |
| B3 | Aviso del fin | `orchestration.subscribeThread` emite `run.updated completed`. El MCP `t3_thread_wait` con `untilDelegatedWorkSettled` espera también al hijo. |
| B4 | Cola retenida | Una caída del proveedor o un reinicio del servidor deja la cola retenida. `queue.resume {commandId, threadId}` la libera. |
| B5 | Sesión nativa | `orchestration.getThreadProjection` trae `providerThreads[].nativeThreadRef.nativeId`, igual al id de sesión de OMP. |

Primera prueba de OMP como runtime en T3, con la misma instancia ACP:

| # | Prueba | Resultado |
|---|---|---|
| P1 | Tools de T3 en OMP | Llegan todas con el nombre `mcp__t3_code_<tool>`; la de delegación es `mcp__t3_code_delegate_task`. OMP las expone como rutas `xd://`, y el modelo las llama escribiendo en esa ruta. |
| P2 | Doble `tool_call` | Cada tool MCP dispara primero un `write` a la ruta `xd://…` y después la llamada real `mcp__t3_code_*`. Los guards deben mirar la llamada real. |
| P3 | Guard sobre una tool MCP | `tool_call` rechazó un `delegate_task` con su `reason`. |
| P4 | Reescritura del input | `tool_call` cambió el texto de la tarea, y el hijo recibió la versión reescrita. Con Claude esto no se probó. |
| P5 | Schema de la tool registrada | OMP lo valida antes del handler: `verdict: "maybe"` volvió como `Validation failed`. Con Claude, el valor inválido llegó al handler (V3 del corte). |
| P6 | Instrucciones de orquestación | T3 inyecta su sección "T3 Code orchestration" en la sesión OMP. |
| P7 | Catálogo de modelos | T3 lo descubre después de la primera sesión: 34 modelos de varias familias. El motor de OMP reportó el mismo modelo pedido (`openai-codex/gpt-6.1-terra`). |
| P8 | Sesión de descubrimiento | Para leer el catálogo, T3 abre una sesión OMP corta en su propio directorio, y la extensión también carga ahí. La extensión no puede asumir que corre dentro de un repo. |
| P9 | `model: "default"` | T3 registra solo `default`, y no se sabe qué modelo corrió. a4s debe pedir siempre un modelo explícito. |
| P10 | Delegación anidada | El hijo con `worktree` quedó en `~/.t3/worktrees/a4s/<carpeta>`, con base en el HEAD del coordinador, rama renombrada y `relationshipToParent: subagent`. Los sub-hijos `shared` (`wait` y `async`) trabajaron en el mismo worktree. El coordinador recibió un único aviso. |

Recuento final de los puntos que dependen del agente (✔ probado en ejecución,
código = solo visto en código, ✘ abierto):

| # | Necesidad | Claude (corte) | OMP + puente |
|---|---|---|---|
| 1 | Saber cuál es su thread | ✔ `T3CODE_THREAD_ID` | ✔ R2 |
| 2 | Validar el dictado al llegar | código (`prompt.submit`) | ✔ R3 |
| 3 | Negar o reescribir una delegación | ✔ negar (V2); reescribir sin probar | ✔ R4, P3, P4 |
| 4 | Registrar el hijo | código | ✔ R5 |
| 5 | Tool de resultado con schema | ✘ el engine no valida (V3) | ✔ R6, P5 |
| 6 | Impedir que se detenga sin resultado | ✘ | ✔ R7 |
| 7 | "Terminó" o "espera a un hijo" | ✘ | ✘ R8, cubierto por la fila 4 y por B3 |
| 8 | Retomar tras 30 min de inactividad | código | ✔ R10 |
| 9 | Reusar las extensiones de a4s | ✘ hay que portarlas | código |
| — | Envío idempotente, cola retenida, hijo de otra familia sin extensión | ✘ | ✔ B2, B4, R7 |

La configuración previa de OMP en T3 no está en el git log de nixos, que solo
registra la instalación del paquete. La configuración de T3 vive en
`~/.t3/userdata/settings.json`, que nixos no versiona. La base de T3
(`statev2.sqlite`) conserva dos sesiones `acpRegistry` con la instancia `omp` del
2026-10-30, junto con su log ACP.

Además:

- Las extensiones no pueden invocar tools MCP arbitrarias (`invokeTool` solo invoca la misma tool).
- La CLI `t3 thread send --wait` solo espera el run, no el trabajo delegado.
- T3 no tiene plugins en runtime. Proveedores, secretos y control de versiones son paquetes compilados. Lo extensible son los ajustes de proveedor, los scripts de proyecto, las tareas programadas, los webhooks, las APIs MCP/CLI/HTTP/WS y los parches al código.
- `runOnSettle` corre al asentarse el thread (por inactividad o a mano) y solo en threads con worktree; no al terminar un run.

## 3. Lo que el diseño debe contemplar

1. **El orden FIFO se rompe tras una caída.** Si no hay un run activo, un envío nuevo arranca de inmediato y se adelanta a los retenidos (`Orchestrator.ts:1660-1690`). Antes de dictar, el puente revisa si hay runs retenidos y hace `queue.resume`.
2. **El bloqueo del coordinador espera a su hijo.** Sin esta regla, el coordinador queda bloqueado justo después de delegar y entrega un resultado provisional. `session_stop` no bloquea mientras haya un `taskId` pendiente (R5).
3. **Los dictados aparecen como del usuario.** El servidor fuerza `createdBy: "user"` y respeta `creationSource: "mcp"`. La autenticidad depende de que `before_agent_start` valide contra Dagu.
4. **El protocolo WebSocket es interno de T3.** Hay que fijar la versión de T3 y correr una prueba de contrato en cada actualización.
5. **El token es del operador.** Lo emite el operador. Se guarda el id del thread, nunca el token.
6. **El servidor de T3 se arranca fuera de OMP.** Si arranca dentro, el proceso OMP hereda `PI_SESSION_ID`, `PI_SESSION_FILE` y `PI_TOOL_CALL_ID` de otra sesión. La extensión usa `ctx.sessionManager.getSessionId()`.

## 4. Descartado

| Opción | Motivo |
|---|---|
| Proveedor Pi de T3 (`omp --mode rpc`) | T3 cierra el turno solo con `agent_settled`, que OMP no emite. También manda `clear_queue`, que OMP no conoce, y escucha nombres de eventos de compaction distintos a los de OMP. Sin ese evento, `delegate_task` nunca despertaría al coordinador. Un traductor propio dependería de un protocolo sin contrato. ACP lo reemplaza sin parches. |
| "T3 llama a Dagu" con comandos por paso (`admit`, `gate`, `integrate`) | La secuencia queda en la memoria del LLM, y un paso olvidado no lo detecta nadie. |
| "T3 llama a Dagu" con una sola entrada (`a4s next`) | Mete el bucle autónomo dentro de una sesión LLM durable, que es el problema de las sesiones OMP (§1). |
| "Dagu llama a T3" con `t3 thread start --worktree --wait` | El punto de entrada tiene que ser el operador en el coordinador. Además, `--wait` no espera el trabajo delegado. |
| `t3 thread send` como canal de dictado | No es idempotente. Su campo `delivery` dice `started` aunque el mensaje quede en cola. Lo reemplaza `message.dispatch` con `commandId` (B2). |
| La extensión consulta Dagu desde la sesión (el poll de `status`) | Muere con la sesión, y T3 libera la sesión tras 30 min de inactividad (`ProviderSessionManager.ts:57`). Ver §1. |
| `human.task` para el trabajo del coordinador | Dagu solo se entera si el LLM recuerda completarlo, y un turno terminado no significa trabajo terminado. Se usa solo para decisiones del operador. |
| Puntos de extensión de T3 para avisar el fin | T3 no carga plugins en runtime. `runOnSettle` no se dispara al terminar un run. Las tareas programadas y los webhooks no liberan colas retenidas (`Orchestrator.ts:5874-5879`). Un parche al código sería un fork. |
| Bus MQTT y el adaptador `synagent` de Claude (rama `origin/legacy`) | Fuera por decisión del operador. Solo interesaba como ejemplo de mecanismo de extensión. |

## 5. Punto de partida en el repo

En `feature`, Dagu ya lanza los roles como pasos deterministas. Lo que cambia es el
ejecutor: hoy es un `omp -p --no-session` headless, y pasa a ser un dictado al
coordinador, que delega. La dependencia real del LLM está en `poc`, `discovery` y
`planning`, donde el trabajo del modelo cuelga de un `human.task`.

| Pieza actual | Dónde | Destino |
|---|---|---|
| Roles headless `omp -p --no-session` | `role-jobs stage triage` y `implement` en `packages/issue-lifecycle/skills/issue-execution/feature.yaml:455,955`; `packages/issue-lifecycle/src/role-runtime.ts:56`; `role-runner.ts` | Dictado al coordinador y `delegate_task` |
| Trabajo del LLM bajo `human.task` | `poc.yaml`: `run_poc`, `fix_result`. `discovery.yaml`: `discover`, `validate`, `consolidate`. `planning.yaml`: `review` (instrucción `omp --no-extensions`, línea 117) | Pasos de dictado |
| `human.task` mecánicos | `dependency_review`, `conflict_review`, `recover_gate` y `recover_poc_scope`, resueltos con `nohup` y poll en `handler_on.wait` (`feature.yaml:2109`) | Pasos de shell (opcional) |
| Decisiones del operador | `escalation`, `start_primary_unavailable`, `close_primary_unavailable`, `poc_scope_decision`, `recover_start_gate`, `recover_push`, `validation`; `approve` en planning; `decide` en poc | Se quedan como `human.task` |
| Identidad `OMP_SESSION_ID` | 12 archivos de `packages/issue-lifecycle/src`, entre ellos `admission.ts:112`, `registration.ts:33` y `status/progress.ts` | Identidad a4s más una asociación al thread |
| Worktrees `.workspace/worktrees/issue-N` | `feature.yaml:48,228,813` | Los maneja T3 |
| Widget de estado con poll cada segundo | `packages/issue-lifecycle/src/status/index.ts`, `status/widget.ts` | Se retira; T3 no dibuja widgets (V1 del corte) |

## 6. Decisiones previas

1. **Aceptar el WebSocket interno.** El dispatch idempotente, la suscripción y `queue.resume` dependen de él. Se acepta con la versión de T3 fijada y la prueba de contrato, o se busca otra vía.
2. **La CI después del push.** En trunk, `REQUIRED_CHECK` y CodeQL corren después del merge local en `main` y push. Hay que definir qué bloquea y qué revierte. La protección de `main` permite ese flujo sin exigir `validate` antes de integrar ([Deployment](../operations/deployment.md#main-branch-protection-and-trunk-based-work)).
3. **La autoridad de push.** AGENTS.md exige autoridad explícita. Propuesta: se fija en el enqueue, y Dagu la verifica antes de integrar.
4. **La forma de ejecutarlo.** Issues por fase, o seguir como investigación.

## 7. Roadmap

Orden: F0 → F1 y F2+F3 (en paralelo) → F4 → F5 → F6 → F7. Cada fase se cierra con
commit en el worktree, merge local en `main` y push, pasando `npm test` y `npm run typecheck`, y su `test:live` con
los hosts reales. La CI corre después del push. Las pruebas unitarias no prueban la integración.

### F0 · Plataforma (del operador, en nixos)

- Fijar T3 0.1.6.
- Pin the OMP package as well; the native probes in §11 used `omp/18.16.0`. The OMP version for the earlier ACP evidence was not recorded here.
- Registrar la instancia `omp`: `acpRegistry`, fuente local, `omp acp -e <extensión del release en cache>`.
- Arrancar el servidor de T3 fuera de OMP.
- Definir el procedimiento del token (`t3 auth session issue`).
- Configurar el proyecto en T3:
  - setup `bash scripts/bootstrap.sh` con `runOnWorktreeCreate` y `async: false`;
  - `worktreeCleanup: custom` con `worktreeUnchanged`.
- Salida: un thread OMP en T3 carga la extensión de a4s.

### F1 · Puente `a4s dictate`

Un workspace nuevo, por ejemplo `packages/t3-bridge`.

- Cliente RPC sobre WS: `Request`, `Chunk` con `Ack`, `Exit`, `Ping`/`Pong`.
  - This is T3's orchestration WebSocket framing, not OMP's native RPC protocol or its request correlation IDs.
- `queue.resume` antes de dictar.
- `message.dispatch` idempotente con la clave `run:step:iteration` como `commandId`.
  - This deduplicates T3 dispatches, not tool side effects replayed during recovery; it is not an exactly-once execution guarantee.
- Espera por `subscribeThread` hasta que terminen el run y su trabajo delegado.
- Lee el resultado del estado del run y lo valida.
  - Derive Dagu's exit code from the final run status and validated structured result, not the parent CLI exit code. A present but invalid result is a failure, distinct from an absent result; parent exit 0 is not evidence of child success.
- Sale con códigos que Dagu reintenta (el mismo patrón que `exit_code: [75]`). Si falta el resultado, vuelve a dictar y cuenta; agotado el presupuesto, va a `escalation`.
- Prueba de contrato en `test:live` contra el T3 fijado.
- Salida: un DAG de prueba dicta, espera y valida.

### F2 · Extensión OMP del coordinador y los roles

En `packages/issue-lifecycle`, junto a `status/` y `triage/`.

- `session_start`: asociación al thread con `acp-mcp-call`. Guarda solo el id del thread.
- `before_agent_start`: valida el dictado contra el paso pendiente en Dagu.
- `tool_call` sobre `delegate_task`: impone rol, aislamiento y modelo de otra familia, con las políticas de `review-routing`.
  - Mira la llamada real `mcp__t3_code_delegate_task`, no el `write` previo a `xd://` (P2).
  - Exige un modelo explícito; rechaza `default` (P9).
  - Bloquea la tool nativa `task` de OMP, para que toda delegación sea un thread de T3 visible.
- `tool_call` niega push y merge a `main` fuera de Dagu. Así el coordinador no puede saltarse la puerta. Mejor todavía: que la credencial de push exista solo en Dagu.
- `tool_result`: registra `taskId` y `childThreadId` en el estado del run.
- `a4s_submit_result`: schema por paso, validado dentro de a4s.
- `session_stop`: bloquea sin resultado, salvo con un `taskId` pendiente.
- Los hijos cargan la misma extensión (R7) y toman su rol del dictado.
- La extensión tolera la sesión de descubrimiento de modelos, que no corre en un repo (P8).
- Solo inyecta en el coordinador lo que pide una acción. El estado de rutina se queda en Dagu.

### F3 · Identidad (en paralelo con F2)

- Cambiar `OMP_SESSION_ID` por la identidad a4s en el receipt y en `DECIDED_BY`.
- Guardar la asociación `{host: "t3", threadId, nativeId, lease}` como estado de runtime en `$DAGU_HOME`.
- Ajustar la admisión (`admission.ts:112`) y la tool de registro (`registration.ts`).

### F4 · Migrar los roles de `feature`

Es la primera migración: el flujo ya es determinista.

- `role-jobs stage` pasa a `a4s dictate`. `REBASE_RESOLVER` pasa a un dictado de `conflict-resolution`.
- Se conservan `JobBinding`, `JobResult` y la capacidad de `RoleJobStore`. La evidencia nativa pasa a ser el thread, el run y el modelo de T3 (V4 del corte).
- El prompt del rol pasa al dictado.
  - Hoy triage usa `packages/issue-lifecycle/agents/triage-reviewer.md`.
  - Implement y conflict-resolution usan el agente `task` que trae OMP, cuyo prompt no está en el repo (`role-runner.ts:67,77`). Hay que darles una definición propia del repo, por ejemplo `.omp/agents/implementer.md`.
- El modelo de cada rol lo fija hoy OMP con sus overrides de `task` (`role-runner.ts:78-79`). Pasa a fijarlo a4s en `target.model`.
- Se retiran `role-runtime.ts` y `role-runner.ts`.

### F5 · Migrar el trabajo del LLM en `poc`, `discovery` y `planning`

- Sus `human.task` de LLM pasan a dictados.
- Desaparece la instrucción de reanudar con `omp --no-extensions`.
- Opcional: los cuatro `human.task` mecánicos pasan a pasos de shell y se borra el `nohup` de `handler_on.wait`.

### F6 · Trunk y worktrees

Es la fase de mayor riesgo.

- Dagu pone PRIMARY en `origin/main` y dicta `implement` con `isolation: "worktree"`.
- Lee la rama y el worktree desde la proyección, ya con el nombre final.
- El hijo hace commit en el worktree; Dagu corre el gate ahí, hace merge local en `main` y push. La CI corre después del push.
- Se retiran los pasos de publicación y su reconciliación, reemplazados por la integración local y push.
- Issues en paralelo: actualizar contra el nuevo main con el rol de conflictos.

### F7 · Avisos y retiro

- Dagu avisa de las decisiones con un dictado al thread del coordinador, y el operador responde ahí.
- Completar un `human.task` debe venir de un mensaje del operador. La idea es comprobar `creationSource` (web frente a mcp).
- Se retiran el widget y el poll de `status`.
- Retiro a decidir: `agent-messaging` y `message-bus` (MQTT), y `orca-integration` si T3 reemplaza a Orca.

## 8. Relación con los issues

Estados consultados con `gh` el 2026-11-03.

| Issue | Estado | Qué dice | Con esta arquitectura |
|---|---|---|---|
| #918 (épica P0) | abierto | Cada rol corre como subagente nativo de la sesión coordinadora. Ningún rol es headless. OMP es el coordinador semántico en una sesión TUI. | La regla sin headless se cumple en F4 y F5. La coordinadora pasa de una TUI a un thread de T3, y los roles pasan a hijos de `delegate_task`. Hay que reescribir las invariantes 1 a 4 sin atarlas a un host, como pide el corte (§7). |
| #919, #920 (spikes P0) | abiertos | #919 es la línea base A. #920 compara la coordinación LLM corregida (B) con el control procedimental determinista (C), y exige cero headless. | Esta arquitectura es un candidato para C. #920 depende de #919. |
| #893 (fachada MCP) | abierto | Guard tipado, portabilidad de host y push de eventos sobre la CLI de a4s | Se cruza con F1 y F2. Hay que decidir si el puente o la tool de resultado viven ahí. |
| #510, #513, #791 | cerrados | Origen de la ruta headless: roles independientes del coordinador y sin sus turnos, sobre el `omp` compilado | F4 la retira. Todavía no hay un issue para eso; según #918 se deriva después de #920. |
| #885 | cerrado | Sesiones especialistas independientes | Cancelado en #918. |
| #731, #496, #270, #551 | abiertos | Coordinadora TUI dirigible, aceptación integrada con hijos de la TUI, documentación y compatibilidad OMP de la delegación nativa | Hay que reescribirlos para un thread de T3 con `delegate_task`. El riesgo de #551 pasa a ser la prueba de contrato de F1 y la compatibilidad de OMP por ACP. |
| #501 | abierto | Un único ingreso de eventos de Dagu, con replay tras una ausencia | Lo reemplaza el dictado durable e idempotente de F1. |
| #505 | abierto | Bus de mensajes como canal lateral | Obsoleto: no se usa MQTT. |
| #499, #503, #884, #441 | abiertos | Lease del coordinador, admisión por el coordinador efectivo, traspaso a una sesión sucesora, sesiones ligadas al repo | Hay que rehacerlos sobre la identidad a4s y su asociación al thread (F3). |
| #882 | abierto | Tracker de estabilización | Hay que ubicar aquí las fases si se adoptan. |

## 9. Pendiente o no verificado

1. **Que la extensión vea `creationSource`.** Lo necesita F7.
2. **Rendimiento con varios runs.** El coordinador atiende un dictado a la vez. Con la regla de `session_stop`, su turno termina al delegar y entra el siguiente. Falta medirlo con issues en paralelo.
3. **Los pendientes del corte (§8)** sobre setup, nombres de rama, limpieza e integración en main siguen abiertos.
4. **Un coordinador efímero por evento**, en vez de uno durable. Eliminaría la sesión larga; no se probó.
5. **Pedirle a T3 que exponga `workspaceStrategy` en `delegate_task`.** El comando interno `delegated_task.request` ya lo acepta. Pedirlo es una acción externa y la decide el operador.
6. **El observador de otra familia ante una escalada:** diseñado, no probado.
7. **Las citas de la investigación en línea hecha con `grok-4.3`** (referencias a cambios e issues de T3) siguen sin verificar, como dice el corte (§8).

## 10. Estado del entorno al cierre

- **Restaurado:** el `settings.json` de T3 tiene un sha256 idéntico al del respaldo; la instancia `omp` ya no existe.
- **Revocado:** el token del puente, y su archivo está borrado.
- **Fuera del repo:** las extensiones de prueba, el cliente del puente y sus logs están en directorios temporales, sin adoptar.
- **Por archivar en T3 (proyecto Scratch):** los threads de prueba "a4s probe OMP …", el coordinador de la prueba de delegación y su hijo.
- **Cambiado:** la protección de `main` (ver [Deployment](../operations/deployment.md#main-branch-protection-and-trunk-based-work)).

## 11. Addendum 2026-11-03: installed OMP and integration boundaries

The decision remains **T3 Code + OMP**, with the existing F0–F7 order and scope. These native-runtime and alternative-host probes do not rewrite the R/P/B evidence in §2 or the 2026-11-02 evaluation. The OMP version used for those earlier ACP rows was not recorded here. The native delegation and RPC acceptance records identify the installed runtime as `omp/18.16.0`; F0 must pin OMP as well as T3. Native OMP success does not itself validate T3 integration: F2 continues to block native `task` so delegation remains visible as T3 threads.

**Evidence scope after the 2026-11-04 no-headless-agents decision** ([super-agent roadmap §3, decision 6](super-agent-roadmap.md#3-decisiones-del-operador-previas-al-roadmap)): no agent may run headless (`-p`/print, script-driven RPC/JSON mode, or SDK without UI). The RPC rows below (`--resume`, request-ID correlation, RPC acceptance) describe OMP behavior but are not evidence for this architecture's runtime path; they must be reproduced with OMP in its TUI under Tern before an F-phase depends on them. Infrastructure without UI (Temporal server, Dagu, Bun workers) is unaffected.

### Dispatch, correlation and result validation

- B2 remains evidence for T3 `message.dispatch`: the same `commandId` returns the same `sequence` without a second run. It was not retested in this session.
- F1's `Request`, `Chunk`/`Ack`, `Exit` and `Ping`/`Pong` belong to T3's orchestration WebSocket. They are not OMP RPC request IDs. Two sequential, completed OMP RPC prompts with the same request ID both ran: the ID correlated responses rather than deduplicating execution.
- Native strict `yield` rejected an invalid payload and accepted a corrected payload. In a separate exhaustion probe, its fourth invalid submission was accepted by the tool with `schemaOverridden: true`, but final strict task validation still returned a failed job and `structured.status: invalid`. The parent CLI exited 0 despite that child failure. Neither a tool-level "Result submitted" message nor the presence of structured data proves success. F1 must use final status and validate the result. Invalid data is a failure, not an absent result to handle through the missing-result path. This is native result validation, distinct from registered-tool input validation in P5; permissive result mode was not tested.

### Recovery and delivery

OMP's RPC `--resume` retained session identity, history and a recalled nonce; wire messages were not byte-identical because a live `errorId: 0` field was absent after reload. RPC `--restore` was rejected as interactive-only. Separate interactive hard-crash probes restored an active parent turn and an active child with persisted identity and history. The child probe killed the original parent only: an interrupted `bash` sleep was replayed, while one child write and one `yield` were recorded. Completion arrived through both the parent's `wait` and an additional async-result notice. This is recovery evidence, not exactly-once tool execution or exactly-once delivery.

R10's ACP `initialize` + `session/load` after inactivity is a different mechanism; R10 and B4's retained queue were not retested. There was no end-to-end Dagu–a4s–OMP crash-recovery test or equivalent T3 crash retest in this session. The native findings neither close those integration questions nor establish an absence of T3 recovery.

The alternative host was **Stencil's Tern 0.9.10 (`2ad447b`)**, not `tern.build` and not OMP itself. Its results must stay scoped to that host and probe:

- Two distinct CLI sends with the same terminal-input label produced two effects; this was not a retry using one transport request ID. Acknowledged but unconsumed input produced no effect after daemon restart, and the generic receiver was not relaunched. Terminal-input acknowledgement was not a durable application commit.
- Reconnecting observers could inspect completed terminal scrollback, but the completion event was not replayed. Repeated `wait` calls reread completed status; they were not evidence of duplicate structured-result acceptance.
- The real isolated daemon automatically relaunched the same pane with OMP `--restore` pointing to the original persisted parent. The previously active child showed no progress, effect, result or delivery within 100 seconds after restart. No manual restore was issued and no normal graphical window was attached; successful restore initialization and the effect of attaching a window remain unverified. This is not a production failure finding for T3 or OMP.
- Standalone headless `serve` excludes restored sessions by design and is not an equivalent daemon-recovery test. The attempted agent-API launching-VM reset did not establish a recovery guarantee.

### Workspaces and models

Native OMP ran parallel shared and isolated children, and a nested shared grandchild, with valid strict results. Workspace lifetime differed between native probes: one isolated worktree was removed after patch capture; another retained the completed child's artifact while the parent was alive but disappeared on full parent exit. Neither establishes a retained workspace for a later Dagu gate. Separately, a gate in an externally owned worktree retained the same path, HEAD and content across an isolated Tern daemon stop/start. That is not a T3 worktree test. F6 still reads branch and worktree from T3's projection; `worktreeUnchanged` and the other execution gaps in §9.3 remain open.

Explicit GPT role routing completed native tasks. An explicit Gemini override resolved to the requested effective model without fallback but timed out without a structured result. Automatic load-, token- or quota-aware model balancing was not exercised; explicit role/agent routing is not evidence of such balancing. Substantive GPT and `deepseek-v4-flash-0731` reviews were observed through Tern's CLI, not T3 `delegate_task`. Effective model metadata does not independently verify upstream weights. The cross-family escalation observer in §9.6 remains untested. The §2 summary's phrase "hijo de otra familia sin extensión" does not establish an extension-free child: R7 used the shared extension, as F2 requires.

### Evidence scope

The inspected records below are temporary probe artifacts, not durable committed evidence. Paths are relative to their temporary parent directory:

- `omp-native-delegation.ca8bAF/acceptance.json`, `omp-native-delegation.ca8bAF/acceptance-addendum.json`, and `omp-native-delegation.ca8bAF/acceptance-exhaustion.json`.
- `omp-child-restore-boY26i/exact-run/acceptance.json`.
- `omp-interactive-restore-Ck6Sw7/hard-crash-persisted/acceptance.json`.
- `omp-rpc-recovery-wu9gnIYf/acceptance.json`.
- `tern-transport.Oxzehu/acceptance.json`.
- `tern-workspace-review.eeCJfI/evidence.json`.
- `tern-recovery.pLSksp/daemon-run-absolute/acceptance.json`.
