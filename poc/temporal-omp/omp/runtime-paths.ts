// First extension import: initialize before core-bridge evaluates. Threads inherit env.
import { join } from 'node:path';
process.env.A4S_TEMPORAL_DIST = import.meta.dir;
Object.assign(globalThis, { __A4S_TEMPORAL_THREAD_ENTRY: join(import.meta.dir, 'workflow-worker-thread.js') });
