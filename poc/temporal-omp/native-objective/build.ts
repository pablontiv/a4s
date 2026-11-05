process.env.A4S_TEMPORAL_BUILD_ROOT = import.meta.dir;
// Environment must be set before the shared build module evaluates its root.
await import('../omp/build.ts');
