---
tipo: adr
estado: accepted
fecha: '2026-09-18'
contexto: 'El owner corrigió el MVP observer-only: el objetivo del plugin es que Jev decida la compactación y extraiga reglas en la misma lectura; una compactación nativa de respaldo reintroduce exactamente la pérdida semántica que se buscaba evitar.'
decision: 'La extensión reemplazará la compactación nativa mediante session_before_compact: Jev decidirá keep, truncate o drop por mensaje y emitirá RuleSignals en la misma pasada; el código construirá una compaction custom determinista y los fallos de Jev cancelarán la compactación sin fallback nativo.'
alternativas: 'Mantener observación lateral con fallback nativo: descartado porque no satisface el objetivo; adoptar pi-jev o fast-jev-compaction completos: descartado porque sus contratos de cobertura, redacción, provenance y lifecycle no coinciden; usar el modelo generativo actual para resumir: descartado por volver a un summary libre y lossy.'
consecuencias: 'Jev pasa a ser dependencia operativa de compaction; Pi conserva almacenamiento y lifecycle, pero no genera el summary; RuleSignals se publican sólo después de compaction exitosa; /retro-rules sigue siendo review-only; una indisponibilidad Jev bloquea compaction de forma visible y recuperable.'
---
# 0013. Usar jev como autoridad de compaction semantica

Reemplaza a 0012-alojar-rule-compiler-como-extension-pi-en-a4s.

## Contexto
El owner corrigió el MVP observer-only: el objetivo del plugin es que Jev decida la compactación y extraiga reglas en la misma lectura; una compactación nativa de respaldo reintroduce exactamente la pérdida semántica que se buscaba evitar.

## Decisión
La extensión reemplazará la compactación nativa mediante session_before_compact: Jev decidirá keep, truncate o drop por mensaje y emitirá RuleSignals en la misma pasada; el código construirá una compaction custom determinista y los fallos de Jev cancelarán la compactación sin fallback nativo.

## Alternativas descartadas
Mantener observación lateral con fallback nativo: descartado porque no satisface el objetivo; adoptar pi-jev o fast-jev-compaction completos: descartado porque sus contratos de cobertura, redacción, provenance y lifecycle no coinciden; usar el modelo generativo actual para resumir: descartado por volver a un summary libre y lossy.

## Consecuencias
Jev pasa a ser dependencia operativa de compaction; Pi conserva almacenamiento y lifecycle, pero no genera el summary; RuleSignals se publican sólo después de compaction exitosa; /retro-rules sigue siendo review-only; una indisponibilidad Jev bloquea compaction de forma visible y recuperable.
