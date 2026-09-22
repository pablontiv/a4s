# Extensión Pi unificada de compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convertir `@a4s/pi-rule-compiler` en la única extensión Pi para compaction, trigger, retrieval por query y Evidence, sin cambiar el contrato `basic` observable.

**Architecture:** Separar primero la decisión y el renderer determinista de compaction de la extracción de reglas. Sobre ese núcleo, añadir Trigger, un corpus sanitizado append-only, Ladder por query y Evidence como consumidor conservador de Ladder. Cada entrega termina instalable, con su propia suite y commit; las rutas opt-in no alteran `basic` ni el contexto normal cuando fallan.

**Tech Stack:** TypeScript 7, Node 22.19+, `tsx --test`, Pi `@earendil-works/pi-coding-agent` y `@earendil-works/pi-ai` 0.87.0, Jev 1.13.0, Rootline, Beads.

**Spec:** `.workspace/docs/specs/2026-09-22-unified-pi-compaction-extension-design.md`

## Global Constraints

- `compaction.strategy` acepta `basic|ladder` y su valor por defecto es `basic`.
- `trigger.mode` acepta `off|hint|auto`; `auto` necesita acknowledgement persistido y llama sólo a `ctx.compact()`.
- `evidence.strategy` acepta `off|ladder`, por defecto `off`, y `ladder` exige `compaction.strategy=ladder`.
- `basic` conserva los golden fixtures: decisiones `keep|truncate|drop`, summary, recovery y cancelación fail-closed de ADR 0013.
- Compaction que falla por Jev, timeout, abort, schema, presupuesto o validación devuelve `{ cancel: true }`; no hay fallback nativo ni resumen generativo.
- Corpus y details contienen únicamente texto sanitizado; ningún digest se calcula antes de redacción y nunca se persisten secretos, thinking raw, imágenes o credenciales.
- Ladder fallido en `context_with_system` no omite contexto: Pi recibe su contexto normal.
- Los artefactos de compact-adviser conservan licencia MIT, URL, SHA completo y alcance; no se sincroniza upstream.
- No crear base de datos, daemon ni control plane externos. Rootline gobierna documentación durable bajo `.workspace/docs/`.
- Cada entrega ejecuta `npm test`, `npm run typecheck`, `rootline validate <artefacto> -o json` para documentación afectada y `git diff --check`.

## Review Focus

1. Un fixture `basic` que antes conservaba o truncaba un mensaje debe producir exactamente el mismo summary y details después del refactor.
2. Un error o abort durante `session_before_compact` no publica corpus, Evidence ni RuleSignals y devuelve únicamente `{ cancel: true }`.
3. Un secreto reconocible incluido en una entrada debe estar ausente del texto, digest, CustomEntry, receipt y diagnóstico persistido.
4. Una respuesta Ladder con id desconocido, span fuera de límite o rangos solapados inválidos debe descartar la proyección y dejar el contexto normal intacto.
5. `trigger.mode=auto` sin acknowledgement, con editor no vacío, cooldown activo o trabajo pendiente no muestra hint ni llama `ctx.compact()`.

---

### Task 1: Separar el núcleo `basic` de Evidence

**Files:**
- Create: `packages/pi-rule-compiler/src/compaction-core.ts`
- Create: `packages/pi-rule-compiler/src/evidence-pipeline.ts`
- Modify: `packages/pi-rule-compiler/src/compaction.ts`
- Modify: `packages/pi-rule-compiler/src/extension.ts`
- Modify: `packages/pi-rule-compiler/src/index.ts`
- Modify: `packages/pi-rule-compiler/src/types.ts`
- Test: `packages/pi-rule-compiler/test/compaction.test.ts`
- Test: `packages/pi-rule-compiler/test/extension.test.ts`

**Interfaces:**
- Consumes: `SessionBeforeCompactEvent`, `JevClient`, `CompactionRetentionAction` y los golden fixtures existentes.
- Produces: `buildBasicCompactionResult(input: BasicCompactionInput): JevCompactionResult` y `EvidencePipeline.afterCompaction(result, ctx): Promise<void>`, cuyo default es un no-op explícito.

- [ ] **Step 1: Escribir golden tests de compatibilidad y no-op**

