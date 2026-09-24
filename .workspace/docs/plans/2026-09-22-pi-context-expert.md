# Pi Context Expert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Renombrar la extensión a `pi-context-expert` y entregar configuración inmediata, comandos `ce-`, recap semántico con Jev y hints de compaction accionables.

**Architecture:** La extensión conserva Pi como autoridad de lifecycle y Jev como selector semántico. Un runtime mutable conserva la configuración validada; `/ce-settings` la persiste de forma atómica antes de aplicarla, y cada hook lee el valor vigente. `/ce-recap` selecciona evidencia saneada mediante preguntas Jev tipadas y renderiza excerpts deterministas, con fallback local.

**Tech Stack:** TypeScript ESM, Node test, `@earendil-works/pi-coding-agent` 0.87, `@earendil-works/pi-tui` `SettingsList`, `@earendil-works/pi-ai`, Jev 1.13.0.

**Spec:** `.workspace/docs/specs/2026-09-22-pi-context-expert-design.md`

## Global Constraints

- No conservar aliases, migración ni lectura de `pi-rule-compiler`, su archivo global, sus comandos o sus custom entries.
- Pi no se modifica: `/ce-settings` es una UI de extensión basada en `SettingsList`, no una contribución a `/settings`.
- Mantener la redacción antes de digest, persistencia y toda llamada Jev; nunca incluir texto raw o credenciales en diagnósticos.
- La compaction conserva fallo cerrado sin fallback nativo; el recap falla de forma degradable y no altera lifecycle.
- Cada Bead ejecuta tests offline del paquete, typecheck, `git diff --check` y el E2E del producto sólo cuando sus credenciales reales estén autorizadas por separado.

## Review Focus

- Archivo de settings truncado, desconocido o no escribible: debe conservar el runtime seguro previo; Task 2 lo prueba.
- Cambio `ladder -> basic` durante una sesión: la siguiente proyección debe devolver el contexto Pi sin llamada Jev; Task 2 lo prueba.
- Un slash command antiguo restaurado desde sesión o enviado manualmente: no debe registrarse ni ejecutar comportamiento; Task 3 lo prueba.
- Recap con secreto, timeout o respuesta Jev inválida: no revela el texto ni llama al modelo activo; Task 4 lo prueba.
- Contexto grande por prompt/sistema pero sin mensajes compactables: no debe anunciar `/compact`; Task 5 lo prueba.

---

## File map

| Path | Responsibility |
| --- | --- |
| `packages/pi-context-expert/src/config.ts` | Schema, lectura y escritura atómica de la configuración global nueva. |
| `packages/pi-context-expert/src/context-runtime.ts` | Estado mutable y validado que los hooks consultan en caliente. |
| `packages/pi-context-expert/src/settings.ts` | Adaptador `SettingsList` y `/ce-settings`. |
| `packages/pi-context-expert/src/rules-command.ts` | Parser y dispatcher de `/ce-rules`. |
| `packages/pi-context-expert/src/recap.ts` | Request Jev, validación, selección y renderer determinista de recap. |
| `packages/pi-context-expert/src/extension.ts` | Wiring de lifecycle, runtime y los tres comandos públicos. |
| `packages/pi-context-expert/src/trigger.ts` | Gate de contenido compactable antes de hint/auto. |
| `packages/pi-context-expert/test/*.test.ts` | Pruebas unitarias e integración offline por entrega. |

## Task 1: Renombrar el producto sin compatibilidad

**Files:**
- Move: `packages/pi-rule-compiler/` → `packages/pi-context-expert/`
- Modify: `package.json`, `package-lock.json`
- Modify: `packages/pi-context-expert/package.json`, `src/index.ts`, `src/extension.ts`, `src/storage.ts`, scripts, README y tests que contengan la identidad anterior
- Modify: `.workspace/docs/references/jev-engineering-for-coding-agents.md` y los documentos activos que describan la superficie instalada
- Test: `packages/pi-context-expert/test/extension.test.ts`, `test/test_repository_contract.py`

**Interfaces:**
- Produces: paquete workspace `@a4s/pi-context-expert`, `registerPiContextExpert(pi, options)` y `PiContextExpertOptions`.
- Preserves: shapes de compaction, corpus, evidence y proposals; sólo cambian sus prefijos `a4s.pi-context-expert.*`.

- [ ] **Step 1: Escribir pruebas de identidad nueva**

