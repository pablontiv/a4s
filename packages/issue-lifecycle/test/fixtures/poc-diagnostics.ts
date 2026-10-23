import type { ChildProcess } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class PocDiagnostics {
  private lastHttp?: { url: string; status: number; body: string };
  private stdout = "";
  private stderr = "";
  private closed?: Promise<void>;

  capture(service: ChildProcess): void {
    this.closed = new Promise<void>(resolve => {
      service.once("close", resolve);
    });
    service.stdout?.on("data", chunk => { this.stdout += chunk; });
    service.stderr?.on("data", chunk => { this.stderr += chunk; });
  }

  async fetch(url: string): Promise<{ url: string; status: number; body: string; ok: boolean }> {
    const response = await fetch(url);
    const body = await response.text();
    this.lastHttp = { url, status: response.status, body };
    return { ...this.lastHttp, ok: response.ok };
  }

  async runDetails<T extends { statusLabel: string }>(url: string, waiting = false): Promise<T | undefined> {
    const response = await this.fetch(url);
    const context = JSON.stringify(this.lastHttp);
    if (!response.ok) {
      if (waiting) return;
      throw new Error(`Dagu HTTP response was not OK: ${context}`);
    }
    let value: unknown;
    try { value = JSON.parse(response.body); }
    catch (cause) { throw new Error(`Dagu HTTP response contained malformed JSON: ${context}`, { cause }); }
    const run = (value as { dagRunDetails?: T } | null)?.dagRunDetails;
    if (!run || typeof run !== "object" || typeof run.statusLabel !== "string") {
      throw new Error(`Dagu HTTP response lacks valid dagRunDetails: ${context}`);
    }
    return run;
  }

  async finish(service: ChildProcess, root: string, home: string, failure: unknown, failed: boolean,
    report: (message: string) => void = message => console.error(message),
    base = process.env.A4S_DAGU_DIAGNOSTICS_DIR ?? join(tmpdir(), "a4s-dagu-poc-diagnostics")): Promise<void> {
    try {
      if (service.exitCode === null && service.signalCode === null) {
        service.kill("SIGTERM");
      }
      await this.closed;
      if (failed) {
        mkdirSync(base, { recursive: true, mode: 0o700 });
        const artifact = mkdtempSync(join(base, "poc-"));
        chmodSync(artifact, 0o700);
        report(`Dagu PoC diagnostics: ${artifact}`);
        writeFileSync(join(artifact, "failure.txt"), failure instanceof Error ? failure.stack ?? String(failure) : String(failure), { mode: 0o600 });
        writeFileSync(join(artifact, "http.json"), JSON.stringify(this.lastHttp ?? null, null, 2), { mode: 0o600 });
        writeFileSync(join(artifact, "server.stdout.log"), this.stdout, { mode: 0o600 });
        writeFileSync(join(artifact, "server.stderr.log"), this.stderr, { mode: 0o600 });
        for (const name of ["data", "logs"]) {
          const source = join(home, name);
          if (existsSync(source)) cpSync(source, join(artifact, name), {
            recursive: true,
            filter: path => {
              const stat = lstatSync(path);
              return stat.isDirectory() || stat.isFile();
            },
          });
        }
        const privatePaths = [artifact];
        for (const path of privatePaths) {
          const stat = lstatSync(path);
          chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
          if (stat.isDirectory()) privatePaths.push(...readdirSync(path).map(name => join(path, name)));
        }
      }
    } catch (error) {
      if (!failed) throw error;
      report(`Dagu PoC diagnostic retention failed: ${error instanceof Error ? error.stack : String(error)}`);
    } finally {
      try { rmSync(root, { recursive: true, force: true }); }
      catch (error) {
        if (!failed) throw error;
        report(`Dagu PoC runtime cleanup failed: ${String(error)}`);
      }
    }
  }
}
