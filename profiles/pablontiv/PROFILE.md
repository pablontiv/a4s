# Perfil Pablontiv A4S

- **Profile id:** `pablontiv/a4s`
- **Versión del perfil:** 2
- **Base:** Engineering Handbook 1.4
- **Digest de la base:** `f5455e3eced13690358b02823053a1e00a6c7c06de5f17d9716805bf0a0cff26`
- **Runtime compatible:** Pi exclusivamente
- **Configuración operativa:** `.workspace/config.yaml`
- **Raíz de conocimiento:** `.workspace/docs/`
- **Raíz de aislamiento:** `.workspace/worktrees/`
- **Gobernanza:** Rootline, obligatoria y sin sustitutos
- **Memoria episódica:** Backscroll, obligatoria y sin sustitutos
- **Madurez:** prose-first; los controles deterministas quedan diferidos

## 1. Propósito

Este perfil especializa Engineering Handbook 1.4 como un método reusable para workspaces heterogéneos. Conserva su contrato genérico de fases, invariantes, precedencia, gates y evidencia mínima, y fija las elecciones aprobadas de Pablontiv sin convertirlas en reglas universales del Engineering Handbook base.

`PROFILE.md` es una referencia reusable. La ejecución concreta pertenece a la instancia aprobada en `.workspace/config.yaml`; Pi no opera un repositorio consumidor modificando este documento. Las palabras **DEBE**, **NO DEBE**, **DEBERÍA** y **PUEDE** expresan requisitos normativos.

## 2. Principios de diseño

### Configuración central, ejecución distribuida

Toda la configuración de control se representa en un único `.workspace/config.yaml`. Ese aplanamiento es solamente físico: conserva las capas lógicas `workspace`, `groups` y `repositories`. Los repositorios contienen código e interfaces ejecutables, pero no sustituyen la autoridad central.

### Controles genéricos, bindings concretos

El contrato distingue control genérico, binding concreto y evidencia. Este perfil versión 2 expresa controles mediante prosa, listas de prosa y valores `unknown`. No define executors, no genera schemas, no implementa un merge engine ni afirma ejecución automática. Una migración futura podrá concretar un control únicamente con el modelo completo y una decisión aprobada.

### Fallo cerrado

La falta de configuración, acceso, evidencia, historia requerida o resolución inequívoca produce `unknown`. Un valor o control obligatorio en ese estado bloquea la siguiente mutación o entrega afectada.

### Trazabilidad y autoridad

La configuración efectiva debe permitir identificar repositorios administrados, valores finales, origen por capa, controles aplicables y revisión observada. Las referencias a artefactos locales evitan duplicación, pero no transfieren autoridad ni permiten inferir controles ausentes.

Pi es el único runtime compatible en la versión 2. Rootline gobierna el Markdown durable y Backscroll aporta memoria episódica; ambos son obligatorios, sin sustitutos. Declarar otro runtime exige paridad completa verificada.

## 3. Modelo de workspace

La especialización usa este modelo conceptual:

```text
.workspace/docs/references/engineering-handbook-v1.4.md
            → especialización
profiles/pablontiv/PROFILE.md
            → adopción guiada
.workspace/config.yaml
            → operación
.workspace/docs/ y .workspace/worktrees/
```

La raíz `.workspace/docs/` es la autoridad final del conocimiento durable del workspace. `.workspace/worktrees/` es la raíz de aislamiento administrado solamente cuando la estrategia efectiva lo requiere.

Cada repositorio administrado DEBE tener una identidad estable, un locator canónico del repositorio de origen y una entrada efectiva. `repo.path` guarda ese locator relocatable, nunca la ruta física de un checkout local. Pi descubre el checkout en runtime y verifica con `git remote get-url origin` que corresponde al origen configurado. Aliases, symlinks y worktrees derivados no crean identidades nuevas. Un repositorio no clasificado puede inspeccionarse en modo de solo lectura, pero no puede recibir mutaciones ni entregas.