```ts
test("basic preserves the established deterministic compaction fixture", async () => {
  const before = buildJevCompactionResult(legacyInput);
  const after = buildBasicCompactionResult(toBasicInput(legacyInput));
  assert.deepEqual(after, before);
});

test("basic does not publish rule artifacts when Evidence is off", async () => {
  const { pi, context, handlers } = createFakePi();
  registerPiRuleCompiler(pi, { evidence: { strategy: "off" } });
  await handlers.session_compact(compactionSucceeded, context);
  assert.equal(context.entries.some((entry) => entry.customType?.includes("rule")), false);
});
```

- [ ] **Step 2: Ejecutar los tests para verificar el fallo inicial**

Run: `npm test --workspace @a4s/pi-rule-compiler -- --test-name-pattern "basic preserves|Evidence is off"`

Expected: FAIL porque `buildBasicCompactionResult` y la opción `evidence` todavía no existen.

- [ ] **Step 3: Extraer el resultado `basic` y el pipeline no-op**

```ts
export interface BasicCompactionInput {
  attemptId: string;
  sourceDigest: string;
  createdAt: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  decisions: readonly MessageCompactionDecision[];
  scheduler: JevRequestSchedulerStats;
}

export interface EvidencePipeline {
  afterCompaction(result: JevCompactionResult, ctx: ExtensionContext): Promise<void>;
}

export const disabledEvidencePipeline: EvidencePipeline = {
  async afterCompaction() {},
};
```

Move el renderer y la comprobación de cobertura a `compaction-core.ts`; conserva el adaptador público anterior durante esta entrega. En `session_compact`, invoca sólo `disabledEvidencePipeline` cuando `evidence.strategy` es `off`; elimina la publicación automática y retro de RuleSignals de la ruta `basic`, sin bloques comentados.

- [ ] **Step 4: Ejecutar la suite del paquete**

Run: `npm test --workspace @a4s/pi-rule-compiler`

Expected: PASS; los fixtures existentes y los nuevos golden tests son idénticos para `basic`.

- [ ] **Step 5: Ejecutar los gates del workspace y revisar el diff**

Run: `npm test && npm run typecheck && git diff --check && git diff -- packages/pi-rule-compiler`

Expected: PASS; sólo aparecen el core, pipeline no-op, adaptadores y tests de compatibilidad.

- [ ] **Step 6: Commit de la entrega instalable**

```bash
git add packages/pi-rule-compiler
git commit -m "refactor: isolate basic compaction from evidence"
```

### Task 2: Actualizar contratos de Pi a 0.87.0

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/pi-rule-compiler/package.json`
- Modify: `packages/pi-rule-compiler/src/extension.ts`
- Modify: `packages/pi-rule-compiler/test/extension.test.ts`
- Modify: `packages/pi-rule-compiler/test/fixtures.ts`
- Test: `packages/pi-rule-compiler/test/pi-087-contract.test.ts`

**Interfaces:**
- Consumes: la superficie instalada de Pi 0.87.0: `ContextEditEntry`, los hooks de sesión, `agent_settled`, `ctx.compact()` y `context_with_system`.
- Produces: fakes tipados y un contrato ejecutable que fija el boundary seguro para notificar un hint y para llamar a `ctx.compact()` sin reentrancia.

- [ ] **Step 1: Escribir el contrato de lifecycle antes de cambiar versiones**

```ts
test("agent_settled defers trigger work and auto enters the existing compact hook once", async () => {
  const runtime = createPi087Fake({ acknowledgedAuto: true });
  registerPiRuleCompiler(runtime.pi, { trigger: { mode: "auto" } });
  await runtime.emit("agent_settled");
  assert.equal(runtime.compactCalls, 1);
  assert.equal(runtime.beforeCompactCalls, 1);
});

