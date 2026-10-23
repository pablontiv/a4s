/**
 * Regression: kiro-cli whoami only refreshes hard-expired rows. Within the
 * pre-expiry buffer it exits 0 WITHOUT writing. getKiroCredential must still
 * return the (valid) row credential after the whoami fallback instead of
 * throwing "token still stale" — the original bug. A transient whoami
 * failure (non-zero exit) must also not void a still-valid token.
 *
 * Uses a temp sqlite store without a device-registration row, so the OIDC
 * refresh path is SKIPPED (readRegistration returns null) and the ladder
 * runs: skip-OIDC → whoami → reread. No network involved.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { getKiroCredential, __resetRefreshInFlight, type KiroStoredToken } from "../../src/token";

const TMP = "/tmp/kiro-token-test";
const DB_PATH = `${TMP}/data.sqlite3`;
const BIN = `${TMP}/bin`;

let previousPath: string | undefined;

function makeToken(expiresAtMs: number): KiroStoredToken {
	return {
		access_token: `tok-${Math.random().toString(36).slice(2)}`,
		refresh_token: "rt-unused",
		expires_at: new Date(expiresAtMs).toISOString().replace("+00:00", "Z"),
		region: "us-east-1",
	} as KiroStoredToken;
}

function writeRow(token: KiroStoredToken): void {
	const db = new Database(DB_PATH);
	db.query("CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
	db.query("INSERT OR REPLACE INTO auth_kv (key, value) VALUES ('kirocli:odic:token', ?)").run(JSON.stringify(token));
	db.close();
}

function readRow(): KiroStoredToken {
	const db = new Database(DB_PATH, { readonly: true });
	const row = db.query("SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token'").get() as { value: string };
	db.close();
	return JSON.parse(row.value);
}

beforeAll(() => {
	fs.mkdirSync(TMP, { recursive: true });
	fs.mkdirSync(BIN, { recursive: true });
	// Fake kiro-cli: exits with the code in EXIT_FILE (default 0) and does NOT
	// touch the store — what the real CLI does when the row is inside the
	// pre-expiry window.
	fs.writeFileSync(
		`${BIN}/kiro-cli`,
		'#!/bin/sh\nif [ -f "$EXIT_FILE" ]; then exit "$(cat "$EXIT_FILE")"; fi\nexit 0\n',
	);
	fs.chmodSync(`${BIN}/kiro-cli`, 0o755);
	previousPath = process.env.PATH;
	process.env.PATH = `${BIN}:${previousPath}`;
});

afterAll(() => {
	process.env.PATH = previousPath;
	fs.rmSync(TMP, { recursive: true, force: true });
	__resetRefreshInFlight();
});

describe("getKiroCredential whoami fallback", () => {
	it("returns the still-valid row credential instead of throwing (pre-expiry buffer, whoami exits 0 without writing)", async () => {
		__resetRefreshInFlight();
		// Token expires in 90s: inside the 3-min pre-expiry buffer (refresh
		// triggers) but NOT hard-expired (whoami won't rewrite it).
		const token = makeToken(Date.now() + 90_000);
		writeRow(token);

		const cred = await getKiroCredential(DB_PATH);
		// Used the row's token, not a refresh.
		expect(cred.accessToken).toBe(token.access_token);
		expect(cred.region).toBe("us-east-1");
		// Row untouched by the fake whoami.
		expect(readRow().expires_at).toBe(token.expires_at);
	});

	it("throws 'still stale' when the row is genuinely hard-expired after whoami", async () => {
		__resetRefreshInFlight();
		const token = makeToken(Date.now() - 10_000);
		writeRow(token);

		await expect(getKiroCredential(DB_PATH)).rejects.toThrow("token still stale");
		// Row untouched: hard-expired and whoami didn't write.
		expect(readRow().expires_at).toBe(token.expires_at);
	});

	it("returns the still-valid row credential when whoami itself fails (non-zero exit)", async () => {
		__resetRefreshInFlight();
		const exitFile = `${TMP}/exit-code`;
		fs.writeFileSync(exitFile, "1");
		process.env.EXIT_FILE = exitFile;
		try {
			const token = makeToken(Date.now() + 90_000);
			writeRow(token);
			const cred = await getKiroCredential(DB_PATH);
			expect(cred.accessToken).toBe(token.access_token);
			expect(readRow().expires_at).toBe(token.expires_at);
		} finally {
			delete process.env.EXIT_FILE;
			fs.rmSync(exitFile, { force: true });
		}
	});

	it("throws 'still stale' when the row is hard-expired AND whoami fails", async () => {
		__resetRefreshInFlight();
		const exitFile = `${TMP}/exit-code`;
		fs.writeFileSync(exitFile, "1");
		process.env.EXIT_FILE = exitFile;
		try {
			const token = makeToken(Date.now() - 10_000);
			writeRow(token);
			await expect(getKiroCredential(DB_PATH)).rejects.toThrow("token still stale");
		} finally {
			delete process.env.EXIT_FILE;
			fs.rmSync(exitFile, { force: true });
		}
	});
});
