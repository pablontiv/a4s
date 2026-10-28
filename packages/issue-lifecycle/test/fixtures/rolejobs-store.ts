import { RoleJobStore as Store, type ExecutorIdentity, type JobBinding } from "../../src/role-jobs.ts";

/** Keep SQLite ownership/recovery real while replacing the operating-system identity probe. */
export class RoleJobStore extends Store {
  constructor(home: string, capacity: number, alive: (owner: ExecutorIdentity) => boolean = () => true) {
    super(home, capacity, alive);
  }
  override claim(binding: JobBinding, directory: string, readyAt: string, authorize: () => void,
    executor: ExecutorIdentity = { host: "fixture-host", pid: 123, processStartedAt: "fixture-start" }) {
    return super.claim(binding, directory, readyAt, authorize, executor);
  }
}
