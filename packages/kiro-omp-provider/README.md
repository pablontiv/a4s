# kiro-omp-provider

Kiro (KIRO PRO / CodeWhisperer runtime) como proveedor de modelos para **omp** (Oh My Pi), vía extensión de usuario con `pi.registerProvider` + `streamSimple` custom que habla `GenerateAssistantResponse` directamente. omp exige que un proveedor con `models` declare `apiKey` u `oauth`: la extensión registra `apiKey: "KIRO_API_KEY"` (forma env-var-name — unset resuelve a su literal y satisface la validación; el valor nunca viaja en el wire, las credenciales reales salen del sqlite de kiro-cli).

- **No hay SDK**: HTTP + AWS Event Stream binario con fetch/Bun builtins. Cero dependencias npm.
- **Auth**: custodia compartida con kiro-cli — lee el token del sqlite de kiro-cli (`auth_kv`), refresca con ladder OIDC `CreateToken` → fallback `kiro-cli whoami` (con write-back y single-flight).
- **Local-only**: paquete del monorepo. Instalación: copia de `src/` → `~/.omp/agent/extensions/kiro/` (index.ts adentro, imports relativos intactos; no symlink — la copia es independiente del repo).

## Protocolo (verificado en vivo 2026-10-20)

- `POST https://runtime.{region}.kiro.dev/generateAssistantResponse`, `x-amz-target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse` (legacy target — el nuevo `KiroRuntimeService.*` da 403 con token IdC-Enterprise), `Authorization: Bearer <accessToken>`, `profileArn` en body + header, `x-amzn-kiro-agent-mode: vibe`, `x-amzn-codewhisperer-optout: true`.
- Respuesta `application/vnd.amazon.eventstream`: framing binario (u32BE totalLen/headersLen, headers tipados, payload JSON). Eventos: `assistantResponseEvent` (deltas texto), `reasoningContentEvent` (thinking), `toolUseEvent` (args = string JSON acumulable hasta `stop:true`), `metadataEvent` (stopReason + tokenUsage), errores in-band (`throttlingError`, …).
- Reglas de wire: `tools` en CADA mensaje user (sino `TOOL_CONFIG_MISSING`); toolResult content = `{"text": ...}`; mensajes alternados; user vacío sólo con toolResults; effort (`additionalModelRequestFields.output_config.effort`) sólo en modelos cuyo schema del control-plane lo declara; **`chatTriggerType` siempre `"MANUAL"`** (`"CONTINUOUS"` → 400 `REQUEST_BODY_INVALID`, verificado en vivo).
- Refresh del token: ladder OIDC `CreateToken` → fallback `kiro-cli whoami` (el endpoint OIDC rechazó el refresh directo con 403 `AccessDeniedException` desde clientes propios, aunque kiro-cli refresca bien; el fallback relee el sqlite tras dejar que kiro-cli lo refresque).

## Layout

```
src/
  eventstream.ts    # decoder AWS Event Stream (sync, incremental)
  token.ts          # auth: sqlite kiro-cli + refresh OIDC single-flight
  conversation.ts   # context omp -> conversationState Kiro
  client.ts         # generateAssistantResponse() con AbortSignal
  models.ts         # seed models (control-plane 2026-10-20) + live fetch
  index.ts          # streamSimple + registerProvider (entry de la extensión)
scripts/
  poc-chat.ts       # PoC: chat one-shot por HTTP directo
tests/              # unit (fixtures) + integration (live endpoint)
```

## Uso

```bash
bun test                    # unit (offline, fixtures)
bun test tests/integration  # integration (requiere kiro-cli logueado)
bun run scripts/poc-chat.ts "hola"
# instalar:
mkdir -p ~/.omp/agent/extensions/kiro && cp packages/kiro-omp-provider/src/*.ts ~/.omp/agent/extensions/kiro/
omp models | grep kiro
omp -p --model kiro/claude-haiku-4.5 "decí ok"

### Variables de entorno

- `KIRO_PROFILE_ARN` (requerido): ARN del perfil de CodeWhisperer/IdC de tu cuenta, p.ej. `arn:aws:codewhisperer:us-east-1:<account>:profile/<id>`.

La ruta de instalación del ejemplo (línea 38) es relativa a la raíz de este monorepo (a4s).

## Limitaciones

- Endpoint no documentado; puede romper sin aviso (mitigado con `fetchDynamicModels` + seed estático).
- `~/.aws/sso/cache/kiro-auth-token.json` NO es la fuente (stale); la fuente es el sqlite de kiro-cli.
- systemPrompt de omp se envía como primer mensaje user (el legacy target no tiene campo systemPrompt).
- Los 20 modelos del listado de chat-cli (opus-5.5, gpt-5.6-*) no pasan por este endpoint+perfil.
