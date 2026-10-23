import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function agentDirectory(home = homedir()): string {
  const raw = process.env.OMP_PROFILE !== undefined ? process.env.OMP_PROFILE : process.env.PI_PROFILE;
  const value = raw?.trim();
  const profile = !value || value === "default" ? undefined : value;
  if (!profile && process.env.PI_CODING_AGENT_DIR) return resolve(process.env.PI_CODING_AGENT_DIR);
  const root = join(home, process.env.PI_CONFIG_DIR || ".omp");
  return join(root, ...(profile ? ["profiles", profile] : []), "agent");
}
