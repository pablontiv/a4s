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

Cambios respecto del corte: el coordinador y los hijos corren OMP en vez de Claude
(acuerdos 1 y 6 del corte), y Dagu dicta los pasos por el WebSocket de T3 (el corte,
§5, lo había descartado). El resto de los acuerdos se mantiene: trunk sin PR,
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

Además:

- Las extensiones no pueden invocar tools MCP arbitrarias (`invokeTool` solo invoca la misma tool).
- La CLI `t3 thread send --wait` solo espera el run, no el trabajo delegado.
- T3 no tiene plugins en runtime. Proveedores, secretos y control de versiones son paquetes compilados. Lo extensible son los ajustes de proveedor, los scripts de proyecto, las tareas programadas, los webhooks, las APIs MCP/CLI/HTTP/WS y los parches al código.
- `runOnSettle` corre al asentarse el thread (inactividad, merge del PR o a mano) y solo en threads con worktree; no al terminar un run.

## 3. Lo que el diseño debe contemplar

1. **El orden FIFO se rompe tras una caída.** Si no hay un run activo, un envío nuevo arranca de inmediato y se adelanta a los retenidos (`Orchestrator.ts:1660-1690`). Antes de dictar, el puente revisa si hay runs retenidos y hace `queue.resume`.
2. **El bloqueo del coordinador espera a su hijo.** Sin esta regla, el coordinador queda bloqueado justo después de delegar y entrega un resultado provisional. `session_stop` no bloquea mientras haya un `taskId` pendiente (R5).
3. **Los dictados aparecen como del usuario.** El servidor fuerza `createdBy: "user"` y respeta `creationSource: "mcp"`. La autenticidad depende de que `before_agent_start` valide contra Dagu.
4. **El protocolo WebSocket es interno de T3.** Hay que fijar la versión de T3 y correr una prueba de contrato en cada actualización.
5. **El token es del operador.** Lo emite el operador. Se guarda el id del thread, nunca el token.
6. **El servidor de T3 se arranca fuera de OMP.** Si arranca dentro, el proceso OMP hereda `PI_SESSION_ID`, `PI_SESSION_FILE` y `PI_TOOL_CALL_ID` de otra sesión. La extensión usa `ctx.sessionManager.getSessionId()`.

## 4. Punto de partida en el repo

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
| Flujo con PR | Pasos `pr` a `authorize_ci` (`feature.yaml:1637-1826`); `gh pr checks` y `gh pr merge` en `reconcile.yaml` | Integrar en main y hacer push |
| Widget de estado con poll cada segundo | `packages/issue-lifecycle/src/status/index.ts`, `status/widget.ts` | Se retira; T3 no dibuja widgets (V1 del corte) |

## 5. Decisiones previas

1. **Aceptar el WebSocket interno.** El dispatch idempotente, la suscripción y `queue.resume` dependen de él. Se acepta con la versión de T3 fijada y la prueba de contrato, o se busca otra vía.
2. **La CI sin PR.** Hoy `REQUIRED_CHECK` y CodeQL filtran antes del merge. En trunk corren después del push. Hay que definir qué bloquea y qué revierte.
3. **La autoridad de push.** AGENTS.md exige autoridad explícita. Propuesta: se fija en el enqueue, y Dagu la verifica antes de integrar.
4. **La forma de ejecutarlo.** Issues por fase, o seguir como investigación.

## 6. Roadmap

Orden: F0 → F1 y F2+F3 (en paralelo) → F4 → F5 → F6 → F7. Cada fase se cierra con
commit en main y push, pasando `npm test` y `npm run typecheck`, y su `test:live` con
los hosts reales. Las pruebas unitarias no prueban la integración.

### F0 · Plataforma (del operador, en nixos)

- Fijar T3 0.1.6.
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
- `queue.resume` antes de dictar.
- `message.dispatch` idempotente con la clave `run:step:iteration` como `commandId`.
- Espera por `subscribeThread` hasta que terminen el run y su trabajo delegado.
- Lee el resultado del estado del run y lo valida.
- Sale con códigos que Dagu reintenta (el mismo patrón que `exit_code: [75]`). Si falta el resultado, vuelve a dictar y cuenta; agotado el presupuesto, va a `escalation`.
- Prueba de contrato en `test:live` contra el T3 fijado.
- Salida: un DAG de prueba dicta, espera y valida.

### F2 · Extensión OMP del coordinador y los roles

En `packages/issue-lifecycle`, junto a `status/` y `triage/`.

- `session_start`: asociación al thread con `acp-mcp-call`. Guarda solo el id del thread.
- `before_agent_start`: valida el dictado contra el paso pendiente en Dagu.
- `tool_call` sobre `delegate_task`: impone rol, aislamiento y modelo de otra familia, con las políticas de `review-routing`.
- `tool_result`: registra `taskId` y `childThreadId` en el estado del run.
- `a4s_submit_result`: schema por paso, validado dentro de a4s.
- `session_stop`: bloquea sin resultado, salvo con un `taskId` pendiente.
- Los hijos cargan la misma extensión (R7) y toman su rol del dictado.

### F3 · Identidad (en paralelo con F2)

- Cambiar `OMP_SESSION_ID` por la identidad a4s en el receipt y en `DECIDED_BY`.
- Guardar la asociación `{host: "t3", threadId, nativeId, lease}` como estado de runtime en `$DAGU_HOME`.
- Ajustar la admisión (`admission.ts:112`) y la tool de registro (`registration.ts`).

### F4 · Migrar los roles de `feature`

Es la primera migración: el flujo ya es determinista.

- `role-jobs stage` pasa a `a4s dictate`. `REBASE_RESOLVER` pasa a un dictado de `conflict-resolution`.
- Se conservan `JobBinding`, `JobResult` y la capacidad de `RoleJobStore`. La evidencia nativa pasa a ser el thread, el run y el modelo de T3 (V4 del corte).
- Se retiran `role-runtime.ts` y `role-runner.ts`.

### F5 · Migrar el trabajo del LLM en `poc`, `discovery` y `planning`

- Sus `human.task` de LLM pasan a dictados.
- Desaparece la instrucción de reanudar con `omp --no-extensions`.
- Opcional: los cuatro `human.task` mecánicos pasan a pasos de shell y se borra el `nohup` de `handler_on.wait`.

### F6 · Trunk y worktrees

Es la fase de mayor riesgo.

- Dagu pone PRIMARY en `origin/main` y dicta `implement` con `isolation: "worktree"`.
- Lee la rama y el worktree desde la proyección, ya con el nombre final.
- Corre el gate en ese worktree, integra en main y hace push.
- Se retiran los pasos `pr` a `authorize_ci` y las partes de PR de `reconcile.yaml`.
- Issues en paralelo: actualizar contra el nuevo main con el rol de conflictos.

### F7 · Avisos y retiro

- Dagu avisa de las decisiones con un dictado al thread del coordinador, y el operador responde ahí.
- Completar un `human.task` debe venir de un mensaje del operador. La idea es comprobar `creationSource` (web frente a mcp).
- Se retiran el widget y el poll de `status`.
- Retiro a decidir: `agent-messaging` y `message-bus` (MQTT), y `orca-integration` si T3 reemplaza a Orca.

## 7. Pendiente o no verificado

1. **Que la extensión vea `creationSource`.** Lo necesita F7.
2. **Rendimiento con varios runs.** El coordinador atiende un dictado a la vez. Con la regla de `session_stop`, su turno termina al delegar y entra el siguiente. Falta medirlo con issues en paralelo.
3. **Los pendientes del corte (§8)** sobre setup, nombres de rama, limpieza e integración en main siguen abiertos.
