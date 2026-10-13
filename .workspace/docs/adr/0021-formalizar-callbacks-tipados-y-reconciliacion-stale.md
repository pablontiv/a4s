---
tipo: adr
estado: proposed
fecha: '2026-09-19'
contexto: 'Tras integrar docs/dispatch-topology (ADR 0019) y validar el PoC nativo de callbacks tipados (a4s-ya4.2), falta una decisión que fije el contrato de completion y trate stale como observación del reconciler sin crear un segundo control plane.'
decision: 'Completion se señala exclusivamente por callback tipado por puntero WORK_RESULT SUBMITTED o ATTENTION REQUIRED con bead_id, verdict y artifact_path; el DONE binario queda prohibido; stale es observación derivada del reconciler o AttentionTicket STALE_WORK, nunca estado de Mission ni outcome; el heartbeat prueba liveness y no dispara retry ni poll; la implementación queda bloqueada por el PoC nativo y por una decisión explícita de scheduler.'
alternativas: 'Tratar stale como estado de Mission: descartado por drift y segunda autoridad de lifecycle; reconciler que reintenta o sondea: descartado por contradecir ADR 0015; añadir inbox o cola propia ahora: descartado por ADR 0009; re-especificar el lifecycle de AttentionTicket o WorkResult: descartado por duplicar la autoridad del ACR de la spec v0.9.'
consecuencias: 'El callback tipado por puntero (ADR 0015) es el único contrato de completion; spec y skill referencian esta decisión sin re-especificar lifecycle; la implementación del reconciler permanece bloqueada hasta cerrar el PoC y decidir el scheduler.'
pendientes: 'Cerrar a4s-ya4.2; decisión explícita sobre scheduler o ACR antes de implementar; mapeo durable Bead-WorkResult-Mission conforme a ADR 0019.'
---
# 0021. Formalizar callbacks tipados y reconciliacion stale

## Contexto
Tras integrar docs/dispatch-topology (ADR 0019) y validar el PoC nativo de callbacks tipados (a4s-ya4.2), falta una decisión que fije el contrato de completion y trate stale como observación del reconciler sin crear un segundo control plane.

## Decisión
Completion se señala exclusivamente por callback tipado por puntero WORK_RESULT SUBMITTED o ATTENTION REQUIRED con bead_id, verdict y artifact_path; el DONE binario queda prohibido; stale es observación derivada del reconciler o AttentionTicket STALE_WORK, nunca estado de Mission ni outcome; el heartbeat prueba liveness y no dispara retry ni poll; la implementación queda bloqueada por el PoC nativo y por una decisión explícita de scheduler.

## Alternativas descartadas
Tratar stale como estado de Mission: descartado por drift y segunda autoridad de lifecycle; reconciler que reintenta o sondea: descartado por contradecir ADR 0015; añadir inbox o cola propia ahora: descartado por ADR 0009; re-especificar el lifecycle de AttentionTicket o WorkResult: descartado por duplicar la autoridad del ACR de la spec v0.9.

## Consecuencias
El callback tipado por puntero (ADR 0015) es el único contrato de completion; spec y skill referencian esta decisión sin re-especificar lifecycle; la implementación del reconciler permanece bloqueada hasta cerrar el PoC y decidir el scheduler.

## Pendientes
Cerrar a4s-ya4.2; decisión explícita sobre scheduler o ACR antes de implementar; mapeo durable Bead-WorkResult-Mission conforme a ADR 0019.
