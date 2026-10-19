---
tipo: adr
estado: accepted
fecha: '2026-09-28'
contexto: 'La forma de trabajo de A4S estaba repartida entre .workspace/config.yaml, PROFILE.md, el Engineering Handbook, AGENTS.md, ADRs aceptados que nunca se materializaron en config y las referencias de varios skills (Roadmap, sweep, herdr, adr, gh-communication-style, rule-audit). Varias de esas fuentes se contradecían; por ejemplo, sweep mergeaba con su propio gate y el ADR 0048 declaraba el loop autónomo por defecto. Ninguna declaraba cuál prevalecía, así que no era posible saber qué regla estaba en vigor.'
decision: '.workspace/config.yaml, integrada en main, es la única fuente normativa de la forma de trabajo. Los registros (ADRs, specs, planes, reportes) son append-only, no gobiernan y nunca se editan: una sustitución se declara sólo en el registro nuevo. Profile, AGENTS.md, README y tests de contrato derivan de config, que prevalece ante conflicto. Skills y métodos son mecanismo. Una regla ausente de config no está en vigor. Config incorpora las reglas vigentes que se decidió conservar, añade reglas nuevas y deja fuera las descartadas; el detalle está en el cuerpo de este ADR. Este ADR declara también qué registros sustituye.'
alternativas: 'Mantener la cadena Handbook → PROFILE → config se descarta porque config seguiría siendo una instancia y no la fuente. Absorber en config todas las reglas encontradas se descarta porque varias estaban obsoletas o eran configuración de runtime. Conservar la exclusión sparse de .workspace en worktrees se descarta porque, para evitar copias divergentes de la autoridad, basta con declarar que sólo cuenta la config integrada en main. Marcar como superseded los registros sustituidos editando su frontmatter se descarta por la regla append-only.'
consecuencias: 'Los registros listados en Sustituciones dejan de estar en vigor en la medida indicada. Los artefactos derivados y los skills quedan desalineados hasta corregirse; ese backlog se sigue por separado. La spec de arquitectura v0.9 se sustituirá por una versión que use los roles de config. Los ADRs de la rama roadmap-init-capability-lifecycle, que no están integrados, deben renumerarse antes de proponerse. El profile reusable se reescribirá a partir de esta config.'
pendientes: 'Registrar como Beads el backlog derivado.'
---
# 0061. Hacer de config la autoridad canónica del WoW

## Contexto
La forma de trabajo de A4S estaba repartida entre `.workspace/config.yaml`, `PROFILE.md`, el Engineering Handbook, `AGENTS.md`, ADRs aceptados que nunca se materializaron en config y las referencias de varios skills (Roadmap, sweep, herdr, adr, gh-communication-style, rule-audit). Varias de esas fuentes se contradecían; por ejemplo, sweep mergeaba con su propio gate y el ADR 0048 declaraba el loop autónomo por defecto. Ninguna declaraba cuál prevalecía, así que no era posible saber qué regla estaba en vigor.

## Decisión
`.workspace/config.yaml`, integrada en `main`, es la única fuente normativa de la forma de trabajo. Una copia en un worktree o rama es sólo candidata hasta que su PR se integra. Una regla ausente de config no está en vigor. Las demás capas quedan así:

- **Registros.** ADRs, specs, planes y reportes son append-only y no gobiernan. Un registro existente nunca se edita; la sustitución se declara sólo en el registro nuevo.
- **Derivados.** Profile, `AGENTS.md`, README y tests de contrato derivan de config; ante conflicto, prevalece config. `AGENTS.md` queda como una línea que remite a config.
- **Mecanismo.** Skills y métodos leen de config su política y no añaden reglas propias.

### Reglas que config conserva o incorpora de otras fuentes
- Umbral de probe, antes en `METHOD.md`: unknown material, sin objetivo compartido ni de producción, nunca promover el código, veredicto demostrado / refutado / no concluyente, y hallazgo con cleanup registrados.
- Seguridad general fail-closed, antes en `AGENTS.md` y PROFILE.
- Registros append-only.
- Texto generado como voz del operador, sin disclosure de IA por ese solo motivo (ADR 0040).
- Merge autónomo supervisado y excepción por billing (ADRs 0046 y 0047).
- Convenciones de skills: autocontenidos, `metadata.author` y `metadata.updated`, el loop no edita `skills/roadmap`, activación por tag.
- Principios de producto:
  - config y runtime son capas del mismo producto;
  - los runtimes externos son providers;
  - los proyectos relacionados son referencias;
  - operación directa y reversible;
  - DRY y KISS;
  - familias top-level sólo con contenido real.

