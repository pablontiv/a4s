---
tipo: adr
estado: accepted
fecha: '2026-10-01'
contexto: 'Pi >=0.99.1 ya ofrece el provider TypeSafe, el catálogo classifier, la resolución de credenciales y ModelRegistry.classify; mantener @a4s/typesafe duplicaba autenticación y transporte, fijaba jev-1.13.0 y contradecía la selección automática aprobada para Context Expert.'
decision: 'Sustituir la decisión de ADR 0020 para Context Expert: resolver typesafe/jev-latest con el ModelRegistry nativo de Pi y ejecutar classify sin registrar ni implementar un provider propio; Pi posee catálogo, credencial, payload y transporte, mientras A4S conserva deadline, abort, scheduler, Retry-After, validación estricta y fallo cerrado; eliminar packages/typesafe y admitir jev-1.13.0 sólo al leer artefactos históricos.'
alternativas: 'Conservar @a4s/typesafe y el SDK directo: descartado por duplicar capacidades nativas y fijar un modelo obsoleto; usar fetch crudo: descartado por volver a poseer autenticación, payload y transporte; elevar el mínimo exclusivamente a Pi 1.0: descartado porque la superficie requerida ya existe en 0.99.1.'
consecuencias: 'Los nuevos requests y artefactos usan typesafe/jev-latest; Pi mantiene /login typesafe y TYPESAFE_API_KEY como fallback headless; el lockfile de desarrollo avanza a Pi 1.0.0 pero el mínimo soportado sigue en >=0.99.1; desaparecen @a4s/typesafe y @typesafe-ai/sdk; los artefactos jev-1.13.0 siguen legibles y nunca se ejecutan; el Pi global del operador no forma parte de esta decisión.'
---
# 0065. Usar clasificador typesafe nativo de pi

## Contexto
Pi >=0.99.1 ya ofrece el provider TypeSafe, el catálogo classifier, la resolución de credenciales y ModelRegistry.classify; mantener @a4s/typesafe duplicaba autenticación y transporte, fijaba jev-1.13.0 y contradecía la selección automática aprobada para Context Expert.

## Decisión
Sustituir la decisión de ADR 0020 para Context Expert: resolver typesafe/jev-latest con el ModelRegistry nativo de Pi y ejecutar classify sin registrar ni implementar un provider propio; Pi posee catálogo, credencial, payload y transporte, mientras A4S conserva deadline, abort, scheduler, Retry-After, validación estricta y fallo cerrado; eliminar packages/typesafe y admitir jev-1.13.0 sólo al leer artefactos históricos.

## Alternativas descartadas
Conservar @a4s/typesafe y el SDK directo: descartado por duplicar capacidades nativas y fijar un modelo obsoleto; usar fetch crudo: descartado por volver a poseer autenticación, payload y transporte; elevar el mínimo exclusivamente a Pi 1.0: descartado porque la superficie requerida ya existe en 0.99.1.

## Consecuencias
Los nuevos requests y artefactos usan typesafe/jev-latest; Pi mantiene /login typesafe y TYPESAFE_API_KEY como fallback headless; el lockfile de desarrollo avanza a Pi 1.0.0 pero el mínimo soportado sigue en >=0.99.1; desaparecen @a4s/typesafe y @typesafe-ai/sdk; los artefactos jev-1.13.0 siguen legibles y nunca se ejecutan; el Pi global del operador no forma parte de esta decisión.
