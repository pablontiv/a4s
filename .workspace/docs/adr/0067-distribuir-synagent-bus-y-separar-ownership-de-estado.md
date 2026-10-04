---
tipo: adr
estado: proposed
fecha: '2026-10-04'
contexto: 'El broker Synagent debe instalarse y operarse independientemente de los adaptadores, conservar persistencia local durable y ofrecer una integración Herdr idempotente sin convertir el checkout en propietario del estado.'
decision: 'Distribuir el broker como paquete global @a4s/synagent-bus y plugin Herdr desde packages/synagent-bus; el paquete posee proceso Aedes y LevelDB en rutas de estado del usuario, Herdr posee sólo estado de coordinación bajo HERDR_PLUGIN_STATE_DIR, y @a4s/synagent conserva contrato y adaptadores.'
alternativas: 'Mantener broker y estado dentro de @a4s/synagent acopla instalación y checkout; usar memoria ante fallos pierde durabilidad; hacer que Herdr supervise continuamente añade lifecycle innecesario; guardar LevelDB en el plugin mezcla datos durables con estado de coordinación.'
consecuencias: 'La CLI y el plugin son superficies distribuibles independientes, existe un único lock npm raíz, el estado sobrevive cambios de checkout, y ensure debe verificar workspace, pane y listener y fallar cerrado ante ambigüedad; se mantienen las limitaciones locales de seguridad y una instancia por LevelDB.'
pendientes: 'Publicación efectiva del paquete en el registry y evolución futura del addressing quedan fuera de esta decisión.'
---
# 0067. Distribuir synagent bus y separar ownership de estado

## Contexto
El broker Synagent debe instalarse y operarse independientemente de los adaptadores, conservar persistencia local durable y ofrecer una integración Herdr idempotente sin convertir el checkout en propietario del estado.

## Decisión
Distribuir el broker como paquete global @a4s/synagent-bus y plugin Herdr desde packages/synagent-bus; el paquete posee proceso Aedes y LevelDB en rutas de estado del usuario, Herdr posee sólo estado de coordinación bajo HERDR_PLUGIN_STATE_DIR, y @a4s/synagent conserva contrato y adaptadores.

## Alternativas descartadas
Mantener broker y estado dentro de @a4s/synagent acopla instalación y checkout; usar memoria ante fallos pierde durabilidad; hacer que Herdr supervise continuamente añade lifecycle innecesario; guardar LevelDB en el plugin mezcla datos durables con estado de coordinación.

## Consecuencias
La CLI y el plugin son superficies distribuibles independientes, existe un único lock npm raíz, el estado sobrevive cambios de checkout, y ensure debe verificar workspace, pane y listener y fallar cerrado ante ambigüedad; se mantienen las limitaciones locales de seguridad y una instancia por LevelDB.

## Pendientes
Publicación efectiva del paquete en el registry y evolución futura del addressing quedan fuera de esta decisión.
