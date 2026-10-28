/** Persistent OMP owner identity shared by admission and runtime authorization. */
export function requireOwnerSession(value: unknown): string {
  if (typeof value !== "string" || !/^[^\s\u0000-\u001f\u007f]{1,200}$/.test(value)) {
    throw new Error("OMP_SESSION_ID requires a valid owning session (1–200 non-whitespace, non-control characters)");
  }
  return value;
}
