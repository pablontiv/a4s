import { hotReload } from "@a4s/hot-reload";
import extension from "./extension.ts";

export default function reloadable(pi: Parameters<typeof extension>[0]): Promise<void> {
  return hotReload(pi, extension, new URL("./extension.ts", import.meta.url));
}
