---
tipo: adr
estado: accepted
fecha: '2026-09-01'
contexto: 'La auditoría de pi-intercom confirmó IPC multiplataforma y turn triggering, pero su API pública comunica sesiones y extensiones Pi y no admite a4sd como daemon externo sin imports internos, gateways o cambios upstream.'
decision: 'A4S conservará a4sd como autoridad externa y construirá un IPC propio mínimo para el adapter Pi; pi-intercom se utilizará como referencia empírica, no como dependencia de transporte.'
alternativas: 'Adoptar pi-intercom mediante imports internos, gateway o cambio upstream: descartado porque no funciona as-is; sustituir a4sd por otra sesión Pi: descartado porque cambia la hipótesis y el ownership del control plane.'
consecuencias: 'E0 verificará únicamente el IPC requerido por a4sd y la extensión Pi. El diseño podrá reutilizar patrones demostrados por pi-intercom sin acoplarse a su protocolo privado.'
---
# 0004. Construir ipc a4s con a4sd externo

Reemplaza a 0003-adoptar-pi-intercom-como-sustrato-de-e0.

## Contexto

La auditoría de pi-intercom confirmó IPC multiplataforma y turn triggering, pero su API pública comunica sesiones y extensiones Pi y no admite a4sd como daemon externo sin imports internos, gateways o cambios upstream.

## Decisión

A4S conservará a4sd como autoridad externa y construirá un IPC propio mínimo para el adapter Pi; pi-intercom se utilizará como referencia empírica, no como dependencia de transporte.

## Alternativas descartadas

Adoptar pi-intercom mediante imports internos, gateway o cambio upstream: descartado porque no funciona as-is; sustituir a4sd por otra sesión Pi: descartado porque cambia la hipótesis y el ownership del control plane.

## Consecuencias

E0 verificará únicamente el IPC requerido por a4sd y la extensión Pi. El diseño podrá reutilizar patrones demostrados por pi-intercom sin acoplarse a su protocolo privado.
