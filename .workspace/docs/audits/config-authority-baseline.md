---
audit_baseline: a4s-9on
authority_sha: e6154b537fc1e0890f221a42103ec15dad06a29d
status: completed
---
# Línea base de autoridad de `.workspace/config.yaml`

## Resultado

En el árbol integrado `e6154b537fc1e0890f221a42103ec15dad06a29d`,
`.workspace/config.yaml` es la única autoridad normativa sobre la forma de
trabajo de A4S. Esta auditoría compara los claims versionados con esa fuente;
no convierte el informe, los records citados ni las técnicas de componentes en
nueva autoridad.

Se encontraron claims alineados, contratos técnicos de dominio, material
histórico/inactivo, estado externo desconocido y conflictos que requieren una
elección posterior del operador. Esta entrega no decide sus remediaciones, no
crea tareas y no cambia ninguna superficie auditada.

## Autoridad, alcance y método

- **SHA de autoridad e inventario (`A0`):**
  `e6154b537fc1e0890f221a42103ec15dad06a29d`, integrado en `main`.
- **Método semántico:** lectura estática del árbol `A0`, búsqueda léxica de
  lenguaje normativo, lectura contextual de cada resultado y comparación
  semántica con las reglas exactas de config. Cada fila de la matriz contiene un
  claim estrecho; varios paths sólo aparecen juntos cuando implementan o prueban
  el mismo claim.
- **Superficies:** `AGENTS.md`, `README.md`, `profiles/`, `skills/` y
  `skills/*/references/`, `agents/`, `output-styles/`, `packages/`, `test/`, CI
  y documentación GitHub.
- **Inventario reproducible:**
  `git ls-tree -r --name-only A0 -- AGENTS.md README.md profiles skills agents
  output-styles packages test .github` devuelve 363 paths. El apéndice enumera
  los 363 y su clase de cobertura, no una muestra.
- **Records excluidos como autoridad:**
  `git ls-tree -r --name-only A0 -- .workspace/docs` devuelve 173 paths.
  `git ls-tree -r --name-only A0 -- .workspace/docs/history
  .workspace/docs/reports` devuelve 73; y `git ls-tree -r --name-only A0 --
  .workspace/docs/adr .workspace/docs/plans .workspace/docs/specs
  .workspace/docs/experiments .workspace/docs/reports` devuelve 95. Son
  selectores literales reproducibles; `.workspace/docs/reports` aporta cero
  paths en `A0`. Los conteos son evidencia de inventario, no claims de matriz.
- **Frontera de aceptación bounded:** se exige corpus reproducible, cobertura
  363/363, referencias exactas para todos los claims reportados y cero errores
  conocidos dentro de esos resultados; no se intenta probar ausencia de otros
  claims ni exhaustividad semántica absoluta.
- **Queries y muestreo:** `git ls-tree` fijó el corpus; `rg` buscó vocabulario
  normativo/authority/approval/cleanup/merge; `nl -ba` fijó rangos. Se revisaron
  completos los surfaces high-risk conocidos (Profile/Template, Roadmap, Herdr,
  Mentor, package READMEs, contract tests y GitHub controls); los demás paths se
  cubrieron por scan léxico y muestreo contextual, ampliado cuando apareció un
  hit o un backstop.
- **Blind spots y unknowns:** claims sin vocabulario detectable, contenido
  generado/no tracked, instalaciones globales, symlinks, providers y settings
  remotos pueden quedar fuera. Los estados externos se conservan `unknown`; el
  manifiesto no convierte un non-hit en prueba de ausencia.

### Clases de claim

- `alineado`: reproduce una regla de config sin ampliarla.
- `conflicto`: contradice, debilita o añade policy ausente de config.
- `autoridad de dominio`: contrato técnico o de interacción de un componente;
  no gobierna la forma de trabajo de A4S.
- `histórico/inactivo`: record, fixture, snapshot o plan no activo como
  autoridad.
- `unknown`: el árbol no permite determinar el estado o el efecto activo.

### Clases del manifiesto

- `semantic-review`: texto/configuración inspeccionado semánticamente.
- `backstop-review`: test o harness inspeccionado como backstop.
- `domain-implementation`: código/asset inspeccionado para comprobar si un
  claim estaba implementado.
- `evidence-snapshot`: fixture, eval o baseline tratado sólo como evidencia.
- `inactive-plan`: artefacto prepare-only de publicación.

El manifiesto contiene: 83 `semantic-review`, 157 `backstop-review`, 103
`domain-implementation`, 15 `evidence-snapshot` y 5 `inactive-plan`; total 363.
Tests/harnesses ganan precedencia sobre fixture/eval para su clasificación.

## Reglas exactas de config usadas

Todas provienen de `A0:.workspace/config.yaml`.

- **R1, `workspace.authority.source`, líneas 13-17:** “This file, as integrated
  on the main branch, is the only normative source of this repository's way of
  working. A rule absent from it is not in force.”
- **R2, `workspace.authority.records`, líneas 18-22:** ADRs, specifications,
  plans y reports “do not govern”; son append-only y la supersession se declara
  sólo en el nuevo record.
- **R3, `workspace.authority.derived` y `mechanism`, líneas 23-28:** Profile,
  AGENTS, README y contract tests derivan de config; skills y methods aportan
  técnica y “add no rule of their own”.
- **R4, `workspace.authority.deviation`, líneas 29-34:** una contradicción se
  nombra y sólo procede con aprobación explícita para ese caso; no crea norma.
- **R5, `workspace.choose_work`, líneas 50-65:** el operador elige resultado y
  cambios materiales; presentar Beads no infiere, muta ni backfill valores.
- **R6, `workspace.define_work` y `prepare_work`, líneas 67-142:** task con un
  resultado, un kind, artefacto versionado por PR y readiness acordado; nueva
  capacidad requiere experimento separado.
- **R7, `workspace.do_work.starting_point` y `safety`, líneas 144-153:** `main`
  limpio y sincronizado, worktree bajo `.workspace/worktrees/`; inventario y
  planning nunca mutan; ambigüedad detiene; un match no autoriza borrar.
- **R8, `workspace.do_work.modes`, líneas 154-170:** assignment usa scope elegido;
  autonomía requiere solicitud explícita y no autoriza merge por sí sola.
- **R9, `workspace.do_work.external_effects`, líneas 180-188:** observar read-only,
  validar localmente, autorizar payload live y definir recovery; tras fallo,
  causa, reproducción, corrección, review y autorización renovada.
- **R10, `workspace.do_work.credentials`, líneas 189-197:** “TypeSafe resolves
  credentials only through Pi's native provider”; otros servicios usan SOPS.
- **R11, `workspace.do_work.knowledge`, líneas 198-213:** records y findings
  durables van bajo `.workspace/docs/`; Rootline se usa al consultar, escribir y
  validar; records acompañan el cambio; AGENTS es puntero de una línea.
- **R12, `workspace.do_work.communication`, líneas 214-218:** issue o comment de
  issue/PR requiere texto completo y aprobación; PR y description no requieren
  aprobación previa; texto generado usa la voz del operador.
- **R13, `workspace.accept_work.evidence`, `kind_checks` y `end_to_end`, líneas
  225-256:** criterios trazables, acceptance sólo con controles pass, raw output
  disposable salvo criterio, E2E real para implementación.
- **R14, `workspace.accept_work.review`, líneas 262-268:** cada PR requiere
  reviewer fresco del candidato completo, de familia distinta y, cuando exista,
  provider distinto.
- **R15, `workspace.deliver_work.mechanism` y `merge`, líneas 269-289:** PR,
  commit convencional con `Bead`, checks antes de commit, no push directo;
  merge exige ci-local, R14, sin HIGH, resultados y CI remoto aplicable; docs
  bajo `.workspace/docs/` requieren aprobación del operador.
- **R16, `workspace.deliver_work.external_prs` y `billing_exception`, líneas
  290-313:** bot PRs pasan los mismos controles; billing sólo omite CI remoto con
  anotación y cero pasos.
- **R17, `workspace.deliver_work.close` e `improve_work.cleanup`, líneas 314-331
  y 363-372:** cleanup obligatorio después de integración verificada sólo para
  identidades exactas y outputs clasificados; todo otro cleanup destructivo
  requiere autorización explícita.
- **R18, `workspace.improve_work.review` y `change`, líneas 345-362:** cada
  finding se escala; el operador decide scope, nuevo Bead o no action; una norma
  cambia sólo con aprobación y ADR en el mismo PR.
- **R19, `workspace.product.skills`, líneas 373-380:** skill self-contained con
  author/updated; Roadmap no se edita en su loop y activa por tag.
- **R20, `workspace.product.providers`, líneas 381-388:** runtimes y tools
  externos son providers integrados, no código A4S.

## Matriz de claims

Todas las filas usan SHA `A0`. “Pendiente de elección” significa exactamente
que esta auditoría no decide si ajustar scope, usar un Bead existente, crear una
unidad futura o no actuar; esa elección pertenece al operador bajo R18.

