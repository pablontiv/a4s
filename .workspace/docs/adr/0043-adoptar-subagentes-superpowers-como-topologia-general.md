---
tipo: adr
estado: accepted
fecha: '2026-09-24'
contexto: 'A4S prohibió subagentes in-session por el coste observado de S4, pero el Operador decidió reemplazar globalmente la topología Herdr por una coordinación Superpowers acotada con implementadores y revisores especializados dentro de la sesión.'
decision: 'Adoptar subagentes Superpowers in-session como topología general: un controlador secuencia unidades, despacha implementadores y revisores frescos, prohíbe delegación recursiva y usa reportes por archivo; Herdr queda opcional y los ADR 0015 y 0019 aplican sólo cuando un flujo lo invoca explícitamente.'
alternativas: 'Limitar la excepción a Roadmap se descarta porque mantendría dos topologías generales; conservar Herdr como default se descarta por decisión explícita del Operador; permitir árboles recursivos de subagentes se descarta porque recrearía ownership difuso y reinyección de contexto.'
consecuencias: 'Las skills, contratos y pruebas deben migrar al controlador con subagentes; el coste se contiene con roles acotados, artefactos por puntero y ausencia de delegación anidada; los flujos Herdr explícitos conservan sus controles Beads y callbacks.'
---
# 0043. Adoptar subagentes superpowers como topologia general

Reemplaza a 0014-adoptar-topologia-de-dispatch-por-tabs-peer.

## Contexto
A4S prohibió subagentes in-session por el coste observado de S4, pero el Operador decidió reemplazar globalmente la topología Herdr por una coordinación Superpowers acotada con implementadores y revisores especializados dentro de la sesión.

## Decisión
Adoptar subagentes Superpowers in-session como topología general: un controlador secuencia unidades, despacha implementadores y revisores frescos, prohíbe delegación recursiva y usa reportes por archivo; Herdr queda opcional y los ADR 0015 y 0019 aplican sólo cuando un flujo lo invoca explícitamente.

## Alternativas descartadas
Limitar la excepción a Roadmap se descarta porque mantendría dos topologías generales; conservar Herdr como default se descarta por decisión explícita del Operador; permitir árboles recursivos de subagentes se descarta porque recrearía ownership difuso y reinyección de contexto.

## Consecuencias
Las skills, contratos y pruebas deben migrar al controlador con subagentes; el coste se contiene con roles acotados, artefactos por puntero y ausencia de delegación anidada; los flujos Herdr explícitos conservan sus controles Beads y callbacks.
