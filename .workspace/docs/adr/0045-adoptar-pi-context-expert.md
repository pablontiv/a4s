---
tipo: adr
estado: accepted
fecha: '2026-09-22'
contexto: 'La configuración de pi-rule-compiler se carga una vez al inicio y no representa la identidad ni las capacidades actuales de un gestor de contexto.'
decision: 'Renombrar a pi-context-expert sin compatibilidad, guardar configuración global mutable en ~/.pi/agent/pi-context-expert.json y aplicar cambios al instante mediante /ce-settings; exponer /ce-recap y /ce-rules bajo el namespace ce-.'
alternativas: 'Mantener la ruta y comandos pi-rule-compiler: descartado por baja adopción y una identidad de reglas incompleta; reiniciar Pi para cada cambio: descartado porque /ce-settings debe aplicar valores en caliente; recap con modelo actual: descartado porque Jev conserva la autoridad semántica.'
consecuencias: 'Los paquetes, configuración, comandos y custom entries antiguos dejan de ser compatibles; /ce-recap consulta Jev de forma explícita sobre una vista saneada y muestra fallback local; los hooks consultan el estado de configuración mutable.'
pendientes: ""
---
# 0045. Adoptar pi context expert

Reemplaza a 0031-configurar-rule-compiler-global.

## Contexto
La configuración de pi-rule-compiler se carga una vez al inicio y no representa la identidad ni las capacidades actuales de un gestor de contexto.

## Decisión
Renombrar a pi-context-expert sin compatibilidad, guardar configuración global mutable en ~/.pi/agent/pi-context-expert.json y aplicar cambios al instante mediante /ce-settings; exponer /ce-recap y /ce-rules bajo el namespace ce-.

## Alternativas descartadas
Mantener la ruta y comandos pi-rule-compiler: descartado por baja adopción y una identidad de reglas incompleta; reiniciar Pi para cada cambio: descartado porque /ce-settings debe aplicar valores en caliente; recap con modelo actual: descartado porque Jev conserva la autoridad semántica.

## Consecuencias
Los paquetes, configuración, comandos y custom entries antiguos dejan de ser compatibles; /ce-recap consulta Jev de forma explícita sobre una vista saneada y muestra fallback local; los hooks consultan el estado de configuración mutable.

## Pendientes
Comprobar con una prueba que el trigger no sugiera compactación cuando Pi no tiene contenido compactable.
