# a4s sobre T3 Code: corte de acuerdos y validaciones

Fecha: 2026-11-02. Estado: evaluación. Este documento no cambia código ni configuración de a4s.

Fuentes:

- Código de T3: `pingdotgg/t3code`, rama `main` (servidor 0.1.6), obtenido con `opensrc`. Las rutas `apps/…` y `packages/…` de este documento son de ese repo.
- Pruebas: corridas en sesiones de Claude alojadas en T3 sobre un checkout local de a4s.

## 1. Acuerdos

1. **T3 Code es el orquestador.** Claude Code es solo el runtime. En T3 se usa únicamente el provider Claude. Los demás modelos (GPT, Grok, etc.) llegan por el gateway con `target.model`.
2. **El coordinador es un thread de Claude en T3**, ubicado en PRIMARY y en main.
3. **Todo el trabajo de LLM lo maneja el coordinador.** Se eliminan las llamadas headless de a4s (`omp -p`, role-runner, etc.).
4. **Dagu es determinista:** solo pasos de shell y CLI.
5. **Los subagentes se lanzan con `delegate_task` de T3.** No se usan:
   - los subagentes nativos de Claude;
   - el bus MQTT;
   - `t3 thread send` como canal de retorno.
6. **La extensión del lado de Claude es un plugin de function hooks** (`on(event, …)`), no hooks en `settings.json`.
7. **La identidad es un nombre universal de a4s**, no atado a un harness. El host (thread de T3) se asocia aparte.
8. **Un worktree = un feature, issue o fix**, manejado por T3 según su configuración.
9. **Trunk-based: commit en el worktree, merge local a `main` y push; la CI corre después del push.**
10. **Ubicación de worktrees:** el valor global por defecto de T3, `~/.t3/worktrees/<repo>/<rama>`.
11. **Todo supuesto sobre T3 se confirma en su código.**

## 2. Arquitectura resultante

```
Coordinador (Claude + T3, PRIMARY en main)          ← identidad a4s
 └─ delegate_task isolation:"worktree"               → thread del issue: 1 worktree, 1 rama
     └─ delegate_task isolation:"shared"             → PoC, reviewers, fixes: mismo worktree
Dagu (determinista): actualizar main → gate → integrar en main → push
Plugin a4s (function hooks) en cada sesión de Claude: guards, tool de resultado, contratos
```

Flujo por issue:

1. a4s pone PRIMARY en `origin/main`.
2. El coordinador lanza `delegate_task` con `isolation: "worktree"`. T3 crea el worktree, corre el setup y nombra la rama.
3. El hijo del issue delega a sus propios subagentes con `shared` y hace commit en su worktree.
4. Cuando termina todo el trabajo del hijo, T3 despierta al coordinador **una sola vez**.
5. Dagu corre el gate en el worktree del hijo, hace merge local en `main` y push; la CI corre después del push.
6. T3 borra el worktree con la regla `worktreeUnchanged`.

## 3. Validado en ejecución

| # | Prueba | Resultado |
|---|---|---|
| V1 | Plugin de function hooks en una sesión de Claude dentro de T3 | Carga. `/reload-plugins` funciona con el thread abierto. `$.prompt.submit` despierta la sesión. T3 no ofrece dónde dibujar widgets. |
| V2 | `tool.call` sobre `mcp__t3-code__delegate_task` y `t3_thread_launch` | Rechaza la llamada (`{ deny }`) aunque T3 los habilite con `--allowedTools`. El hook ve el input completo, incluido `target.model`. |
| V3 | Tool registrada por el plugin (`$.tool.register`) dentro de hijos de `delegate_task` | Disponible, también en un hijo con modelo de gateway (`gpt-6.1-terra`). **El engine no aplica `inputSchema`**: `verdict: "maybe"` llegó al handler. **Una tool visible en todas las sesiones se usa sin que nadie la pida.** |
| V4 | Modelo usado por un hijo | Lo traen el resultado de `delegate_task` (`model`) y `t3_thread_read` (`model` del thread y de cada run). Es el modelo que T3 eligió y registró; el proveedor no lo confirma. |
| V5 | Delegación anidada | El hijo con `worktree` quedó en `~/.t3/worktrees/a4s/t3-a6368721`, con base en el HEAD del coordinador (`423f438`). La rama `t3/<hex>` se renombró a `t3/a4s-nested-delegation-test`. Quedó `relationshipToParent: "subagent"`. El sub-hijo `wait`/`shared` trabajó en el mismo worktree y rama. El sub-hijo `async`/`shared` despertó al hijo. El coordinador recibió **un único aviso**, cuando terminó todo. |
| V6 | `worktreesDirectory` relativo (`.workspace/worktrees`) | Falla toda creación de worktree. Ya se corrigió (ver §8). |
| V7 | `t3 thread send` desde un shell sin el entorno de T3 | Funciona: si el thread está libre abre turno; si está ocupado, el mensaje espera en cola. Queda **descartado** como canal de retorno (§5). |
| V8 | `t3_thread_launch` con `existing_worktree` | Se asocia al worktree. Queda **descartado** para workers: no avisa al terminar (§5). |