| ID | Path:line | Claim estrecho | Clase | Regla | Disposición |
| --- | --- | --- | --- | --- | --- |
| C001 | `AGENTS.md:1` | Sólo config define la forma de trabajo. | `alineado` | R1, R11 | Conservar. |
| C002 | `README.md:3-19`, `README.md:21-25` | Outcome incremental, familias de capacidades e integraciones como providers. | `alineado` | R1, R20 | Sin acción. |
| C003 | `README.md:20` | La superficie TypeSafe/Jev está “gobernada por ADR 0020”. | `conflicto` | R1-R3 | Pendiente de elección; el ADR es record, no gobierno. |
| C004 | `README.md:29-37` | Handbook y Profile aparecen aguas arriba de config. | `conflicto` | R1, R3 | Pendiente de elección sobre README. |
| C005 | `README.md:41-46` | ADRs/spec se presentan como “Dirección vigente”. | `conflicto` | R1-R3 | Pendiente de elección sobre README. |
| C006 | `README.md:48` | Historia Handbook no forma otro decision log. | `alineado` | R1, R2 | Sin acción. |
| C007 | `profiles/pablontiv/PROFILE.md:17-19` | Profile v2 declara requisitos normativos propios. | `conflicto` | R1, R3 | Aislar como target estructural; pendiente de elección. |
| C008 | `profiles/pablontiv/PROFILE.md:25`, `profiles/pablontiv/PROFILE.md:37` | La config central contiene control y no se infieren controles ausentes. | `alineado` | R1, R3 | Preservar al rediseñar Profile. |
| C009 | `profiles/pablontiv/PROFILE.md:55` | `.workspace/docs/` es autoridad final. | `conflicto` | R1, R2 | Target estructural Profile; pendiente de elección. |
| C010 | `profiles/pablontiv/PROFILE.md:63-80` | Define merge/precedencia `workspace -> group -> repository` como norma. | `conflicto` | R1, R3 | Target estructural Profile; no cambiar config por inferencia. |
| C011 | `profiles/pablontiv/PROFILE.md:55`, `profiles/pablontiv/PROFILE.md:185`, `profiles/pablontiv/PROFILE.md:219`, `profiles/pablontiv/PROFILE.md:251`, `profiles/pablontiv/PROFILE.md:371` | Worktree es condicional y no obligatorio. | `conflicto` | R7 | Target estructural Profile; pendiente de elección. |
| C012 | `profiles/pablontiv/PROFILE.md:188`, `profiles/pablontiv/PROFILE.md:231` | Delivery puede quedar unknown y el perfil no presupone PR. | `conflicto` | R6, R15 | Target estructural Profile; pendiente de elección. |
| C013 | `profiles/pablontiv/PROFILE.md:202`, `profiles/pablontiv/PROFILE.md:239`, `profiles/pablontiv/PROFILE.md:256` | Cleanup exacto post-integración es obligatorio y otro destructivo requiere autorización. | `alineado` | R17 | Preservar al rediseñar Profile. |
| C014 | `profiles/pablontiv/PROFILE.md:239`, `profiles/pablontiv/PROFILE.md:355-357` | Tras fallo live exige causa, reproducción, fix, review y nueva autorización. | `alineado` | R9 | Preservar. |
| C015 | `profiles/pablontiv/PROFILE.md:347-349` | Config central es autoridad. | `alineado` | R1, R3 | Separar de la inspección añadida en C016. |
| C016 | `profiles/pablontiv/PROFILE.md:347` | Toda adopción debe inspeccionar global config, steering, hooks, plugins, CI, provider y práctica. | `conflicto` | R1, R3 | Mandatory adoption policy añadida; pendiente de elección. |
| C017 | `profiles/pablontiv/bootstrap.md:22-23` | La adopción debe validar Profile/Handbook digest como procedencia que bloquea. | `conflicto` | R1-R3 | Target estructural Profile; records no son autoridad. |
| C018 | `profiles/pablontiv/bootstrap.md:3-21` | Identidad, observación y separación propuesta/aprobación/escritura del wizard. | `autoridad de dominio` | R3, R7 | Técnica de adopción, no norma A4S. |
| C019 | `profiles/pablontiv/bootstrap.md:25-43` | Inspección read-only y consulta acotada de memoria durante adopción. | `autoridad de dominio` | R3, R7, R9 | Técnica de adopción. |
| C020 | `profiles/pablontiv/bootstrap.md:45-104` | Render, approval, escritura, verificación y activación gradual del wizard. | `autoridad de dominio` | R3 | Técnica de adopción; no sustituye config. |
| C021 | `profiles/pablontiv/config.template.yaml:1-25`, `profiles/pablontiv/bootstrap.md:55-57`, `profiles/pablontiv/config.template.yaml:29-38`, `profiles/pablontiv/config.template.yaml:43-48` | Scaffold reusable de schema/capas incluye placeholders unknown para base, sync, isolation y delivery que divergen de la config efectiva. | `autoridad de dominio` | R1, R3 | Input activo del wizard, pero no config efectiva; divergencias visibles y pendientes de elección. |
| C022 | `profiles/pablontiv/config.template.yaml:26-27` | Defaults `incomplete_task_policy=skip` y `failed_task_policy=skip`. | `conflicto` | R1, R3, R8 | Aunque coinciden materialmente con continuar trabajo independiente, añaden policy al adoptarse; pendiente de elección. |
| C023 | `profiles/pablontiv/config.template.yaml:28` | Default `controller_identity=unknown`. | `conflicto` | R1, R3 | Diverge de `track_work.controller_identity=env:PI_SESSION_ID`; pendiente de elección. |
| C024 | `profiles/pablontiv/config.template.yaml:39-40` | Knowledge policy ubica ADR/spec/plan en `.workspace/docs/` y usa Rootline. | `alineado` | R11 | Alineación material en un template activo de adopción pero no efectivo; no convierte el template en config efectiva. |
| C025 | `profiles/pablontiv/config.template.yaml:41-42` | Cleanup exacto post-integración y autorización para cualquier otro cleanup destructivo. | `alineado` | R17 | Alineación material en un template activo de adopción pero no efectivo; no autoriza cleanup por sí mismo. |
| C026 | `skills/gh-communication-style/SKILL.md:18-25`, `skills/gh-communication-style/SKILL.md:38-43` | Templates, evidencia, idioma y forma de GitHub artifacts. | `autoridad de dominio` | R3, R12 | Técnica de comunicación. |
| C027 | `skills/gh-communication-style/SKILL.md:13`, `skills/gh-communication-style/SKILL.md:17`, `skills/gh-communication-style/SKILL.md:44` | Approval previa se extiende a PR title/body. | `conflicto` | R1, R3, R12 | Pendiente de elección; R12 exceptúa PR/description. |
| C028 | `skills/gh-communication-style/SKILL.md:17` | Standing instruction preautoriza publicaciones nombradas. | `conflicto` | R4, R12 | Pendiente de elección. |
| C029 | `skills/sweep/SKILL.md:13-31`, `skills/sweep/references/evidence.md:5-47` | Preflight, inventario y evidencia para clasificación. | `autoridad de dominio` | R3, R7, R13 | Técnica de Sweep. |
| C030 | `skills/sweep/SKILL.md:11`, `skills/sweep/SKILL.md:33-35` | `--apply` se declara autorización suficiente para delete y merge. | `conflicto` | R4, R8, R15, R17 | Pendiente de elección; flag no reemplaza controles. |
| C031 | `skills/sweep/SKILL.md:43` | Un sweep sin apply muta mediante `git fetch`. | `conflicto` | R7 | Pendiente de elección; inventario/planning no mutan. |
| C032 | `skills/sweep/references/apply.md:24-26`, `skills/sweep/references/apply.md:48-58` | Permite excepción `rm -rf`, `rmdir` y `update-ref` desde el método. | `conflicto` | R7, R17 | Pendiente de elección; limitar a cleanup autorizado. |
| C033 | `skills/sweep/references/apply.md:30-34`, `skills/sweep/references/apply.md:44-46`, `skills/sweep/references/tiers.md:23-29` | Con gates de mergeability/checks/reviewDecision, autorización explícita para admin y guards de conflict/breaking, aún permite self-approval de bot y auto-merge low-risk. | `conflicto` | R14-R16 | Pendiente de elección; los guards existen pero no satisfacen reviewer fresco ni controles completos. |
| C034 | `skills/sweep/references/fork-mirrors.md:11-16`, `skills/sweep/references/fork-mirrors.md:34-49` | Igualdad de SHA habilita borrado remoto de mirrors. | `conflicto` | R9, R17 | Pendiente de elección; es efecto live fuera del cleanup exacto. |
| C035 | `skills/sweep/references/fanout.md:3-18` | Evidencia y delivery de agentes por runtime. | `autoridad de dominio` | R3, R13 | Técnica de Sweep. |
| C036 | `skills/herdr/SKILL.md:11-19` | Herdr CLI exige pane administrado y verifica `HERDR_ENV` antes de controlarlo. | `autoridad de dominio` | R3, R20 | Precondición técnica del provider. |
| C037 | `skills/herdr/SKILL.md:23-25` | Dispatch termina sólo con agente iniciado/prompted y usa space/tab/pane con semántica propia. | `autoridad de dominio` | R3, R20 | Contrato técnico de Herdr. |
| C038 | `skills/herdr/SKILL.md:45`, `skills/herdr/SKILL.md:60-66`, `skills/herdr/SKILL.md:74-79` | Resolución/creación de workspace y tab usa IDs devueltos por Herdr. | `autoridad de dominio` | R3, R20 | Mecánica CLI, sin closure de Bead. |
| C039 | `skills/herdr/SKILL.md:67-73` | Cada Bead mutante concurrente obtiene worktree propio; read-only puede compartir root. | `alineado` | R7 | Alineación de aislamiento para mutación concurrente. |
| C040 | `skills/herdr/SKILL.md:99-108`, `skills/herdr/SKILL.md:110-117`, `skills/herdr/SKILL.md:284` | Dispatch estampa metadata/correlation/target y trata prompt acceptance como transporte, no acknowledgement. | `autoridad de dominio` | R3, R13 | Contrato de transporte; excluye línea 109 de closure. |
| C041 | `skills/herdr/SKILL.md:27-31`, `skills/herdr/SKILL.md:276`, `skills/herdr/SKILL.md:279` | Impone roles, un agent por tab, un worker por feature y no delegación recursiva. | `conflicto` | R1, R3, R8 | Policy de trabajo ausente de config; pendiente de elección. |
| C042 | `skills/herdr/SKILL.md:33-41`, `skills/herdr/SKILL.md:277` | Vendor PRs/merges sólo pueden apuntar al fork `pablontiv`, nunca upstream. | `conflicto` | R1, R3, R9, R15 | Targeting añadido por la skill; pendiente de elección. |
| C043 | `skills/herdr/SKILL.md:43`, `skills/herdr/SKILL.md:278` | Acciones de quota/budget requieren self-check del model/provider live. | `autoridad de dominio` | R3, R7 | Guard técnico de ruta; no autoriza acciones de cuota. |
| C044 | `skills/herdr/SKILL.md:81`, `skills/herdr/SKILL.md:83-92`, `skills/herdr/SKILL.md:94-97`, `skills/herdr/SKILL.md:286-288` | Impone kinds, routing por altitud y trust/YOLO obligatorio, incluidos sus comandos de ejemplo. | `conflicto` | R1, R3, R8 | Excluye línea 98; overlap de 94/288 se explica en las filas técnicas y guard alineado; pendiente de elección. |
| C045 | `skills/herdr/SKILL.md:94` | El nombre de agent debe ser único entre agentes live y seguir el patrón indicado. | `autoridad de dominio` | R3, R20 | Restricción técnica de identidad; overlap de línea 94 con policy de routing explicitado. |
| C046 | `skills/herdr/SKILL.md:46`, `skills/herdr/SKILL.md:80`, `skills/herdr/SKILL.md:198`, `skills/herdr/scripts/README.md:10` | Fan-out/ready dispatch adquiere y despacha todas las unidades ready en el mismo pass o tick. | `conflicto` | R5, R8 | Selección y dispatch automáticos añadidos; overlap de línea 198 limitado a esta cláusula; pendiente de elección. |
| C047 | `skills/herdr/SKILL.md:47-59`, `skills/herdr/SKILL.md:275` | Crea o claim Bead como precondición técnica sin readiness/kind/choice completos. | `conflicto` | R5, R6, R8 | Pendiente de elección. |
| C048 | `skills/herdr/SKILL.md:285` | Sólo Beads mutantes concurrentes que comparten repo necesitarían worktree propio. | `conflicto` | R7 | Puede dejar mutación no concurrente fuera del worktree dedicado; pendiente de elección. |
| C049 | `skills/herdr/SKILL.md:119-140`, `skills/herdr/SKILL.md:282`, `skills/herdr/scripts/README.md:38` | ACK/START usa writer único, correlación, idempotencia y fail-closed. | `autoridad de dominio` | R3, R13 | Contrato técnico; excluye línea 142 y closure de scripts. |
| C050 | `skills/herdr/SKILL.md:148-165` | TASK_RESULT define envelope y valida verdict, correlación, artifact e identidad antes de registrar resultado. | `autoridad de dominio` | R3, R13 | Empieza en 148; línea 146 pertenece al claim de closure. |
| C051 | `skills/herdr/SKILL.md:169-180`, `skills/herdr/SKILL.md:281`, `skills/herdr/scripts/README.md:46` | Escalación usa target correlacionado, persiste delivery failure y no reroutea a Human/MC. | `autoridad de dominio` | R3, R9, R13 | Contrato técnico de escalación. |
| C052 | `skills/herdr/SKILL.md:109`, `skills/herdr/SKILL.md:142`, `skills/herdr/SKILL.md:146`, `skills/herdr/SKILL.md:167`, `skills/herdr/SKILL.md:182-198`, `skills/herdr/SKILL.md:283`, `skills/herdr/scripts/README.md:11`, `skills/herdr/scripts/README.md:42`, `skills/herdr/scripts/README.md:48-50` | Worker o reconciler ejecuta `bd close`/harvest-close desde TASK_RESULT y liveness; línea 196 limita ese cierre a la unidad delegada y niega auto-cierre del lifecycle A4S, pero sigue siendo transición lifecycle del Bead. | `conflicto` | R6, R13, R15, R17 | Único claim de Bead closure; mitigación reconocida y finding pendiente de elección. |
| C053 | `skills/herdr/SKILL.md:198`, `skills/herdr/scripts/README.md:34` | Worker ausente o stale puede provocar redispatch automático en un nuevo tab. | `conflicto` | R1, R3, R5, R8 | Recovery lifecycle añadido; overlap de línea 198 limitado a redispatch; pendiente de elección. |
| C054 | `skills/herdr/SKILL.md:198`, `skills/herdr/scripts/README.md:15` | Closed Bead con live tab provoca tab reaping/close. | `conflicto` | R1, R3, R17 | Cleanup lifecycle añadido; overlap de línea 198 limitado a tab reaping; pendiente de elección. |
| C055 | `skills/herdr/SKILL.md:198`, `skills/herdr/SKILL.md:280`, `skills/herdr/scripts/README.md:23-30` | Mission Control protegido exige owner/lease/session identity y bloquea mutación ambigua. | `autoridad de dominio` | R3, R7 | Safety técnico; overlap de línea 198 limitado al MC gate. |
| C056 | `skills/herdr/SKILL.md:198` | Project Orchestrator debe permanecer thin y no acumular child transcripts. | `conflicto` | R1, R3, R8 | Policy de trabajo añadida; pendiente de elección. |
| C057 | `skills/herdr/scripts/README.md:3`, `skills/herdr/scripts/README.md:9`, `skills/herdr/scripts/README.md:13-14`, `skills/herdr/scripts/README.md:16-19` | Reconciler es executor determinista; tickets, ack audits e idempotencia fallan cerrado. | `autoridad de dominio` | R3, R7, R13 | Contrato técnico del script; closure/dispatch quedan separados. |
| C058 | `skills/herdr/scripts/README.md:55-60` | Default/dry-run y planning ignoring MC gate son read-only. | `autoridad de dominio` | R3, R7 | Interfaz técnica no mutante. |
| C059 | `skills/herdr/scripts/README.md:61-62` | `--apply` ejecuta tick mutante. | `conflicto` | R1, R3, R8, R9 | Flag técnico no sustituye autorización/controles; pendiente de elección. |
| C060 | `skills/herdr/scripts/README.md:65` | Label opt-in puede ampliarse a todo ready backlog para auto-dispatch. | `conflicto` | R1, R3, R5, R8 | Policy de selección/dispatch añadida; overlap de línea 65 explicitado. |
| C061 | `skills/herdr/scripts/README.md:65` | Reconciler asigna default kind/model `claude`/Sonnet. | `conflicto` | R1, R3, R8 | Default de modelo añadido; overlap de línea 65 explicitado. |
| C062 | `skills/herdr/scripts/README.md:65` | Metadata `cwd` y worktree sólo se exigen para mutación concurrente. | `conflicto` | R7 | Puede debilitar worktree dedicado; overlap de línea 65 explicitado. |
| C063 | `skills/herdr/scripts/README.md:69-80` | Runbook instala launchd/cron que ejecuta ticks mutantes recurrentes. | `conflicto` | R1, R3, R9 | Instalación/efecto externo requiere decisión y autorización; pendiente de elección. |
| C064 | `skills/herdr/SKILL.md:202` | La observación w4J registró 73/73 wakes con turn y 57 sin write/dispatch. | `histórico/inactivo` | R2 | Evidencia histórica que motiva H2; no gobierna el contrato. |
| C065 | `skills/herdr/SKILL.md:202-217` | H2 clasifica wakes por evidencia, persiste state/ticks y `--live` prompts/notifica sin mutar Beads. | `autoridad de dominio` | R3, R13 | Contrato técnico; overlap de línea 202 limitado a la mecánica H2. |
| C066 | `skills/herdr/SKILL.md:219` | Pane split requiere petición explícita y background setup usa no-focus. | `autoridad de dominio` | R3, R7 | Guard de interacción/focus. |
| C067 | `skills/herdr/SKILL.md:223-231` | Binary instalado y leaf help son autoridad de sintaxis; bare `herdr` se evita y IDs salen de JSON. | `autoridad de dominio` | R3, R20 | Autoridad técnica del provider instalado. |
| C068 | `skills/herdr/SKILL.md:235-241` | IDs son handles opacos y targeting usa current/IDs/responses observadas. | `autoridad de dominio` | R3, R20 | Mecánica de targeting. |
| C069 | `skills/herdr/SKILL.md:245-249` | Agent get/read/send-keys son controles one-shot del runtime. | `autoridad de dominio` | R3, R20 | Interfaz técnica. |
| C070 | `skills/herdr/SKILL.md:251` | Completion es callback-driven; no polling/wait/timeouts y blocked se inspecciona una vez. | `autoridad de dominio` | R3, R13, R20 | Técnica de observación; routing humano distinto se clasifica en la siguiente fila. |
| C071 | `skills/herdr/SKILL.md:251` | Blocked Worker no se responde a mano y toda decisión humana escala vía Mission Control. | `conflicto` | R1, R3, R8 | Policy de roles/escalación añadida; overlap de línea 251 explicitado. |
| C072 | `skills/herdr/SKILL.md:253` | Read sources y alternate-screen recovery definen cómo recuperar output. | `autoridad de dominio` | R3, R20 | Interfaz técnica. |
| C073 | `skills/herdr/SKILL.md:257-263` | Plain command usa root pane, wait-output y read. | `autoridad de dominio` | R3, R20 | Operación técnica sin agent. |
| C074 | `skills/herdr/SKILL.md:265-271` | Pane split/layout usa direction, ratio e IDs devueltos. | `autoridad de dominio` | R3, R20 | Operación técnica de layout. |
| C075 | `skills/herdr/SKILL.md:98`, `skills/herdr/SKILL.md:288` | Trust/YOLO no autoriza push, merge, delete, secrets ni efectos externos. | `alineado` | R7-R9, R15, R17 | Guard alineado; line98 excluida de policy conflictiva. |
| C076 | `skills/herdr/SKILL.md:289` | Background work usa no-focus. | `autoridad de dominio` | R3, R7 | Guard técnico de focus. |
| C077 | `skills/herdr/SKILL.md:290` | Targeting usa current, ID explícito o agent name único. | `autoridad de dominio` | R3, R20 | Guard técnico de target. |
| C078 | `skills/herdr/SKILL.md:291` | IDs se parsean desde JSON, no sidebar order. | `autoridad de dominio` | R3, R20 | Contrato técnico de identificación. |
| C079 | `skills/herdr/SKILL.md:292` | No se cierran recursos Herdr ajenos salvo petición del usuario. | `conflicto` | R1, R3, R17 | Petición genérica no sustituye cleanup/authorization exactos; pendiente de elección. |
| C080 | `skills/herdr/SKILL.md:293` | Nunca se detiene server/kill main Herdr desde sesión activa. | `autoridad de dominio` | R3, R7 | Safety técnico del provider. |
| C081 | `skills/herdr/SKILL.md:294` | Errores server/syntax tienen streams y exit codes definidos. | `autoridad de dominio` | R3, R20 | Contrato CLI. |
| C082 | `skills/docs-northstar/SKILL.md:96`, `skills/docs-northstar/references/method.md:13` | Excava `docs/**` pero omite la raíz real `.workspace/docs/**`. | `conflicto` | R11 | Root defect mapeado únicamente a `a4s-apo.6`; no mutar Bead. |
| C083 | `skills/docs-northstar/SKILL.md:32-35`, `skills/docs-northstar/references/method.md:19-21` | ADR/spec declarado actúa como SOURCE hasta que owner lo confirme/corrija. | `conflicto` | R1-R3 | Sin mapeo; pendiente de elección del operador. |
| C084 | `skills/docs-northstar/SKILL.md:25`, `skills/docs-northstar/references/method.md:21`, `skills/docs-northstar/references/method.md:160` | “Mark superseded” no especifica si crea un nuevo record append-only o edita el existente. | `unknown` | R2 | Sin mapeo; pendiente de elección y de concretar operación. |
| C085 | `skills/docs-northstar/SKILL.md:41`, `skills/docs-northstar/references/method.md:161` | Prescribe pre-push docs-sync guard. | `conflicto` | R1, R3 | Sin mapeo; pendiente de elección. |
| C086 | `skills/docs-northstar/SKILL.md:13-24`, `skills/docs-northstar/SKILL.md:45-90` | No inventar hero, separar evidencia/narrativa y verificar claims. | `autoridad de dominio` | R3, R5, R13 | Técnica narrativa. |
| C087 | `skills/roadmap/README.md:3` | La forma de trabajo vive en config, no en la skill; ADR 0059 se trata sólo como provenance parentética. | `alineado` | R1-R3 | Sólo config-as-authority; la cláusula sequential de la misma línea queda en C097. |
| C088 | `skills/roadmap/README.md:23` | Un cambio Roadmap requiere real loop run con outcome observado. | `alineado` | R13 | E2E específico del skill. |
| C089 | `skills/roadmap/README.md:43` | Merge y activation son separados; released tag, operator-authorized reinstall, never implementation worktree y loop no-edit. | `alineado` | R1, R9, R19 | Conservar activation boundary completa. |
| C090 | `skills/roadmap/README.md:63` | Rollback reinstala el tag previo con el mismo runbook. | `autoridad de dominio` | R3, R9 | Técnica de rollback; no autoriza external effect. |
| C091 | `skills/roadmap/README.md:65` | Post-merge activation runbook está declarado superseded/historical. | `histórico/inactivo` | R2 | No usar como procedimiento activo. |
| C092 | `skills/roadmap/SKILL.md:13` | Roadmap lee way-of-working desde config y no lo define. | `alineado` | R1, R3 | Sólo config-as-authority; one-task de la misma línea queda en C097. |
| C093 | `skills/roadmap/SKILL.md:15` | Routing carga `contracts.md` y una recipe sin cambiar cwd. | `autoridad de dominio` | R3 | Mecánica de invocación. |
| C094 | `skills/roadmap/SKILL.md:24` | Wording ambiguo se resuelve por intent y una pregunta sólo si quedan dos modos. | `autoridad de dominio` | R3, R5 | Técnica de routing. |
| C095 | `skills/roadmap/SKILL.md:40` | Beads es backlog durable y task record. | `alineado` | R6, R13 | Conservar derivación. |
| C096 | `skills/roadmap/SKILL.md:41-42`, `skills/roadmap/SKILL.md:44` | Tipos/edges y unknown-not-guessed especializan graph/readiness. | `autoridad de dominio` | R3, R5, R6 | Técnica Roadmap. |
| C097 | `skills/roadmap/README.md:3`, `skills/roadmap/README.md:11`, `skills/roadmap/SKILL.md:13`, `skills/roadmap/SKILL.md:43`, `skills/roadmap/references/loop.md:3` | Roadmap/Loop impone ejecución sequential y one-task-at-a-time. | `conflicto` | R1, R3, R8 | Policy añadida; overlaps de README:3 y SKILL:13 contienen fragments aligned separados en C087/C092; pendiente de elección. |
| C098 | `skills/roadmap/SKILL.md:45` | Loop nunca edita `skills/roadmap`. | `alineado` | R19 | Conservar. |
| C099 | `skills/roadmap/references/tree.md:56` | Tree presenta Description, ID, Result y Scope sin inferir/mutar/backfill. | `alineado` | R5 | Conservar proyección UI. |
| C100 | `skills/roadmap/references/tree.md:79` | Tree elige candidato por resumable/executable y orden priority/dependents/ID. | `autoridad de dominio` | R3, R8 | Mecánica de candidate rendering; defaults readiness quedan en conflictos separados. |
| C101 | `skills/roadmap/SKILL.md:28-30` | Precedencia operator, config, skill. | `conflicto` | R1, R4 | Pendiente de elección; operator requiere protocolo de desviación. |
| C102 | `skills/roadmap/SKILL.md:32-34` | Roadmap dice derivar de config y no añadir gates. | `alineado` | R3, R5, R8 | Conservar. |
| C103 | `skills/roadmap/SKILL.md:36` | Axis ausente toma default del Profile. | `conflicto` | R1, R3 | Pendiente de elección; Profile no rellena config ausente. |
| C104 | `skills/roadmap/references/contracts.md:33` | Cualquier axis ausente recibe el default de contracts. | `conflicto` | R1, R3 | Policy añadida; pendiente de elección. |
| C105 | `skills/roadmap/references/contracts.md:37`, `skills/roadmap/references/contracts.md:49-53`, `skills/roadmap/references/loop.md:15` | Default de readiness añade task contract y excepción `legacy`. | `conflicto` | R1, R3, R6 | La base material coincide en parte, pero excepción/default son policy añadida; pendiente de elección. |
| C106 | `skills/roadmap/references/contracts.md:38`, `skills/roadmap/references/loop.md:16-18`, `skills/roadmap/references/loop.md:54` | Default `incomplete_task_policy` controla skip/stop/backfill. | `conflicto` | R1, R3, R8 | Coincide materialmente con continuar trabajo independiente, pero como fallback ausente es policy añadida; line54 overlap con failed policy explicitado. |
| C107 | `skills/roadmap/references/contracts.md:39`, `skills/roadmap/references/loop.md:43-44`, `skills/roadmap/references/loop.md:54` | Default `failed_task_policy` bloquea y decide skip/stop. | `conflicto` | R1, R3, R8 | Coincide materialmente con reportar bloqueo y continuar, pero añade policy; line54 overlap explicitado. |
| C108 | `skills/roadmap/references/contracts.md:40` | Default `controller_identity=unknown`. | `conflicto` | R1, R3 | Contradice `track_work.controller_identity=env:PI_SESSION_ID`; pendiente de elección. |
| C109 | `skills/roadmap/references/contracts.md:45`, `skills/roadmap/references/loop.md:68` | Default cleanup “offer, never delete”. | `conflicto` | R17 | Contradice cleanup obligatorio post-integración; pendiente de elección. |
| C110 | `skills/roadmap/references/contracts.md:47` | Un unknown repository-wide detiene Loop. | `alineado` | R8 | Coincide con detener autonomía ante un control general unknown. |
| C111 | `skills/roadmap/references/contracts.md:47` | Un unknown task-scoped aplica el default `failed_task_policy`. | `conflicto` | R1, R3, R8 | Fallback añadido por la skill; pendiente de elección. |
| C112 | `skills/roadmap/references/loop.md:7`, `skills/roadmap/references/loop.md:21-34`, `skills/roadmap/references/loop.md:38`, `skills/roadmap/references/loop.md:49-53`, `skills/roadmap/references/loop.md:55-57` | Loop lee config, usa guarded transitions y respeta stop/human gates. | `alineado` | R5, R8, R13-R17 | Recipe alineada; excluye graph/default mechanics. |
| C113 | `skills/roadmap/references/loop.md:11-14`, `skills/roadmap/references/loop.md:19`, `skills/roadmap/references/loop.md:59-67`, `skills/roadmap/references/plan.md:3-10`, `skills/roadmap/references/doctor.md:5-33`, `skills/roadmap/references/tree.md:3-30` | Selección, graph rendering, proposal/doctor y summary son mecánicas Roadmap. | `autoridad de dominio` | R3, R5 | Técnica de graph/UI. |
| C114 | `skills/roadmap/references/loop.md:15-18`, `skills/roadmap/references/loop.md:43-44`, `skills/roadmap/references/loop.md:54` | Loop aplica definition/incomplete/failed defaults añadidos por contracts. | `conflicto` | R1, R3, R6, R8 | Referencias a defaults conflictivos C105-C107; overlaps deliberados y pendientes de elección. |
| C115 | `skills/roadmap/references/loop.md:36` | Controller delega a workers fresh y workers no delegan. | `conflicto` | R1, R3, R8 | Topology policy ausente; pendiente de elección. |
| C116 | `skills/roadmap/references/loop.md:42`, `skills/roadmap/references/loop.md:45` | Pass task/epic se cierra antes del cleanup obligatorio post-integración. | `conflicto` | R17 | Lifecycle order contradice mandatory cleanup-before-close; pendiente de elección. |
| C117 | `skills/adr/SKILL.md:11` | Skill se declara único owner de policy ADR. | `conflicto` | R1, R3 | Pendiente de elección. |
| C118 | `skills/adr/SKILL.md:15`, `skills/adr/SKILL.md:23-34` | Routing técnico a `.workspace/docs/adr` y Rootline. | `autoridad de dominio` | R3, R11 | Técnica de escritura, subordinada a config. |
| C119 | `skills/adr/SKILL.md:19`, `skills/adr/SKILL.md:44-46` | Threshold propio y hook/merge gate opcional. | `conflicto` | R1, R3, R11, R15 | Pendiente de elección; config define cuándo ADR y merge controls. |
| C120 | `skills/decision-calibrator/SKILL.md:31-40` | Controles de calibración y rigor. | `autoridad de dominio` | R3 | Técnica de decisión. |
| C121 | `skills/decision-calibrator/SKILL.md:35-36`, `skills/decision-calibrator/SKILL.md:48` | ADR aceptado es estado canónico que no puede revivirse sin nuevo ADR. | `conflicto` | R1-R3 | Pendiente de elección; records informan, no gobiernan. |
| C122 | `skills/decision-calibrator/SKILL.md:60` | Toda corrección de ADR usa supersede/accept vía skill. | `conflicto` | R1-R3, R18 | Pendiente de elección; config sólo exige nuevo record para supersession y ADR para cambio normativo/arquitectural. |
| C123 | `skills/context-save/SKILL.md:30`, `skills/context-save/SKILL.md:57` | Handover estructurado y calidad de claims Verified/Reported/Assumed. | `autoridad de dominio` | R3, R13 | Técnica de snapshot. |
| C124 | `skills/context-save/SKILL.md:64-90`, `skills/context-save/SKILL.md:142-189` | Crea session-state durable bajo `.claude/session-state/`. | `conflicto` | R1, R3, R11 | Mapping a `a4s-apo.7` no autoriza cambios y queda pendiente de confirmación del operador. |
| C125 | `skills/context-save/SKILL.md:244-250` | Backscroll es opcional y su ausencia permite continuar silenciosamente. | `conflicto` | R3, `do_work.history` líneas 219-224 | Mapping a `a4s-apo.7` es no-autorizante y queda pendiente de confirmación del operador. |
| C126 | `skills/context-save/SKILL.md:252-290` | Restore/list y validación Rootline de session-state. | `autoridad de dominio` | R3 | Técnica; el destino conflictivo está separado en C124. |
| C127 | `skills/rule-audit/SKILL.md:17`, `skills/rule-audit/SKILL.md:19-22` | Rubric, block scoring y harness map para auditar reglas. | `autoridad de dominio` | R3, R13 | Técnica de auditoría. |
| C128 | `skills/rule-audit/SKILL.md:18`, `skills/rule-audit/SKILL.md:46`, `skills/rule-audit/SKILL.md:58` | Impone screen-first y approval por finding incluso si se pide audit+fix. | `conflicto` | R1, R3, R4 | Pendiente de elección. |
| C129 | `skills/rule-audit/SKILL.md:34-35`, `skills/rule-audit/SKILL.md:45` | Si Backscroll falta/stale, continúa como “no violation evidence”. | `conflicto` | `do_work.history` líneas 219-224 | Pendiente de elección; una fuente requerida ausente queda unknown. |
| C130 | `skills/agent-behavior-doctor/SKILL.md:15-18` | Siempre escanea diez sesiones cross-project sin flujo project-first/one widen. | `conflicto` | R1, R3, `do_work.history` | Pendiente de elección. |
| C131 | `skills/cost-analyzer/SKILL.md:44`, `skills/cost-analyzer/SKILL.md:78` | Atribución de PRs/cohortes y lectura Git no mutante. | `autoridad de dominio` | R3 | Técnica de medición. |
| C132 | `skills/markitdown/SKILL.md:23-26`, `skills/markitdown/references/formats.md:1-24` | CLI, formatos y protección de secretos al convertir. | `autoridad de dominio` | R3, R10 | Técnica de conversión. |
| C133 | `skills/mission-control-health/SKILL.md:30-36` | Umbrales, notificación y lectura no mutante de salud. | `autoridad de dominio` | R3 | Contrato técnico. |
| C134 | `skills/model-optimizer/SKILL.md:11-24`, `skills/model-optimizer/SKILL.md:47-54` | Inventario, evaluación confinada, approval de config y rollback. | `autoridad de dominio` | R3, R9 | Técnica de optimización; no autoriza mutación A4S. |
| C135 | `skills/naming-brief/SKILL.md:19-28` | Sólo produce brief, no nombre, y pregunta por required unknowns. | `autoridad de dominio` | R3 | Contrato del artefacto. |
| C136 | `skills/remove-gentle-context/SKILL.md:12`, `skills/remove-gentle-context/SKILL.md:24-40` | Plan digest, ownership y rollback para retirar contexto. | `autoridad de dominio` | R3, R7, R17 | Técnica de cleanup del componente. |
| C137 | `skills/systemic-issue-triage/SKILL.md:24-30`, `skills/systemic-issue-triage/SKILL.md:38-46`, `skills/systemic-issue-triage/SKILL.md:101-106` | Scope CWD, inventario read-only y stop antes de diseño/mutación. | `autoridad de dominio` | R3, R7 | Técnica de triage. |
| C138 | `skills/cost-analyzer/references/canonical-dataset-design.md:7-17`, `skills/model-optimizer/references/benchmark-sources.md:7-54`, `skills/model-optimizer/references/contracts.md:7-184`, `skills/model-optimizer/references/evaluation-tiers.md:8-130`, `skills/model-optimizer/references/optimization-flow.md:11-111`, `skills/remove-gentle-context/references/contracts.md:5-102`, `skills/remove-gentle-context/references/preservation.md:1-26`, `skills/rule-audit/references/rule-strength-rubric.md:5-101` | Después de extraer los conflictos específicos de ADR, decision-calibrator, context-save, rule-audit y agent-behavior-doctor, las references residuales especifican schemas, scoring, evaluación, apply/rollback y preservation internos. | `autoridad de dominio` | R3 | Contratos de componentes; no se tratan como policy A4S. |
| C139 | `agents/superpowers/superpowers-architecture-reviewer.md:9-13`, `agents/superpowers/superpowers-final-reviewer.md:9-13`, `agents/superpowers/superpowers-task-reviewer.md:9-11` | Reviewers comunes son read-only, no delegan ni publican/commitean. | `autoridad de dominio` | R3, R14 | Contrato común de rol. |
| C140 | `agents/superpowers/superpowers-final-reviewer.md:9-13` | Final reviewer evalúa branch completo y merge readiness. | `alineado` | R14 | Puede servir a R14 si además cumple freshness/family/provider. |
| C141 | `agents/superpowers/superpowers-task-reviewer.md:9-13` | Task reviewer limita revisión a una task/surface y separa preexistentes. | `autoridad de dominio` | R14 | Rol task-only; por sí solo no acredita review del PR completo. |
| C142 | `agents/README.md:7-9`, `agents/superpowers/superpowers-integration-worker.md:9-20` | Canonical/adapters y worker scope/formato de retorno. | `autoridad de dominio` | R3, R20 | Contrato de invocación. |
| C143 | `agents/README.md:13` | ADR 0049 se presenta como gobierno de activation Claude. | `conflicto` | R1, R2 | Record no gobierna activation; pendiente de elección. |
| C144 | `output-styles/mentor-telemetria.assets/append-system.md:5-8` | Instrucción directa suficientemente scoped es execution signal salvo unknown material. | `alineado` | R5, R8 | No exime reserved authority ni controles. |
| C145 | `output-styles/mentor-telemetria.assets/append-system.md:19-21` | Corrección no es preferencia durable salvo future rule explícita. | `alineado` | R1, R2, R18 | Conservar memory/evidence boundary. |
| C146 | `output-styles/mentor-telemetria.assets/append-system.md:14-17` | Persistent memory es evidencia, no autoridad, y current user message la supera. | `alineado` | R1, R2, `do_work.history` | Conservar guard de procedencia. |
| C147 | `output-styles/mentor-telemetria.assets/append-system.md:25-27` | Texto generado se publica como voz del operador sin disclosure por autoría AI. | `alineado` | R12 | Conservar. |
| C148 | `output-styles/mentor-telemetria.assets/append-system.md:35-37` | Verificación mínima se escala al changed surface y active contract. | `alineado` | R13 | Conservar criterio proporcional. |
| C149 | `output-styles/mentor-telemetria.md:38`, `output-styles/mentor-telemetria.assets/append-system.md:66` | Evaluar learning antes de cada output es obligatorio. | `conflicto` | R1, R3 | Mismo policy conflictivo en main y append; pendiente de elección. |
| C150 | `output-styles/mentor-telemetria.md:9-28` | Voz y response shape son contrato de interacción. | `autoridad de dominio` | R3 | Learning mandatory queda fuera, en su conflicto propio. |
| C151 | `output-styles/mentor-telemetria.md:30-32` | Safety gate exige observación, fail-closed, review y autorización renovada. | `alineado` | R9 | Conservar. |
| C152 | `output-styles/mentor-telemetria.assets/append-system.md:56` | Retry tras fallo exige fix/review pero omite autorización renovada. | `conflicto` | R9 | Pendiente de elección. |
| C153 | `output-styles/mentor-telemetria.assets/append-system.md:58-60` | Content instruction no autoriza retarget de symlink y preserva topología verificada. | `alineado` | R7 | Guard defensivo separado del retry. |
| C154 | `output-styles/mentor-telemetria.md:34`, `output-styles/mentor-telemetria.assets/append-system.md:62` | Siempre añade `/.codegraph/` al exclude local. | `conflicto` | R1, R3, R7 | Pendiente de elección. |
| C155 | `output-styles/mentor-telemetria.md:42-44`, `output-styles/mentor-telemetria.assets/append-system.md:70-72` | Output style decide routing y ADR. | `conflicto` | R1-R3, R11 | Pendiente de elección. |
| C156 | `packages/typesafe/README.md:14-20`, `packages/typesafe/src/resolver.ts:34-35`, `packages/typesafe/test/resolver.test.ts:47-54`, `packages/pi-context-expert/README.md:20`, `packages/pi-context-expert/README.md:87` | Provider credential contract incluye fallback `TYPESAFE_API_KEY`, documentado en ambos packages, implementado y probado. | `conflicto` | R10 | Pendiente de elección para `@a4s/typesafe` y `pi-context-expert`; provider/fallback fuera de autoridad de dominio. |
| C157 | `packages/typesafe/README.md:8-13`, `packages/typesafe/README.md:21-25` | SDK pin, factory, model exacto y fail-closed before network son contratos técnicos. | `autoridad de dominio` | R20 | Provider/fallback credentials quedan fuera. |
| C158 | `packages/typesafe/README.md:52-55`, `packages/typesafe/src/resolver.ts:34-35` | README afirma “no env scraping” mientras resolver lee env fallback. | `conflicto` | R10, R13 | Factual drift conocido; pendiente de elección para ambos packages. |
| C159 | `packages/pi-context-expert/README.md:7-19`, `packages/pi-context-expert/README.md:21`, `packages/pi-context-expert/README.md:23-24`, `packages/pi-context-expert/README.md:26-74` | Compaction, Evidence, store-only mechanics, Trigger y privacy, excluyendo fallback y ADR-deferred apply. | `autoridad de dominio` | R13, R20 | Lines20/87 y line22 quedan en conflictos separados. |
| C160 | `packages/pi-context-expert/README.md:22` | Durable apply de accepted rule se difiere a “decision in ADR 0020”. | `conflicto` | R1, R2, R11 | Record no gobierna durable apply; pendiente de elección. |
| C161 | `packages/pi-context-expert/README.md:194-197` | Todo E2E preserva artifacts y su cleanup queda manual. | `conflicto` | R6, R13, R17 | Pendiente de elección sobre Context Expert; no prescribir clasificación. |
| C162 | `test/test_repository_contract.py:123-124`, `test/test_repository_contract.py:184-253` | Backstops exactos para AGENTS, config y Roadmap UI derivada. | `alineado` | R3, R5, R7, R11 | Conservar patrón; global steering queda separado. |
| C163 | `test/test_repository_contract.py:35-39`, `test/test_repository_contract.py:126-130` | Contract test conserva guards defensivos de global steering. | `alineado` | R3, R7, R13 | Backstop derivado/defensivo; no demuestra activación instalada. |
| C164 | `profiles/pablontiv/tests/test_profile_contract.py:246-250` | Test fija handbook snapshot digest como procedencia aprobada. | `conflicto` | R1-R3 | Record snapshot no gobierna; pendiente de elección. |
| C165 | `profiles/pablontiv/tests/test_profile_contract.py:252-370` | Tests congelan secciones, categorías, template y routing normativo de Profile v2. | `conflicto` | R1-R3 | Parte del target estructural Profile; pendiente de elección. |
| C166 | `profiles/pablontiv/tests/test_profile_contract.py:373-384` | Bootstrap conserva orden read-only, candidate, approval, write y verify; unknown bloquea. | `alineado` | R7, R9 | Backstop de safe-order. |
| C167 | `profiles/pablontiv/tests/test_profile_contract.py:386-392` | Identidad reusable usa origin relocatable y no path físico. | `autoridad de dominio` | R3, R20 | Contrato técnico de adopción. |
| C168 | `profiles/pablontiv/tests/test_profile_contract.py:394-584` | Tests leen y comprueban reglas del dogfood config. | `alineado` | R3 | Conservar patrón derivado. |
| C169 | `test/ci-local.sh:65-159`, `.github/workflows/ci.yml:17-126` | CI local/remoto ejecuta tests, typecheck y Rootline. | `alineado` | R11, R13, R15 | Gate ejecutable requerido. |
| C170 | `test/test_publication_security.py:78-240` | Backstop supply-chain y manifest prepare-only. | `autoridad de dominio` | R9, R13 | No autoriza rollout. |
| C171 | `.github/CONTRIBUTING.md:3-16`, `.github/SECURITY.md:3-23`, `.github/CODEOWNERS:1-9` | Contribución, disclosure y ownership GitHub. | `autoridad de dominio` | R9, R20 | Política del servicio, no workflow interno. |
| C172 | `.github/publication/README.md:1-57`, `.github/publication/desired-state.json:1-18`, `.github/publication/cleanup-plan.json:1-25` | Rollout y cleanup están marcados prepare-only/futuros. | `histórico/inactivo` | R2, R9, R17 | No ejecutar como autoridad. |
| C173 | `.github/publication/desired-state.json:7-16` | Candidate validation exige exact-SHA ci-local e independent reviewer, pero no codifica freshness/family/provider de R14. | `histórico/inactivo` | R14 | Gap de plan inactivo; pendiente de elección antes de activarlo. |
| C174 | `agents/README.md:14-17` | Activación Claude depende de symlinks externos. | `unknown` | R7, R20 | Verificar symlinks read-only en instalación real. |
| C175 | `test/test_repository_contract.py:19`, `test/test_repository_contract.py:126-130` | Repo valida contenido de append-system, no demuestra que global steering esté instalado/activo. | `unknown` | R7, R13 | Verificar instalación externa antes de depender de ella. |
| C176 | `.github/publication/README.md:35-47`, `.github/publication/desired-state.json:89-120` | Desired branch protection está documentada, pero el plan no prueba settings GitHub actuales. | `unknown` | R7, R13 | Reread remoto read-only antes de cualquier decisión. |
| C177 | `packages/pi-context-expert/README.md:166-173`, `packages/pi-context-expert/src/extension.ts:190` | Código registra provider y E2E requiere providers, pero disponibilidad/auth live no están en Git. | `unknown` | R7, R10, R13 | Verificar provider real sin exponer credenciales. |
| C178 | `skills/remove-gentle-context/tests/fixtures/current-installer/gemini/GEMINI.md:286-303` | Fixture contiene instrucciones normativas copiadas para tests. | `histórico/inactivo` | R2, R3 | Evidencia fixture; no está cubierto por `a4s-apo.7`. |
| C179 | `skills/model-optimizer/tests/pressure/baseline.md:1-13` | Baseline de presión conserva respuestas históricas. | `histórico/inactivo` | R2, R3 | Evidencia de test; sin afirmar cobertura de ningún Bead. |

