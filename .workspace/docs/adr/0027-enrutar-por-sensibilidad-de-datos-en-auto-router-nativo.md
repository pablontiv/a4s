---
tipo: adr
estado: accepted
fecha: '2026-09-21'
contexto: 'ADR 0018 rutea solo por altitud y costo y no considera la sensibilidad de los datos, por lo que una tarea acotada sobre archivos con secrets puede enrutarse a proveedores economicos de bajo trust segun el paper seccion nueve y la Table IV; con el auto-router ingerido como codigo nativo por ADR 0026 la sensibilidad puede unificarse con costo y altitud en un solo motor.'
decision: 'A4S enruta por sensibilidad de datos como tercer eje sobre altitud y costo con una politica unica a4s-owned basada en Table IV con clases open standard restricted y custom; la clase se clasifica con el core Jev del decider de ADR 0023 como superficie de la Table I y gatea proveedores y modelos elegibles como piso duro que gana sobre la altitud cuando chocan, fallando cerrado a frontier de primera parte cuando la sensibilidad es incierta; se enforce en dos puntos con la misma politica, el dispatch herdr que extiende ADR 0018 y el routing intra-agente del auto-router nativo via excludeProviders, y cada ejecucion registra la clase de sensibilidad.'
alternativas: 'Rutear solo por altitud y costo status quo 0018: descartado por dejar fuga de datos a endpoints low-trust; un mecanismo de sensibilidad paralelo separado del auto-router: descartado por duplicar el motor de routing ya que la sensibilidad es el mismo tipo de decision que costo y va en excludeProviders; clasificar la sensibilidad con reglas estaticas: descartado a favor del core Jev que ya decide superficies tipadas de la Table I; enforcement solo intra-agente: descartado porque el dispatch precede al agente y debe gatear tambien.'
consecuencias: 'Depende de la ingesta del auto-router por ADR 0026 y su bead a4s-e02 para el enforcement intra-agente nativo; reusa el core Jev de ADR 0023 para la clasificacion; una tarea con secrets nunca se enruta a proveedores economicos de tercero; el dispatch herdr suma un gate de sensibilidad ademas de altitud; cada ejecucion loguea la clase de sensibilidad junto a kind ruta altitud y razon.'
pendientes: ""
---
# 0027. Enrutar por sensibilidad de datos en auto router nativo

## Contexto
ADR 0018 rutea solo por altitud y costo y no considera la sensibilidad de los datos, por lo que una tarea acotada sobre archivos con secrets puede enrutarse a proveedores economicos de bajo trust segun el paper seccion nueve y la Table IV; con el auto-router ingerido como codigo nativo por ADR 0026 la sensibilidad puede unificarse con costo y altitud en un solo motor.

## Decisión
A4S enruta por sensibilidad de datos como tercer eje sobre altitud y costo con una politica unica a4s-owned basada en Table IV con clases open standard restricted y custom; la clase se clasifica con el core Jev del decider de ADR 0023 como superficie de la Table I y gatea proveedores y modelos elegibles como piso duro que gana sobre la altitud cuando chocan, fallando cerrado a frontier de primera parte cuando la sensibilidad es incierta; se enforce en dos puntos con la misma politica, el dispatch herdr que extiende ADR 0018 y el routing intra-agente del auto-router nativo via excludeProviders, y cada ejecucion registra la clase de sensibilidad.

## Alternativas descartadas
Rutear solo por altitud y costo status quo 0018: descartado por dejar fuga de datos a endpoints low-trust; un mecanismo de sensibilidad paralelo separado del auto-router: descartado por duplicar el motor de routing ya que la sensibilidad es el mismo tipo de decision que costo y va en excludeProviders; clasificar la sensibilidad con reglas estaticas: descartado a favor del core Jev que ya decide superficies tipadas de la Table I; enforcement solo intra-agente: descartado porque el dispatch precede al agente y debe gatear tambien.

## Consecuencias
Depende de la ingesta del auto-router por ADR 0026 y su bead a4s-e02 para el enforcement intra-agente nativo; reusa el core Jev de ADR 0023 para la clasificacion; una tarea con secrets nunca se enruta a proveedores economicos de tercero; el dispatch herdr suma un gate de sensibilidad ademas de altitud; cada ejecucion loguea la clase de sensibilidad junto a kind ruta altitud y razon.

## Pendientes
Fuente de evidencia de que archivos toca la tarea por dispatch y por request; taxonomia exacta de proveedores por clase restricted y custom; umbral de confianza de la clasificacion Jev antes de fallar cerrado; interaccion con la telemetria-safety de redaccion ya existente en el auto-router.