Un grupo comparte controles o defaults sin implicar equipo, ownership ni estructura organizacional. Las excepciones se declaran centralmente por identidad de repositorio.

## 4. Resolución de configuración

La precedencia lógica es:

```text
workspace → group → repository
```

La capa más específica prevalece únicamente en los campos que declara.

- Los escalares de una capa más específica reemplazan a los anteriores.
- Los mapas se combinan recursivamente.
- Las listas se reemplazan completas; no se concatenan implícitamente.
- Una lista vacía (`[]`) declara que no hay controles de esa clase.
- Un valor ausente significa heredar.
- Un valor `unknown` significa no resuelto y activa fallo cerrado cuando afecta una fase obligatoria.
- `custom_rules` no puede debilitar los invariantes.
- Los identificadores de artefactos se resuelven por coincidencia canónica exacta; aliases o equivalencias solo existen cuando se declaran explícitamente.

Antes del trabajo mutante, Pi DEBE mostrar la vista efectiva con valores, origen `workspace`, `group` o `repository`, revisión de configuración, revisión observada del repositorio, warnings, conflictos y campos `unknown`. Una vista derivada nunca se convierte en autoridad editable.

Un binding queda stale cuando cambian identidad, locator de origen, branch, proveedor, comando, precondición o vigencia de forma que invalida el control. `verified_revision` registra la revisión del origen sobre la que se verificó el binding; no es una ruta local ni exige que todo HEAD posterior sea idéntico. Si Pi no puede descubrir el checkout, hacer coincidir su `origin`, verificar `cwd`, interfaz, precondiciones y revisión aplicable, conserva `unknown` y no infiere un sustituto.

## 5. Contrato de los controles

El modelo lógico completo de un control concreto preserva estos campos:

```yaml
id: stable-control-id
phase: pre | acceptance | review | delivery | post | monitoring | cleanup
when: explicit-condition
required: true
mode: read-only | local-mutation | external-mutation
executor:
  type: command | human-approval | observation
timeout_seconds: 300
success:
  evidence: verifiable-postcondition
on_failure: stop | defer | notify
```

Un control determinista futuro DEBE usar un `id` estable; un único tipo de executor con sus campos completos; una condición explícita; un `cwd` concreto cuando corresponda; una postcondición verificable; manejo de error que no convierta fallo en éxito; y evidencia sanitizada. Un control `external-mutation` requiere aprobación humana explícita y acotada, salvo autorización permanente igualmente explícita y acotada.

La versión 2 no presenta este modelo como un executor disponible. Sus controles prose-first son instrucciones para Pi y no pueden reportarse como automáticamente ejecutados.

Los estados canónicos son:

- `pending`: todavía no ejecutado;
- `passed`: postcondición verificada;
- `failed`: ejecución o postcondición fallida;
- `skipped`: exclusión permitida por una condición explícita;
- `unknown`: no se pudo ejecutar o verificar;
- `not_applicable`: el control no aplica según la configuración efectiva.

## 6. Ejes configurables

Cada repositorio recibe valores efectivos para todos estos ejes:

| Eje | Propósito |
| --- | --- |
| `context_sources` | Ticket, diseño, adjuntos, memoria y recursos requeridos. |
| `base_branch` | Branch o revisión base. |
| `sync_strategy` | Mecanismo y evidencia de frescura. |
| `isolation_strategy` | Worktree, branch, entorno efímero u otro aislamiento verificable. |
| `development_workflow` | Diseño, aprobación, planificación e implementación. |
| `commit_policy` | Forma y restricciones de commits. |
| `delivery_mode` | PR, entrega directa, trunk, artefacto local u otro mecanismo. |
| `delivery_gate` | Aprobación y evidencia previas a la entrega. |
| `pre_checks` | Controles previos a acceptance y entrega. |
| `acceptance_checks` | Verificación trazable del spec aprobado. |
| `review_checks` | Revisión humana, automática o independiente. |
| `definition_of_ready` | Qué debe declarar una task para que un loop de backlog la ejecute. |
| `incomplete_task_policy` | Qué hace un loop ante una task que no cumple `definition_of_ready`: `skip`, `stop` o `backfill`. |
| `failed_task_policy` | Qué hace un loop cuando una task falla un gate o su implementación: `skip` o `stop`. |
| `controller_identity` | Fuente de la identidad de sesión del controlador de un loop de backlog. |
| `post_checks` | Postcondiciones después de integrar, publicar o desplegar. |
| `monitoring` | Señales y periodo de observación. |
| `external_effects` | Precondiciones, autorización y postcondiciones externas. |
| `credential_policy` | Uso y protección autorizados de credenciales. |
| `knowledge_policy` | Clases, destinos y aprobación para conocimiento durable. |
| `cleanup_policy` | Qué se ofrece, conserva o elimina y quién lo autoriza. |
| `custom_rules` | Reglas adicionales que no contradicen invariantes. |

