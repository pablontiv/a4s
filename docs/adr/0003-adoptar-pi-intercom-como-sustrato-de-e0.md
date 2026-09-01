---
tipo: adr
estado: superseded
fecha: '2026-09-01'
contexto: 'E0 iba a comparar e implementar transportes locales, pero pi-intercom ya resuelve IPC multiplataforma, framing, reconnect, deduplicación, receipts y turn triggering para sesiones Pi.'
decision: 'E0 evaluará la adopción de pi-intercom como sustrato del adapter Pi y no construirá ni comparará transportes alternativos.'
alternativas: 'Comparar Unix socket, HTTP más SSE y WebSocket: descartado por duplicar infraestructura existente; usar RPC Pi: descartado porque elimina la TUI interactiva alojada en Herdr; embeber Pi mediante SDK: descartado porque cambia el ownership del runtime.'
consecuencias: 'El experimento se concentra en conectar a4sd como autoridad externa, mapear Deliveries al extension bus y verificar las garantías faltantes. La durabilidad seguirá perteneciendo a A4S, no al broker de pi-intercom.'
superseded_by: 0004-construir-ipc-a4s-con-a4sd-externo
---
# 0003. Adoptar pi intercom como sustrato de e0

## Contexto

E0 iba a comparar e implementar transportes locales, pero pi-intercom ya resuelve IPC multiplataforma, framing, reconnect, deduplicación, receipts y turn triggering para sesiones Pi.

## Decisión

E0 evaluará la adopción de pi-intercom como sustrato del adapter Pi y no construirá ni comparará transportes alternativos.

## Alternativas descartadas

Comparar Unix socket, HTTP más SSE y WebSocket: descartado por duplicar infraestructura existente; usar RPC Pi: descartado porque elimina la TUI interactiva alojada en Herdr; embeber Pi mediante SDK: descartado porque cambia el ownership del runtime.

## Consecuencias

El experimento se concentra en conectar a4sd como autoridad externa, mapear Deliveries al extension bus y verificar las garantías faltantes. La durabilidad seguirá perteneciendo a A4S, no al broker de pi-intercom.
