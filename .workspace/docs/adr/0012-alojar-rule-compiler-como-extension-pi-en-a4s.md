---
tipo: adr
estado: superseded
fecha: '2026-09-18'
contexto: 'A4S ya consolida configuración y runtime como un producto; el probe con Jev demostró valor en analizar sesiones completas, pero la extracción de reglas necesita una extensión Pi autocontenida sin crear otra autoridad de lifecycle.'
decision: 'Tratar A4S como monorepo npm incremental y crear packages/pi-rule-compiler como provider Pi autocontenido; compartirá observación de compaction con preguntas Jev, mantendrá compaction y RuleSignal como outputs separados, y no publicará reglas sin revisión.'
alternativas: 'Añadirlo a src/pi-extension: descartado porque mezclaría el experimento E0 de transporte con knowledge compilation; crear otro repositorio: descartado porque reintroduce fragmentación de un mismo producto; adoptar fast-jev-compaction completo: descartado porque su adapter es Claude-specific y su objetivo es poda, no reglas.'
consecuencias: 'El package tendrá contrato, dependencias y tests propios dentro del workspace; ADR 0009 permanece intacto porque la extensión no posee task lifecycle; Engram conserva memoria episódica y Rootline gobierna reglas aceptadas; el MVP será read-only/propose-only y fallará sin afectar la compaction normal.'
pendientes: ""
superseded_by: 0013-usar-jev-como-autoridad-de-compaction-semantica
---
# 0012. Alojar rule compiler como extension pi en a4s

## Contexto
A4S ya consolida configuración y runtime como un producto; el probe con Jev demostró valor en analizar sesiones completas, pero la extracción de reglas necesita una extensión Pi autocontenida sin crear otra autoridad de lifecycle.

## Decisión
Tratar A4S como monorepo npm incremental y crear packages/pi-rule-compiler como provider Pi autocontenido; compartirá observación de compaction con preguntas Jev, mantendrá compaction y RuleSignal como outputs separados, y no publicará reglas sin revisión.

## Alternativas descartadas
Añadirlo a src/pi-extension: descartado porque mezclaría el experimento E0 de transporte con knowledge compilation; crear otro repositorio: descartado porque reintroduce fragmentación de un mismo producto; adoptar fast-jev-compaction completo: descartado porque su adapter es Claude-specific y su objetivo es poda, no reglas.

## Consecuencias
El package tendrá contrato, dependencias y tests propios dentro del workspace; ADR 0009 permanece intacto porque la extensión no posee task lifecycle; Engram conserva memoria episódica y Rootline gobierna reglas aceptadas; el MVP será read-only/propose-only y fallará sin afectar la compaction normal.

## Pendientes
Calibrar thresholds con corpora reales; decidir después si fusionar físicamente requests de compaction y reglas; definir publicación Rootline sólo tras validar el MVP.
