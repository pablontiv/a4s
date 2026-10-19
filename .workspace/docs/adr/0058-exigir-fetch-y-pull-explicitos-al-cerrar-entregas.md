---
tipo: adr
estado: accepted
fecha: '2026-09-25'
contexto: 'Un merge remoto actualiza origin/main pero no el checkout estable local; el texto anterior pedía pull sin exigir un fetch explícito ni una segunda actualización de la referencia remota antes de declarar cierre.'
decision: 'Exigir antes de trabajo mutante y al cerrar cada entrega la secuencia explícita git fetch origin main y git pull --ff-only origin main en el checkout estable de main; después de publicar commits locales, repetir git fetch origin main y cerrar sólo si git rev-parse main coincide con git rev-parse origin/main y git status --porcelain está vacío; cualquier fallo, conflicto, rama incorrecta o divergencia detiene el cierre.'
alternativas: 'Pull sin fetch explícito: descartado porque oculta la actualización de la referencia remota; comparación read-only: descartada porque detecta drift pero no activa el checkout estable; validar sólo GitHub: descartado porque el skill activo se sirve desde el checkout local.'
consecuencias: 'El cierre incorpora dos fetch explícitos y un pull fast-forward-only, añade una comprobación ejecutable al contrato del repositorio y puede detener entregas cuando el checkout estable no sea reconciliable sin intervención.'
---
# 0058. Exigir fetch y pull explicitos al cerrar entregas

## Contexto
Un merge remoto actualiza origin/main pero no el checkout estable local; el texto anterior pedía pull sin exigir un fetch explícito ni una segunda actualización de la referencia remota antes de declarar cierre.

## Decisión
Exigir antes de trabajo mutante y al cerrar cada entrega la secuencia explícita git fetch origin main y git pull --ff-only origin main en el checkout estable de main; después de publicar commits locales, repetir git fetch origin main y cerrar sólo si git rev-parse main coincide con git rev-parse origin/main y git status --porcelain está vacío; cualquier fallo, conflicto, rama incorrecta o divergencia detiene el cierre.

## Alternativas descartadas
Pull sin fetch explícito: descartado porque oculta la actualización de la referencia remota; comparación read-only: descartada porque detecta drift pero no activa el checkout estable; validar sólo GitHub: descartado porque el skill activo se sirve desde el checkout local.

## Consecuencias
El cierre incorpora dos fetch explícitos y un pull fast-forward-only, añade una comprobación ejecutable al contrato del repositorio y puede detener entregas cuando el checkout estable no sea reconciliable sin intervención.
