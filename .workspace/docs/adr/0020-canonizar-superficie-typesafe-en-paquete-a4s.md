---
tipo: adr
estado: proposed
fecha: '2026-09-19'
contexto: 'Tres extensiones Pi integran TypeSafe/Jev de forma independiente: packages/pi-rule-compiler usa fetch crudo contra /v1/systemone con modelo fijado jev-1.13.0 y credencial /login typesafe con override por env; vendor/rpiv-mono usa @typesafe-ai/sdk 0.6.0 con modelo móvil jev-latest y sólo TYPESAFE_API_KEY; vendor/pi-auto-router sólo define un seam JevTransport inyectado sin cliente ni credencial. La precedencia de credencial de rule-compiler (env sobre auth.json) contradice el orden de Pi (auth.json sobre env).'
decision: 'La superficie canónica es un único paquete A4S, packages/typesafe (@a4s/typesafe): pin exacto de @typesafe-ai/sdk 0.6.0; factory createTypesafeClient que construye TypeSafeClient con apiKey, baseURL y defaultModel explícitos, nunca el fallback de env del SDK; provider Pi credential-only typesafe registrado desde el paquete; resolución única de credencial por ctx.modelRegistry.getProviderAuth("typesafe") sobre auth.json (0600) con TYPESAFE_API_KEY sólo como override headless dentro de ese resolver y con precedencia auth.json primero, como Pi; modelo fijado jev-1.13.0 como constante del paquete, sin alias móviles; clave ausente o vacía lanza error tipado missing_key antes de cualquier red y cada consumidor conserva su política de fallo.'
alternativas: 'Sólo env TYPESAFE_API_KEY: descartado porque el SDK lo lee solo, invita a cada extensión a raspar env, no da login ni rotación, un valor global de launchctl enmascara /login y no tiene permisos 0600; sólo provider auth.json sin paquete: descartado porque resuelve credencial pero deja tres clientes, modelos y semánticas de fallo divergentes; paquete compartido sin auth.json: descartado porque necesita igualmente una fuente de credencial y reintroduce env por consumidor; mantener clientes por repo: descartado por ser el drift que originó el epic a4s-cxk; archivo de config compartido: descartado por añadir una capa sin necesidad, ya que la credencial vive en Pi y la config de comportamiento en cada consumidor.'
consecuencias: 'rule-compiler migra primero por ser dueño del código y tener la única evidencia PoC y live, luego rpiv-mono, y pi-auto-router sólo cuando active un transport vivo, ya que hoy no tiene llamadas SDK ni de credencial que migrar; migrar rule-compiler de fetch crudo al SDK exige verificar con fetch inyectado que la respuesta cumple el validador estricto y que los reintentos del SDK caben en hookTimeoutMs; invertir la precedencia a auth.json primero cambia comportamiento observable y debe ir en el mismo cambio; el default jev-latest de rpiv-mono debe rechazarse en rutas de producción; ninguna migración se declara hecha hasta cerrar sus Beads hijos con evidencia.'
pendientes: 'Mecanismo de distribución hacia forks vendor (npm privado o tarball vs. peer dependency opcional con caída a la UI humana en rpiv-mono); comportamiento de registerProvider cuando varias extensiones registran la misma definición typesafe; compatibilidad de la respuesta del SDK con el validador estricto de rule-compiler; Pi 0.85.1 del PoC frente al pin 0.84.4 del workspace.'
---
# 0020. Canonizar superficie typesafe en paquete a4s

## Contexto
Tres extensiones Pi integran TypeSafe/Jev de forma independiente (inventario read-only, 2026-09-19):

| Consumidor | Cliente | Credencial | Modelo | Fallo sin clave |
|---|---|---|---|---|
| `packages/pi-rule-compiler` | `fetch` crudo a `https://api.typesafe.ai/v1/systemone` (`src/jev.ts`) | `/login typesafe` vía `getProviderAuth`; env `TYPESAFE_API_KEY` gana sobre auth.json (`src/extension.ts`) | `jev-1.13.0` fijo (`src/types.ts`) | `missing_key`, compaction cancelada (ADR 0013) |
| `vendor/rpiv-mono` (`rpiv-ask-user-question`) | `@typesafe-ai/sdk` `^0.6.0`, `new TypeSafeClient({ defaultModel })` (`jev-auto-answer.ts`) | sólo `TYPESAFE_API_KEY` por fallback del SDK | `jev-latest` móvil (`config.ts`) | cae a la UI humana |
| `vendor/pi-auto-router` | ninguno: seam `JevTransport` inyectado, `NoopJevTransport` por defecto (`src/jev-adapter/`) | ninguna | n/a | fallback a clasificador local |