### Reglas nuevas
- **Desviación.** Una instrucción del operador que contradice config sólo se ejecuta si el executor nombra la regla afectada y el operador aprueba explícitamente ese caso. Hacerla norma requiere el proceso de cambio normativo.
- **ADRs.** Llevan ADR todo cambio a config y todo cambio de arquitectura del que dependan otros componentes, usuarios o tasks futuras, o que sea costoso de revertir.
- **Documentos durables.** Todo PR que agregue o cambie un documento en `.workspace/docs/` requiere aprobación del operador, también en modo autónomo. Un registro va en el mismo PR que el cambio que registra.
- **Reviewer.** Todo PR, incluidos los de docs, config y bots, requiere un reviewer fresco de otra familia de modelo que el implementador y, si hay disponible, de otro proveedor.
- **E2E.** Sólo en tasks de implementation, según el tipo de producto: paquete, skill, script, definición de agente u output style. Sin punto de entrada ejercitable, el criterio queda `unknown` y se escala.
- **API pública.** Si una implementation cambia una API pública (exports, comando o CLI, invocación de un skill, claves de config), actualizar su documentación es criterio de aceptación.
- **PRs de bots.** Pasan el mismo gate que cualquier PR. Un fallo se arregla en el mismo PR y, sin cuota de CI, aplica la excepción por billing. Están exentos del trailer `Bead:`.
- **Comunicación.** Issues y comentarios requieren aprobación del texto antes de publicarse; los PRs no.
- **Entrega.**
  - Trailer `Bead:` en los commits.
  - Nunca push directo a `main`.
  - Cada task se integra al aceptarse; los skills se activan por tag.
- **Loop autónomo.** Una pregunta de estado no lo detiene. Un hallazgo del WoW sí: después de cada task se escala al operador, que decide si ajusta el alcance, abre un Bead nuevo o no hace nada.
- **Worktrees.** Van en `.workspace/worktrees/`.

### Reglas que quedan fuera
- Restricciones de git por rol.
- Enrutamiento de modelos por altitud y sensibilidad: es configuración de runtime.
- BACKLOG EMERGENCY.
- Gate runtime-first: lo cubre el principio PoC por capacidad.
- Métricas de eficiencia y la regla "audits-to-screen-first".
- Orden y agrupación de tasks: siguen como mecanismo de Roadmap.

## Sustituciones
Este ADR sustituye, en la medida indicada:

- **0009:** deja de ser regla del WoW.
- **0025:** sustituido. Los worktrees van en `.workspace/worktrees/` sin exclusión sparse, y la autoridad es la config integrada en `main`.
- **0028:** sustituido por E2E sólo en implementation, según el tipo de producto.
- **0043:** deja de estar en vigor en topología y delegación. La revisión fresca vive en `accept_work.review`.
- **0046:** sustituido en el fallback de push directo, que se elimina. El resto vive en `deliver_work.billing_exception`.
- **0048:** sustituido en el loop autónomo por defecto. El modo autónomo requiere una petición explícita que fije el alcance.
- **0052:** deja de estar en vigor.
- **0054:** sustituido en la independencia de reviewers. Las rutas por rol son configuración de runtime, fuera del WoW.
- **0010, 0015 y 0019:** sus roles y reglas de Herdr dejan de ser WoW. Los términos del WoW son los de config.
- **0018, 0027 y 0036:** quedan fuera del WoW.

## Alternativas descartadas
- **Mantener la cadena Handbook → PROFILE → config.** Config seguiría siendo una instancia y no la fuente.
- **Absorber en config todas las reglas encontradas.** Varias estaban obsoletas o eran configuración de runtime.
- **Conservar la exclusión sparse de `.workspace` en worktrees.** Para evitar copias divergentes de la autoridad basta con declarar que sólo cuenta la config integrada en `main`.
- **Marcar como superseded los registros sustituidos editando su frontmatter.** Contradice la regla append-only.

## Consecuencias
Los registros listados en Sustituciones dejan de estar en vigor en la medida indicada.

Los artefactos derivados y los skills quedan desalineados hasta corregirse:
- Roadmap: `contracts.md`, `loop.md` y la sección Authority de `SKILL.md`.
- sweep: `apply.md`.
- Los skills adr, herdr y gh-communication-style.
- `PROFILE.md`, bootstrap, template y README.
- Los tests de contrato.

Ese backlog se sigue por separado.

La spec de arquitectura v0.9 se sustituirá por una versión que use los roles de config. Los ADRs de la rama `roadmap-init-capability-lifecycle`, que no están integrados, deben renumerarse antes de proponerse. El profile reusable se reescribirá a partir de esta config.

## Pendientes
- Registrar como Beads el backlog derivado.