## Hallazgos independientes requeridos

### GitHub Communication

C026 es técnica de dominio. C027 contradice la excepción expresa para PR y
PR descriptions; C028 añade standing authorization. Ambos conflictos quedan
pendientes de elección y no se corrigieron.

### Sweep

C029 y C035 son técnica. C030-C034 separan flag, fetch mutante, cleanup local,
self-approval/auto-merge y borrado remoto. C033 reconoce expresamente que ya
existen mergeability/check/reviewDecision gates, autorización `--admin` y guards
de conflictos/breaking; el conflicto restante es que esos guards no completan
R14-R16.

### Herdr

C036-C081 cubren SKILL 11-294 y scripts README 3-80 dentro de la frontera
bounded. C044 excluye line98; C045 separa naming; C075 clasifica guards 98/288.
C050 empieza en 148 y C052 es el único Bead-closure claim, con line146/196.
C046/C053-C056 dividen line198; C057-C063 cubren scripts policy; C064 separa la
observación histórica y C065-C081 cubren H2/CLI/safety. Appendix B asigna cada
línea material a claim o reason non-normative, sin inferir ausencia externa.

### Mentor Telemetría

C144-C149 separan direct instruction, memory/correction evidence, operator voice,
proportional verification y el único mandatory-learning conflict. C150 es
interacción domain; C151 safety; C152-C155 separan retry, symlink topology,
`.codegraph` y routing/ADR.

