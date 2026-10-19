---
tipo: adr
estado: accepted
fecha: '2026-09-25'
contexto: 'Roadmap puede detener Loop por autoridad unknown aun cuando existan tareas pendientes y candidatas completas; el resumen actual no muestra magnitud, no declara que el trabajo quedó varado y ofrece una continuación genérica, creando un dead-end operacional.'
decision: 'Cuando existan Beads no cerrados pero Loop no pueda ejecutar ninguno, emitir BACKLOG EMERGENCY, mostrar el total pendiente y el siguiente candidato varado cuando exista, nombrar el blocker literal y ofrecer una única continuación concreta y policy-valid que resuelva esa clase de bloqueo.'
alternativas: 'Mantener LOOP SUMMARY genérico se descarta porque oculta severidad y magnitud; llamar al problema calidad de backlog se descarta porque hay trabajo real no ejecutable; listar varias reparaciones secundarias se descarta porque aumenta carga cognitiva sin desbloquear Loop.'
consecuencias: 'Loop y Doctor conservan fallo cerrado y approval gates, pero nunca terminan un backlog pendiente no ejecutable sin una ruta accionable; los pressure scenarios verifican la forma de salida y el no downgrade.'
---
# 0052. Tratar backlog pendiente no ejecutable como emergencia

## Contexto
Roadmap puede detener Loop por autoridad unknown aun cuando existan tareas pendientes y candidatas completas; el resumen actual no muestra magnitud, no declara que el trabajo quedó varado y ofrece una continuación genérica, creando un dead-end operacional.

## Decisión
Cuando existan Beads no cerrados pero Loop no pueda ejecutar ninguno, emitir BACKLOG EMERGENCY, mostrar el total pendiente y el siguiente candidato varado cuando exista, nombrar el blocker literal y ofrecer una única continuación concreta y policy-valid que resuelva esa clase de bloqueo.

## Alternativas descartadas
Mantener LOOP SUMMARY genérico se descarta porque oculta severidad y magnitud; llamar al problema calidad de backlog se descarta porque hay trabajo real no ejecutable; listar varias reparaciones secundarias se descarta porque aumenta carga cognitiva sin desbloquear Loop.

## Consecuencias
Loop y Doctor conservan fallo cerrado y approval gates, pero nunca terminan un backlog pendiente no ejecutable sin una ruta accionable; los pressure scenarios verifican la forma de salida y el no downgrade.