## 4. Confirmado en el código de T3

### Delegación

- **El modo async despierta al padre con cada final del hijo** (`completionWake: "always"`). En modo `wait` solo lo despierta si el padre ya no estaba esperando (`settled_only`). Fuente: `apps/server/src/mcp/OrchestratorMcpService.ts` (handler de `delegate_task`).
- **`delegate_task` con `isolation: "worktree"`** usa como base el HEAD del checkout del padre, con `startFromOrigin: false` fijo. El ajuste `newWorktreesStartFromOrigin` no aplica. Fuente: `OrchestratorMcpService.ts:2389-2421`.
- **`delegate_task` solo acepta `shared` o `worktree` nuevo.** No acepta `existing_worktree`, ni `branch`, ni un `target.projectId` distinto del padre.
- **El comando interno sí acepta más.** `delegated_task.request` trae `workspaceStrategy`, pero la tool MCP no lo expone. Fuente: `packages/contracts/src/orchestrationV2.ts`.
- **El hijo con `shared` copia la rama y el worktree del padre.** Fuente: `packages/provider-core/src/server/subagentProjection.ts` (`...input.parentThread`).
- **El hijo con `worktree` usa la misma preparación que `t3_thread_launch`.** Fuentes: `Orchestrator.ts` (`defer_start`) y `ThreadLaunchService.ts:300-640`.

### Threads lanzados

- **Siempre nacen sin padre** (`parentThreadId: null`).
- **`delegatedFrom` se descarta** si no lo marca el servidor; solo existe para delegación remota. Fuentes: `ThreadManagementService.ts` (`withCreationProvenance`) y `Orchestrator.ts` (`thread.create`).

### Worktrees

- **Ubicación:** `worktreesDirectory` es un ajuste de toda la máquina y tiene que ser una ruta absoluta.
  - La ruta del worktree es `<ubicación>/<carpeta del repo>/<rama con "/" cambiado por "-">`.
  - No hay override por proyecto ni por `t3.json`.
  - Fuentes: `git/GitManager.ts:746-762`, `vcs/GitVcsDriverCore.ts:4125-4150`, `worktreesDirectory.ts`, `packages/contracts/src/settings.ts`.
- **Nombre de rama:** `branchNamingMode` (`static`, `semantic` o `custom`), `branchNamePrefix` y `branchNameInstructions` se configuran por proyecto.
  - En los tres modos el texto lo genera un modelo: `static` pone el prefijo más un slug saneado; `custom` usa el texto tal cual.
  - Se crea como `t3/<hex>` y se renombra en segundo plano.
  - Fuentes: `settings.ts`, `packages/shared/src/git.ts`, `ThreadLaunchService.ts:373-377,478-500`.
- **Setup:** el servidor corre el script del proyecto marcado `runOnWorktreeCreate`, también para los hijos. Con `async: false` el agente espera a que termine.
  - Los scripts salen de la configuración del proyecto. Los de `t3.json` hay que **importarlos**; T3 no los carga solo.
  - El proyecto a4s hoy tiene `scripts: []`.
  - Fuentes: `ThreadLaunchService.ts:571-620`, `project/ProjectSetupScriptRunner.ts:422`, `packages/shared/src/projectScripts.ts`.
- **`t3.json` solo acepta** `$schema`, `iconPath`, `defaultThreadEnvMode`, `worktreeSubmodules` y `scripts`. Es igual en `main` y en la 0.1.6 instalada. Fuente: `packages/contracts/src/t3ProjectFile.ts`.
- **Limpieza tras integrar:** `worktreeUnchanged` borra el worktree cuando su HEAD ya está contenido en `origin/<rama por defecto>`; antes hace un fetch.
  - La frenan una sesión del agente todavía abierta, una terminal abierta, o `worktreeKeepWhen` (por defecto protege cambios sin commitear).
  - La rama no se borra.
  - Fuente: `storageCleanup.ts:880-1120`.
- **Recreación:** si el worktree falta al empezar un turno, T3 lo recrea desde la rama local. **Al recrearlo no corre el setup**, así que se pierden los archivos ignorados. Fuente: `ProviderTurnStartService.ts:191-225,636-670`.
- **Integrar en main no es trabajo de T3:** no trae una operación para eso. `defaultAutoPull` solo actúa al arrancar el servidor. Fuentes: `vcs/GitVcsDriverCore.ts`, `serverRuntimeStartup.ts:192-200,575`.
- **Cambios de configuración:** el servidor vigila `settings.json` y lo vuelve a leer al cambiar. Fuente: `serverSettings.ts:1211-1292`.

## 5. Descartado

