import { readFileSync } from "node:fs";
import { join } from "node:path";

export function loadDaguConfig(root: string): { daguUrl: string } {
  const file = join(root, ".workspace", "config", "dagu.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { daguUrl: "http://127.0.0.1:8080" };
    throw error;
  }
  try {
    const config: unknown = JSON.parse(text);
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("expected an object");
    const daguUrl = (config as Record<string, unknown>).daguUrl;
    if (daguUrl !== undefined && typeof daguUrl !== "string") throw new Error("daguUrl must be a string");
    return { daguUrl: (daguUrl ?? "http://127.0.0.1:8080").replace(/\/+$/, "") };
  } catch (error) {
    throw new Error(`Invalid Dagu config ${file}: ${(error as Error).message}`, { cause: error });
  }
}