Añadir una prueba de entrypoint que cree `~/.pi/agent/pi-context-expert.json`, cargue el export default y verifique que se registra. Añadir una aserción negativa que cree sólo `pi-rule-compiler.json` y compruebe que no habilita Ladder.

```ts
writeFileSync(join(configDirectory, "pi-context-expert.json"), JSON.stringify(LADDER_CONFIG));
piContextExpertExtension(fake.pi);
assert.equal(fake.handlers.has("context_with_system"), true);
```

- [ ] **Step 2: Ejecutar la prueba para comprobar que falla**

Run: `npm test --workspace @a4s/pi-rule-compiler -- --test-name-pattern "identity new"`
Expected: FAIL porque el paquete y la ruta nueva todavía no existen.

- [ ] **Step 3: Mover el paquete y cambiar cada identidad pública**

Usar `git mv`; cambiar el nombre workspace, scripts raíz, lockfile y todas las referencias instalables. Renombrar los exports y cada constante de custom entry a `a4s.pi-context-expert.*`. No introducir lecturas, exports ni aliases con `pi-rule-compiler`.

```ts
export function registerPiContextExpert(pi: ExtensionAPI, options: PiContextExpertOptions = {}): void {
  // cuerpo migrado de registerPiRuleCompiler
}
```

- [ ] **Step 4: Ejecutar las verificaciones de identidad**

Run: `npm test --workspace @a4s/pi-context-expert && npm run typecheck --workspace @a4s/pi-context-expert && rg -n 'pi-rule-compiler' package.json package-lock.json packages/pi-context-expert`
Expected: tests y typecheck PASS; la búsqueda sólo puede devolver referencias históricas fuera del paquete nuevo.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json packages/pi-context-expert .workspace/docs
git commit -m "feat: rename pi context expert"
```

## Task 2: Aplicar configuración viva desde /ce-settings

**Files:**
- Create: `packages/pi-context-expert/src/context-runtime.ts`
- Create: `packages/pi-context-expert/src/settings.ts`
- Modify: `packages/pi-context-expert/src/config.ts`, `src/extension.ts`, `src/index.ts`, `test/config.test.ts`, `test/extension.test.ts`, README
- Test: `packages/pi-context-expert/test/settings.test.ts`

**Interfaces:**
- Consumes: `CompactionConfig`, `resolveCompactionConfig()` y la ruta global nueva de Task 1.
- Produces:

```ts
export interface ContextRuntime {
  current(): CompactionConfig;
  replace(next: CompactionConfig): void;
}
export function createContextRuntime(initial: CompactionConfig): ContextRuntime;
export async function saveGlobalCompactionConfiguration(config: CompactionConfig): Promise<void>;
export function registerContextSettingsCommand(pi: ExtensionAPI, runtime: ContextRuntime): void;
```

- [ ] **Step 1: Escribir pruebas fallidas de runtime y persistencia**

En `settings.test.ts`, usar un directorio temporal y probar: escritura de las tres claves; JSON inválido resuelve el perfil básico; una falla de rename/escritura rechaza y no llama `runtime.replace`; una transición viva `ladder -> basic` hace que el handler registrado retorne `{ messages }` sin llamar al fake Jev.

```ts
const runtime = createContextRuntime(LADDER_CONFIG);
await assert.rejects(() => persist(BASIC_CONFIG));
assert.deepEqual(runtime.current(), LADDER_CONFIG);
```

- [ ] **Step 2: Ejecutar las pruebas para comprobar que fallan**

Run: `npm test --workspace @a4s/pi-context-expert -- --test-name-pattern "runtime|persistencia|viva"`
Expected: FAIL porque no existen runtime, writer ni `/ce-settings`.

- [ ] **Step 3: Implementar writer atómico, runtime y UI**

`saveGlobalCompactionConfiguration` debe serializar sólo las tres claves, escribir un archivo temporal 0600 en el mismo directorio y renombrarlo sobre la ruta final. `settings.ts` debe construir tres `SettingItem`, usar `SettingsList` y aplicar solamente después de completar el writer.

```ts
const next = resolveCompactionConfig(raw, runtime.current());
await saveGlobalCompactionConfiguration(next);
runtime.replace(next);
ctx.ui.notify("Context settings applied", "info");
```

Cambiar los handlers de `extension.ts` para leer `runtime.current()` dentro de `context_with_system`, `agent_settled` y `session_compact`, no una constante capturada en el factory.

- [ ] **Step 4: Ejecutar tests y typecheck**

Run: `npm test --workspace @a4s/pi-context-expert && npm run typecheck --workspace @a4s/pi-context-expert`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/pi-context-expert/src packages/pi-context-expert/test packages/pi-context-expert/README.md
git commit -m "feat: add live context settings"
```

