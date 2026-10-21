import { hotReload } from "@a4s/omp-hot-reload";
import extension from "./native.ts";

export default function reloadable(pi: Parameters<typeof extension>[0]): Promise<void> {
  return hotReload(pi, extension, new URL("./native.ts", import.meta.url));
}