test("a failed context projection leaves Pi's supplied system context unchanged", async () => {
  const runtime = createPi087Fake();
  await runtime.emit("context_with_system", { systemPrompt: "normal" });
  assert.equal(runtime.systemPrompt, "normal");
});
```

- [ ] **Step 2: Ejecutar el contrato contra las dependencias 0.84.4**

Run: `npm test --workspace @a4s/pi-rule-compiler -- --test-name-pattern "agent_settled defers|failed context projection"`

Expected: FAIL por las APIs o boundaries ausentes de Pi 0.84.4.

- [ ] **Step 3: Actualizar dependencias y adaptar sólo los cambios de contrato**

```bash
npm install --save-dev @earendil-works/pi-coding-agent@0.87.0 --workspace @a4s/pi-rule-compiler
npm install @earendil-works/pi-ai@0.87.0 --workspace @a4s/pi-rule-compiler
npm install --save-dev @earendil-works/pi-coding-agent@0.87.0
```

Actualiza las referencias root, peer, dev y lockfile a `0.87.0`. Sustituye los fakes por el shape real de los eventos y registra el contrato observado: `agent_settled` sólo agenda trabajo; el hint se emite en el boundary autorizado por Pi y `ctx.compact()` usa el mismo `session_before_compact`.

- [ ] **Step 4: Ejecutar typecheck y el contrato Pi real**

Run: `npm run typecheck && npm test --workspace @a4s/pi-rule-compiler -- --test-name-pattern "agent_settled|context projection"`

Expected: PASS; no se usa `agent_before_settle` sin una prueba que descarte reentrancia.

- [ ] **Step 5: Ejecutar el gate completo y commit**

```bash
npm test && npm run typecheck && git diff --check
git add package.json package-lock.json packages/pi-rule-compiler
git commit -m "chore: align rule compiler with Pi 0.87"
```

### Task 3: Incorporar Trigger con provenance verificable

**Files:**
- Create: `packages/pi-rule-compiler/src/config.ts`
- Create: `packages/pi-rule-compiler/src/trigger.ts`
- Create: `packages/pi-rule-compiler/third_party/compact-adviser/LICENSE`
- Create: `packages/pi-rule-compiler/third_party/compact-adviser/PROVENANCE.md`
- Create: `packages/pi-rule-compiler/eval/trigger/README.md`
- Modify: `packages/pi-rule-compiler/src/extension.ts`
- Modify: `packages/pi-rule-compiler/src/types.ts`
- Modify: `packages/pi-rule-compiler/README.md`
- Test: `packages/pi-rule-compiler/test/config.test.ts`
- Test: `packages/pi-rule-compiler/test/trigger.test.ts`
- Test: `packages/pi-rule-compiler/test/extension.test.ts`

**Interfaces:**
- Consumes: gates locales de sesión, acknowledgement persistido y la señal Jev de compact-adviser adaptada al cliente Jev existente.
- Produces: `resolveCompactionConfig(raw, previous): CompactionConfig`, `evaluateTrigger(input): TriggerDecision` y una única acción `"hint" | "compact" | "none"`.

- [ ] **Step 1: Congelar el upstream permitido y registrar provenance**

```bash
git ls-remote https://github.com/kunchenguid/compact-adviser.git HEAD
```

Selecciona el SHA completo devuelto, inspecciona sólo `pi/` y `eval/`, y escribe `PROVENANCE.md` con URL, SHA de 40 caracteres, fecha, archivos importados y la frase “sin sincronización automática”. Copia la licencia MIT del commit seleccionado. No copies implementaciones de Claude Code, Codex o Grok.

- [ ] **Step 2: Escribir tests de configuración, gates y auto confirmado**

```ts
test("invalid configuration preserves the previous safe value", () => {
  assert.deepEqual(resolveCompactionConfig({ "evidence.strategy": "ladder" }, basicConfig), basicConfig);
});

test("trigger only compacts after all local gates and persisted acknowledgement", async () => {
  const decision = await evaluateTrigger({ ...readyInput, mode: "auto", autoAcknowledged: true });
  assert.equal(decision.action, "compact");
});

test("auto without acknowledgement, with pending work, cooldown, or editor text is inert", async () => {
  for (const input of blockedInputs) assert.equal((await evaluateTrigger(input)).action, "none");
});
```

- [ ] **Step 3: Ejecutar los tests de Trigger para verificar el fallo inicial**

Run: `npm test --workspace @a4s/pi-rule-compiler -- --test-name-pattern "invalid configuration|trigger only|auto without"`

Expected: FAIL porque configuración y Trigger todavía no existen.

- [ ] **Step 4: Implementar el adaptador sin segunda autoridad de compaction**

```ts
export type TriggerMode = "off" | "hint" | "auto";
export type TriggerDecision = { action: "none" } | { action: "hint"; reason: string } | { action: "compact" };