## Task 3: Consolidar los comandos bajo ce-

**Files:**
- Create: `packages/pi-context-expert/src/rules-command.ts`
- Modify: `packages/pi-context-expert/src/extension.ts`, `test/extension.test.ts`, README

**Interfaces:**
- Consumes: `drainPendingRetro()`, `renderProposalList()`, `resolveCandidate()` y `isAccepted()` extraídos desde `extension.ts`.
- Produces: `registerContextCommands(pi, dependencies)` que registra exactamente `ce-recap`, `ce-settings` y `ce-rules`; `parseCeRulesArgs(args)` devuelve `list | show | accept | retry` o un error de uso.

- [ ] **Step 1: Escribir pruebas de dispatch fallidas**

Construir el fake Pi existente y exigir `commands.has("ce-rules")`; invocar `"list"`, `"show <id>"`, `"accept <id>"` y `"retry"`; exigir que `retro-rules`, `rules-review`, `rules-show`, `rules-accept` y `compaction-trigger-acknowledge` no estén registrados.

```ts
assert.deepEqual([...fake.commands.keys()].sort(), ["ce-recap", "ce-rules", "ce-settings"]);
await fake.commands.get("ce-rules")!("show bad", context);
assert.match(lastNotification(), /Usage: \/ce-rules/);
```

- [ ] **Step 2: Ejecutar la prueba para comprobar que falla**

Run: `npm test --workspace @a4s/pi-context-expert -- --test-name-pattern "ce-rules|old commands"`
Expected: FAIL porque los comandos previos siguen registrados.

- [ ] **Step 3: Extraer el dispatcher de reglas e instalar el namespace**

Mover la lógica pura de listas, resolución y aceptación a `rules-command.ts`; conservar la semántica store-only. El dispatcher debe aceptar sin argumento como `list`, rechazar combinaciones incompletas y referir sólo a comandos `ce-` en su texto. Mover el acknowledgement de `auto` a la confirmación de `settings.ts` y no registrar un comando adicional.

- [ ] **Step 4: Verificar contratos de comandos**

Run: `npm test --workspace @a4s/pi-context-expert -- --test-name-pattern "ce-rules|old commands|review" && npm run typecheck --workspace @a4s/pi-context-expert`
Expected: PASS; ningún mensaje recomienda un slash command retirado.

- [ ] **Step 5: Commit**

```bash
git add packages/pi-context-expert/src/rules-command.ts packages/pi-context-expert/src/extension.ts packages/pi-context-expert/test/extension.test.ts packages/pi-context-expert/README.md
git commit -m "feat: namespace context commands"
```

## Task 4: Entregar /ce-recap con selección Jev y fallback local

**Files:**
- Create: `packages/pi-context-expert/src/recap.ts`
- Modify: `packages/pi-context-expert/src/types.ts`, `src/extension.ts`, `src/index.ts`, `test/extension.test.ts`
- Test: `packages/pi-context-expert/test/recap.test.ts`

**Interfaces:**
- Consumes: `normalizeSessionMessages`, `redactAndLimitCorpusText`, `fitWholeSessionState`, `validateJevResponse`, `JevClient`.
- Produces:

```ts
export interface SessionRecap { objective: string[]; completed: string[]; pending: string[]; partial: boolean }
export async function buildJevRecap(entries: readonly unknown[], jev: JevClient, signal: AbortSignal): Promise<SessionRecap>;
export function buildLocalRecap(entries: readonly unknown[]): SessionRecap;
export function renderRecap(recap: SessionRecap): string;
```

- [ ] **Step 1: Escribir pruebas fallidas de recap**

Usar un fake Jev que selecciona un excerpt por categoría. Afirmar que el request no contiene una contraseña/email canary, que `renderRecap` contiene las tres cabeceras y que timeout, credencial ausente o respuesta inválida devuelven `partial: true` sin llamar `ctx.modelRegistry.complete`.

```ts
assert.match(renderRecap(result), /## Objective/);
assert.match(renderRecap(result), /## Completed/);
assert.match(renderRecap(result), /## Pending/);
assert.doesNotMatch(JSON.stringify(jev.requests), /canary-secret|alice@example\.com/);
```