Evidencia adicional: el SDK 0.6.0 (`latest` en npm) acepta `apiKey`, `baseURL`, `defaultModel` y `fetch` explícitos y sólo recurre a `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL` cuando faltan; el PoC a4s-6ak.1 probó un provider credential-only sin modelos, `auth.json` 0600, resolución en proceso fresco y fallo cerrado sin credencial; la documentación de Pi fija el orden auth.json antes que variable de entorno.

## Decisión
La superficie canónica es un único paquete A4S, `packages/typesafe` (`@a4s/typesafe`), con estas partes congeladas:

1. **SDK**: `@typesafe-ai/sdk` con pin exacto `0.6.0`.
2. **Factory**: `createTypesafeClient({ apiKey, model?, fetch? })` construye `TypeSafeClient` con `apiKey`, `baseURL` y `defaultModel` explícitos; ningún consumidor instancia el SDK directamente ni depende de su fallback de env.
3. **Credencial**: provider Pi credential-only `typesafe` (sin modelos, sin oauth) registrado desde el paquete; resolución única con `ctx.modelRegistry.getProviderAuth("typesafe")` sobre `auth.json`. `TYPESAFE_API_KEY` sólo actúa como override headless dentro de ese resolver, con precedencia auth.json primero como en Pi; ninguna extensión lee env por su cuenta.
4. **Modelo**: `jev-1.13.0` como constante del paquete. Un override por consumidor debe ser un id exacto; alias móviles como `jev-latest` se rechazan en rutas de producción.
5. **Fallo cerrado**: clave ausente o vacía lanza error tipado `missing_key` antes de cualquier llamada de red, sin clave por defecto ni fallback. El paquete no decide qué hacer tras el fallo: cada consumidor conserva su política (compaction cancela, auto-answer cae a la UI humana, router usa el clasificador local).
6. **Config**: sin archivo compartido; la credencial vive en Pi y la configuración de comportamiento (`jev.*`, `jevAdvisor`) sigue en cada consumidor.

## Alternativas descartadas
- **Sólo env**: el SDK lo lee solo, lo que invita a cada extensión a raspar env; no da login ni rotación; un valor global de `launchctl setenv` enmascara `/login`; sin permisos 0600.
- **Sólo provider auth.json, sin paquete**: resuelve credencial pero deja tres clientes, modelos y semánticas de fallo divergentes.
- **Paquete sin auth.json**: necesita igualmente una fuente de credencial y reintroduce env por consumidor.
- **Clientes por repo (status quo)**: es el drift que originó el epic a4s-cxk.
- **Archivo de config compartido**: capa adicional sin necesidad (AGENTS.md, Simplicity).

## Consecuencias
- Orden de migración: rule-compiler primero (dueño del código, con evidencia PoC y live), luego rpiv-mono, y pi-auto-router sólo cuando active un transport vivo, con un adaptador `typesafe/jev` sobre el cliente canónico; hoy no tiene llamadas SDK ni de credencial que migrar. Esto difiere del orden auto-router, rule-compiler, rpiv de la secuencia original del epic.
- Migrar rule-compiler de `fetch` crudo al SDK exige verificar con `fetch` inyectado que la respuesta cumple `validateJevResponse` y que los reintentos del SDK caben en `hookTimeoutMs`.
- Invertir la precedencia a auth.json primero cambia comportamiento observable de rule-compiler y va en el mismo cambio.
- El default `jev-latest` de rpiv-mono debe reemplazarse por el pin.
- Los forks vendor son providers integrados: el paquete no se acopla a ellos y rpiv-mono debe degradar a la UI humana si el paquete no está presente.
- Ninguna migración se declara hecha hasta cerrar sus Beads hijos con evidencia; este ADR no migra código.

## Pendientes
- Mecanismo de distribución hacia forks vendor: npm privado o tarball, o peer dependency opcional con caída a la UI humana en rpiv-mono.
- Comportamiento de `pi.registerProvider` cuando varias extensiones registran la misma definición `typesafe` (la documentación dice "register or override"; sin verificar empíricamente).
- Compatibilidad de la respuesta del SDK con el validador estricto de rule-compiler.
- El PoC corrió con Pi 0.85.1 y el workspace fija 0.84.4.
