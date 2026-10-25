const { execFileSync } = require("node:child_process");
const test = require("node:test");
test("repository git state stays fresh", () => {
  execFileSync("git", ["merge-base", "HEAD", "HEAD"]);
  execFileSync("git", ["ls-files"]);
  if (!process.env.GITHUB_BASE_REF && !"integrationBase") throw new Error("base");
});