### Fuentes obligatorias

Rootline se usa cuando se crea, consulta, modifica o valida Markdown gobernado. Su ausencia o una validación fallida deja el control en `unknown` y bloquea declarar exitosa la escritura gobernada. No se elige otra herramienta como sustituto.

Backscroll se consulta en fase 0 cuando trabajo previo puede afectar una feature, bug, prueba, refactor o decisión. Pi DEBE ejecutar primero el preflight oficial, buscar con alcance de proyecto, ampliar exactamente una vez a todos los proyectos si no hay resultado, y usar búsqueda de contenido de herramienta para recordar comandos, rutas o errores de ejecución. La salida para agentes DEBE ser acotada y legible por máquina mediante `--robot`, `--fields minimal` y `--max-tokens`. Si la historia requerida no está disponible o no puede usarse, el valor permanece `unknown`; Backscroll no reemplaza decisiones durables, registros Rootline ni inspección del source.

### Routing de artefactos publicados

La pertenencia al catálogo no activa una herramienta rutinariamente. Pi enruta cada artefacto solamente bajo su trigger real y no selecciona equivalentes cuando el artefacto oficial aplicable no está disponible:

- `adr`: se activa después de una decisión significativa nueva o revocada, ante una corrección que invalida una decisión, o cuando se solicita registrar o recuperar un ADR.
- `roadmap`: se activa al planificar trabajo en Beads, visualizar la topología pendiente, alinear Beads existentes o ejecutar secuencialmente el backlog.
- `context-save`: se activa para guardar, restaurar o listar estado estructurado entre sesiones; para conversaciones históricas se usa Backscroll.
- `cost-analyzer`: se activa cuando el usuario pregunta por costo, tokens, outcomes por harness, extensión Pi, topología de agentes o subagentes.
- `decision-calibrator`: se activa tras una corrección contradictoria, una pregunta repetida, recuperación de contexto, una tercera ronda sin nuevos unknowns decisivos o una elección de herramienta o arquitectura con costo operativo sostenido.
- `agent-behavior-doctor`: se activa cuando un agente promete sin actuar, repite preguntas ya resueltas, se vuelve procedimentalmente lento o parece condicionado por memoria, auto-respuesta, compaction, skills o instrucciones en conflicto; diagnostica con evidencia y permanece read-only salvo petición explícita de corregir.
- `empirical-capability-development`: se activa únicamente cuando el repositorio opta por el método y un `UNKNOWN` material bloquea una decisión con un probe disposable seguro disponible; fuera de ese caso no aplica.
- `mission-control-health`: se activa para informar por separado la ejecución del schedule, la entrega de recibos y el procesamiento o acuse de Mission Control a partir de registros de solo lectura y emitir una alerta visible independiente del modelo; nunca reintenta, sondea, pausa, reinicia ni cambia proveedores o modelos.
- `model-optimizer`: se activa al optimizar, asignar, validar o refrescar modelos y rutas de agentes cuando disponibilidad, autenticación, respuesta live, costo, cuota, cache, visión, esfuerzo o independencia importan. En este perfil solo se autorizan rutas del runtime Pi.
- `naming-brief`: se activa para crear un brief que otro modelo usará al proponer nombres de proyectos, herramientas, paquetes o servicios.
- `docs-northstar`: se activa al definir, recuperar o auditar la dirección narrativa de un repositorio y contrastarla con comportamiento verificado.
- `rule-audit`: se activa para auditar, puntuar o reforzar archivos de reglas e instrucciones de agentes y sus backstops.
- `gh-communication-style`: se activa para redactar issues, pull requests, respuestas de review o comentarios destinados a GitHub.
- `herdr`: se activa cuando se solicita usar Herdr para ejecutar, delegar o distribuir trabajo en repositorios; usa un space por repo, un tab por unidad de trabajo y sólo completa el despacho cuando el agente recibió su tarea.
- `markitdown`: se activa para convertir documentos o medios a Markdown mediante la CLI MarkItDown.

