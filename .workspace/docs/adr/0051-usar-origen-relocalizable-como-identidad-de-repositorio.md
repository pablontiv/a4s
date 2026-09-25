---
tipo: adr
estado: superseded
fecha: '2026-09-25'
contexto: 'El perfil v2 exige una ruta física canónica y la instancia dogfood conserva repo.path en unknown; una configuración versionada o pública no debe persistir rutas locales de una máquina y Roadmap no puede verificar identidad sin un locator portable.'
decision: 'Configurar repo.path con el locator del repositorio de origen; descubrir el checkout local en runtime; verificar que git remote get-url origin corresponde al locator configurado; y registrar verified_revision como la revisión observada del origen, sin persistir la ruta física local.'
alternativas: 'Persistir la ruta local se descarta por no ser portable y exponer información de la máquina; usar sólo repo.id se descarta porque no verifica el remoto efectivo; inferir origin sin autoridad configurada se descarta porque rompe el fallo cerrado.'
consecuencias: 'El perfil, bootstrap, plantilla e instancia dogfood usan identidad relocatable; aliases y worktrees se validan contra el mismo origen; una discrepancia de origin o revisión queda unknown y bloquea mutación.'
superseded_by: 0053-aclarar-revision-observada-en-identidad-relocalizable
---
# 0051. Usar origen relocalizable como identidad de repositorio

## Contexto
El perfil v2 exige una ruta física canónica y la instancia dogfood conserva repo.path en unknown; una configuración versionada o pública no debe persistir rutas locales de una máquina y Roadmap no puede verificar identidad sin un locator portable.

## Decisión
Configurar repo.path con el locator del repositorio de origen; descubrir el checkout local en runtime; verificar que git remote get-url origin corresponde al locator configurado; y registrar verified_revision como la revisión observada del origen, sin persistir la ruta física local.

## Alternativas descartadas
Persistir la ruta local se descarta por no ser portable y exponer información de la máquina; usar sólo repo.id se descarta porque no verifica el remoto efectivo; inferir origin sin autoridad configurada se descarta porque rompe el fallo cerrado.

## Consecuencias
El perfil, bootstrap, plantilla e instancia dogfood usan identidad relocatable; aliases y worktrees se validan contra el mismo origen; una discrepancia de origin o revisión queda unknown y bloquea mutación.
