---
tipo: adr
estado: accepted
fecha: '2026-09-24'
contexto: 'CI bloqueado por billing (a4s-1cy desde 2026-09-19); ADR 0046 permite merge de PR sin checks remotos si hay autorización del operador ligada al SHA; loop autónomo de roadmap requiere integración sin intervención manual; suite test/ci-local.sh en verde valida cambios localmente.'
decision: 'Declarar modo de entrega autónomo supervisado: permitir merge por squash con --match-head-commit automático cuando para el SHA de cabeza del PR se cumplan TODOS: test/ci-local.sh en verde; aprobación de reviewer subagente fresco; sin hallazgos HIGH de seguridad; marca ''Delivery-Override: ci-billing''; evidencia registra SHA y resultado. Mantener gate humano para cambios a política de entrega, efectos externos, operaciones destructivas, sustitución de ADR aceptado. Revocable.'
alternativas: 'Mantener gate humano por PR: bloquea integración autónoma del loop de roadmap; campo determinista nuevo en config: el contrato workspace-control/v1 es prosa y prohíbe campos de control deterministas; integración sólo por push directo: pierde trazabilidad de PR.'
consecuencias: 'Entregas autónomas son identificables con ''Delivery-Override: ci-billing''; el loop de roadmap puede operar sin intervención manual; cambios a política de entrega y operaciones destructivas siguen bajo autorización humana explícita; revocabilidad preservada; migración a CI normal requiere revertir texto de delivery_gate a manual.'
---
# 0047. Modo entrega autonomo supervisado

## Contexto
CI bloqueado por billing (a4s-1cy desde 2026-09-19); ADR 0046 permite merge de PR sin checks remotos si hay autorización del operador ligada al SHA; loop autónomo de roadmap requiere integración sin intervención manual; suite test/ci-local.sh en verde valida cambios localmente.

## Decisión
Declarar modo de entrega autónomo supervisado: permitir merge por squash con --match-head-commit automático cuando para el SHA de cabeza del PR se cumplan TODOS: test/ci-local.sh en verde; aprobación de reviewer subagente fresco; sin hallazgos HIGH de seguridad; marca 'Delivery-Override: ci-billing'; evidencia registra SHA y resultado. Mantener gate humano para cambios a política de entrega, efectos externos, operaciones destructivas, sustitución de ADR aceptado. Revocable.

## Alternativas descartadas
Mantener gate humano por PR: bloquea integración autónoma del loop de roadmap; campo determinista nuevo en config: el contrato workspace-control/v1 es prosa y prohíbe campos de control deterministas; integración sólo por push directo: pierde trazabilidad de PR.

## Consecuencias
Entregas autónomas son identificables con 'Delivery-Override: ci-billing'; el loop de roadmap puede operar sin intervención manual; cambios a política de entrega y operaciones destructivas siguen bajo autorización humana explícita; revocabilidad preservada; migración a CI normal requiere revertir texto de delivery_gate a manual.