| Opción | Motivo |
|---|---|
| Subagentes nativos de Claude (`Agent`, redirección con `WorktreeCreate`) | Acuerdo 5. Además ignoran `cwd`. |
| Bus MQTT | Era solo un ejemplo de tecnología de extensión. |
| Workers con `t3_thread_launch` (`existing_worktree`) | No avisa al terminar y `delegatedFrom` se descarta. |
| `t3 thread send` o un watcher de Dagu como retorno | `delegate_task` ya avisa al terminar. |
| `delegated_task.request` por el WebSocket interno | Protocolo interno y frágil. |
| Dagu creando `.workspace/worktrees/issue-N` | Los worktrees los maneja T3 (acuerdo 8). |
| Carpeta de worktrees por repo o en `t3.json` | T3 no lo soporta (§4). |

## 6. Lo que a4s tiene que construir o cambiar

### Plugin de function hooks

| Pieza | Base |
|---|---|
| Guards de admisión, de mutación del run y de PRIMARY con `tool.call` | V2 |
| Regla cross-family con `tool.call` sobre `delegate_task`: rechaza según `target.model` | V2 |
| Tool de resultado de roles: valida el schema dentro de a4s y **solo se registra en sesiones de rol**, según la identidad | V3 |
| Contratos del coordinador y de cada rol con `prompt.compose` | No probado |

### Identidad

- Un nombre lógico de a4s para el coordinador y para cada rol, guardado en el receipt y en `DECIDED_BY`.
- Una asociación aparte, `{host: "t3", address: <threadId>, lease}`, como estado de runtime en `$DAGU_HOME`.
- `owner-session.ts` ya acepta un texto opaco. `OMP_SESSION_ID` aparece en unos 10 archivos de `packages/issue-lifecycle/src`.

### Dagu

- Antes de cada delegación, poner PRIMARY en `origin/main`.
- Leer la rama y el worktree del hijo desde T3, ya con el nombre final.
- Correr el gate en el worktree con el commit del hijo, hacer merge local en `main` y push, con las reglas de autoridad de AGENTS.md; la CI corre después del push.
- Cuando hay issues en paralelo, actualizar contra el nuevo main con el rol de conflictos.
- Dejar de crear worktrees.

### Configuración del proyecto a4s en T3 (no aplicada)

- Script de setup `bash scripts/bootstrap.sh` con `runOnWorktreeCreate` y `async: false`, versionado en `t3.json` e importado al proyecto.
- Nombres de rama.
- `worktreeCleanup: custom` con `worktreeUnchanged`.
- `worktreeKeepWhen`.

## 7. Impacto en los issues

- **#918:** reescribir las invariantes 1 a 4 en términos neutrales respecto al host (coordinador = identidad a4s; el host transporta). Las 5 a 7 no cambian.
- **#920:** la opción B pasa a ser T3 + Claude. **#893** (fachada MCP) se vuelve central.
- **Cadena de identidad** (#499, #501, #503, #884, #505, #441): reescribir alrededor de la identidad y su asociación.
- **Obsoletos o casi:** #151, #872, el widget y los transcripts de #351 y #850, la parte de #886 que cancela role jobs, y la parte de #551 sobre el runner de OMP.
- **Falta un issue para quitar las llamadas headless.** La aceptación A5 de #882 depende de ellas.
- **También cambian** la convención `.workspace/worktrees/issue-N`, el mensaje del guard de PRIMARY (`primary-guard/guard.ts:93`) y el flujo de integración local en `main` y push.

## 8. Pendiente o no verificado

1. **Canal de Dagu al coordinador** para decisiones, stalls y fallos del gate. Lo propuesto: el plugin consulta el estado con la CLI de a4s y despierta con `$.prompt.submit`, como en V1. Falta acordarlo.
2. **Regla cross-family:** se validó el rechazo, no la reescritura del modelo.
3. **Setup con el bootstrap de a4s en un worktree de T3:** no probado.
4. **Nombres de rama** con instrucciones `custom` (por ejemplo, número de issue): no probado.
5. **Limpieza `worktreeUnchanged` en ejecución real:** no probada.
6. **Integración en main desde el worktree del hijo** (gate, integración, push) e issues en paralelo: no probados.
7. **Diseño de la identidad y su asociación:** no validado.
8. **Referencias a cambios e issues de T3 que citó la investigación con `grok-4.3`** (#16719, #17412, #17415, #11266): no verificadas. Los nombres de mecanismos que citó sí existen en el código.

## 9. Estado del entorno al cierre

- **Cambiado:** en la configuración de T3 (`~/.t3/userdata/settings.json`) se quitó `worktreesDirectory: ".workspace/worktrees"`. Ahora usa el valor por defecto.
- **Cambiado después del corte:** para aplicar el acuerdo 9 (trunk), la protección de `main` permite el merge local y push, sin exigir el check `validate` antes de integrar. El detalle está en [Deployment](../operations/deployment.md#main-branch-protection-and-trunk-based-work).
- **Restaurado:** el plugin de prueba quedó desinstalado y la configuración de Claude, idéntica a la previa.
- **Limpio:** el checkout de a4s, y las ramas y worktrees de prueba.
- **Por archivar:** los threads de prueba ("a4s probe …").
- **Temporales fuera del repo:** el plugin de prueba con sus evidencias, y la copia del código de T3 obtenida con `opensrc`.
