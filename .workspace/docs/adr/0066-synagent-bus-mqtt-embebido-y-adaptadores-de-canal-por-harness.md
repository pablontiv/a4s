---
tipo: adr
estado: proposed
fecha: '2026-10-04'
contexto: 'Agentes de distintos harnesses (Claude, Pi) necesitan enviar y recibir mensajes por una mensajería aislada que no vive dentro del harness y sin que un agente conozca al otro; se requiere pub/sub con push y una base embebida local, sin Docker ni manejador de base de datos instalado, priorizando un solo lenguaje.'
decision: 'Adoptar synagent: un bus con broker MQTT embebido (aedes, Node) y persistencia LevelDB como backbone distribuible, mas un adaptador de canal por harness que solo traduce entre el contrato canonico y el API nativo, empezando por el adaptador de Claude como plugin; todo el stack en TypeScript/Node.'
alternativas: 'MCP, A2A y ACP son interfaces de acceso y no brokers durables; libSQL/Turso es almacenamiento sin pub/sub ni realtime nativo; los brokers en Go, Rust o C (mochi-mqtt, mercure, honker, nanomq) se descartan por el objetivo de un solo lenguaje; la mensajeria dentro del harness o la nativa Claude-a-Claude es efimera y acopla agentes; un bus propio desde cero es coste innecesario frente a MQTT estandar.'
consecuencias: 'Entrega pub/sub con push real (QoS, retained, sesiones persistentes) sin dependencias pesadas; la durabilidad, el orden y el ACK semantico son responsabilidad del bus y no del adaptador; requiere Node en el host porque el broker y los bridges son procesos que el adaptador lanza; MQTT no ofrece replay historico tipo log, que queda como evolucion aditiva (log sink y luego event sourcing); agregar un harness nuevo es escribir un adaptador nuevo sin tocar el bus.'
pendientes: 'ACK semantico fenceado y la semantica exacta de retencion y orden exigidas por el spec; el adaptador de Pi; las fases aditivas de log sink y event sourcing; el RPC o protocolo de entrada de Pi.'
---
# 0066. Synagent bus mqtt embebido y adaptadores de canal por harness

## Contexto
Agentes de distintos harnesses (Claude, Pi) necesitan enviar y recibir mensajes por una mensajería aislada que no vive dentro del harness y sin que un agente conozca al otro; se requiere pub/sub con push y una base embebida local, sin Docker ni manejador de base de datos instalado, priorizando un solo lenguaje.

## Decisión
Adoptar synagent: un bus con broker MQTT embebido (aedes, Node) y persistencia LevelDB como backbone distribuible, mas un adaptador de canal por harness que solo traduce entre el contrato canonico y el API nativo, empezando por el adaptador de Claude como plugin; todo el stack en TypeScript/Node.

## Alternativas descartadas
MCP, A2A y ACP son interfaces de acceso y no brokers durables; libSQL/Turso es almacenamiento sin pub/sub ni realtime nativo; los brokers en Go, Rust o C (mochi-mqtt, mercure, honker, nanomq) se descartan por el objetivo de un solo lenguaje; la mensajeria dentro del harness o la nativa Claude-a-Claude es efimera y acopla agentes; un bus propio desde cero es coste innecesario frente a MQTT estandar.

## Consecuencias
Entrega pub/sub con push real (QoS, retained, sesiones persistentes) sin dependencias pesadas; la durabilidad, el orden y el ACK semantico son responsabilidad del bus y no del adaptador; requiere Node en el host porque el broker y los bridges son procesos que el adaptador lanza; MQTT no ofrece replay historico tipo log, que queda como evolucion aditiva (log sink y luego event sourcing); agregar un harness nuevo es escribir un adaptador nuevo sin tocar el bus.

## Pendientes
ACK semantico fenceado y la semantica exacta de retencion y orden exigidas por el spec; el adaptador de Pi; las fases aditivas de log sink y event sourcing; el RPC o protocolo de entrada de Pi.