export async function applyTriggerDecision(decision: TriggerDecision, ctx: ExtensionContext): Promise<void> {
  if (decision.action === "hint") ctx.ui.notify(`Compaction suggested: ${decision.reason}`, "info");
  if (decision.action === "compact") await ctx.compact();
}
```

Ejecuta los gates antes de Jev; `off` no consulta Jev. Persistir sólo el acknowledgement y metadatos de cooldown permitidos, nunca texto de chunks ni credenciales. `basic` sigue activo y Evidence apagado.

- [ ] **Step 5: Ejecutar suites, eval local y gates**

Run: `npm test --workspace @a4s/pi-rule-compiler && npm run typecheck --workspace @a4s/pi-rule-compiler && git diff --check`

Expected: PASS; el eval usa únicamente fixtures locales ignorados y el README describe su formato y métricas, sin credenciales reales.

- [ ] **Step 6: Commit de Trigger y provenance**

```bash
git add packages/pi-rule-compiler
git commit -m "feat: add opt-in compaction trigger"
```

### Task 4: Persistir el corpus sanitizado y recuperable

**Files:**
- Create: `packages/pi-rule-compiler/src/corpus.ts`
- Modify: `packages/pi-rule-compiler/src/redaction.ts`
- Modify: `packages/pi-rule-compiler/src/storage.ts`
- Modify: `packages/pi-rule-compiler/src/types.ts`
- Modify: `packages/pi-rule-compiler/src/extension.ts`
- Modify: `packages/pi-rule-compiler/src/index.ts`
- Test: `packages/pi-rule-compiler/test/corpus.test.ts`
- Test: `packages/pi-rule-compiler/test/extension.test.ts`

**Interfaces:**
- Consumes: mensajes normalizados, resultado de compaction exitoso, rama actual de `sessionManager` y `pi.appendEntry`.
- Produces: `CorpusChunk`, `CorpusReceipt`, `stageCorpus(...)`, `publishCorpusAfterCompaction(...)` y `collectCorpus(branch)`.

- [ ] **Step 1: Escribir tests de redacción antes de digest, éxito-gate y aislamiento de rama**

```ts
test("corpus redacts before deriving its digest or CustomEntry", () => {
  const chunk = stageCorpus([secretMessage])[0];
  assert.equal(JSON.stringify(chunk).includes("canary-secret"), false);
  assert.notEqual(chunk.digest, stableDigest(secretMessage.content));
});

test("a cancelled compaction publishes no corpus while a successful one is reloadable", async () => {
  assert.deepEqual(await compactAndEntries({ cancel: true }), []);
  assert.equal(collectCorpus(await compactAndReload({ success: true })).length, 1);
});

