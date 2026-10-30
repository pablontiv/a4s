export const BUILD_ID: RegExp;
export function idFromCount(count: string | number): string;
export function gitBuildIdentity(cwd: string, sha?: string): { version: string; commit: string };
export interface PublicationInputs {
  validated: boolean; headSha: string; checkoutSha: string; version: string;
  tagSha?: string | undefined; lastSha?: string | undefined; firstParent: boolean;
  changed: boolean; exists: boolean;
}
export function publicationPlan(input: PublicationInputs): boolean;
export function assertPublishedDigest(archive: string, rebuilt: string, published: string): void;
