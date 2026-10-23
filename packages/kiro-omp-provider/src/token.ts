/**
 * Kiro auth token resolution + OIDC refresh, sharing custody with kiro-cli.
 *
 * Source of truth: kiro-cli's SQLite at ~/.local/share/kiro-cli/data.sqlite3,
 * table auth_kv, keys `kirocli:odic:token` (token) and
 * `kirocli:odic:device-registration` (client registration). The legacy
 * `~/.aws/sso/cache/kiro-auth-token.json` is stale on this host and unused.
 *
 * Refresh ladder: AWS SSO OIDC CreateToken —
 *   POST https://oidc.{region}.amazonaws.com/
 *   x-amz-target: com.amazonaws.ssooidc#CreateToken
 *   body: { clientId, clientSecret, refreshToken, grantType: "refresh_token" }
 * When the OIDC endpoint rejects the stored registration (observed live:
 * 403 AccessDeniedException while kiro-cli itself refreshes fine), fall back
 * to `kiro-cli whoami`, which refreshes the sqlite token in place. The OIDC
 * response rotates the refresh token; we write the whole updated token row
 * back into the same table so kiro-cli keeps working. Single-flight via a
 * module-level promise; 3-minute pre-expiry buffer (same as KAS).
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface KiroStoredToken {
	access_token: string;
	refresh_token: string;
	expires_at: string; // ISO
	region: string;
	start_url?: string;
	oauth_flow?: string;
	scopes?: string[];
}

export interface KiroDeviceRegistration {
	client_id: string;
	client_secret: string;
	region: string;
}

export interface KiroCredential {
	accessToken: string;
	region: string;
}

const PRE_EXPIRY_MS = 3 * 60 * 1000;
const KIRO_CLI_DB = path.join(os.homedir(), ".local/share/kiro-cli/data.sqlite3");

let refreshInFlight: Promise<KiroCredential> | null = null;

function readTokenRow(dbPath = KIRO_CLI_DB): KiroStoredToken | null {
	if (!fs.existsSync(dbPath)) return null;
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.query("SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token'").get() as
			| { value: string }
			| undefined;
		return row ? (JSON.parse(row.value) as KiroStoredToken) : null;
	} finally {
		db.close();
	}
}

function writeTokenRow(token: KiroStoredToken, dbPath = KIRO_CLI_DB): void {
	const db = new Database(dbPath);
	try {
		db.query("UPDATE auth_kv SET value = ? WHERE key = 'kirocli:odic:token'").run(JSON.stringify(token));
	} finally {
		db.close();
	}
}

function readRegistration(dbPath = KIRO_CLI_DB): KiroDeviceRegistration | null {
	if (!fs.existsSync(dbPath)) return null;
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.query("SELECT value FROM auth_kv WHERE key = 'kirocli:odic:device-registration'").get() as
			| { value: string }
			| undefined;
		return row ? (JSON.parse(row.value) as KiroDeviceRegistration) : null;
	} finally {
		db.close();
	}
}

function isExpiring(token: KiroStoredToken, now = Date.now()): boolean {
	const expiresAt = Date.parse(token.expires_at);
	if (!Number.isFinite(expiresAt)) return true;
	return expiresAt - now < PRE_EXPIRY_MS;
}

function isHardExpired(token: KiroStoredToken, now = Date.now()): boolean {
	const expiresAt = Date.parse(token.expires_at);
	if (!Number.isFinite(expiresAt)) return true;
	return expiresAt - now <= 0;
}

async function refreshViaOidc(token: KiroStoredToken, registration: KiroDeviceRegistration): Promise<KiroStoredToken> {
	const region = token.region || registration.region || "us-east-1";
	const res = await fetch(`https://oidc.${region}.amazonaws.com/`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-amz-json-1.0",
			"x-amz-target": "com.amazonaws.ssooidc#CreateToken",
		},
		body: JSON.stringify({
			clientId: registration.client_id,
			clientSecret: registration.client_secret,
			refreshToken: token.refresh_token,
			grantType: "refresh_token",
		}),
	});
	if (!res.ok) {
		throw new Error(`kiro token refresh failed: HTTP ${res.status} ${await res.text()}`);
	}
	const raw: unknown = await res.json();
	const accessToken =
		raw && typeof raw === "object" && "accessToken" in raw && typeof raw.accessToken === "string"
			? raw.accessToken
			: undefined;
	const expiresIn =
		raw && typeof raw === "object" && "expiresIn" in raw && typeof raw.expiresIn === "number" ? raw.expiresIn : undefined;
	const refreshedToken =
		raw && typeof raw === "object" && "refreshToken" in raw && typeof raw.refreshToken === "string"
			? raw.refreshToken
			: undefined;
	if (!accessToken || !expiresIn) {
		throw new Error("kiro token refresh: response missing accessToken/expiresIn");
	}
	const next: KiroStoredToken = {
		...token,
		access_token: accessToken,
		// SSO OIDC may not rotate the refresh token on every grant; keep the old
		// one when the response omits it.
		refresh_token: refreshedToken ?? token.refresh_token,
		expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
	};
	writeTokenRow(next);
	return next;
}

/** Shell out to kiro-cli so it refreshes the shared token store itself. */
async function refreshViaKiroCli(): Promise<void> {
	const proc = Bun.spawn(["kiro-cli", "whoami"], { stdout: "ignore", stderr: "ignore" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`kiro: kiro-cli whoami fallback exited ${exitCode}`);
	}
}