`remove-gentle-context` se activa únicamente para retirar contexto activo de Gentle AI o investigar registros generados stale; no se ejecuta rutinariamente y no desinstala paquetes, binarios, source ni instalaciones del framework.

- `sweep`: se activa para inventariar o limpiar worktrees, branches o pull requests, incluidos barridos, revisión de PRs y ejecuciones explícitas de sweep; informa antes de mutar y aplica solo lo aprobado.
- `systemic-issue-triage`: se activa cuando se solicita triaje sistémico del repositorio sin identificadores suministrados, o al evaluar issues, bugs, backlog, duplicación, usuarios bloqueados o iniciativas sistémicas propuestas.
- `pr-investigator`: se activa para investigar profundamente un PR individual contra convenciones, arquitectura y dirección del proyecto, normalmente delegado por `sweep`.
- `sweep-scout`: se activa para recopilar hechos Git y GitHub de un único repositorio durante un sweep de múltiples repositorios; devuelve evidencia sin clasificar ni recomendar.
- `sweep-triage`: se activa cuando un repositorio del sweep requiere juicio para clasificar worktrees, branches o PRs con evidencia de comandos.
- `mentor-telemetria`: se activa como estilo de salida cuando se requiere una interacción educativa con modo operacional, análisis de decisiones, insights y telemetría post-tarea; delega el registro de decisiones significativas al artefacto `adr`.

## 7. Valores por defecto

Los defaults priorizan seguridad:

- `base_branch`: detectar por lectura; si es ambiguo, `unknown`.
- `sync_strategy`: `unknown` antes de trabajo mutante.
- `isolation_strategy`: aislamiento dedicado para trabajo mutante asociado a una tarea; equivalentes requieren declaración explícita.
- `development_workflow`: diseño proporcional y aprobación antes de implementar.
- `commit_policy`: prosa explícita en la instancia; no se infiere.
- `delivery_mode`: `unknown`, por lo que bloquea entrega.
- `delivery_gate`: aprobación y evidencia explícitas.
- `pre_checks`: `[]`; ausencia visible, no equivalente a validación.
- `acceptance_checks`: obligatorios cuando existe un spec con criterios.
- `review_checks`: al menos una revisión antes de entrega mutante.
- `definition_of_ready`: el contrato de task del workflow de backlog activo; una task con label `legacy` requiere sólo descripción y criterios de aceptación.
- `incomplete_task_policy`: `skip`; la task queda visible como hallazgo y el loop continúa con la siguiente ejecutable.
- `failed_task_policy`: `skip`; el fallo queda registrado en la task, que se bloquea, y el loop continúa con la siguiente ejecutable.
- `controller_identity`: `unknown`, por lo que un loop no adquiere tasks.
- `post_checks`: `[]`; ausencia visible y conscientemente aceptada.
- `monitoring`: deshabilitado o no aplicable hasta declaración.
- `external_effects`: solo lectura hasta autorización explícita.
- `credential_policy`: mecanismo autorizado sin persistir secretos.
- `knowledge_policy`: Rootline gobierna ADRs, specs y planes bajo `.workspace/docs/`; ninguna clase se escribe en un repositorio hijo sin autorización explícita.
- `cleanup_policy`: después de integración verificada, eliminar obligatoriamente el worktree y las branches exactas de la task junto con outputs clasificados como reproducibles y desechables, sólo tras registrar evidencia durable y verificar identidad, ausencia de cambios no integrados y ausencia de retención; cualquier otro cleanup destructivo requiere autorización explícita.
- `custom_rules`: `[]` salvo reglas adicionales aprobadas.