## Targets, findings pendientes y no acciones

1. **Profile v2:** C007-C025 y tests conflictivos C164-C165 forman target
   estructural; C166-C167 se preservan como safe-order/domain.
2. **Docs Northstar:** sólo C082 se mapea a `a4s-apo.6`; C083-C085 quedan
   pendientes de elección.
3. **Snapshots activos:** sólo C124-C125 se mapean a `a4s-apo.7`; mapping
   no-autorizante y pendiente de confirmación. C178-C179 no están cubiertos.
4. **Findings consolidados pendientes:** README C003-C005; Roadmap sólo
   C097, C101, C103-C109, C111 y C114-C116; TypeSafe C156/C158; Context Expert
   C160-C161; Docs Northstar C083/C085. Todos quedan
   pendientes de elección del operador. No se crea tarea, no se cambia config y
   no se prescribe una disposición aprobada.
5. Esta entrega modifica únicamente este informe; no toca Profile, skills,
   references, agents, output styles, packages, tests, CI, GitHub docs ni Beads.

## Métricas reproducibles y revisión propia

- **Inventario:** 363/363 paths del comando `git ls-tree` están manifestados una
  vez. Esto prueba cobertura de inventario, no exhaustividad semántica.
- **Claims:** 179 filas estrechas (`C001`-`C179`), cada una con al menos un
  `path:line`, una clase, regla y disposición.
