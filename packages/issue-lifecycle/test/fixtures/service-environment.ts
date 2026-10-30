import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { schedulerTools } from "../../../launcher/src/service-environment.ts";

/** Isolated operator-owned declaration; production never writes these files. */
export function declareService(home: string, endpoint: string, path?: string): NodeJS.ProcessEnv {
  const bin = join(home, "bin");
  if (path === undefined) {
    mkdirSync(bin, { recursive: true });
    for (const tool of schedulerTools) {
      writeFileSync(join(bin, tool), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, tool), 0o755);
    }
  }
  const file = join(home, "service-environment.json");
  writeFileSync(file, JSON.stringify({ DAGU_URL: endpoint, DAGU_HOME: home, PATH: path ?? bin }));
  return { A4S_SERVICE_ENV: file, DAGU_HOME: home, DAGU_URL: endpoint };
}

/** A nested station fixture retaining the real test tools and loopback policy. */
export function stationEnv(home: string, endpoint = process.env.DAGU_URL!): NodeJS.ProcessEnv {
  mkdirSync(home, { recursive: true });
  return declareService(home, endpoint, process.env.PATH);
}

export function useStation(home: string, endpoint?: string): () => void {
  const declaration = join(home, "service-environment.json");
  const before = existsSync(declaration) ? readFileSync(declaration) : undefined;
  const previous = { A4S_SERVICE_ENV: process.env.A4S_SERVICE_ENV, DAGU_HOME: process.env.DAGU_HOME, DAGU_URL: process.env.DAGU_URL };
  Object.assign(process.env, stationEnv(home, endpoint));
  return () => {
    if (before) writeFileSync(declaration, before);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
}

/** Declare the station selected by a native fixture's complete child environment. */
export function stationEnvironment<T extends NodeJS.ProcessEnv>(env: T): T & NodeJS.ProcessEnv {
  const endpoint = env.DAGU_PORT ? `http://127.0.0.1:${env.DAGU_PORT}` : env.DAGU_URL ?? process.env.DAGU_URL!;
  mkdirSync(env.DAGU_HOME!, { recursive: true });
  return { ...env, ...declareService(env.DAGU_HOME!, endpoint, env.PATH ?? process.env.PATH) };
}
