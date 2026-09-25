---
tipo: adr
estado: accepted
fecha: '2026-09-25'
contexto: 'El umbral fijo de 16K activó sugerencias cerca del 10% en modelos grandes y el rango fijo de 150K–200K de ADR 0016 no escala al cambiar de modelo ni demuestra que Pi tenga historia compactable.'
decision: 'El Trigger exigirá al menos 20% del contextWindow activo y una prueba conservadora de historia compactable sobre la proyección de sesión y keepRecentTokens efectivos; recalculará ambos al cambiar de modelo y consultará Jev sólo después de esos gates deterministas.'
alternativas: 'Se descartan mantener un rango fijo de tokens porque no escala, esperar una nueva API canCompact de Pi porque no es un bloqueo y copiar la preparación exacta de Pi porque aumenta el acoplamiento; la prueba local conservadora prefiere falsos negativos seguros.'
consecuencias: 'Las sugerencias se adaptan al modelo y no aparecen cuando no queda un turno antiguo resumible; algunos casos que Pi sí podría compactar pueden omitir el hint, y cambios futuros en proyección o settings de Pi requieren conservar los tests de contrato.'
---
# 0055. Usar umbral relativo y readiness conservadora para compaction

Reemplaza a 0016-compactar-contexto-con-jev-desde-150k-200k.

## Contexto
El umbral fijo de 16K activó sugerencias cerca del 10% en modelos grandes y el rango fijo de 150K–200K de ADR 0016 no escala al cambiar de modelo ni demuestra que Pi tenga historia compactable.

## Decisión
El Trigger exigirá al menos 20% del contextWindow activo y una prueba conservadora de historia compactable sobre la proyección de sesión y keepRecentTokens efectivos; recalculará ambos al cambiar de modelo y consultará Jev sólo después de esos gates deterministas.

## Alternativas descartadas
Se descartan mantener un rango fijo de tokens porque no escala, esperar una nueva API canCompact de Pi porque no es un bloqueo y copiar la preparación exacta de Pi porque aumenta el acoplamiento; la prueba local conservadora prefiere falsos negativos seguros.

## Consecuencias
Las sugerencias se adaptan al modelo y no aparecen cuando no queda un turno antiguo resumible; algunos casos que Pi sí podría compactar pueden omitir el hint, y cambios futuros en proyección o settings de Pi requieren conservar los tests de contrato.