Estos defaults no autorizan inferir comandos por la mera presencia de archivos.

## 8. Flujo de trabajo

### Fase 0 — Resolver autoridad y memoria

Identificar la identidad canónica; resolver configuración efectiva; mostrar herencia, overrides, conflictos y `unknown`; consultar Backscroll mediante el flujo oficial; detenerse si una fuente obligatoria no está disponible.

### Fase 1 — Cargar contexto

Leer todos los tickets, diseños, adjuntos y recursos declarados en `context_sources`. Si un recurso requerido no puede abrirse, detener el trabajo y nombrar lo faltante.

### Fase 2 — Preparar entorno

Ejecutar y verificar `sync_strategy`; crear o seleccionar el aislamiento aprobado; confirmar que cada mutación ocurrirá dentro del entorno autorizado. No se presupone `pull`, nombre de branch ni tecnología de aislamiento.

### Fase 3 — Diseñar e implementar

Clasificar alcance y riesgo; explorar; aclarar; proponer y aprobar el diseño requerido; escribir un spec con criterios cuando corresponda; implementar solo después del gate aplicable y según `development_workflow`.

### Fase 4 — Verificar

Ejecutar en orden todos los `pre_checks`, `acceptance_checks` y `review_checks` aplicables; registrar resultados y evidencia; detener la entrega ante un control requerido `failed` o `unknown`. La existencia de CI o tests no demuestra acceptance sin trazabilidad.

### Fase 5 — Entregar

Preparar el artefacto según `delivery_mode` y `commit_policy`; verificar `delivery_gate`; presentar evidencia y obtener aprobación; entregar solo dentro del alcance autorizado; verificar y registrar que la entrega ocurrió. El perfil no presupone PR.

### Fase 6 — Monitorear

Cuando `monitoring` esté habilitado, observar señales, duración y salida declaradas. La observación es de solo lectura salvo autorización independiente para remediar.

### Fase 7 — Verificar postcondiciones y cerrar

Ejecutar `post_checks`; confirmar el estado final; registrar `passed`, `failed`, `unknown` o `not_applicable`; aplicar `cleanup_policy`; ante un fallo, detener reintentos mutantes y renovar observación, reproducción, corrección, revisión y autorización. Una señal `done` no sustituye postcondiciones.

### Fase 8 — Retro y conocimiento durable

Extraer decisiones, errores, fricciones y patrones; asignar una clase canónica antes de la primera escritura; obtener la aprobación aplicable; escribir solamente en el destino autorizado; registrar procedencia sin secretos ni contenido sensible innecesario.

## 9. Invariantes

1. **INV-01 — Destino de conocimiento:** todo conocimiento o gobierno durable se escribe en el destino central configurado; un repositorio hijo solo lo recibe cuando su clase está autorizada. Una clasificación ambigua produce `unknown` y detiene la escritura.
2. **INV-02 — Control plane central:** configuración y conocimiento operativo tienen autoridad central e historial auditable.
3. **INV-03 — Contexto completo:** un recurso requerido inaccesible detiene el trabajo.
4. **INV-04 — Frescura declarada:** antes de mutar se ejecuta y verifica la estrategia efectiva; no se presupone `pull`.
5. **INV-05 — Aislamiento declarado:** toda mutación ocurre en el entorno autorizado; no se presupone worktree.
6. **INV-06 — Diseño aprobado:** no se implementa antes del gate de diseño aplicable.
7. **INV-07 — Acceptance trazable:** criterios, pre-checks y review checks obligatorios se vinculan a resultados verificables antes de entregar.
8. **INV-08 — Entrega autorizada:** ninguna entrega o mutación externa ocurre fuera del gate, modo y alcance declarados.
9. **INV-09 — Conocimiento aprobado:** la aprobación durable se aplica por clase y no se amplía por inferencia.
10. **INV-10 — Cleanup gobernado:** el cleanup post-merge exacto y verificado de una task es obligatorio; toda otra eliminación destructiva sigue política y autorización explícita.
11. **INV-11 — Fallo cerrado:** un control obligatorio `failed` o `unknown` no se trata como éxito.
12. **INV-12 — Postcondición verificada:** finalizar un proceso no equivale a entrega verificada.
13. **INV-13 — Secretos protegidos:** configuración, comandos, logs y evidencia no exponen ni persisten credenciales fuera del mecanismo autorizado.

