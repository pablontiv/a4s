---
tipo: adr
estado: accepted
fecha: '2026-09-29'
contexto: 'El cierre de tasks exigía sincronizar main, pero el cleanup sólo se ofrecía y cada eliminación requería autorización puntual. Eso dejó worktrees y branches fusionados, y confundió outputs brutos reproducibles con evidencia durable aunque el resultado sanitizado ya estaba registrado en PR y Bead.'
decision: 'Después de una integración verificada, el cleanup exacto de la task es obligatorio y queda preautorizado: eliminar outputs clasificados como reproducibles-desechables, worktree dedicado, branch local y branch remota que aún nombre el head integrado. Antes se exige evidencia durable sanitizada en el Bead, main sincronizado, identidades exactas, ausencia de cambios no integrados y ausencia de retención explícita. Cualquier unknown bloquea cleanup y cierre sin borrar; toda otra eliminación destructiva conserva autorización puntual.'
alternativas: 'Mantener autorización por cada cleanup se descarta porque conserva residuos ordinarios y fricción sin proteger mejor recursos ya integrados. Borrar incondicionalmente después de merge se descarta porque podría destruir cambios no integrados, evidencia retenida o una branch reutilizada. Versionar JSONL, respuestas de proveedor u otros outputs brutos se descarta por privacidad, tamaño y porque el resultado sanitizado ligado al SHA es la evidencia durable.'
consecuencias: 'Readiness clasifica outputs y recursos de cleanup; acceptance registra resultados sanitizados y pointers versionados; closure no termina hasta verificar ausencia de los recursos exactos. La autorización permanente no alcanza worktrees ambiguos, cambios no integrados, outputs retained ni cleanup ajeno a la task. Profile, template y tests reflejan la nueva regla.'
pendientes: ''
---
# 0063. Exigir cleanup post-merge de tasks

## Contexto

El cierre de tasks exigía sincronizar `main`, pero el cleanup sólo se ofrecía y cada eliminación requería autorización puntual. Eso dejó worktrees y branches fusionados. También confundió outputs brutos reproducibles con evidencia durable: el E2E de Context Expert ya tenía un resultado sanitizado ligado al SHA en el PR y Bead, mientras su JSONL ignorado mantenía vivo el worktree sin aportar una condición de aceptación adicional.

Un output reproducible no es desechable por el solo hecho de poder generarse otra vez. Se vuelve desechable cuando readiness lo clasificó así, acceptance registró el resultado durable necesario y ningún criterio exige retener el raw.

## Decisión

Después de una integración verificada, el cleanup exacto de la task es obligatorio y queda preautorizado.

Antes de borrar, el executor debe verificar:

1. el PR y su head exacto están integrados;
2. `main` está sincronizado y limpio;
3. el Bead conserva resultados sanitizados y links a artefactos versionados;
4. worktree, branch local y branch remota corresponden inequívocamente a esa task y head;
5. no existe cambio no integrado;
6. ningún output está marcado para retención.

Sólo entonces elimina:

- outputs clasificados en readiness como reproducibles-desechables;
- el worktree dedicado de la task;
- su branch local;
- su branch remota cuando todavía nombra el head integrado.

Si una identidad, clasificación o postcondición está `failed` o `unknown`, no borra nada y bloquea el cierre. Toda otra eliminación destructiva conserva autorización explícita por caso.

## Alternativas descartadas

- **Mantener autorización por cada cleanup.** Conserva residuos ordinarios y fricción sin proteger mejor recursos ya integrados y verificados.
- **Borrar incondicionalmente después de merge.** Podría destruir cambios no integrados, evidencia retenida o una branch reutilizada.
- **Versionar outputs brutos.** JSONL de sesión, respuestas de proveedor y artefactos equivalentes tienen riesgos de privacidad y tamaño; no sustituyen el resultado sanitizado ligado al SHA.
- **Conservar siempre el worktree como evidencia.** Confunde el entorno de ejecución con el registro durable y hace crecer estado local sin límite.

## Consecuencias

Readiness clasifica outputs y recursos de cleanup. Acceptance registra resultados sanitizados y pointers versionados. Closure no termina hasta verificar la ausencia de los recursos exactos.

La autorización permanente no alcanza worktrees ambiguos, cambios no integrados, outputs retained ni cleanup ajeno a la task. `PROFILE.md`, la plantilla reusable y los tests de contrato reflejan la nueva regla.

## Pendientes

Ninguno.