- **Referencias:** se cuentan sólo tokens `path:start[-end]` de la columna
  `Path:line`, no matches incidentales del resto del documento. El script del
  Apéndice B reproduce 179 filas, 179 filas con refs, 313 tokens de referencia,
  294 triples `(path,start,end)` únicos y 165 tokens multi-line; valida cada
  existencia y rango contra `A0`. Los 19 tokens duplicados son overlaps
  deliberados de una misma línea con claims distintos (por ejemplo Herdr
  94/198/251/288 y Roadmap 47/54), y cada overlap se explica en su disposición.
- **Clases de claim:** 34 `alineado`, 72 `conflicto`, 62 `autoridad de dominio`,
  6 `histórico/inactivo` y 5 `unknown`; total 179, reproducido por el script.
- [PASS] README:20, defaults Roadmap, Profile estrecho, guards Sweep, cuatro
  skills omitidas, reviewer split, plan publication, TypeSafe implementado,
  context-save y unknowns externos están separados.
- [PASS] Mapping exacto: C082 a `a4s-apo.6`; C124-C125 a `a4s-apo.7`; ningún
  otro claim se presenta como cubierto por esos Beads.
- [PASS] E1: los selectores literales reproducen 173 docs totales, 73 para
  history más el selector docs/reports y 95 para records más ese selector.
- [PASS] E2: template activo/no efectivo separado de defaults skip,
  controller unknown, knowledge y cleanup; no se llama inactivo al template.
- [PASS] E3: fork mirrors cita tanto igualdad SHA (`:11-16`) como borrado
  (`:34-49`).
- [PASS] E4 previo: C049 excluye línea 142 y C052 reúne lines109/142/146/167,
  closure fragments de 182-198/283/scripts y la mitigación de línea 196.
- [PASS] E5 previo: C110 clasifica unknown global alineado y C111 separa fallback
  task-scoped conflictivo.
- [PASS] One-task policy consolidada en C097 con cinco ubicaciones; fragments
  config-as-authority de C087/C092 permanecen aligned y estrechos.
- [PASS] C114 incluye R6 y remite a C105-C107; Appendix verifica IDs externos,
  subjects/classes conocidos y prohíbe los crossrefs stale localizados.
- [PASS] Historia y fixtures concretos nunca se usan como autoridad.
- [PASS] Baseline evidence-backed bounded: corpus y 363/363 coverage, claims
  reportados exactos y cero errores conocidos; queries, muestreo, high-risk full
  review, blind spots y external unknowns quedan explícitos sin afirmar ausencia.

## Validación

Resultados del candidato remediado final:

- [PASS] Rootline escribió el estado final con `rootline set`; validación strict
  del documento: 1/1 válido, sin errors ni warnings.
- [PASS] `rootline validate --all .workspace/docs --strict -o json`: 167/167
  válidos, sin errors, warnings ni drift; sólo el notice informativo preexistente
  del nested root `adr/.stem`.
- [PASS] E001-E010: template activo/no efectivo; Herdr guards/naming/closure y
  scripts; Roadmap README/SKILL/loop; global steering constants; Profile tests;
  agents activation; Mentor clauses; manifest test precedence.
- [PASS] Barrido bounded adicional: 165 tokens multi-line revisados; Herdr
  material cubierto 195/195 y scripts 53/53 mediante claim IDs o reason explícito.
- [PASS] Script del Apéndice B: inventario 363, filas 179, filas con refs 179,
  313 tokens, 294 triples únicos, 165 rangos multi-line y class counts
  34/72/62/6/5; todos los paths y
  rangos son válidos en `A0`.
- [PASS] `test/ci-local.sh`: 20/20 steps.
- [PASS] `git diff --check`; sólo este archivo difiere de `HEAD` antes del amend.

## Apéndice B: check reproducible de matriz y manifiesto

Ejecutar desde la raíz del worktree:

```python
from pathlib import Path
from collections import Counter
import re
import subprocess

A = "e6154b537fc1e0890f221a42103ec15dad06a29d"
DOC = Path(".workspace/docs/audits/config-authority-baseline.md")
ROOTS = [
    "AGENTS.md", "README.md", "profiles", "skills", "agents",
    "output-styles", "packages", "test", ".github",
]

def is_backstop(path: str) -> bool:
    basename = path.rsplit("/", 1)[-1]
    return (
        path.startswith("test/")
        or "/tests/" in path
        or "/test/" in path
        or ".test." in basename
        or re.match(r"^test(?:[_-]|\.)", basename) is not None
        or re.search(r"_test(?:\.|$)", basename) is not None
    )

def coverage(path: str) -> str:
    if path.startswith(".github/publication/"):
        return "inactive-plan"
    if is_backstop(path):
        return "backstop-review"
    if ("/fixtures/" in path or "/pressure/" in path or "/evals/" in path
            or path.startswith("packages/pi-context-expert/fixtures/")):
        return "evidence-snapshot"
    if (path in {"AGENTS.md", "README.md", ".github/CODEOWNERS"}
            or path.endswith((".md", ".yaml", ".yml"))):
        return "semantic-review"
    return "domain-implementation"

text = DOC.read_text(encoding="utf-8")
matrix = text.split("## Matriz de claims\n", 1)[1].split(
    "\n## Hallazgos independientes", 1
)[0]
rows = [line for line in matrix.splitlines() if re.match(r"^\| C\d{3} \|", line)]
ids = [re.match(r"^\| (C\d{3})", row).group(1) for row in rows]
assert ids == [f"C{i:03d}" for i in range(1, len(rows) + 1)]
row_by_id = {claim_id: row for claim_id, row in zip(ids, rows)}
source_by_id = {claim_id: row.split("|")[2] for claim_id, row in row_by_id.items()}
claim_by_id = {claim_id: row.split("|")[3].strip() for claim_id, row in row_by_id.items()}
class_by_id = {claim_id: row.split("|")[4].strip().strip("`") for claim_id, row in row_by_id.items()}
rule_by_id = {claim_id: row.split("|")[5].strip() for claim_id, row in row_by_id.items()}
disposition_by_id = {claim_id: row.split("|")[6].strip() for claim_id, row in row_by_id.items()}

# Semantic split mechanics required by the fourth review.
def covered_lines(claim_id: str, path: str) -> set[int]:
    covered = set()
    for ref_path, first, last in re.findall(
        r"`([^`\n]+?):(\d+)(?:-(\d+))?`", source_by_id[claim_id]
    ):
        if ref_path == path:
            start, end = int(first), int(last or first)
            covered.update(range(start, end + 1))
    return covered

