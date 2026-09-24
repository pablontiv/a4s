---
tipo: adr
estado: accepted
fecha: '2026-09-24'
contexto: 'El runtime global de Pi cargaba pi-auto-router y los hooks autodescubiertos herdr-agent-state y moshi-hooks en cada sesión, aunque el operador pidió conservar solo steering compartido explícito.'
decision: 'Filtrar las extensiones del package pi-auto-router, retirar los dos hooks autodescubiertos y preservar copias byte-idénticas recuperables en el historial de A4S.'
alternativas: 'Desregistrar solo las rutas explícitas de pi-auto-router: descartado porque su manifest vuelve a cargar ambas extensiones; borrar sus archivos vendor: descartado porque el objetivo es retirar su carga global; conservar los hooks: descartado por instrucción explícita del operador.'
consecuencias: 'Las nuevas sesiones no cargarán esas extensiones; el package source queda instalado sin extensiones y los hooks se recuperan desde el historial por SHA-256.'
---
# 0038. Retirar extensiones globales

## Contexto
El runtime global de Pi cargaba pi-auto-router y los hooks autodescubiertos herdr-agent-state y moshi-hooks en cada sesión, aunque el operador pidió conservar solo steering compartido explícito.

## Decisión
Filtrar las extensiones del package pi-auto-router, retirar los dos hooks autodescubiertos y preservar copias byte-idénticas recuperables en el historial de A4S.

## Alternativas descartadas
Desregistrar solo las rutas explícitas de pi-auto-router: descartado porque su manifest vuelve a cargar ambas extensiones; borrar sus archivos vendor: descartado porque el objetivo es retirar su carga global; conservar los hooks: descartado por instrucción explícita del operador.

## Consecuencias
Las nuevas sesiones no cargarán esas extensiones; el package source queda instalado sin extensiones y los hooks se recuperan desde el historial por SHA-256.
