import { parseArgs } from "node:util";
import { readServiceEnvironment } from "../packages/launcher/src/service-environment.ts";
import { healthJson, stationHealth } from "../packages/launcher/src/station-health.ts";

// Deliberately bypass the selecting a4s launcher: it takes leases and may promote.
const { values } = parseArgs({ options: {
  now: { type: "string" }, from: { type: "string" }, "cpu-measurement": { type: "string" }, help: { type: "boolean" },
}, strict: true, allowPositionals: false });
if (values.help) {
  console.log("node --import tsx scripts/station-health.ts [--now ISO_TIMESTAMP] [--from ISO_TIMESTAMP] [--cpu-measurement URL]\nRead-only station health JSON. Default window: all retained history through now; --from narrows it.");
} else {
  const environment = readServiceEnvironment();
  const snapshot = await stationHealth({ home: environment.DAGU_HOME, url: environment.DAGU_URL,
    now: values.now ?? new Date().toISOString(), ...(values.from ? { from: values.from } : {}),
    ...(values["cpu-measurement"] ? { cpuMeasurement: values["cpu-measurement"] } : {}),
  });
  process.stdout.write(healthJson(snapshot));
}