## 10. Configuración mínima por repositorio

Cada consumidor DEBE incluir una entrada central aunque herede todos sus controles. Esta forma ilustra los campos mínimos; la plantilla reusable mantiene las tres capas lógicas:

```yaml
schema_version: workspace-control/v1
repo:
  id: group/repository
  path: https://forge.example/group/repository.git
  group: group
  managed: true
  verified_revision: unknown
context_sources: []
workflow:
  base_branch: unknown
  sync_strategy: unknown
  isolation_strategy: unknown
  development_workflow: |
    Describir el flujo aprobado.
  commit_policy: |
    Describir la política de commits.
  delivery_mode: unknown
  delivery_gate: |
    Describir aprobación y evidencia.
  definition_of_ready: |
    Describir qué debe declarar una task para ser ejecutable.
  incomplete_task_policy: skip
  failed_task_policy: skip
  controller_identity: unknown
pre_checks: []
acceptance_checks: []
review_checks: []
post_checks: []
monitoring: |
  Describir o declarar que no aplica.
external_effects: |
  Solo lectura hasta autorización explícita.
credential_policy: |
  Describir el mecanismo autorizado sin secretos.
knowledge_policy: |
  Rootline gobierna el conocimiento bajo .workspace/docs/.
cleanup_policy: |
  Tras integración verificada, eliminar los recursos exactos y desechables de la task bajo guardas fail-closed; cualquier otro cleanup requiere autorización explícita.
custom_rules: []
```

Los valores `unknown` bloquean las fases afectadas. El onboarding los sustituye únicamente con hechos observados y aprobados.

## 11. Ejemplo no normativo de binding

Este ejemplo prose-first es ilustrativo y no constituye un executor ni evidencia automática:

```yaml
repositories:
  example/service:
    repo:
      id: example/service
      path: https://forge.example/example/service.git
      group: example
      managed: true
      verified_revision: abc123
    workflow:
      base_branch: primary
      sync_strategy: |
        Verificar por lectura que la revisión base observada está vigente.
      isolation_strategy: dedicated-worktree
      development_workflow: |
        Diseñar, aprobar, implementar mediante TDD y revisar.
      commit_policy: conventional-commits
      delivery_mode: review-request
      delivery_gate: |
        Requerir evidencia local y aprobación humana explícita.
    pre_checks:
      - Ejecutar los checks locales documentados y conservar el resultado.
    acceptance_checks:
      - Mapear cada criterio aprobado a evidencia verificable.
    review_checks:
      - Obtener una revisión independiente antes de entregar.
    post_checks:
      - Observar la revisión entregada y confirmar su estado.
```

Cada repositorio debe reemplazar la prosa con realidad observada. Mientras no exista un binding determinista completo, Pi no reporta estos controles como automáticos.

## 12. Precedencia frente a steering y automatización

La configuración central es la autoridad del workspace, pero no puede prometer que anula controles técnicamente activos. Durante adopción, Pi inspecciona configuración global, steering heredado, steering local, hooks, plugins, CI, políticas del proveedor y práctica observable.

