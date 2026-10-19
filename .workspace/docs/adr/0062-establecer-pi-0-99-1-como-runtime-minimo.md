---
tipo: adr
estado: accepted
fecha: '2026-09-29'
contexto: 'Las extensiones A4S compilaban y cargaban con Pi 0.99.1, pero sus manifests, lockfile, fixtures y documentación activa todavía fijaban 0.87.0. Además, @a4s/typesafe instalaba pi-ai como dependencia de runtime aunque Pi lo proporciona al host, con riesgo de módulos duplicados.'
decision: 'Soportar Pi desde 0.99.1 inclusive. Los manifests expresan el mínimo como >=0.99.1 sólo en dependencias de desarrollo y lo verifican mediante contrato ejecutable; los paquetes proporcionados por Pi permanecen peerDependencies con rango * para que exista una sola instancia del runtime. El lockfile conserva la resolución reproducible y no define por sí mismo la política de soporte.'
alternativas: 'Conservar el pin exacto 0.87.0 se descarta porque rechaza un runtime compatible ya demostrado. Fijar exactamente 0.99.1 se descarta porque impediría adoptar releases posteriores compatibles. Usar >=0.99.1 también en peerDependencies se descarta porque contradice el contrato de paquetes host de Pi, que exige *. Usar sólo peers * sin un mínimo probado se descarta porque no declara ni verifica el baseline soportado.'
consecuencias: 'El desarrollo y CI conservan 0.99.1 como resolución mínima reproducible mientras los manifests admiten versiones posteriores. Cada actualización del lockfile debe mantener verdes el contrato de versión, typecheck, tests y E2E real. Las extensiones no pueden usar una API introducida después de 0.99.1 sin elevar el mínimo mediante otra decisión. pi-ai deja de instalarse como dependencia de runtime de @a4s/typesafe.'
pendientes: ''
---
# 0062. Establecer Pi 0.99.1 como runtime mínimo

## Contexto

Las extensiones A4S compilaban y cargaban con Pi 0.99.1, pero sus manifests, lockfile, fixtures y documentación activa todavía fijaban `0.87.0`. El contrato de prueba fallaba únicamente por dos comparaciones exactas de versión. Además, `@a4s/typesafe` instalaba `@earendil-works/pi-ai` como dependencia de runtime aunque Pi lo proporciona al host, con riesgo de cargar módulos duplicados.

Pi documenta que `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui` y `typebox` deben declararse como peers `"*"` y no empaquetarse dentro de extensiones.

## Decisión

A4S soporta Pi desde `0.99.1` inclusive.

- Las dependencias de desarrollo expresan `>=0.99.1`, no una versión exacta.
- Los paquetes proporcionados por Pi permanecen en `peerDependencies` con rango `"*"`, para que el proceso activo suministre una sola instancia del runtime.
- El contrato ejecutable acepta `0.99.1` y releases estables posteriores, rechaza releases anteriores y comprueba la versión realmente instalada.
- El lockfile conserva una resolución concreta para builds reproducibles; esa resolución no sustituye la política de soporte del manifest.
- Los registros históricos que documentaron el baseline 0.87 permanecen intactos.

## Alternativas descartadas

- **Conservar el pin exacto `0.87.0`.** Rechaza un runtime compatible ya demostrado y deja la instalación activa fuera del contrato declarado.
- **Fijar exactamente `0.99.1`.** Impediría adoptar releases posteriores compatibles sin una razón técnica.
- **Usar `>=0.99.1` también en peers.** Contradice el contrato de paquetes proporcionados por el host de Pi, que exige `"*"`.
- **Usar sólo peers `"*"`.** Evita duplicación, pero no declara ni prueba el baseline mínimo soportado.

## Consecuencias

El desarrollo y CI conservan `0.99.1` como resolución mínima reproducible mientras los manifests admiten versiones posteriores. Cada actualización del lockfile debe mantener verdes el contrato de versión, typecheck, tests y E2E real.

Las extensiones no pueden usar una API introducida después de `0.99.1` sin elevar el mínimo mediante otra decisión. `@earendil-works/pi-ai` deja de instalarse como dependencia de runtime de `@a4s/typesafe`.

## Pendientes

Ninguno.
