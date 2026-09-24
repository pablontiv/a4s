---
tipo: adr
estado: superseded
fecha: '2026-09-22'
contexto: 'El owner corrigió ADR 0030: pidió configuración global persistida de Pi, no variables de entorno por proceso. Pi settings.json no reserva una clave de extensión.'
decision: 'La extensión lee ~/.pi/agent/pi-rule-compiler.json al iniciar. El archivo contiene únicamente las tres claves flat de modo; falta, JSON inválido o valores inválidos resuelven a basic. La configuración global activa ladder para toda sesión nueva que cargue la extensión.'
alternativas: 'Variables de entorno por proceso: descartadas por corrección explícita del owner. Añadir claves no soportadas a settings.json: descartado porque Pi no reserva configuración namespaced para extensiones y ExtensionContext no expone settings.'
consecuencias: 'La configuración se preserva fuera del repositorio y requiere reinicio de Pi; nunca contiene credenciales ni texto de sesión.'
superseded_by: 0045-adoptar-pi-context-expert
---
# 0031. Configurar rule compiler global

Reemplaza a 0030-configurar-rule-compiler-por-entorno.

## Contexto
El owner corrigió ADR 0030: pidió configuración global persistida de Pi, no variables de entorno por proceso. Pi settings.json no reserva una clave de extensión.

## Decisión
La extensión lee ~/.pi/agent/pi-rule-compiler.json al iniciar. El archivo contiene únicamente las tres claves flat de modo; falta, JSON inválido o valores inválidos resuelven a basic. La configuración global activa ladder para toda sesión nueva que cargue la extensión.

## Alternativas descartadas
Variables de entorno por proceso: descartadas por corrección explícita del owner. Añadir claves no soportadas a settings.json: descartado porque Pi no reserva configuración namespaced para extensiones y ExtensionContext no expone settings.

## Consecuencias
La configuración se preserva fuera del repositorio y requiere reinicio de Pi; nunca contiene credenciales ni texto de sesión.