herdr = "skills/herdr/SKILL.md"
herdr_scripts = "skills/herdr/scripts/README.md"
assert 98 not in covered_lines("C044", herdr)
assert 94 in covered_lines("C045", herdr)
assert {98, 288} <= covered_lines("C075", herdr)
assert 146 not in covered_lines("C050", herdr)
assert {109, 142, 146, 167, *range(182, 199), 283} <= covered_lines("C052", herdr)
assert {11, 42, 48, 49, 50} <= covered_lines("C052", herdr_scripts)
assert 80 in covered_lines("C046", herdr)
assert 198 in covered_lines("C046", herdr)
assert 198 in covered_lines("C053", herdr)
assert 198 in covered_lines("C054", herdr)
assert 198 in covered_lines("C055", herdr)
assert 198 in covered_lines("C056", herdr)
assert 15 in covered_lines("C054", herdr_scripts)
assert 34 in covered_lines("C053", herdr_scripts)
assert all(65 in covered_lines(claim_id, herdr_scripts) for claim_id in ("C060", "C061", "C062"))
assert {3, 9, 13, 14, 16, 17, 18, 19} <= covered_lines("C057", herdr_scripts)
assert set(range(69, 81)) <= covered_lines("C063", herdr_scripts)
assert set(range(202, 218)) <= covered_lines("C065", herdr)
assert set(range(223, 232)) <= covered_lines("C067", herdr)
assert set(range(235, 242)) <= covered_lines("C068", herdr)
assert set(range(245, 250)) <= covered_lines("C069", herdr)
assert 251 in covered_lines("C070", herdr) and 251 in covered_lines("C071", herdr)
assert 253 in covered_lines("C072", herdr)
assert set(range(257, 264)) <= covered_lines("C073", herdr)
assert set(range(265, 272)) <= covered_lines("C074", herdr)
assert all(covered_lines(claim_id, herdr) for claim_id in (
    "C076", "C077", "C078", "C079", "C080", "C081"
))

# Every non-empty Herdr line is attached to a semantic claim or explicitly
# marked as non-normative structure/example. This supplements, not replaces,
# the semantic classifications above.
HERDR_NON_NORMATIVE = {
    herdr: {
        21: "section heading", 144: "section heading", 200: "section heading",
        221: "section heading", 233: "section heading", 243: "section heading",
        255: "section heading", 273: "section heading",
    },
    herdr_scripts: {
        5: "section heading", 7: "table header", 8: "table separator",
        12: "cross-reference row", 21: "section heading", 32: "section heading",
        36: "section heading", 40: "section heading", 44: "section heading",
        52: "section heading", 54: "code fence", 63: "code fence",
        67: "section heading",
    },
}

def semantic_coverage(path: str, start: int, end: int) -> dict[str, int]:
    blob = subprocess.check_output(["git", "show", f"{A}:{path}"], text=True)
    lines = blob.splitlines()
    material = {line for line in range(start, end + 1) if lines[line - 1].strip()}
    mapped = set()
    for claim_id in ids:
        mapped.update(covered_lines(claim_id, path))
    mapped &= material
    non_normative = set(HERDR_NON_NORMATIVE[path])
    assert non_normative <= material
    assert not (mapped & non_normative)
    assert material == mapped | non_normative, sorted(material - mapped - non_normative)
    return {
        "material": len(material),
        "claim_mapped": len(mapped),
        "non_normative": len(non_normative),
    }

herdr_semantic_coverage = {
    herdr: semantic_coverage(herdr, 11, 294),
    herdr_scripts: semantic_coverage(herdr_scripts, 3, 80),
}

# Bounded known-finding assertions for Template, Roadmap, Mentor, packages,
# Profile tests, agents and steering.
assert 55 in covered_lines("C021", "profiles/pablontiv/bootstrap.md")
assert all("inactivo" not in row_by_id[cid] for cid in ("C021", "C024", "C025"))
assert 202 in covered_lines("C064", herdr) and 202 in covered_lines("C065", herdr)
assert 36 not in covered_lines("C112", "skills/roadmap/references/loop.md")
assert 42 not in covered_lines("C112", "skills/roadmap/references/loop.md")
assert 45 not in covered_lines("C112", "skills/roadmap/references/loop.md")
assert 36 in covered_lines("C115", "skills/roadmap/references/loop.md")
assert {42, 45} <= covered_lines("C116", "skills/roadmap/references/loop.md")
assert all(claim_id in row_by_id for claim_id in (
    "C087", "C088", "C089", "C090", "C091", "C092", "C093", "C094",
    "C095", "C096", "C097", "C098", "C099", "C100"
))
assert 3 in covered_lines("C087", "skills/roadmap/README.md")
assert 23 in covered_lines("C088", "skills/roadmap/README.md")
assert 43 in covered_lines("C089", "skills/roadmap/README.md")
assert 63 in covered_lines("C090", "skills/roadmap/README.md")
assert 65 in covered_lines("C091", "skills/roadmap/README.md")
assert 56 in covered_lines("C099", "skills/roadmap/references/tree.md")
assert 79 in covered_lines("C100", "skills/roadmap/references/tree.md")
for path, line in (
    ("skills/roadmap/README.md", 3),
    ("skills/roadmap/README.md", 11),
    ("skills/roadmap/SKILL.md", 13),
    ("skills/roadmap/SKILL.md", 43),
    ("skills/roadmap/references/loop.md", 3),
):
    assert line in covered_lines("C097", path)
assert class_by_id["C097"] == "conflicto"
assert class_by_id["C087"] == "alineado" and class_by_id["C092"] == "alineado"
assert "one-task" not in claim_by_id["C087"].lower()
assert "one-task" not in claim_by_id["C092"].lower()
assert "sequential" not in claim_by_id["C087"].lower()
assert "sequential" not in claim_by_id["C092"].lower()
assert "R6" in rule_by_id["C114"]
assert "C105-C107" in disposition_by_id["C114"]
assert "C095-C097" not in disposition_by_id["C114"]
assert "separado en C124" in row_by_id["C126"]
assert "C072-C085" not in row_by_id["C138"]
assert 5 in covered_lines("C144", "output-styles/mentor-telemetria.assets/append-system.md")
assert 19 in covered_lines("C145", "output-styles/mentor-telemetria.assets/append-system.md")
assert 35 in covered_lines("C148", "output-styles/mentor-telemetria.assets/append-system.md")
assert {38} <= covered_lines("C149", "output-styles/mentor-telemetria.md")
assert {66} <= covered_lines("C149", "output-styles/mentor-telemetria.assets/append-system.md")
assert all(claim_id in row_by_id for claim_id in (
    "C144", "C145", "C146", "C147", "C148", "C149", "C152", "C153"
))
assert {20, 87} <= covered_lines("C156", "packages/pi-context-expert/README.md")
assert not ({14, 15, 16, 17, 18, 19, 20} & covered_lines("C157", "packages/typesafe/README.md"))
assert {52, 53, 54, 55} <= covered_lines("C158", "packages/typesafe/README.md")
assert 22 not in covered_lines("C159", "packages/pi-context-expert/README.md")
assert 22 in covered_lines("C160", "packages/pi-context-expert/README.md")
pending_summary = text.split("**Findings consolidados pendientes:**", 1)[1].split(
    "5. Esta entrega", 1
)[0]
assert "C086-C104" not in pending_summary
assert "C097, C101, C103-C109, C111 y C114-C116" in pending_summary
assert class_by_id["C110"] == "alineado"
assert class_by_id["C111"] == "conflicto"
assert "E5 previo: C110" in text and "C111 separa fallback" in text
report_before_appendix = text.split("## Apéndice B", 1)[0]
assert "E5 previo: C100" not in report_before_appendix
assert "defaults conflictivos C095-C097" not in report_before_appendix

# Every ID/range mentioned outside the table resolves to an actual matrix row.
report_without_matrix = text.split("## Matriz de claims", 1)[0] + text.split(
    "## Hallazgos independientes requeridos", 1
)[1].split("## Apéndice B", 1)[0]
mentioned_ids = set()
for first, last in re.findall(r"C(\d{3})(?:-C?(\d{3}))?", report_without_matrix):
    start, end = int(first), int(last or first)
    assert start <= end
    mentioned_ids.update(f"C{number:03d}" for number in range(start, end + 1))
assert mentioned_ids <= set(row_by_id), sorted(mentioned_ids - set(row_by_id))
# Subject/class checks for every narrative family that assigns meaning to IDs.
for claim_id, expected_class, source_fragment in (
    ("C026", "autoridad de dominio", "gh-communication-style"),
    ("C030", "conflicto", "skills/sweep"),
    ("C052", "conflicto", "skills/herdr"),
    ("C097", "conflicto", "skills/roadmap"),
    ("C110", "alineado", "skills/roadmap"),
    ("C111", "conflicto", "skills/roadmap"),
    ("C124", "conflicto", "context-save"),
    ("C149", "conflicto", "mentor-telemetria"),
    ("C156", "conflicto", "typesafe"),
    ("C160", "conflicto", "pi-context-expert"),
    ("C164", "conflicto", "test_profile_contract"),
):
    assert class_by_id[claim_id] == expected_class
    assert source_fragment in source_by_id[claim_id]
assert {35, 36, 37, 38, 39, 126, 127, 128, 129, 130} <= covered_lines(
    "C163", "test/test_repository_contract.py"
)
assert all(claim_id in row_by_id for claim_id in ("C164", "C165", "C166", "C167"))
assert 13 in covered_lines("C143", "agents/README.md")
assert set(range(14, 18)) <= covered_lines("C174", "agents/README.md")

# Bounded-language guard: corpus/path coverage and zero known errors are allowed;
# absolute semantic completeness or absence claims are not.
lower_report = text.split("## Apéndice B", 1)[0].lower()
for forbidden in (
    "demuestra exhaustividad semántica",
    "prueba exhaustividad semántica",
    "prueba ausencia de otros claims",
    "no existen otros claims",
    "todos los claims del repositorio están cubiertos",
):
    assert forbidden not in lower_report

refs = []
rows_with_refs = 0
multi_line_reference_tokens = 0
claim_classes = Counter()
for row in rows:
    cells = row.split("|")
    source_cell = cells[2]
    claim_class = cells[4].strip().strip("`")
    claim_classes[claim_class] += 1
    found = re.findall(r"`([^`\n]+?):(\d+)(?:-(\d+))?`", source_cell)
    assert found, row
    rows_with_refs += 1
    for path, first, last in found:
        start, end = int(first), int(last or first)
        multi_line_reference_tokens += int(end > start)
        blob = subprocess.check_output(["git", "show", f"{A}:{path}"])
        lines = blob.count(b"\n") + (0 if blob.endswith(b"\n") else 1)
        assert 1 <= start <= end <= lines, (path, start, end, lines)
        refs.append((path, start, end))

assert claim_classes == {
    "alineado": 34,
    "conflicto": 72,
    "autoridad de dominio": 62,
    "histórico/inactivo": 6,
    "unknown": 5,
}

def tree_paths(*selectors: str) -> list[str]:
    return subprocess.check_output(
        ["git", "ls-tree", "-r", "--name-only", A, "--", *selectors],
        text=True,
    ).splitlines()

assert len(tree_paths(".workspace/docs")) == 173
assert len(tree_paths(".workspace/docs/history", ".workspace/docs/reports")) == 73
assert len(tree_paths(
    ".workspace/docs/adr", ".workspace/docs/plans", ".workspace/docs/specs",
    ".workspace/docs/experiments", ".workspace/docs/reports",
)) == 95

paths = subprocess.check_output(
    ["git", "ls-tree", "-r", "--name-only", A, "--", *ROOTS], text=True
).splitlines()
expected = [f"{coverage(path)}\t{path}" for path in paths]
manifest = text.rsplit("```text\n", 1)[1].split("\n```", 1)[0].splitlines()
assert manifest == expected
assert Counter(coverage(path) for path in paths) == {
    "semantic-review": 83,
    "backstop-review": 157,
    "domain-implementation": 103,
    "evidence-snapshot": 15,
    "inactive-plan": 5,
}
for required_backstop in (
    "skills/cost-analyzer/assets/test_attribution.py",
    "skills/cost-analyzer/assets/test_skill_contract.py",
    "skills/sweep/assets/test-assets.sh",
    "skills/model-optimizer/evals/mechanical-duration/project/test_duration.py",
):
    assert coverage(required_backstop) == "backstop-review"
