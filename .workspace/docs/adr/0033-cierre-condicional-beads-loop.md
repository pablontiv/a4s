---
tipo: adr
estado: accepted
fecha: '2026-09-22'
contexto: 'La revisión final detectó que bd close no ofrece precondiciones de propietario o estado, por lo que el cierre no puede preservar la propiedad del claim bajo concurrencia.'
decision: 'Antes de finalizar, exigir que el Bead exacto siga in_progress y asignado al actor actual; usar bd update condicional con --if-assignee y --if-status para closed o blocked, anexar evidencia PASS o FAIL y devolver claim_lost ante pérdida de propiedad o guard sin mutar.'
alternativas: 'Mantener bd close con chequeo previo: descartado porque conserva una ventana TOCTOU; mantener el contrato actual: descartado porque permite finalizar trabajo de otro actor; investigar un guard de bd close: descartado porque la ayuda instalada no lo ofrece.'
consecuencias: 'El adapter y sus pruebas validan propiedad in_progress antes de toda finalización, documentan la carrera y preservan evidencia en notas; sólo releen estado tras una mutación exitosa y el flujo deja de depender de bd close para pass.'
---
# 0033. Cierre condicional beads loop

Reemplaza a 0032-beads-loop-adapter.

## Contexto
La revisión final detectó que bd close no ofrece precondiciones de propietario o estado, por lo que el cierre no puede preservar la propiedad del claim bajo concurrencia.

## Decisión
Antes de finalizar, exigir que el Bead exacto siga `in_progress` y asignado al actor actual. Tanto `pass` como `fail` usan `bd update` con `--if-assignee` y `--if-status in_progress`: `pass` cambia a `closed` y anexa `PASS evidence=<ruta>`; `fail` cambia a `blocked` y anexa `FAIL evidence=<ruta>`. Una pérdida de propiedad o un guard condicional obsoleto devuelve `claim_lost` sin releer ni mutar.

## Alternativas descartadas
Mantener bd close con chequeo previo: descartado porque conserva una ventana TOCTOU; mantener el contrato actual: descartado porque permite finalizar trabajo de otro actor; investigar un guard de bd close: descartado porque la ayuda instalada no lo ofrece.

## Consecuencias
El adapter y sus pruebas validan propiedad `in_progress` antes de toda finalización, documentan la carrera y preservan evidencia en notas. El estado final sólo se relee después de una mutación exitosa y el flujo deja de depender de `bd close` para `pass`.