- [ ] **Step 2: Ejecutar las pruebas para comprobar que fallan**

Run: `npm test --workspace @a4s/pi-context-expert -- --test-name-pattern "recap"`
Expected: FAIL porque `recap.ts` y `/ce-recap` no existen.

- [ ] **Step 3: Implementar selección estructurada y renderer**

Crear una pregunta `noul` por mensaje saneado y por categoría (`objective`, `completed`, `pending`). Usar sólo los excerpts que pasan una probabilidad explícita y mantener el orden cronológico. No pedir texto generado a Jev: la salida se compone de excerpts seleccionados. El handler `/ce-recap` intenta la ruta Jev bajo deadline y, ante fallo, notifica/renderiza `buildLocalRecap` marcado `partial`.

```ts
const recap = await buildJevRecap(ctx.sessionManager.getBranch(), await createJevClient(ctx), signal)
  .catch(() => buildLocalRecap(ctx.sessionManager.getBranch()));
safeNotifyText(ctx, renderRecap(recap), recap.partial ? "warning" : "info");
```

- [ ] **Step 4: Ejecutar tests y chequeos de privacidad**

Run: `npm test --workspace @a4s/pi-context-expert && npm run typecheck --workspace @a4s/pi-context-expert`
Expected: PASS; tests prueban que los fallos de recap no alteran entries ni invocan el modelo activo.

- [ ] **Step 5: Commit**

```bash
git add packages/pi-context-expert/src/recap.ts packages/pi-context-expert/src/types.ts packages/pi-context-expert/src/index.ts packages/pi-context-expert/src/extension.ts packages/pi-context-expert/test
git commit -m "feat: add semantic session recap"
```

## Task 5: Evitar hints de compaction no accionables

**Files:**
- Modify: `packages/pi-context-expert/src/trigger.ts`, `src/extension.ts`, `test/trigger.test.ts`, `test/extension.test.ts`, README

**Interfaces:**
- Consumes: trigger local gates y la rama activa de `ctx.sessionManager`.
- Produces: `hasCompactableSessionContent(entries: readonly unknown[]): boolean` y `TriggerInput.hasCompactableContent: boolean`.

- [ ] **Step 1: Reproducir el hint contradictorio como prueba fallida**

Añadir al fake de extensión una rama con sólo contexto no compactable y un uso de tokens por encima del umbral. El fake Jev debe recomendar compactar; esperar `action: "none"`, cero notificaciones de `Compaction suggested` y cero llamadas Jev. Mantener un caso control que contiene mensajes compactables y todavía permite hint.

```ts
const decision = await evaluateTrigger({ ...readyInput(jev), hasCompactableContent: false });
assert.deepEqual(decision, { action: "none" });
assert.equal(jev.calls, 0);
```

- [ ] **Step 2: Ejecutar la regresión para comprobar que falla**

Run: `npm test --workspace @a4s/pi-context-expert -- --test-name-pattern "compactable|hint"`
Expected: FAIL porque el trigger actual sólo conoce tokens y recomienda compaction.

- [ ] **Step 3: Implementar el gate en la frontera local**

Definir contenido compactable como al menos un mensaje de rama normalizado y no vacío que Pi puede resumir; no inferirlo desde el prompt de sistema, uso de tokens ni custom receipts. Ejecutar este gate antes de resolver credenciales o enviar el request Jev. Pasar el resultado desde `agent_settled` a `evaluateTrigger`.

- [ ] **Step 4: Verificar la regresión y el contrato completo**

Run: `npm test --workspace @a4s/pi-context-expert && npm run typecheck --workspace @a4s/pi-context-expert && git diff --check`
Expected: PASS; el caso compacto sigue llamando Jev y el caso pequeño no emite una sugerencia accionable.

- [ ] **Step 5: Commit**

```bash
git add packages/pi-context-expert/src/trigger.ts packages/pi-context-expert/src/extension.ts packages/pi-context-expert/test packages/pi-context-expert/README.md
git commit -m "fix: suppress noncompactable context hints"
```

## Final verification

- [ ] Run: `npm test`
- [ ] Run: `npm run typecheck`
- [ ] Run: `rootline validate .workspace/docs/specs/2026-09-22-pi-context-expert-design.md -o json`
- [ ] Run: `git diff --check`
- [ ] Run the authorized product E2E: `npm run e2e --workspace @a4s/pi-context-expert -- --mode basic`
- [ ] Confirm every Bead has its task-level test evidence before closing it.
