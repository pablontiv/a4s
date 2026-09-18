---
tipo: adr
estado: accepted
fecha: '2026-09-18'
contexto: 'La topología S3 evita subagentes anidados, pero un tab o estado de agente no conserva por sí solo ownership durable de la unidad; el owner exige que toda unidad Herdr ejecutada con kind claude o pi esté respaldada por un Bead antes de crear el tab o iniciar el agente.'
decision: 'Todo dispatch Herdr fallará cerrado sin un Bead creado o reclamado: cada tab peer y cada rama de fan-out tendrá un Bead distinto, enlazado a su padre cuando aplique; bead_id viajará en el prompt, el reporte y el callback WORK_RESULT o ATTENTION; tras evidencia terminal autorizada, el agente ejecutor cerrará su propio Bead con bd close --actor y --reason.'
alternativas: 'Crear o reclamar el Bead después del dispatch: descartado porque deja una ventana sin ownership durable; compartir un Bead entre tabs: descartado porque mezcla accountability; inferir completion desde idle, done o terminal: descartado porque telemetría no es outcome; construir un scheduler propio: descartado por ADR 0009.'
consecuencias: 'Sin Bead no se crea workspace o tab ni se inicia o despacha un agente; bloqueos y atención sólo preservan evidencia y dejan el Bead abierto; cerrar el Bead termina la unidad delegada pero nunca auto-cierra WorkResult, Mission ni otro lifecycle autoritativo; el callback binario DONE se sustituye por envelopes WORK_RESULT SUBMITTED o ATTENTION REQUIRED con artifact_path y bead_id.'
pendientes: ""
---
# 0019. Exigir bead antes de dispatch herdr

## Contexto
La topología S3 evita subagentes anidados, pero un tab o estado de agente no conserva por sí solo ownership durable de la unidad; el owner exige que toda unidad Herdr ejecutada con kind claude o pi esté respaldada por un Bead antes de crear el tab o iniciar el agente.

## Decisión
Todo dispatch Herdr fallará cerrado sin un Bead creado o reclamado: cada tab peer y cada rama de fan-out tendrá un Bead distinto, enlazado a su padre cuando aplique; bead_id viajará en el prompt, el reporte y el callback WORK_RESULT o ATTENTION; tras evidencia terminal autorizada, el agente ejecutor cerrará su propio Bead con bd close --actor y --reason.

## Alternativas descartadas
Crear o reclamar el Bead después del dispatch: descartado porque deja una ventana sin ownership durable; compartir un Bead entre tabs: descartado porque mezcla accountability; inferir completion desde idle, done o terminal: descartado porque telemetría no es outcome; construir un scheduler propio: descartado por ADR 0009.

## Consecuencias
Sin Bead no se crea workspace o tab ni se inicia o despacha un agente; bloqueos y atención sólo preservan evidencia y dejan el Bead abierto; cerrar el Bead termina la unidad delegada pero nunca auto-cierra WorkResult, Mission ni otro lifecycle autoritativo; el callback binario DONE se sustituye por envelopes WORK_RESULT SUBMITTED o ATTENTION REQUIRED con artifact_path y bead_id.

## Pendientes
Validar con el ACR seleccionado el mapeo durable entre Bead, WorkResult y Mission sin duplicar autoridad de lifecycle.
