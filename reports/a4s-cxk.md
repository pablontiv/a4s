# Evidencia — a4s-cxk: integración canónica de TypeSafe

**Veredicto:** PASS

## Decisión registrada

ADR 0020 (`.workspace/docs/adr/0020-canonizar-superficie-typesafe-en-paquete-a4s.md`) está en estado `accepted` y fija:

- `packages/typesafe` como paquete único `@a4s/typesafe`.
- Pin exacto de `@typesafe-ai/sdk` `0.6.0`.
- `createTypesafeClient` como factory única con cliente, base URL y modelo explícitos.
- Provider Pi credential-only `typesafe` y credencial desde `auth.json`, con fallback headless interno.
- Modelo fijo `jev-1.13.0` y fallo tipado `missing_key` sin red.
- Configuración de comportamiento en cada consumidor, sin archivo compartido adicional.

## Alcance y continuación

Los Beads hijos de PoC y migración permanecen como trabajo separado. Esta evidencia no declara migrado ningún consumidor ni modifica su comportamiento.

## Verificación

- `adr.sh list` muestra ADR 0020 como `accepted`.
- `rootline validate .workspace/docs/adr/0020-canonizar-superficie-typesafe-en-paquete-a4s.md -o json` devuelve un documento válido, sin errores ni warnings.