test("corpus entries stay scoped to the current branch", () => {
  assert.notDeepEqual(collectCorpus(branchA), collectCorpus(branchB));
});
```

- [ ] **Step 2: Ejecutar los tests para verificar el fallo inicial**

Run: `npm test --workspace @a4s/pi-rule-compiler -- --test-name-pattern "corpus redacts|cancelled compaction|scoped to the current branch"`

Expected: FAIL porque no existe el esquema `CorpusChunk` ni persistencia de corpus.

- [ ] **Step 3: Implementar staging y CustomEntries estrictos**

```ts
export const CORPUS_ENTRY_TYPE = "a4s.pi-rule-compiler.corpus.v1" as const;
export interface CorpusChunk {
  schema: "a4s.corpus-chunk/v1";
  id: string;
  digest: string;
  role: string;
  position: number;
  text: string;
  provenance: { branchId: string; compactionAttemptId: string; sourceDigest: string };
}
```

Sanitiza, aplica límites y sólo después calcula `digest` e `id`. Conserva staging en memoria hasta `session_compact`; publica chunks y un receipt idempotente después del éxito Pi. En `session_start`, reconstruye desde CustomEntries de la rama actual y no mezcla ramas.

- [ ] **Step 4: Ejecutar tests de corpus y recuperación**

Run: `npm test --workspace @a4s/pi-rule-compiler -- --test-name-pattern "corpus|reload|branch"`

Expected: PASS; reintentos y reload no duplican ids ni muestran secretos.

- [ ] **Step 5: Ejecutar gates completos y commit**

```bash
npm test && npm run typecheck && git diff --check
git add packages/pi-rule-compiler
git commit -m "feat: persist sanitized compaction corpus"
```

ADR 0022 ya está `accepted` y gobierna esta entrega: Ladder es una estrategia opt-in de cuatro niveles, el trigger permanece como eje separado y `basic` conserva el contrato de ADR 0013. El ADR forma parte de la base documental de esta rama; no requiere una entrega ni una aprobación adicional.

### Task 5: Implementar Ladder por query con fallback seguro

**Files:**
- Create: `packages/pi-rule-compiler/src/ladder.ts`
- Create: `packages/pi-rule-compiler/src/projection.ts`
- Modify: `packages/pi-rule-compiler/src/config.ts`
- Modify: `packages/pi-rule-compiler/src/extension.ts`
- Modify: `packages/pi-rule-compiler/src/questions.ts`
- Modify: `packages/pi-rule-compiler/src/types.ts`
- Modify: `packages/pi-rule-compiler/src/index.ts`
- Modify: `packages/pi-rule-compiler/README.md`
- Test: `packages/pi-rule-compiler/test/ladder.test.ts`
- Test: `packages/pi-rule-compiler/test/extension.test.ts`

**Interfaces:**
- Consumes: `CorpusChunk[]`, una query concreta, digest del corpus y la superficie `context_with_system` comprobada en Task 2.
- Produces: `VisibilityLevel`, `SourceSpan`, `VisibilityProjection`, `selectLadderProjection(...)` y `renderProjection(...)`.

- [ ] **Step 1: Escribir tests de spans y fallback al contexto Pi**

```ts
test("renderer orders valid short and long source spans deterministically", () => {
  const projection = validProjection({ levels: ["full", "short", "long", "hide"] });
  assert.equal(renderProjection(projection), expectedChronologicalText);
});

test("unknown chunk ids and invalid spans reject the projection", () => {
  for (const projection of invalidProjections) assert.throws(() => validateProjection(projection, corpus));
});

test("failed Ladder leaves context_with_system unchanged", async () => {
  const result = await applyContextProjection({ systemPrompt: "Pi normal" }, failingLadder);
  assert.equal(result.systemPrompt, "Pi normal");
});
```

- [ ] **Step 2: Ejecutar tests Ladder para verificar el fallo inicial**

Run: `npm test --workspace @a4s/pi-rule-compiler -- --test-name-pattern "source spans|unknown chunk|failed Ladder"`

Expected: FAIL porque no existen proyección, validador ni renderer.

- [ ] **Step 3: Implementar tipos, selección y renderer determinista**

```ts
export type VisibilityLevel = "hide" | "short" | "long" | "full";
export interface SourceSpan { chunkId: string; start: number; end: number }
export interface VisibilityProjection {
  queryDigest: string;
  corpusDigest: string;
  selections: readonly { chunkId: string; level: VisibilityLevel; spans: readonly SourceSpan[] }[];
}
```

Valida que cada chunk seleccionado pertenece al corpus, que `0 <= start < end <= text.length`, que los spans requeridos existen para `short|long`, y que el renderer ordena por posición fuente, recorta por límite y nunca modifica los chunks. Registra `context_with_system` sólo con `compaction.strategy=ladder`; captura todos los fallos de Ladder o validación y devuelve la entrada sin omisión adicional.

- [ ] **Step 4: Ejecutar tests de Ladder y el contrato lifecycle**

Run: `npm test --workspace @a4s/pi-rule-compiler -- --test-name-pattern "Ladder|projection|context_with_system"`

Expected: PASS; `basic` no registra ni consume Ladder y los casos inválidos conservan el contexto normal.

- [ ] **Step 5: Ejecutar gates completos y commit**

```bash
npm test && npm run typecheck && git diff --check
git add packages/pi-rule-compiler
git commit -m "feat: add query-aware context ladder"
```

### Task 6: Restaurar Evidence como consumidor conservador de Ladder

**Files:**
- Create: `packages/pi-rule-compiler/src/evidence.ts`
- Modify: `packages/pi-rule-compiler/src/evidence-pipeline.ts`
- Modify: `packages/pi-rule-compiler/src/config.ts`
- Modify: `packages/pi-rule-compiler/src/extension.ts`
- Modify: `packages/pi-rule-compiler/src/retro.ts`
- Modify: `packages/pi-rule-compiler/src/storage.ts`
- Modify: `packages/pi-rule-compiler/src/types.ts`
- Modify: `packages/pi-rule-compiler/src/index.ts`
- Modify: `packages/pi-rule-compiler/eval/trigger/README.md`
- Modify: `packages/pi-rule-compiler/README.md`
- Test: `packages/pi-rule-compiler/test/evidence.test.ts`
- Test: `packages/pi-rule-compiler/test/retro.test.ts`
- Test: `packages/pi-rule-compiler/test/storage.test.ts`

**Interfaces:**
- Consumes: `evidence.strategy=ladder`, corpus de la rama, `VisibilityProjection` de la query especial de reglas y el pipeline review-only existente.
- Produces: `selectEvidenceContext(...)`, `extractRuleSignals(...)`, receipts y markers idempotentes; ningún RuleSignal cuando Evidence está apagado o la selección falla.

- [ ] **Step 1: Escribir tests de relevancia conservadora y no-regresión**

```ts
test("Evidence elevates an uncertain candidate instead of hiding it", async () => {
  const projection = await selectEvidenceContext(corpusWithUncertainCandidate, fakeJev);
  assert.equal(projection.selections.find((item) => item.chunkId === uncertainId)?.level, "full");
});