print({
    "inventory": len(paths),
    "rows": len(rows),
    "rows_with_refs": rows_with_refs,
    "reference_tokens": len(refs),
    "unique_reference_triples": len(set(refs)),
    "multi_line_reference_tokens": multi_line_reference_tokens,
    "claim_classes": dict(claim_classes),
    "herdr_semantic_coverage": herdr_semantic_coverage,
    "docs_total": len(tree_paths(".workspace/docs")),
    "history_plus_docs_reports_selector": len(tree_paths(
        ".workspace/docs/history", ".workspace/docs/reports"
    )),
    "records_plus_docs_reports_selector": len(tree_paths(
        ".workspace/docs/adr", ".workspace/docs/plans", ".workspace/docs/specs",
        ".workspace/docs/experiments", ".workspace/docs/reports",
    )),
})
```

## Apéndice A: manifiesto de cobertura de A0

Reproducción: ejecutar `git ls-tree` del método y aplicar, en orden: publication
-> `inactive-plan`; cualquier path de `test/`, segmento `test`/`tests`, basename
`test-*`/`test_*`/`*_test.*` o `*.test.*` -> `backstop-review`; restantes
fixtures/pressure/evals -> `evidence-snapshot`; Markdown/YAML/CODEOWNERS ->
`semantic-review`; resto -> `domain-implementation`.

```text
semantic-review	.github/CODEOWNERS
semantic-review	.github/CONTRIBUTING.md
semantic-review	.github/SECURITY.md
semantic-review	.github/dependabot.yml
inactive-plan	.github/publication/README.md
inactive-plan	.github/publication/cleanup-plan.json
inactive-plan	.github/publication/cleanup-plan.json.sha256
inactive-plan	.github/publication/desired-state.json
inactive-plan	.github/publication/desired-state.json.sha256
semantic-review	.github/workflows/ci.yml
semantic-review	AGENTS.md
semantic-review	README.md
semantic-review	agents/README.md
semantic-review	agents/superpowers/claude-code/superpowers-architecture-reviewer.md
semantic-review	agents/superpowers/claude-code/superpowers-debugger.md
semantic-review	agents/superpowers/claude-code/superpowers-final-reviewer.md
semantic-review	agents/superpowers/claude-code/superpowers-integration-worker.md
semantic-review	agents/superpowers/claude-code/superpowers-mechanical-implementer.md
semantic-review	agents/superpowers/claude-code/superpowers-task-reviewer.md
domain-implementation	agents/superpowers/provenance.json
semantic-review	agents/superpowers/superpowers-architecture-reviewer.md
semantic-review	agents/superpowers/superpowers-debugger.md
semantic-review	agents/superpowers/superpowers-final-reviewer.md
semantic-review	agents/superpowers/superpowers-integration-worker.md
semantic-review	agents/superpowers/superpowers-mechanical-implementer.md
semantic-review	agents/superpowers/superpowers-task-reviewer.md
semantic-review	output-styles/mentor-telemetria.assets/append-system.md
semantic-review	output-styles/mentor-telemetria.md
domain-implementation	packages/pi-context-expert/.gitignore
semantic-review	packages/pi-context-expert/README.md
domain-implementation	packages/pi-context-expert/eval/evidence/run.ts
semantic-review	packages/pi-context-expert/eval/trigger/README.md
evidence-snapshot	packages/pi-context-expert/fixtures/evidence/non-rule.json
evidence-snapshot	packages/pi-context-expert/fixtures/evidence/true-rule.json
evidence-snapshot	packages/pi-context-expert/fixtures/evidence/uncertain-candidate.json
domain-implementation	packages/pi-context-expert/package.json
domain-implementation	packages/pi-context-expert/scripts/compaction-diagnostic.ts
domain-implementation	packages/pi-context-expert/scripts/e2e-prompts.ts
domain-implementation	packages/pi-context-expert/scripts/run-headless-e2e.ts
domain-implementation	packages/pi-context-expert/scripts/run-rpc-compact.ts
domain-implementation	packages/pi-context-expert/src/compaction-core.ts
domain-implementation	packages/pi-context-expert/src/compaction.ts
domain-implementation	packages/pi-context-expert/src/config.ts
domain-implementation	packages/pi-context-expert/src/corpus.ts
domain-implementation	packages/pi-context-expert/src/deadline.ts
domain-implementation	packages/pi-context-expert/src/digest.ts
domain-implementation	packages/pi-context-expert/src/evidence-pipeline.ts
domain-implementation	packages/pi-context-expert/src/evidence.ts
domain-implementation	packages/pi-context-expert/src/extension.ts
domain-implementation	packages/pi-context-expert/src/index.ts
domain-implementation	packages/pi-context-expert/src/jev.ts
domain-implementation	packages/pi-context-expert/src/ladder.ts
domain-implementation	packages/pi-context-expert/src/messages.ts
domain-implementation	packages/pi-context-expert/src/observer.ts
domain-implementation	packages/pi-context-expert/src/projection.ts
domain-implementation	packages/pi-context-expert/src/questions.ts
domain-implementation	packages/pi-context-expert/src/redaction.ts
domain-implementation	packages/pi-context-expert/src/retro.ts
domain-implementation	packages/pi-context-expert/src/rpc-stdin-guard.ts
domain-implementation	packages/pi-context-expert/src/scheduler.ts
domain-implementation	packages/pi-context-expert/src/signals.ts
domain-implementation	packages/pi-context-expert/src/state.ts
domain-implementation	packages/pi-context-expert/src/storage.ts
domain-implementation	packages/pi-context-expert/src/trigger.ts
domain-implementation	packages/pi-context-expert/src/types.ts
backstop-review	packages/pi-context-expert/test/compaction.test.ts
backstop-review	packages/pi-context-expert/test/config.test.ts
backstop-review	packages/pi-context-expert/test/corpus.test.ts
backstop-review	packages/pi-context-expert/test/e2e-compaction-diagnostic.test.ts
backstop-review	packages/pi-context-expert/test/e2e-prompts.test.ts
backstop-review	packages/pi-context-expert/test/e2e-runner.test.ts
backstop-review	packages/pi-context-expert/test/evidence.test.ts
backstop-review	packages/pi-context-expert/test/extension.test.ts
backstop-review	packages/pi-context-expert/test/fixtures.ts
backstop-review	packages/pi-context-expert/test/identity.test.ts
backstop-review	packages/pi-context-expert/test/jev-client.test.ts
backstop-review	packages/pi-context-expert/test/ladder.test.ts
backstop-review	packages/pi-context-expert/test/pi-minimum-contract.test.ts
backstop-review	packages/pi-context-expert/test/provenance.test.ts
backstop-review	packages/pi-context-expert/test/pure.test.ts
backstop-review	packages/pi-context-expert/test/quality.test.ts
backstop-review	packages/pi-context-expert/test/retro.test.ts
backstop-review	packages/pi-context-expert/test/rpc-stdin-guard.test.ts
backstop-review	packages/pi-context-expert/test/scheduler.test.ts
backstop-review	packages/pi-context-expert/test/signals.test.ts
backstop-review	packages/pi-context-expert/test/storage.test.ts
backstop-review	packages/pi-context-expert/test/trigger.test.ts
domain-implementation	packages/pi-context-expert/third_party/compact-adviser/LICENSE
semantic-review	packages/pi-context-expert/third_party/compact-adviser/PROVENANCE.md
domain-implementation	packages/pi-context-expert/tsconfig.json
semantic-review	packages/typesafe/README.md
domain-implementation	packages/typesafe/package.json
domain-implementation	packages/typesafe/src/client.ts
domain-implementation	packages/typesafe/src/errors.ts
domain-implementation	packages/typesafe/src/index.ts
domain-implementation	packages/typesafe/src/model.ts
domain-implementation	packages/typesafe/src/provider.ts
domain-implementation	packages/typesafe/src/resolver.ts
backstop-review	packages/typesafe/test/client.test.ts
backstop-review	packages/typesafe/test/provider.test.ts
backstop-review	packages/typesafe/test/resolver.test.ts
domain-implementation	packages/typesafe/tsconfig.json
domain-implementation	profiles/pablontiv/.stem
semantic-review	profiles/pablontiv/PROFILE.md
semantic-review	profiles/pablontiv/bootstrap.md
semantic-review	profiles/pablontiv/config.template.yaml
backstop-review	profiles/pablontiv/tests/__init__.py
backstop-review	profiles/pablontiv/tests/test_profile_contract.py
semantic-review	skills/adr/SKILL.md
domain-implementation	skills/adr/adr.sh
domain-implementation	skills/adr/adr.stem
backstop-review	skills/adr/tests/__init__.py
backstop-review	skills/adr/tests/shell_support.py
backstop-review	skills/adr/tests/test_adr_workspace.py
backstop-review	skills/adr/tests/test_shell_support.py
semantic-review	skills/agent-behavior-doctor/SKILL.md
semantic-review	skills/agent-behavior-doctor/forensic.md
semantic-review	skills/agent-behavior-doctor/jev.md
backstop-review	skills/agent-behavior-doctor/tests/__init__.py
backstop-review	skills/agent-behavior-doctor/tests/pressure/__init__.py
backstop-review	skills/agent-behavior-doctor/tests/pressure/assert_pressure.py
backstop-review	skills/agent-behavior-doctor/tests/pressure/run_pressure.py
backstop-review	skills/agent-behavior-doctor/tests/pressure/scenarios.json
backstop-review	skills/agent-behavior-doctor/tests/test_contract.py
domain-implementation	skills/context-save/LICENSE
semantic-review	skills/context-save/SKILL.md
backstop-review	skills/context-save/tests/__init__.py
backstop-review	skills/context-save/tests/test_contract.py
semantic-review	skills/cost-analyzer/SKILL.md
domain-implementation	skills/cost-analyzer/assets/attribution.py
domain-implementation	skills/cost-analyzer/assets/dataset.py
domain-implementation	skills/cost-analyzer/assets/delivery_efficiency.py
domain-implementation	skills/cost-analyzer/assets/enrich.py
domain-implementation	skills/cost-analyzer/assets/extensions.py
domain-implementation	skills/cost-analyzer/assets/outcomes.py
domain-implementation	skills/cost-analyzer/assets/quad.py
domain-implementation	skills/cost-analyzer/assets/report.py
backstop-review	skills/cost-analyzer/assets/test_attribution.py
backstop-review	skills/cost-analyzer/assets/test_dataset.py
backstop-review	skills/cost-analyzer/assets/test_delivery_efficiency.py
backstop-review	skills/cost-analyzer/assets/test_extensions.py
backstop-review	skills/cost-analyzer/assets/test_outcomes.py
backstop-review	skills/cost-analyzer/assets/test_quad.py
backstop-review	skills/cost-analyzer/assets/test_report.py
backstop-review	skills/cost-analyzer/assets/test_skill_contract.py
backstop-review	skills/cost-analyzer/assets/test_views.py
domain-implementation	skills/cost-analyzer/assets/views.py
domain-implementation	skills/cost-analyzer/docs/adr/.stem
semantic-review	skills/cost-analyzer/docs/adr/0001-cross-harness-token-efficiency.md
semantic-review	skills/cost-analyzer/docs/superpowers/plans/2026-09-21-canonical-harness-ledger.md
semantic-review	skills/cost-analyzer/docs/superpowers/plans/2026-09-21-cross-harness-efficiency.md
semantic-review	skills/cost-analyzer/docs/superpowers/specs/2026-09-21-cross-harness-efficiency-design.md
semantic-review	skills/cost-analyzer/examples/report-september-2026.md
semantic-review	skills/cost-analyzer/references/canonical-dataset-design.md
semantic-review	skills/decision-calibrator/SKILL.md
semantic-review	skills/docs-northstar/SKILL.md
semantic-review	skills/docs-northstar/references/method.md
semantic-review	skills/gh-communication-style/SKILL.md
semantic-review	skills/herdr/SKILL.md
domain-implementation	skills/herdr/helper/com.pablontiv.a4s.orchestrator-heartbeat-h2.plist.example
domain-implementation	skills/herdr/helper/escalation.py
domain-implementation	skills/herdr/helper/heartbeat_h2.py
domain-implementation	skills/herdr/helper/task_ack.py
domain-implementation	skills/herdr/helper/task_result.py
semantic-review	skills/herdr/scripts/README.md
domain-implementation	skills/herdr/scripts/a4s-reconcile
domain-implementation	skills/herdr/scripts/dev.a4s.reconcile.plist
backstop-review	skills/herdr/tests/__init__.py
backstop-review	skills/herdr/tests/test_escalation.py
backstop-review	skills/herdr/tests/test_heartbeat_h2.py
backstop-review	skills/herdr/tests/test_reconcile.py
backstop-review	skills/herdr/tests/test_task_ack.py
backstop-review	skills/herdr/tests/test_task_result.py
semantic-review	skills/markitdown/SKILL.md
semantic-review	skills/markitdown/references/formats.md
semantic-review	skills/mission-control-health/SKILL.md
domain-implementation	skills/mission-control-health/helper/mc_health.py
backstop-review	skills/mission-control-health/tests/__init__.py
backstop-review	skills/mission-control-health/tests/test_mc_health.py
semantic-review	skills/model-optimizer/SKILL.md
evidence-snapshot	skills/model-optimizer/evals/mechanical-duration/eval.json
evidence-snapshot	skills/model-optimizer/evals/mechanical-duration/project/duration.py
backstop-review	skills/model-optimizer/evals/mechanical-duration/project/test_duration.py
evidence-snapshot	skills/model-optimizer/evals/mechanical-slugify/eval.json
evidence-snapshot	skills/model-optimizer/evals/mechanical-slugify/project/slugify.py
backstop-review	skills/model-optimizer/evals/mechanical-slugify/project/test_slugify.py
evidence-snapshot	skills/model-optimizer/evals/pi-confined-tools.ts
evidence-snapshot	skills/model-optimizer/evals/regression-retry-delay/eval.json
evidence-snapshot	skills/model-optimizer/evals/regression-retry-delay/project/settings.py
backstop-review	skills/model-optimizer/evals/regression-retry-delay/project/test_worker.py
evidence-snapshot	skills/model-optimizer/evals/regression-retry-delay/project/worker.py
evidence-snapshot	skills/model-optimizer/evals/regression-timeout/eval.json
evidence-snapshot	skills/model-optimizer/evals/regression-timeout/project/client.py
evidence-snapshot	skills/model-optimizer/evals/regression-timeout/project/service.py
evidence-snapshot	skills/model-optimizer/evals/regression-timeout/project/settings.py
backstop-review	skills/model-optimizer/evals/regression-timeout/project/test_service.py
domain-implementation	skills/model-optimizer/helper/__init__.py
domain-implementation	skills/model-optimizer/helper/adapters/__init__.py
domain-implementation	skills/model-optimizer/helper/adapters/opencode.py
domain-implementation	skills/model-optimizer/helper/adapters/pi.py
domain-implementation	skills/model-optimizer/helper/artifacts.py
domain-implementation	skills/model-optimizer/helper/evaluator.py
domain-implementation	skills/model-optimizer/helper/models.py
domain-implementation	skills/model-optimizer/helper/optimizer.py
domain-implementation	skills/model-optimizer/helper/runner.py
domain-implementation	skills/model-optimizer/helper/state.py
semantic-review	skills/model-optimizer/references/benchmark-sources.md
semantic-review	skills/model-optimizer/references/contracts.md
semantic-review	skills/model-optimizer/references/evaluation-tiers.md
semantic-review	skills/model-optimizer/references/optimization-flow.md
domain-implementation	skills/model-optimizer/scripts/model_optimizer.py
backstop-review	skills/model-optimizer/tests/__init__.py
backstop-review	skills/model-optimizer/tests/fixtures/opencode/auth-list.txt
backstop-review	skills/model-optimizer/tests/fixtures/opencode/cli-rejection.jsonl
backstop-review	skills/model-optimizer/tests/fixtures/opencode/live-error.jsonl
backstop-review	skills/model-optimizer/tests/fixtures/opencode/models-verbose.txt
backstop-review	skills/model-optimizer/tests/fixtures/opencode/opencode.json
backstop-review	skills/model-optimizer/tests/fixtures/opencode/permission-asked.jsonl
backstop-review	skills/model-optimizer/tests/fixtures/opencode/permission-v2-asked.jsonl
backstop-review	skills/model-optimizer/tests/fixtures/opencode/tool-failure.jsonl
backstop-review	skills/model-optimizer/tests/fixtures/opencode/tool-success.jsonl
backstop-review	skills/model-optimizer/tests/fixtures/pi/auth-ready.json
backstop-review	skills/model-optimizer/tests/fixtures/pi/list-models.txt
backstop-review	skills/model-optimizer/tests/fixtures/pi/models-store.json
backstop-review	skills/model-optimizer/tests/fixtures/pi/settings.json
backstop-review	skills/model-optimizer/tests/fixtures/pi/subagents.json
backstop-review	skills/model-optimizer/tests/pressure/assert_pressure.py
backstop-review	skills/model-optimizer/tests/pressure/baseline.md
backstop-review	skills/model-optimizer/tests/pressure/green.md
backstop-review	skills/model-optimizer/tests/pressure/run_pressure.py
backstop-review	skills/model-optimizer/tests/pressure/scenarios.json
backstop-review	skills/model-optimizer/tests/replay_pilots.py
backstop-review	skills/model-optimizer/tests/support.py
backstop-review	skills/model-optimizer/tests/test_apply_contract.py
backstop-review	skills/model-optimizer/tests/test_artifacts.py
backstop-review	skills/model-optimizer/tests/test_cli.py
backstop-review	skills/model-optimizer/tests/test_evaluator.py
backstop-review	skills/model-optimizer/tests/test_opencode.py
backstop-review	skills/model-optimizer/tests/test_optimizer.py
backstop-review	skills/model-optimizer/tests/test_pi.py
backstop-review	skills/model-optimizer/tests/test_replay_pilots.py
backstop-review	skills/model-optimizer/tests/test_runner.py
backstop-review	skills/model-optimizer/tests/test_skill_contract.py
backstop-review	skills/model-optimizer/tests/test_state.py
semantic-review	skills/naming-brief/SKILL.md
semantic-review	skills/naming-brief/assets/naming-brief-template.md
semantic-review	skills/remove-gentle-context/SKILL.md
domain-implementation	skills/remove-gentle-context/adapters/gemini.json
domain-implementation	skills/remove-gentle-context/adapters/hermes.json
domain-implementation	skills/remove-gentle-context/adapters/kimi.json
domain-implementation	skills/remove-gentle-context/adapters/shared-agents.json
domain-implementation	skills/remove-gentle-context/adapters/vscode-copilot.json
domain-implementation	skills/remove-gentle-context/helper/__init__.py
domain-implementation	skills/remove-gentle-context/helper/adapter.py
domain-implementation	skills/remove-gentle-context/helper/canonical.py
domain-implementation	skills/remove-gentle-context/helper/clients/__init__.py
domain-implementation	skills/remove-gentle-context/helper/clients/claude.py
domain-implementation	skills/remove-gentle-context/helper/clients/codex.py
domain-implementation	skills/remove-gentle-context/helper/clients/opencode.py
domain-implementation	skills/remove-gentle-context/helper/clients/pi.py
domain-implementation	skills/remove-gentle-context/helper/declarative.py
domain-implementation	skills/remove-gentle-context/helper/engine.py
domain-implementation	skills/remove-gentle-context/helper/lifecycle.py
domain-implementation	skills/remove-gentle-context/helper/models.py
domain-implementation	skills/remove-gentle-context/helper/ownership.py
domain-implementation	skills/remove-gentle-context/helper/paths.py
domain-implementation	skills/remove-gentle-context/helper/transaction.py
domain-implementation	skills/remove-gentle-context/helper/verifier.py
semantic-review	skills/remove-gentle-context/references/contracts.md
domain-implementation	skills/remove-gentle-context/references/ownership-catalog-v1.json
semantic-review	skills/remove-gentle-context/references/preservation.md
domain-implementation	skills/remove-gentle-context/scripts/cleanup.py
backstop-review	skills/remove-gentle-context/tests/__init__.py
backstop-review	skills/remove-gentle-context/tests/clients/__init__.py
backstop-review	skills/remove-gentle-context/tests/clients/test_claude.py
backstop-review	skills/remove-gentle-context/tests/clients/test_codex.py
backstop-review	skills/remove-gentle-context/tests/clients/test_opencode.py
backstop-review	skills/remove-gentle-context/tests/clients/test_pi.py
backstop-review	skills/remove-gentle-context/tests/fixtures/claude/CLAUDE.md
backstop-review	skills/remove-gentle-context/tests/fixtures/claude/gentleman.json
backstop-review	skills/remove-gentle-context/tests/fixtures/claude/settings.json
backstop-review	skills/remove-gentle-context/tests/fixtures/codex/archived-session.jsonl
backstop-review	skills/remove-gentle-context/tests/fixtures/codex/config.toml
backstop-review	skills/remove-gentle-context/tests/fixtures/codex/global-state.json
backstop-review	skills/remove-gentle-context/tests/fixtures/current-installer/gemini/GEMINI.md
backstop-review	skills/remove-gentle-context/tests/fixtures/current-installer/gemini/settings.json
backstop-review	skills/remove-gentle-context/tests/fixtures/current-installer/gemini/skills/sdd-init/SKILL.md
backstop-review	skills/remove-gentle-context/tests/fixtures/current-installer/gemini/system.md
backstop-review	skills/remove-gentle-context/tests/fixtures/current-installer/hermes/SOUL.md
backstop-review	skills/remove-gentle-context/tests/fixtures/current-installer/hermes/config.yaml
backstop-review	skills/remove-gentle-context/tests/fixtures/current-installer/hermes/skills/sdd-init/SKILL.md
backstop-review	skills/remove-gentle-context/tests/fixtures/current-installer/kimi/KIMI.md
backstop-review	skills/remove-gentle-context/tests/fixtures/current-installer/kimi/agents/sdd-init.yaml
backstop-review	skills/remove-gentle-context/tests/fixtures/current-installer/kimi/config.toml
backstop-review	skills/remove-gentle-context/tests/fixtures/current-installer/shared/skills/sdd-init/SKILL.md
backstop-review	skills/remove-gentle-context/tests/fixtures/declarative/forbidden-toml.json
backstop-review	skills/remove-gentle-context/tests/fixtures/declarative/json-surgery-crlf.json
backstop-review	skills/remove-gentle-context/tests/fixtures/declarative/json-surgery-formatting.json
backstop-review	skills/remove-gentle-context/tests/fixtures/declarative/valid.json
backstop-review	skills/remove-gentle-context/tests/fixtures/opencode/opencode.json
backstop-review	skills/remove-gentle-context/tests/fixtures/opencode/package.json
backstop-review	skills/remove-gentle-context/tests/fixtures/opencode/tui.json
backstop-review	skills/remove-gentle-context/tests/fixtures/pi/settings.json
backstop-review	skills/remove-gentle-context/tests/fixtures/pi/skill-registry.md
backstop-review	skills/remove-gentle-context/tests/support.py
backstop-review	skills/remove-gentle-context/tests/test_cli.py
backstop-review	skills/remove-gentle-context/tests/test_declarative.py
backstop-review	skills/remove-gentle-context/tests/test_engine.py
backstop-review	skills/remove-gentle-context/tests/test_lifecycle.py
backstop-review	skills/remove-gentle-context/tests/test_models_paths.py
backstop-review	skills/remove-gentle-context/tests/test_ownership.py
backstop-review	skills/remove-gentle-context/tests/test_transaction.py
semantic-review	skills/roadmap/README.md
semantic-review	skills/roadmap/SKILL.md
semantic-review	skills/roadmap/references/contracts.md
semantic-review	skills/roadmap/references/doctor.md
semantic-review	skills/roadmap/references/loop.md
semantic-review	skills/roadmap/references/plan.md
semantic-review	skills/roadmap/references/tree.md
semantic-review	skills/rule-audit/SKILL.md
semantic-review	skills/rule-audit/assets/rule-template.md
semantic-review	skills/rule-audit/references/rule-strength-rubric.md
semantic-review	skills/sweep/SKILL.md
semantic-review	skills/sweep/agents/claude/pr-investigator.md
semantic-review	skills/sweep/agents/claude/sweep-scout.md
semantic-review	skills/sweep/agents/claude/sweep-triage.md
semantic-review	skills/sweep/agents/pi/pr-investigator.md
semantic-review	skills/sweep/agents/pi/sweep-scout.md
semantic-review	skills/sweep/agents/pi/sweep-triage.md
domain-implementation	skills/sweep/assets/enumerate.sh
domain-implementation	skills/sweep/assets/facts.sh
domain-implementation	skills/sweep/assets/preflight.sh
backstop-review	skills/sweep/assets/test-assets.sh
semantic-review	skills/sweep/references/apply.md
semantic-review	skills/sweep/references/evidence.md
semantic-review	skills/sweep/references/fanout.md
semantic-review	skills/sweep/references/fork-mirrors.md
semantic-review	skills/sweep/references/tiers.md
backstop-review	skills/sweep/tests/__init__.py
backstop-review	skills/sweep/tests/test_contract.py
domain-implementation	skills/systemic-issue-triage/LICENSE
semantic-review	skills/systemic-issue-triage/SKILL.md
backstop-review	skills/systemic-issue-triage/tests/__init__.py
backstop-review	skills/systemic-issue-triage/tests/pressure/__init__.py
backstop-review	skills/systemic-issue-triage/tests/pressure/baseline.md
backstop-review	skills/systemic-issue-triage/tests/pressure/green.md
backstop-review	skills/systemic-issue-triage/tests/pressure/run_pressure.py
backstop-review	skills/systemic-issue-triage/tests/pressure/scenarios.json
backstop-review	skills/systemic-issue-triage/tests/test_skill_contract.py
backstop-review	test/ci-local.sh
backstop-review	test/client.test.ts
backstop-review	test/driver.test.ts
backstop-review	test/endpoint.test.ts
backstop-review	test/evidence.test.ts
backstop-review	test/framing.test.ts
backstop-review	test/messages.test.ts
backstop-review	test/server.test.ts
backstop-review	test/state.test.ts
backstop-review	test/support/client-harness.ts
backstop-review	test/support/server-harness.ts
backstop-review	test/test_publication_security.py
backstop-review	test/test_repository_contract.py
backstop-review	test/test_superpowers_claude_code_agents.py
```
