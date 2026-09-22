---
tipo: adr
estado: accepted
fecha: '2026-09-21'
contexto: 'ADR 0023 confundió el runner E0 con la extensión de compaction: E0 lanza Pi real pero carga src/pi-extension/index.ts y no ejercita packages/pi-rule-compiler.'
decision: 'Cada Bead ejecutará un E2E headless de su propio producto; para pi-rule-compiler será Pi RPC cargando packages/pi-rule-compiler/src/index.ts, con una sesión creada durante la prueba y proveedores reales configurados, sin JSONL prefabricado.'
alternativas: 'Usar npm run e0 para todos los Beads: descartado porque valida únicamente el producto E0. Usar fixtures JSONL pregrabados: descartado porque no prueba el flujo real de sesión y compaction.'
consecuencias: 'El gate requiere disponibilidad de un modelo Pi y credenciales Jev, consume cuota y debe producir evidencia de la extensión bajo prueba; un entorno sin esos proveedores bloquea el cierre en vez de sustituirse por E0.'
---
# 0028. Exigir e2e por producto

Reemplaza a 0023-exigir-e2e-por-bead.

## Contexto
ADR 0023 confundió el runner E0 con la extensión de compaction: E0 lanza Pi real pero carga src/pi-extension/index.ts y no ejercita packages/pi-rule-compiler.

## Decisión
Cada Bead ejecutará un E2E headless de su propio producto; para pi-rule-compiler será Pi RPC cargando packages/pi-rule-compiler/src/index.ts, con una sesión creada durante la prueba y proveedores reales configurados, sin JSONL prefabricado.

## Alternativas descartadas
Usar npm run e0 para todos los Beads: descartado porque valida únicamente el producto E0. Usar fixtures JSONL pregrabados: descartado porque no prueba el flujo real de sesión y compaction.

## Consecuencias
El gate requiere disponibilidad de un modelo Pi y credenciales Jev, consume cuota y debe producir evidencia de la extensión bajo prueba; un entorno sin esos proveedores bloquea el cierre en vez de sustituirse por E0.
