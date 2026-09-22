---
tipo: adr
estado: superseded
fecha: '2026-09-21'
contexto: 'La verificación actual por Bead ejecuta npm test, typecheck, diff y LSP, pero no una prueba end-to-end explícita del runtime Pi.'
decision: 'Ejecutar npm run e0 completo después de cerrar cada Bead, además de los gates existentes; un fallo impide cerrar el Bead.'
alternativas: 'Mantener sólo suites unitarias e integración: rechazado porque no verifica el runtime Pi end-to-end. Usar rpc:compact-driver por Bead: rechazado porque requiere credenciales Jev y no es un gate universal.'
consecuencias: 'Aumenta el tiempo de cierre de cada Bead y genera artefactos E0; ofrece cobertura real de Pi sin consumir credenciales Jev.'
superseded_by: 0028-exigir-e2e-por-producto
---
# 0023. Exigir e2e por bead

## Contexto
La verificación actual por Bead ejecuta npm test, typecheck, diff y LSP, pero no una prueba end-to-end explícita del runtime Pi.

## Decisión
Ejecutar npm run e0 completo después de cerrar cada Bead, además de los gates existentes; un fallo impide cerrar el Bead.

## Alternativas descartadas
Mantener sólo suites unitarias e integración: rechazado porque no verifica el runtime Pi end-to-end. Usar rpc:compact-driver por Bead: rechazado porque requiere credenciales Jev y no es un gate universal.

## Consecuencias
Aumenta el tiempo de cierre de cada Bead y genera artefactos E0; ofrece cobertura real de Pi sin consumir credenciales Jev.