Todo conflicto se muestra con sus autoridades y fase afectada. No se fusiona ni se declara resuelto silenciosamente. El `AGENTS.md` del repositorio consumidor permanece steering local: este perfil no copia el `AGENTS.md` de A4S a otros repositorios.

## 13. Seguridad y sistemas externos

`credential_policy` declara el mecanismo concreto de transporte, helper, token efímero, cifrado o scanner. La evidencia contiene nombres de controles y resultados sanitizados, nunca secretos.

Antes de una mutación externa se observa el sistema real en modo de solo lectura, se verifica su contrato y variabilidad, se derivan pruebas desde evidencia sanitizada, se valida localmente y se obtiene autorización humana explícita para el alcance. Después se ejecutan post-checks y se aplica la condición de rollback, defer o nueva autorización. Si no puede verificarse el contrato, el estado es `unknown` y la mutación no ocurre.

Después de un intento live fallido no hay reintento mutante hasta verificar causa, reproducirla con una prueba fallida, corregir, revisar independientemente y obtener nueva autorización.

## 14. Adopción

La adopción sigue este orden:

1. identificar workspace y repositorio canónicos;
2. leer este perfil y verificar la procedencia del snapshot base;
3. inspeccionar interfaces y controles reales en modo de solo lectura;
4. consultar Backscroll mediante su workflow acotado;
5. asignar grupo si aplica y conservar hechos no resueltos como `unknown`;
6. producir una configuración candidata con orígenes, conflictos y blockers visibles;
7. revisar y aprobar explícitamente los bytes propuestos;
8. escribir y releer únicamente lo aprobado;
9. cuando la estrategia requiera `.workspace/worktrees/`, crearla y añadir idempotentemente `/.workspace/worktrees/` al archivo local de exclusiones resuelto por Git, sin sobrescribir entradas ni modificar el `.gitignore` versionado;
10. validar el Markdown gobernado con Rootline;
11. ejecutar una tarea representativa sin efectos externos;
12. habilitar gradualmente delivery y efectos externos mediante gates separados.

El wizard operativo se encuentra en `bootstrap.md`. No existe CLI de bootstrap ni activación automática en la versión 2.

## 15. Criterios de aceptación

Una adopción de este perfil es aceptable cuando demuestra que:

1. inventaría cada repositorio de origen una sola vez y verifica cada checkout local contra su locator canónico;
2. resuelve `workspace → group → repository` conservando el origen de cada valor;
3. muestra revisión, warnings, conflictos y `unknown`;
4. determina controles sin depender de navegar configuración autoritativa en repositorios hijos;
5. preserva todos los ejes, estados, merge rules, fases e invariantes de la base;
6. conserva `unknown` y falla cerrado;
7. vincula criterios de aceptación con checks y resultados;
8. distingue finalización de entrega verificada;
9. protege secretos;
10. detecta bindings stale;
11. enruta condicionalmente todos los artefactos publicados sin sustitutos;
12. requiere Rootline y Backscroll según sus contratos;
13. mantiene historial auditable de la configuración central;
14. preserva steering local sin copiar el `AGENTS.md` de este repositorio;
15. no afirma que la prosa sea ejecución determinista.

## 16. Fuera de alcance

La versión 2 no define ni implementa:

- el formato interno de scripts o pipelines de repositorios consumidores;
- un control-plane executor;
- un merge engine o resolver automático de configuración efectiva;
- un bootstrap CLI;
- un schema YAML o JSON generado;
- ejecutores o comandos reales para controles prose-first;
- compatibilidad con Claude Code, OpenCode u otro runtime diferente de Pi;
- sustitución de herramientas oficiales por equivalentes;
- proveedor concreto de tickets, Git, CI, secretos, despliegue o monitoreo;
- migraciones automáticas de repositorios existentes;
- instalación o mutación de configuración global de Pi;
- autorización para mutar remotos, GitHub, desplegar o modificar sistemas vivos.

Estas decisiones pertenecen a una versión futura aprobada o a la configuración concreta de cada adopción.
