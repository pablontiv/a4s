import { observeCodeScanning } from "../code-scanning.ts";

export function main(argv: string[]): void {
  const [repo = "", pr = "", sha = "", security = "", alerts = ""] = argv;
  console.log(JSON.stringify(observeCodeScanning(repo, pr, sha, { security, alerts })));
}
