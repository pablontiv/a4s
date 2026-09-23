---
tipo: adr
estado: accepted
fecha: '2026-09-21'
contexto: 'Pi carga AGENTS.md completo, todos los archivos por ancestor-walk, al system prompt en cada carga, sin carga condicional ni por seccion (resource-loader y system-prompt); esto es exactamente la premisa que el paper Jev cuestiona en instrucciones condicionales; ademas a4s ya extrae RuleSignals como reglas candidatas pero su apply durable a AGENTS.md o Rootline sigue deferido por ADR 0020.'
decision: 'A4S aplicara las reglas aceptadas como fragmentos de instruccion atados a condicion inyectados por turno via el hook before_agent_start, en vez de escribirlas estaticas en AGENTS.md; la inyeccion por turno las hace condicionales e inmunes a compaction por construccion, porque el system prompt se reensambla cada turno y no vive en el transcript compactable; el fragmento carga solo cuando su condicion se cumple, por ejemplo tipo de archivo o subdirectorio o intent; esto define el sink del pipeline RuleSignals hacia reglas y reformula el apply deferido de ADR 0020 de write estatico a injection condicional.'
alternativas: 'Escribir reglas estaticas en AGENTS.md: descartado por cargar always-on e inflar el contexto de cada turno, justo lo que el paper evita; usar resources_discover: descartado porque solo entrega paths de skills, prompts y themes sin predicados de condicion; entregar cada regla como skill model-pull: descartado porque es recuperacion por el modelo, no inyeccion condicional del harness, y no garantiza carga cuando la condicion se cumple; lograr inmunidad a compaction extendiendo el pin soft forcedBy de a4s: descartado como ruta primaria por indirecta, la reinjection por turno da inmunidad dura sin tocar compaction.'
consecuencias: 'before_agent_start existe en el pin 0.84.4, sin bump; el apply pasa de write estatico a injection por turno, revisando parcialmente la deferral de ADR 0020; requiere definir el motor de condiciones, tipo de archivo o subdirectorio o intent, y su fuente de evidencia por turno; el system prompt crece solo con los fragmentos activos, reduciendo el overhead fijo; depende del pipeline RuleSignals hacia reglas aceptadas como fuente de fragmentos.'
pendientes: ""
---
# 0024. Aplicar reglas como fragmentos condicionales via before agent start

## Contexto
Pi carga AGENTS.md completo, todos los archivos por ancestor-walk, al system prompt en cada carga, sin carga condicional ni por seccion (resource-loader y system-prompt); esto es exactamente la premisa que el paper Jev cuestiona en instrucciones condicionales; ademas a4s ya extrae RuleSignals como reglas candidatas pero su apply durable a AGENTS.md o Rootline sigue deferido por ADR 0020.

## Decisión
A4S aplicara las reglas aceptadas como fragmentos de instruccion atados a condicion inyectados por turno via el hook before_agent_start, en vez de escribirlas estaticas en AGENTS.md; la inyeccion por turno las hace condicionales e inmunes a compaction por construccion, porque el system prompt se reensambla cada turno y no vive en el transcript compactable; el fragmento carga solo cuando su condicion se cumple, por ejemplo tipo de archivo o subdirectorio o intent; esto define el sink del pipeline RuleSignals hacia reglas y reformula el apply deferido de ADR 0020 de write estatico a injection condicional.

## Alternativas descartadas
Escribir reglas estaticas en AGENTS.md: descartado por cargar always-on e inflar el contexto de cada turno, justo lo que el paper evita; usar resources_discover: descartado porque solo entrega paths de skills, prompts y themes sin predicados de condicion; entregar cada regla como skill model-pull: descartado porque es recuperacion por el modelo, no inyeccion condicional del harness, y no garantiza carga cuando la condicion se cumple; lograr inmunidad a compaction extendiendo el pin soft forcedBy de a4s: descartado como ruta primaria por indirecta, la reinjection por turno da inmunidad dura sin tocar compaction.

## Consecuencias
before_agent_start existe en el pin 0.84.4, sin bump; el apply pasa de write estatico a injection por turno, revisando parcialmente la deferral de ADR 0020; requiere definir el motor de condiciones, tipo de archivo o subdirectorio o intent, y su fuente de evidencia por turno; el system prompt crece solo con los fragmentos activos, reduciendo el overhead fijo; depende del pipeline RuleSignals hacia reglas aceptadas como fuente de fragmentos.

## Pendientes
Motor de condiciones y su fuente de evidencia por turno; formato y almacen durable de los fragmentos condicionales y su relacion con Rootline; interaccion con la superficie de permisos de ADR 0023 iter3; orden entre este apply condicional y cualquier write estatico residual.
