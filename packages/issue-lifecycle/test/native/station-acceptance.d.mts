export const CASES: readonly ["r2", "r4", "r9", "selected-binary"];
export interface Options { base: string; phase: string; out: string; home: string }
export interface MatrixRow { case: string; run?: string; status: string; evidence: string[] }
export interface Matrix { schema: number; passed: boolean; rows: MatrixRow[] }
export interface Snapshot {
  bytes: Buffer; digest: string; rejected: unknown[]; formats: Record<string, unknown>;
  state: { current: { version: string }; rejected: unknown[]; formats: Record<string, unknown> };
}
export interface Context extends Options { root: string; realHome: string; identities: Record<string, string>; station: Snapshot["state"] }
export interface Executor {
  prepare(context: Context): Promise<(() => void | Promise<void>) | void>;
  r2?: (context: Context, evidence: string[]) => Promise<void>;
  r4?: (context: Context, evidence: string[]) => Promise<void>;
  r9?: (context: Context, evidence: string[]) => Promise<void>;
  "selected-binary"?: (context: Context, evidence: string[]) => Promise<void>;
}
export function parseArguments(args: string[]): { base: string; phase: "pre-bun" | "post-bun" };
export function fixtureIdentities(base: string): Record<"a" | "b" | "nonStarting" | "skillsOnly" | "agentOnly", string>;
export function sha256(bytes: string | Buffer): string;
export function stationSnapshot(home: string): Snapshot;
export function assertStationUnchanged(before: Snapshot, after: Snapshot): void;
export function aggregateMatrix(rows: MatrixRow[]): Matrix;
export function isolatedRoot(out: string, realHome: string): string;
export function writeEvidence(out: string, name: string, value: unknown): string;
export function runAcceptance(options: Options, execute: Executor): Promise<Matrix>;
export function fixtureEnvironment(service: { path: string; home: string; agentDir?: string }, home: string, parent: Record<string, string | undefined>, port: number): Record<string, string>;
