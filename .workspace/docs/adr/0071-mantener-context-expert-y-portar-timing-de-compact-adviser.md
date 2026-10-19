---
tipo: adr
estado: accepted
fecha: '2026-10-06'
contexto: 'Existen componentes upstream para compactación Jev: zaycruz/fast-jev-compaction-pi y tamaratran/fast-jev-compaction. El operador decidió mantener context-expert en lugar de migrar a upstream por dos criterios decisivos: (a) compactación automática mediante tiempo y ratio, (b) login nativo de Jev con API key en env sólo como fallback. Los componentes upstream requieren TYPESAFE_API_KEY en env como credencial obligatoria y no soportan login nativo; context-expert usa el proveedor nativo de Pi. La automatización por tiempo y ratio ya no es diferenciador porque los upstreams también la implementan; los diferenciadores reales son credencial nativa-primero y contratos (coverage, redacción, provenance, lifecycle).'
decision: 'Conservar context-expert como implementación de autoridad Jev en lugar de adoptar upstreams; portar el timing de compact-adviser para control automático por tiempo+ratio mediante dos preguntas done/shape, score, floor adaptativo 0.90→0.50, y TriggerState con conversación recortada; implementar credencial nativa-primero con env como fallback; aplicar fail-open con fallback a compactación nativa según ADR 0070.'
alternativas: 'Adoptar fast-jev-compaction o fast-jev-compaction-pi directamente: descartado porque sus contratos de cobertura, redacción, provenance y lifecycle no coinciden y la credencial obligatoria en env no satisface el criterio (b); implementar solo timing upstream: descartado porque separa autoridad de decisión; migrar timing y credencial locales a upstream: descartado por duplicación de esfuerzo si los contratos divergen.'
consecuencias: 'context-expert sigue siendo el propietario local de autoridad Jev, cobertura de decisiones y provisioning de credenciales nativas; el port de timing de compact-adviser introduce dependencia de ese repositorio como referencia de diseño; el equipo mantiene dos implementaciones de timing paralelas (compact-adviser upstream, context-expert local) con riesgo de divergencia; credencial nativa-primero requiere que cada sesión de usuario disponga de acceso Jev por defecto o el fallback a nativo se activa.'
pendientes: 'Cotejear especificación de timing (done/shape, score, floor adaptativo) en kunchenguid/compact-adviser; cotejear selección de autoridad (coverage y criterios de redacción) en fast-jev-compaction(-pi); implementar port de timing con métricas para comparación con upstream; establecer proceso de convergencia con upstreams si context-expert y fast-jev-compaction convergen en comportamiento.'
superseded_by: ''
---
# 0071. Mantener context-expert y portar timing de compact-adviser

Reemplaza a 0045-adoptar-pi-context-expert.

## Contexto
Existen componentes upstream para compactación Jev: zaycruz/fast-jev-compaction-pi y tamaratran/fast-jev-compaction. El operador decidió mantener context-expert en lugar de migrar a upstream por dos criterios decisivos: (a) compactación automática mediante tiempo y ratio, (b) login nativo de Jev con API key en env sólo como fallback. Los componentes upstream requieren TYPESAFE_API_KEY en env como credencial obligatoria y no soportan login nativo; context-expert usa el proveedor nativo de Pi. La automatización por tiempo y ratio ya no es diferenciador porque los upstreams también la implementan; los diferenciadores reales son credencial nativa-primero y contratos (coverage, redacción, provenance, lifecycle).

## Decisión
Conservar context-expert como implementación de autoridad Jev en lugar de adoptar upstreams; portar el timing de compact-adviser para control automático por tiempo+ratio mediante dos preguntas done/shape, score, floor adaptativo 0.90→0.50, y TriggerState con conversación recortada; implementar credencial nativa-primero con env como fallback; aplicar fail-open con fallback a compactación nativa según ADR 0070.

## Alternativas descartadas
Adoptar fast-jev-compaction o fast-jev-compaction-pi directamente: descartado porque sus contratos de cobertura, redacción, provenance y lifecycle no coinciden y la credencial obligatoria en env no satisface el criterio (b); implementar solo timing upstream: descartado porque separa autoridad de decisión; migrar timing y credencial locales a upstream: descartado por duplicación de esfuerzo si los contratos divergen.

## Consecuencias
context-expert sigue siendo el propietario local de autoridad Jev, cobertura de decisiones y provisioning de credenciales nativas; el port de timing de compact-adviser introduce dependencia de ese repositorio como referencia de diseño; el equipo mantiene dos implementaciones de timing paralelas (compact-adviser upstream, context-expert local) con riesgo de divergencia; credencial nativa-primero requiere que cada sesión de usuario disponga de acceso Jev por defecto o el fallback a nativo se activa.

## Pendientes
Cotejear especificación de timing (done/shape, score, floor adaptativo) en kunchenguid/compact-adviser; cotejear selección de autoridad (coverage y criterios de redacción) en fast-jev-compaction(-pi); implementar port de timing con métricas para comparación con upstream; establecer proceso de convergencia con upstreams si context-expert y fast-jev-compaction convergen en comportamiento.
