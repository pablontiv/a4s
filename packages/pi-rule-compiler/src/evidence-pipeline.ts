import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JevCompactionResult } from "./types.ts";

export interface EvidencePipeline {
  afterCompaction(result: JevCompactionResult, ctx: ExtensionContext): Promise<void>;
}

/** Evidence is deliberately inert until its opt-in Ladder implementation is installed. */
export const disabledEvidencePipeline: EvidencePipeline = {
  async afterCompaction() {},
};
