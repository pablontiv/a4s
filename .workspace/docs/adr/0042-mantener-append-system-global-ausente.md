---
tipo: adr
estado: accepted
fecha: '2026-09-24'
contexto: 'ADR 0037 preservó APPEND_SYSTEM al retirar un AGENTS.md global ajeno, pero el Operador indicó después de forma explícita que APPEND_SYSTEM no se usará hasta nuevo aviso.'
decision: 'Mantener retirado el AGENTS.md global ajeno y mantener ausente ~/.pi/agent/APPEND_SYSTEM.md hasta una nueva instrucción explícita del Operador; el source versionado en A4S y el archivo histórico no autorizan su proyección global.'
alternativas: 'Restaurar el symlink hacia A4S: descartado por la instrucción posterior del Operador; borrar el source canónico de A4S: descartado porque puede permanecer como artefacto versionado inactivo; reescribir ADR 0037: descartado porque la historia se preserva mediante supersession.'
consecuencias: 'Las sesiones Pi nuevas no cargan APPEND_SYSTEM global; una restauración futura requiere instrucción explícita y verificación del target, mientras A4S conserva el source sin activarlo.'
---
# 0042. Mantener append system global ausente

Reemplaza a 0037-retirar-agents-global-ajeno.

## Contexto
ADR 0037 preservó APPEND_SYSTEM al retirar un AGENTS.md global ajeno, pero el Operador indicó después de forma explícita que APPEND_SYSTEM no se usará hasta nuevo aviso.

## Decisión
Mantener retirado el AGENTS.md global ajeno y mantener ausente ~/.pi/agent/APPEND_SYSTEM.md hasta una nueva instrucción explícita del Operador; el source versionado en A4S y el archivo histórico no autorizan su proyección global.

## Alternativas descartadas
Restaurar el symlink hacia A4S: descartado por la instrucción posterior del Operador; borrar el source canónico de A4S: descartado porque puede permanecer como artefacto versionado inactivo; reescribir ADR 0037: descartado porque la historia se preserva mediante supersession.

## Consecuencias
Las sesiones Pi nuevas no cargan APPEND_SYSTEM global; una restauración futura requiere instrucción explícita y verificación del target, mientras A4S conserva el source sin activarlo.
