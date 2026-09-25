---
tipo: adr
estado: accepted
fecha: '2026-09-25'
contexto: 'Roadmap declara Beads como registro durable pero duplica cada tarea en reportes por rol ignorados y reportes finales versionados; la auditoría de Beads 1.3.0 y seis escenarios frescos demostraron que comments, notes condicionadas y provenance cubren el expediente sin documentos paralelos.'
decision: 'Hacer del Bead el expediente canónico de ejecución de Roadmap: contratos en campos del issue, handoffs y reviews en comments, resultado final en notes dentro del cierre condicional, y referencias externas en provenance; dejar de crear nuevos reportes Markdown de ejecución, sustituyendo parcialmente el payload de ADR 0033 y el handoff por archivo de ADR 0043.'
alternativas: 'Conservar reportes por archivo se descarta por duplicar autoridad y perder handoffs ignorados; guardar todo como comment se descarta porque comment y cierre no son atómicos; usar HTTP batchApply se descarta porque A4S opera Dolt embebido; crear un runtime o harness se descarta porque contradice ADR 0048 y no es necesario.'
consecuencias: 'Roadmap y Doctor deben escribir y leer comments explícitamente, cerrar o bloquear con un ROADMAP_RESULT acotado y guards de ownership, registrar SHA PR CI y transcript mediante provenance, preservar reportes históricos sin migrarlos y verificar la conducta con escenarios RED-GREEN de agentes frescos más checks mecánicos.'
pendientes: ""
---
# 0051. Hacer del bead el registro canonico de evidencia roadmap

## Contexto
Roadmap declara Beads como registro durable pero duplica cada tarea en reportes por rol ignorados y reportes finales versionados; la auditoría de Beads 1.3.0 y seis escenarios frescos demostraron que comments, notes condicionadas y provenance cubren el expediente sin documentos paralelos.

## Decisión
Hacer del Bead el expediente canónico de ejecución de Roadmap: contratos en campos del issue, handoffs y reviews en comments, resultado final en notes dentro del cierre condicional, y referencias externas en provenance; dejar de crear nuevos reportes Markdown de ejecución, sustituyendo parcialmente el payload de ADR 0033 y el handoff por archivo de ADR 0043.

## Alternativas descartadas
Conservar reportes por archivo se descarta por duplicar autoridad y perder handoffs ignorados; guardar todo como comment se descarta porque comment y cierre no son atómicos; usar HTTP batchApply se descarta porque A4S opera Dolt embebido; crear un runtime o harness se descarta porque contradice ADR 0048 y no es necesario.

## Consecuencias
Roadmap y Doctor deben escribir y leer comments explícitamente, cerrar o bloquear con un ROADMAP_RESULT acotado y guards de ownership, registrar SHA PR CI y transcript mediante provenance, preservar reportes históricos sin migrarlos y verificar la conducta con escenarios RED-GREEN de agentes frescos más checks mecánicos.

## Pendientes
Ninguno.
