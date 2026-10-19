---
tipo: adr
estado: accepted
fecha: '2026-09-22'
contexto: 'ADR 0022 accepted decide niveles durante session_before_compact y RuleSignals en la misma pasada, pero la spec aprobada exige que Ladder reciba una query posterior sobre el corpus sanitizado y que Evidence use su propia query.'
decision: 'Reemplazar la visibilidad anticipada de compaction por Ladder opt-in de retrieval por query: hide/short/long/full y spans se calculan desde CorpusChunk de la rama al proyectar context_with_system; short y long se renderizan determinísticamente; Evidence formula una query separada. basic conserva su contrato.'
alternativas: 'Mantener ADR 0022: descartado porque contradice la spec y hace la visibilidad dependiente de una query inexistente durante compaction. Bajar el estado de ADR 0022 sin sucesor: descartado porque deja Task 5 sin contrato aceptado.'
consecuencias: 'Ladder falla abierto al contexto Pi normal; la proyección no muta corpus y consume cuota Jev por query. Task 5 queda bloqueado hasta aceptación del sucesor.'
---
# 0029. Reemplazar ladder por retrieval query

Reemplaza a 0022-extender-compaction-a-visibility-ladder-de-cuatro-niveles.

## Contexto
ADR 0022 accepted decide niveles durante session_before_compact y RuleSignals en la misma pasada, pero la spec aprobada exige que Ladder reciba una query posterior sobre el corpus sanitizado y que Evidence use su propia query.

## Decisión
Reemplazar la visibilidad anticipada de compaction por Ladder opt-in de retrieval por query: hide/short/long/full y spans se calculan desde CorpusChunk de la rama al proyectar context_with_system; short y long se renderizan determinísticamente; Evidence formula una query separada. basic conserva su contrato.

## Alternativas descartadas
Mantener ADR 0022: descartado porque contradice la spec y hace la visibilidad dependiente de una query inexistente durante compaction. Bajar el estado de ADR 0022 sin sucesor: descartado porque deja Task 5 sin contrato aceptado.

## Consecuencias
Ladder falla abierto al contexto Pi normal; la proyección no muta corpus y consume cuota Jev por query. Task 5 queda bloqueado hasta aceptación del sucesor.