test("Evidence stores a review-only signal from selected spans", async () => {
  const result = await runEvidence({ strategy: "ladder" }, corpusWithRule);
  assert.equal(result.signals[0]?.schema, "a4s.rule-signal/v1");
  assert.equal(result.rootlineWrites, 0);
});

test("Evidence failure creates no signal and preserves recoverable corpus", async () => {
  const result = await runEvidence({ strategy: "ladder" }, corpus, failingJev);
  assert.deepEqual(result.signals, []);
  assert.equal(collectCorpus(result.entries).length, corpus.length);
});
```

- [ ] **Step 2: Ejecutar los tests de Evidence para verificar el fallo inicial**

Run: `npm test --workspace @a4s/pi-rule-compiler -- --test-name-pattern "Evidence elevates|Evidence stores|Evidence failure"`

Expected: FAIL porque el pipeline sigue siendo no-op.

- [ ] **Step 3: Implementar la query de reglas y publicación éxito-gated**

```ts
export async function selectEvidenceContext(corpus: readonly CorpusChunk[], jev: JevClient): Promise<VisibilityProjection> {
  return selectLadderProjection({
    query: "Identify material that may originate a durable rule; elevate uncertain candidates.",
    corpus,
    profile: "conservative-evidence",
    jev,
  });
}
```

Exige ambos flags `compaction.strategy=ladder` y `evidence.strategy=ladder`. Ejecuta extracción sólo sobre spans validados; conserva candidate, generality y authority antes de producir señales. Persiste señales, pending markers, proposals y receipts después de éxito, idempotentemente y siempre review-only. Nunca usa una proyección de una query ordinaria para Evidence.

- [ ] **Step 4: Añadir fixtures y reporte de evaluación local**

```text
fixtures/evidence/true-rule.json
fixtures/evidence/non-rule.json
fixtures/evidence/uncertain-candidate.json
```

Haz que el eval local informe precisión, recall, cobertura de boundaries y falsos negativos de Evidence; las entradas de sesión, corpus y resultados locales permanecen ignorados.

- [ ] **Step 5: Ejecutar la suite completa y gates de documentación**

Run: `npm test && npm run typecheck && rootline validate .workspace/docs/specs/2026-09-22-unified-pi-compaction-extension-design.md -o json && git diff --check`

Expected: PASS; Evidence por defecto es `off`, no filtra contenido y todos los artefactos siguen siendo recuperables tras un fallo.

- [ ] **Step 6: Commit final de la iniciativa**

```bash
git add packages/pi-rule-compiler .workspace/docs
git commit -m "feat: extract rule evidence through context ladder"
```

## Dependency Order

`Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6`.

Cada tarea se revisa y se integra como entrega verificable antes de reclamar la siguiente.
