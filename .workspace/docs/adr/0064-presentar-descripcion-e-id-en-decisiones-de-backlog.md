---
tipo: adr
estado: accepted
fecha: '2026-09-29'
contexto: Al presentar un Bead existente, la persona operadora necesita entender el trabajo y conservar trazabilidad al registro sin que la vista cambie datos, readiness ni workflows. Roadmap especializa la interfaz sobre la política mínima de config y conserva sus mecanismos previos de Tree, Plan y Doctor.
decision: 'Config exige sólo que un Bead existente se presente con Description humana primaria, Bead ID, Result observable y Scope juntos; un valor ausente se muestra missing o unknown sin inferencia, impacto en readiness, mutación ni backfill. Roadmap puede especializar UI, layouts, campos auxiliares, encabezados, marcadores, resúmenes, payloads y loop autónomo sin crear autoridad normativa, gates, permisos, readiness, lifecycle, acceptance ni efectos externos. Los nodos prospectivos de Plan no son Beads: pueden usar UI rica o ID unassigned como especialización; tras creación se reportan los valores reales. Se conservan los mecanismos base de Tree, Plan y Doctor, incluido su flujo de propuesta y elección derivado de config.'
alternativas: Mostrar sólo IDs se descarta porque no explica el trabajo. Aplicar la regla a nodos prospectivos se descarta porque aún no son Beads. Inferir o rellenar campos para completar la vista se descarta porque convertiría presentación en cambio de estado. Fijar formato desde config se descarta porque corresponde a la especialización Roadmap.
consecuencias: Config mantiene política mínima y Roadmap conserva topología, progreso, marcadores, bloqueos, findings, orden, payloads, IDs literales y flujo Doctor previos mientras especializa la presentación. Las pruebas estáticas separan política config, especialización UI y regresiones base; no afirman E2E.
---
# 0064. Presentar descripción e ID en decisiones de backlog

## Contexto
Al presentar un Bead existente, la persona operadora necesita entender el trabajo y conservar trazabilidad al registro sin que la vista cambie datos, readiness ni workflows. Roadmap especializa la interfaz sobre la política mínima de config y conserva sus mecanismos previos de Tree, Plan y Doctor.

## Decisión
Config exige sólo que un Bead existente se presente con `Description` humana primaria, `Bead ID`, `Result` observable y `Scope` juntos; un valor ausente se muestra `missing` o `unknown` sin inferencia, impacto en readiness, mutación ni backfill.

Roadmap puede especializar UI, layouts, campos auxiliares, encabezados, marcadores, resúmenes, payloads y loop autónomo sin crear autoridad normativa, gates, permisos, readiness, lifecycle, acceptance ni efectos externos. Los nodos prospectivos de Plan no son Beads: pueden usar UI rica o ID `unassigned` como especialización; tras creación se reportan los valores reales. Se conservan los mecanismos base de Tree, Plan y Doctor, incluido su flujo de propuesta y elección derivado de config.

## Alternativas descartadas
Mostrar sólo IDs se descarta porque no explica el trabajo. Aplicar la regla a nodos prospectivos se descarta porque aún no son Beads. Inferir o rellenar campos para completar la vista se descarta porque convertiría presentación en cambio de estado. Fijar formato desde config se descarta porque corresponde a la especialización Roadmap.

## Consecuencias
Config mantiene política mínima y Roadmap conserva topología, progreso, marcadores, bloqueos, findings, orden, payloads, IDs literales y flujo Doctor previos mientras especializa la presentación. Las pruebas estáticas separan política config, especialización UI y regresiones base; no afirman E2E.
