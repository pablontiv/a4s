import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
appendFileSync(join(process.argv[2], 'events.jsonl'), JSON.stringify({ type: 'host_exit', at: new Date().toISOString(), code: Number(process.argv[3]) }) + '\n');
