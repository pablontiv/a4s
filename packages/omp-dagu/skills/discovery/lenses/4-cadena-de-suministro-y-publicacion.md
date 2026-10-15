# Lente 4: Cadena de suministro y publicación
- Objetivo: confirmar que lo que se construye y distribuye es lo esperado, y
  que las dependencias, el CI y los mecanismos de instalación o actualización
  resisten manipulación.
- Unidad de análisis: un eslabón de la cadena: dependencia directa, script de
  instalación, workflow de CI, artefacto publicado o mecanismo de actualización.
- Criterios:
  - Dependencias sin lockfile o con versiones sin fijar
  - Vulnerabilidades conocidas en dependencias (usa la herramienta del
    ecosistema: osv-scanner, npm audit, pip-audit, cargo audit, govulncheck)
  - Scripts que se ejecutan al instalar (postinstall, build.rs, setup.py) sin
    justificación clara
  - Acciones de CI sin fijar a un SHA, tokens con más permisos de los
    necesarios, triggers que ejecutan código ajeno con acceso a secretos
    (p. ej. pull_request_target con checkout del PR)
  - Instaladores tipo curl | sh sin verificación de checksum o firma
  - Artefactos sin checksum, firma o attestation; builds no reproducibles
  - Actualización automática que acepta artefactos sin verificar
- Método: empieza por el inventario estático, que es local y sin red. La
  consulta de vulnerabilidades y la verificación de artefactos publicados
  requieren red: trátalas como recursos externos. Para instaladores y
  autoupdate, sirve un artefacto alterado desde un servidor local en la
  carpeta temporal y comprueba que se rechace.
- Restricciones propias: solo lectura del lado remoto; sin publicaciones,
  tags ni ejecución de workflows.
