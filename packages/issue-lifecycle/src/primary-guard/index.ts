import { primaryWriteDecision } from "./guard.ts";
import type { Block, GuardContext, GuardEvent, TargetResolver } from "./guard.ts";

export interface ExtensionAPI {
  on(event: "tool_call", handler: (event: GuardEvent, context?: GuardContext) => Promise<Block>): void;
}

export default function primaryGuard(pi: ExtensionAPI, getResolver: () => Promise<TargetResolver>): void {
  const resolver: TargetResolver = {
    resolve: async (path, context) => (await getResolver()).resolve(path, context),
    expand: async (path, context) => (await getResolver()).expand(path, context),
  };
  pi.on("tool_call", (event, context) => primaryWriteDecision(event, context ?? { cwd: process.cwd() }, resolver));
}
