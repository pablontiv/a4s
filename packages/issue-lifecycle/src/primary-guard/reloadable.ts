import { hotReload } from "@a4s/hot-reload";
import extension from "./native.ts";

export default function reloadable(pi: Parameters<typeof extension>[0]): Promise<void> {
  return hotReload(pi, extension, new URL("./native.ts", import.meta.url), {
    importModule: async path => {
      // OMP-only loader is unavailable to non-host consumers until a live reload.
      const { loadLegacyPiModule } = await import("@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat");
      const module = await loadLegacyPiModule(path.replace(/\?mtime=\d+$/, ""));
      if (!module || typeof module !== "object" || !("default" in module) || typeof module.default !== "function") {
        throw new Error("Primary guard extension has no default factory");
      }
      return { default: module.default as typeof extension };
    },
  });
}
