---
tipo: adr
estado: proposed
fecha: '2026-09-19'
contexto: 'Mission Control puede perder propuestas del operador mientras orquesta trabajo; se requiere una interfaz separada sin autoridad de ejecución ni lifecycle.'
decision: 'A4S usará un Asistente read-only de intake: releva ideas acotadas al Mission Control, recibe sus dudas y las transmite al operador; no crea ni modifica Beads, repositorios, sesiones o dispatches, no decide proyectos activos y falla cerrado ante cualquier solicitud fuera de intake.'
alternativas: 'Mantener intake solo en MC: rechazado por pérdida de contexto; asistente con autoridad de Beads: rechazado por solapamiento de lifecycle; diferir por falta de sandbox: rechazado porque el contrato de proceso acotado reduce el riesgo.'
consecuencias: 'Reduce pérdida de propuestas con una nueva sesión de bajo coste; la prohibición es de proceso, ya que Herdr no ofrece sandbox técnico read-only; el rol debe documentarse y auditarse.'
pendientes: 'Verificar el comportamiento real y documentar el rol en SKILL.md mediante un Bead separado.'
---
# 0023. Asistente read only para intake

## Contexto
Mission Control puede perder propuestas del operador mientras orquesta trabajo; se requiere una interfaz separada sin autoridad de ejecución ni lifecycle.

## Decisión
A4S usará un Asistente read-only de intake: releva ideas acotadas al Mission Control, recibe sus dudas y las transmite al operador; no crea ni modifica Beads, repositorios, sesiones o dispatches, no decide proyectos activos y falla cerrado ante cualquier solicitud fuera de intake.

## Alternativas descartadas
Mantener intake solo en MC: rechazado por pérdida de contexto; asistente con autoridad de Beads: rechazado por solapamiento de lifecycle; diferir por falta de sandbox: rechazado porque el contrato de proceso acotado reduce el riesgo.

## Consecuencias
Reduce pérdida de propuestas con una nueva sesión de bajo coste; la prohibición es de proceso, ya que Herdr no ofrece sandbox técnico read-only; el rol debe documentarse y auditarse.

## Pendientes
Verificar el comportamiento real y documentar el rol en SKILL.md mediante un Bead separado.
