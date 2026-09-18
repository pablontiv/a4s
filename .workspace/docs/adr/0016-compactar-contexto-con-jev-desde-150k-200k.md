---
tipo: adr
estado: accepted
fecha: '2026-09-18'
contexto: 'El umbral observado cercano a 840K tokens produjo sólo cinco compactaciones en dieciocho sesiones S4 y permitió contextos de hasta 1.2M tokens; el ADR 0013 del worktree pi-rule-compiler establece a Jev como autoridad semántica fail-closed para compaction.'
decision: 'La adopción de Jev y la reducción del umbral serán un cambio acoplado: una vez integrado ADR 0013, las sesiones agentic compactarán aproximadamente entre 150K y 200K tokens mediante decisiones deterministas keep, truncate o drop de Jev; sin Jev disponible la compactación se bloquea visiblemente y no usa fallback generativo lossy.'
alternativas: 'Bajar el umbral antes de Jev con resumen nativo: descartado por amplificar pérdida semántica; conservar cerca de 840K: descartado por cacheRead excesivo; usar fallback generativo cuando Jev falle: descartado por contradecir ADR 0013.'
consecuencias: 'Se reduce el contexto releído y aumenta la frecuencia de compaction; Jev pasa a estar en el camino operativo y su indisponibilidad bloquea compaction de forma recuperable; el valor exacto dentro del rango deberá calibrarse con telemetría sin separar ambos cambios.'
pendientes: ""
---
# 0016. Compactar contexto con jev desde 150k 200k

## Contexto
El umbral observado cercano a 840K tokens produjo sólo cinco compactaciones en dieciocho sesiones S4 y permitió contextos de hasta 1.2M tokens; el ADR 0013 del worktree pi-rule-compiler establece a Jev como autoridad semántica fail-closed para compaction.

## Decisión
La adopción de Jev y la reducción del umbral serán un cambio acoplado: una vez integrado ADR 0013, las sesiones agentic compactarán aproximadamente entre 150K y 200K tokens mediante decisiones deterministas keep, truncate o drop de Jev; sin Jev disponible la compactación se bloquea visiblemente y no usa fallback generativo lossy.

## Alternativas descartadas
Bajar el umbral antes de Jev con resumen nativo: descartado por amplificar pérdida semántica; conservar cerca de 840K: descartado por cacheRead excesivo; usar fallback generativo cuando Jev falle: descartado por contradecir ADR 0013.

## Consecuencias
Se reduce el contexto releído y aumenta la frecuencia de compaction; Jev pasa a estar en el camino operativo y su indisponibilidad bloquea compaction de forma recuperable; el valor exacto dentro del rango deberá calibrarse con telemetría sin separar ambos cambios.

## Pendientes
Integrar primero ADR 0013 y calibrar el punto exacto entre 150K y 200K con sesiones reales.
