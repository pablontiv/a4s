---
tipo: adr
estado: superseded
fecha: '2026-09-24'
contexto: 'Pi aplicaba a todos los repositorios un AGENTS.md global que contenía únicamente el informe de entrega del Bead par-6li de pi-auto-router.'
decision: 'Archivar una copia byte-idéntica en el historial de A4S y retirar el archivo global, preservando APPEND_SYSTEM, settings, extensiones y skills compartidos.'
alternativas: 'Mantener el AGENTS.md específico en el directorio global: descartado porque inyecta contexto ajeno en todos los proyectos; retirar también APPEND_SYSTEM o settings: descartado porque contienen steering y runtime compartidos.'
consecuencias: 'El contexto específico deja de cargarse globalmente; el archivo queda recuperable con su SHA-256; una sesión Pi ya iniciada requiere reload o reinicio explícito para observar el cambio.'
superseded_by: 0042-mantener-append-system-global-ausente
---
# 0037. Retirar agents global ajeno

## Contexto
Pi aplicaba a todos los repositorios un AGENTS.md global que contenía únicamente el informe de entrega del Bead par-6li de pi-auto-router.

## Decisión
Archivar una copia byte-idéntica en el historial de A4S y retirar el archivo global, preservando APPEND_SYSTEM, settings, extensiones y skills compartidos.

## Alternativas descartadas
Mantener el AGENTS.md específico en el directorio global: descartado porque inyecta contexto ajeno en todos los proyectos; retirar también APPEND_SYSTEM o settings: descartado porque contienen steering y runtime compartidos.

## Consecuencias
El contexto específico deja de cargarse globalmente; el archivo queda recuperable con su SHA-256; una sesión Pi ya iniciada requiere reload o reinicio explícito para observar el cambio.
