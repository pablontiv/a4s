import { hotReload } from "@a4s/omp-hot-reload";
import extension from "./index.ts";

export default function reloadable(pi: Parameters<typeof extension>[0]): Promise<void> {
  return hotReload(pi, extension, new URL("./index.ts", import.meta.url));
}
