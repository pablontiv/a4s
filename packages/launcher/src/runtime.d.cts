export const EXIT_CODES: Readonly<{ integrationHold: number; retry: number; cancelled: number }>;
export function canonicalJson(value: unknown, pretty?: boolean): string;
export interface AtomicJsonOptions {
  exclusive?: boolean;
  fault?: ((point: "before-rename" | "after-rename") => void) | undefined;
}
export function writeAtomicJson(path: string, value: unknown, options?: AtomicJsonOptions): void;