/**
 * Resolve a usable credential. Refreshes (single-flight, with write-back) when
 * the stored token is within the pre-expiry buffer or already hard-expired:
 * OIDC first, then the `kiro-cli whoami` fallback (re-reads the store).
 * Throws "login required" when no token exists.
 */
export async function getKiroCredential(dbPath = KIRO_CLI_DB): Promise<KiroCredential> {
	const token = readTokenRow(dbPath);
	if (!token) {
		throw new Error(
			"kiro: no token in kiro-cli store (~/.local/share/kiro-cli/data.sqlite3 auth_kv). Run `kiro-cli login` first.",
		);
	}
	if (!isExpiring(token)) {
		return { accessToken: token.access_token, region: token.region || "us-east-1" };
	}
	if (refreshInFlight) return refreshInFlight;
	refreshInFlight = (async () => {
		try {
			const registration = readRegistration(dbPath);
			if (registration) {
				try {
					const fresh = await refreshViaOidc(token, registration);
					return { accessToken: fresh.access_token, region: fresh.region || "us-east-1" };
				} catch (oidcError) {
					const message = oidcError instanceof Error ? oidcError.message : String(oidcError);
					console.warn(`kiro: OIDC refresh failed (${message}); falling back to kiro-cli whoami`);
				}
			}
			try {
				await refreshViaKiroCli();
			} catch (cliError) {
				const message = cliError instanceof Error ? cliError.message : String(cliError);
				console.warn(`kiro: kiro-cli whoami fallback failed (${message}); re-reading store`);
			}
			const reread = readTokenRow(dbPath) ?? token;
			// kiro-cli only refreshes hard-expired rows; within the pre-expiry buffer
			// it exits 0 without writing, and a transient whoami failure (non-zero
			// exit) must not void a still-valid token. Fail only when the row is
			// genuinely hard-expired (login required).
			if (!isHardExpired(reread)) {
				return { accessToken: reread.access_token, region: reread.region || "us-east-1" };
			}
			throw new Error("kiro: token still stale after kiro-cli whoami fallback. Run `kiro-cli login` and retry.");
		} finally {
			refreshInFlight = null;
		}
	})();
	return refreshInFlight;
}

/** Test seam: reset single-flight state. */
export function __resetRefreshInFlight(): void {
	refreshInFlight = null;
}
