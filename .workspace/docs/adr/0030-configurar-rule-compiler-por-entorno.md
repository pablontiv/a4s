---
tipo: adr
estado: superseded
fecha: '2026-09-22'
contexto: 'La spec exige flags basic|ladder, pero el entrypoint Pi -e no recibe PiRuleCompilerOptions.config; Pi 0.87 no expone settings namespaced a extensiones y los valores de registerFlag llegan después de registro.'
decision: 'Configurar el entrypoint mediante variables no secretas y namespaced por proceso: A4S_PI_RULE_COMPILER_COMPACTION_STRATEGY, A4S_PI_RULE_COMPILER_TRIGGER_MODE y A4S_PI_RULE_COMPILER_EVIDENCE_STRATEGY. El entrypoint las proyecta al config flat existente y resolveCompactionConfig falla cerrado a basic. Los runners E2E fijan explícitamente los valores de cada ejecución.'
alternativas: 'Pi registerFlag: descartado por aplicar los valores después de cargar la extensión y requerir reestructurar handlers para lectura perezosa. settings.json global: descartado porque Pi no reserva configuración namespaced ni la expone a ExtensionContext. Bootstrap exclusivo de test: descartado porque no prueba el producto instalado.'
consecuencias: 'El entorno es aislado por proceso y coincide con el patrón E0, pero exige documentación y tests de precedencia; la configuración no contiene secretos y valores inválidos no habilitan opt-ins.'
superseded_by: 0031-configurar-rule-compiler-global
---
# 0030. Configurar rule compiler por entorno

## Contexto
La spec exige flags basic|ladder, pero el entrypoint Pi -e no recibe PiRuleCompilerOptions.config; Pi 0.87 no expone settings namespaced a extensiones y los valores de registerFlag llegan después de registro.

## Decisión
Configurar el entrypoint mediante variables no secretas y namespaced por proceso: A4S_PI_RULE_COMPILER_COMPACTION_STRATEGY, A4S_PI_RULE_COMPILER_TRIGGER_MODE y A4S_PI_RULE_COMPILER_EVIDENCE_STRATEGY. El entrypoint las proyecta al config flat existente y resolveCompactionConfig falla cerrado a basic. Los runners E2E fijan explícitamente los valores de cada ejecución.

## Alternativas descartadas
Pi registerFlag: descartado por aplicar los valores después de cargar la extensión y requerir reestructurar handlers para lectura perezosa. settings.json global: descartado porque Pi no reserva configuración namespaced ni la expone a ExtensionContext. Bootstrap exclusivo de test: descartado porque no prueba el producto instalado.

## Consecuencias
El entorno es aislado por proceso y coincide con el patrón E0, pero exige documentación y tests de precedencia; la configuración no contiene secretos y valores inválidos no habilitan opt-ins.
