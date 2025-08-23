import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { executorAlive, jobId, type Job, type JobBinding } from "./role-jobs.ts";

export interface FeedbackPolicy {
  schemaVersion: 1; issue: string; repo: string; worktree: string; run: string;
  owner: string; publisher: string; jobs: string;
  candidate: { sha: string; iteration: number; attempt: string };
}
export type FeedbackKind = "finding" | "correction" | "verification";
export interface FeedbackInput {
  key: string; type: FeedbackKind; summary: string; findingId?: string;
  correctionId?: string; resolved?: boolean;
}
export interface FeedbackEvent {
  schemaVersion: 1; eventId: string; findingId: string; correctionId?: string;
  type: FeedbackKind; provisional: true; issue: string; jobId: string; sessionId: string;
  binding: JobBinding; createdAt: string; summary: string; resolved?: boolean;
  transcript: { bytes: number; digest: string };
}
export interface FeedbackComment { id: number; url: string; body: string; author: string }
export interface FeedbackTransport {
  authenticatedLogin(): string;
  list(issue: string): FeedbackComment[];
  create(issue: string, body: string): FeedbackComment;
  update(issue: string, id: number, body: string): void;
}
export interface FeedbackWork {
  id: string; eventId: string; findingId: string; correctionId?: string;
  kind: "correction" | "verification"; owner: string; role: "implement" | "qa";
  sha: string; iteration: number; attempt: string;
  state: "ready" | "active" | "completed" | "superseded";
  source: string; outcome?: string;
}
export interface FeedbackReceipt {
  event: FeedbackEvent; publication: "pending" | "published";
  comment?: FeedbackComment; admission: "pending" | "admitted" | "superseded";
}
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
function validPolicy(policy: FeedbackPolicy): void {
  if (policy.schemaVersion !== 1 || !/^[\w.-]+\/[\w.-]+#[1-9][0-9]*$/.test(policy.issue) ||
      !/^[a-f0-9]{40}$/.test(policy.candidate.sha) || !Number.isSafeInteger(policy.candidate.iteration) || policy.candidate.iteration < 0 ||
      !policy.candidate.attempt || !policy.owner || !policy.publisher || !policy.run ||
      realpathSync(policy.repo) !== policy.repo || realpathSync(policy.worktree) !== policy.worktree ||
      realpathSync(policy.jobs) !== policy.jobs) throw new Error("Invalid explicit issue-feedback policy");
}
function marker(id: string): string { return `<!-- dagu-issue-event:${id} -->`; }
function eventBody(event: FeedbackEvent): string {
  return `${marker(event.eventId)}\n## Lifecycle evidence: ${event.type}\n\n` +
    `Role **${event.binding.role}**, candidate \`${event.binding.sha}\`, job \`${event.jobId}\`.\n` +
    "Provisional issue feedback; final quality verdicts remain independently admitted.\n\n" +
    `\`\`\`json\n${JSON.stringify(event, null, 2)}\n\`\`\``;
}
function transcriptPrefix(path: string): Buffer {
  const bytes = readFileSync(path);
  // A native writer can be appending a row. Only complete JSONL rows are evidence.
  return bytes.subarray(0, bytes.lastIndexOf(10) + 1);
}
function validateNative(event: FeedbackEvent, policy: FeedbackPolicy): void {
  const directory = join(policy.jobs, event.jobId);
  if (realpathSync(directory) !== directory) throw new Error("Role-job directory is not canonical");
  const job = JSON.parse(readFileSync(join(directory, "job.json"), "utf8")) as Job;
  if (job.schemaVersion !== 1 || job.id !== event.jobId || job.id !== jobId(job.binding) || job.directory !== directory ||
      canonical(job.binding) !== canonical(event.binding) || job.binding.repo !== policy.repo ||
      job.binding.worktree !== policy.worktree || job.binding.run !== policy.run) throw new Error("Issue event role-job scope mismatch");
  const bytes = transcriptPrefix(join(directory, `${job.id}.jsonl`));
  const seal = event.transcript;
  if (!Number.isSafeInteger(seal.bytes) || seal.bytes < 1 || bytes.length < seal.bytes ||
      digest(bytes.subarray(0, seal.bytes)) !== seal.digest) throw new Error("Issue event native transcript changed");
  const rows = bytes.subarray(0, seal.bytes).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
  const sessions = rows.filter(row => row.type === "session");
  const assignments = rows.filter(row => row.type === "session_init");
  const authorized = `Authorized Dagu role job ${job.id}.`;
  if (sessions.length !== 1 || sessions[0].id !== event.sessionId || !assignments.length ||
      assignments.some(row => typeof row.task !== "string" || !row.task.includes(authorized))) throw new Error("Issue event native session/assignment mismatch");
}

/** Operational receipts under the owning run, not a second controller or quality verdict store. */
export class IssueFeedback {
  private readonly db: DatabaseSync;
  constructor(readonly state: string) {
    mkdirSync(state, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(state, "issue-feedback.sqlite"));
    this.db.exec("PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS policy (id INTEGER PRIMARY KEY, document TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, document TEXT NOT NULL); CREATE TABLE IF NOT EXISTS work (id TEXT PRIMARY KEY, document TEXT NOT NULL);");
  }
  close(): void { this.db.close(); }
  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  configuredPolicy(): FeedbackPolicy | undefined {
    const row = this.db.prepare("SELECT document FROM policy WHERE id=1").get();
    return row ? JSON.parse(String(row.document)) as FeedbackPolicy : undefined;
  }
  policy(): FeedbackPolicy {
    const policy = this.configuredPolicy();
    if (!policy) throw new Error("Issue feedback requires explicit owner publication/scope policy");
    return policy;
  }
  /** The caller supplies owner authority; the CLI checks the existing admission receipt/identity. */
  configure(policy: FeedbackPolicy, owner: string): void {
    validPolicy(policy);
    if (owner !== policy.owner) throw new Error("Only the retained run owner can configure issue feedback");
    this.transaction(() => {
      const row = this.db.prepare("SELECT document FROM policy WHERE id=1").get();
      if (row) {
        const previous = JSON.parse(String(row.document)) as FeedbackPolicy;
        if (canonical({ ...previous, candidate: null }) !== canonical({ ...policy, candidate: null })) throw new Error("Issue feedback cannot replace the retained owner/scope/publication authority");
      }
      this.db.prepare("INSERT INTO policy VALUES (1,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document").run(JSON.stringify(policy));
      this.refreshWork(policy);
    });
  }
  private current(binding: { sha: string; iteration: number; attempt: string }, policy = this.policy()): boolean {
    return canonical({ sha: binding.sha, iteration: binding.iteration, attempt: binding.attempt }) === canonical(policy.candidate);
  }
  /** Capture and rebase retain the native implementer/input HEAD, independently of capture iteration. */
  private correctedCandidate(correction: FeedbackReceipt, policy: FeedbackPolicy): boolean {
    const path = join(this.state, "candidate.json");
    if (!existsSync(path)) return false;
    const candidate = JSON.parse(readFileSync(path, "utf8"));
    if (candidate.sha !== policy.candidate.sha || candidate.iteration !== policy.candidate.iteration ||
        candidate.implementer !== correction.event.jobId || candidate.implementation?.inputSha !== correction.event.binding.sha) return false;
    validateNative(correction.event, policy);
    const bytes = readFileSync(join(policy.jobs, correction.event.jobId, "result.json"));
    const result = JSON.parse(bytes.toString("utf8"));
    return candidate.implementation.resultDigest === digest(bytes) && result.id === correction.event.jobId &&
      result.state === "completed" && canonical(result.binding) === canonical(correction.event.binding);
  }
  private correctionCurrent(work: FeedbackWork, policy: FeedbackPolicy): boolean {
    const finding = this.receipt(work.findingId);
    return work.sha === policy.candidate.sha && finding.admission === "admitted" &&
      (policy.candidate.iteration === finding.event.binding.iteration ||
       policy.candidate.iteration === finding.event.binding.iteration + 1);
  }
  private refreshWork(policy: FeedbackPolicy): void {
    for (const receipt of this.receipts()) {
      if (receipt.event.type !== "correction" || receipt.admission !== "admitted") continue;
      const id = `${receipt.event.eventId}:verification`;
      const previous = this.work().find(work => work.id === id);
      if (this.correctedCandidate(receipt, policy)) {
        if (previous?.state === "superseded") continue;
        const changed = previous && (previous.sha !== policy.candidate.sha || previous.iteration !== policy.candidate.iteration ||
          previous.attempt !== policy.candidate.attempt);
        this.saveWork({ id, eventId: receipt.event.eventId, findingId: receipt.event.findingId,
          correctionId: receipt.event.eventId, kind: "verification", owner: policy.owner, role: "qa",
          ...policy.candidate, state: changed ? "ready" : previous?.state ?? "ready",
          source: receipt.comment!.url, ...(!changed && previous?.outcome ? { outcome: previous.outcome } : {}) });
      } else if (!this.current(receipt.event.binding, policy)) {
        this.save({ ...receipt, admission: "superseded" });
      }
    }
    for (const work of this.work()) {
      if (work.state !== "ready" && work.state !== "active") continue;
      if (work.kind === "correction" && this.correctionCurrent(work, policy)) {
        this.saveWork({ ...work, ...policy.candidate });
      } else if (work.sha !== policy.candidate.sha || work.iteration !== policy.candidate.iteration ||
          (work.kind === "verification" && !this.correctedCandidate(this.receipt(work.eventId), policy))) {
        this.saveWork({ ...work, state: "superseded" });
      }
    }
  }
  private save(receipt: FeedbackReceipt): void {
    this.db.prepare("INSERT INTO events VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document").run(receipt.event.eventId, JSON.stringify(receipt));
  }
  private saveWork(work: FeedbackWork): void {
    this.db.prepare("INSERT INTO work VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document").run(work.id, JSON.stringify(work));
  }
  receipts(): FeedbackReceipt[] { return this.db.prepare("SELECT document FROM events ORDER BY rowid").all().map(row => JSON.parse(String(row.document)) as FeedbackReceipt); }
  work(): FeedbackWork[] { return this.db.prepare("SELECT document FROM work ORDER BY rowid").all().map(row => JSON.parse(String(row.document)) as FeedbackWork); }
  private receipt(id: string): FeedbackReceipt {
    const row = this.db.prepare("SELECT document FROM events WHERE id=?").get(id);
    if (!row) throw new Error("Unknown locally authorized issue event");
    return JSON.parse(String(row.document)) as FeedbackReceipt;
  }
  /** Stable caller key makes retries converge; changing its payload fails closed. No GitHub action here. */
  emit(directory: string, input: FeedbackInput): FeedbackReceipt {
    return this.transaction(() => {
      const policy = this.policy();
      const job = JSON.parse(readFileSync(join(directory, "job.json"), "utf8")) as Job;
      if (directory !== join(policy.jobs, job.id) || !/^[a-f0-9]{64}$/.test(job.id)) throw new Error("Issue event job is outside the authorized scope");
      if (!this.current(job.binding, policy)) throw new Error("Issue feedback candidate/attempt is not current; retry the same key after the owner configures this job's candidate/attempt");
      for (const receipt of this.receipts()) {
        if (receipt.event.jobId === job.id) validateNative(receipt.event, policy);
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.key) || typeof input.summary !== "string" || !input.summary.trim() || Buffer.byteLength(input.summary) > 12000 ||
          !["finding", "correction", "verification"].includes(input.type)) throw new Error("Invalid incremental issue event");
      const prefix = transcriptPrefix(join(directory, `${job.id}.jsonl`));
      const sessions = prefix.toString("utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.type === "session");
      if (sessions.length !== 1 || typeof sessions[0].id !== "string") throw new Error("Native role session is not ready");
      const sessionId = sessions[0].id as string;
      const eventId = digest(canonical({ job: job.id, session: sessionId, key: input.key }));
      const prior = this.db.prepare("SELECT document FROM events WHERE id=?").get(eventId);
      const comparable = (event: FeedbackEvent) => ({ type: event.type, summary: event.summary, findingId: event.findingId,
        correctionId: event.correctionId, resolved: event.resolved });
      const event: FeedbackEvent = { schemaVersion: 1, eventId, findingId: input.type === "finding" ? eventId : input.findingId || "",
        type: input.type, provisional: true, issue: policy.issue, jobId: job.id, sessionId,
        binding: job.binding, createdAt: new Date().toISOString(), summary: input.summary,
        transcript: { bytes: prefix.length, digest: digest(prefix) },
        ...(input.correctionId ? { correctionId: input.correctionId } : {}), ...(input.resolved !== undefined ? { resolved: input.resolved } : {}) };
      if (prior) {
        const receipt = JSON.parse(String(prior.document)) as FeedbackReceipt;
        validateNative(receipt.event, policy);
        if (canonical(comparable(receipt.event)) !== canonical(comparable(event))) throw new Error("Stable issue event key was reused with different content");
        return receipt;
      }
      if (job.state !== "running" || !executorAlive(job.executor)) throw new Error("Only an active authorized native job can emit a new event");
      validateNative(event, policy);
      const role = job.binding.role;
      if ((input.type === "finding" && !["qa", "reviewer"].includes(role)) ||
          (input.type === "correction" && !["implement", "conflict-resolution"].includes(role)) ||
          (input.type === "verification" && !["qa", "reviewer"].includes(role))) throw new Error("Role cannot emit this issue event kind");
      if (input.type === "finding" && (input.findingId || input.correctionId || input.resolved !== undefined)) throw new Error("Finding carries outcome-only fields");
      if (input.type !== "finding") {
        const finding = this.receipt(event.findingId);
        if (finding.event.type !== "finding" || finding.admission !== "admitted") throw new Error("Outcome requires an admitted finding");
        if (input.type === "correction" && (input.correctionId || input.resolved !== undefined)) throw new Error("Correction carries verification-only fields");
        if (input.type === "correction") {
          const work = this.work().find(item => item.id === `${event.findingId}:correction`);
          if (!work || !["ready", "active"].includes(work.state) || !this.correctionCurrent(work, policy)) {
            throw new Error("Correction requires current directed finding work");
          }
        }
        if (input.type === "verification") {
          const correction = this.receipt(input.correctionId || "");
          if (correction.event.type !== "correction" || correction.event.findingId !== event.findingId || correction.admission !== "admitted" ||
              !this.correctedCandidate(correction, policy) ||
              typeof input.resolved !== "boolean") throw new Error("Verification must bind the admitted correction and corrected candidate/attempt");
        }
      }
      const receipt: FeedbackReceipt = { event, publication: "pending", admission: "pending" };
      this.save(receipt);
      return receipt;
    });
  }
  /** Serializes writers across processes, including uncertain POST recovery by stable marker. */
  publish(transport: FeedbackTransport): FeedbackReceipt[] {
    return this.transaction(() => {
      const policy = this.policy();
      const pending = this.receipts().filter(receipt => receipt.publication === "pending");
      if (!pending.length) return this.receipts();
      if (transport.authenticatedLogin().toLowerCase() !== policy.publisher.toLowerCase()) {
        throw new Error("Authenticated publisher differs from the authorized issue publisher");
      }
      const comments = transport.list(policy.issue);
      for (const receipt of pending) {
        validateNative(receipt.event, policy);
        const body = eventBody(receipt.event);
        const matches = comments.filter(comment => comment.author.toLowerCase() === policy.publisher.toLowerCase() && comment.body.startsWith(body));
        if (matches.length > 1) throw new Error("Multiple publications for one stable issue event; inspect retained evidence");
        const comment = matches[0] ?? transport.create(policy.issue, body);
        if (comment.author.toLowerCase() !== policy.publisher.toLowerCase() || !comment.body.startsWith(body)) throw new Error("Publication receipt differs from the authorized event/publisher");
        receipt.comment = comment; receipt.publication = "published"; this.save(receipt);
      }
      return this.receipts();
    });
  }
  /** Comments are data: only exact native-bound local event receipts can enter directed work. */
  poll(transport: FeedbackTransport): FeedbackWork[] {
    return this.transaction(() => {
      const policy = this.policy();
      const pending = this.receipts().filter(receipt => receipt.admission === "pending");
      if (!pending.length) {
        this.refreshWork(policy);
        return this.work();
      }
      const comments = transport.list(policy.issue);
      for (const receipt of pending) {
        const event = receipt.event;
        const comment = comments.find(item => item.author.toLowerCase() === policy.publisher.toLowerCase() && item.body.startsWith(eventBody(event)));
        if (!comment) continue;
        validateNative(event, policy);
        receipt.comment = comment; receipt.publication = "published";
        receipt.admission = this.current(event.binding) ||
          (event.type === "correction" && this.correctedCandidate(receipt, policy)) ? "admitted" : "superseded";
        if (receipt.admission === "admitted") {
          if (event.type === "finding" || event.type === "correction") {
            if (event.type === "correction") {
              const finding = this.receipt(event.findingId);
              if (finding.admission !== "admitted") throw new Error("Correction finding is not admitted");
              const previous = this.work().find(item => item.id === `${event.findingId}:correction`);
              if (previous) this.saveWork({ ...previous, state: "completed", outcome: event.eventId });
            }
            if (event.type === "finding") this.saveWork({ id: `${event.eventId}:correction`, eventId: event.eventId, findingId: event.findingId,
              kind: "correction", owner: policy.owner, role: "implement", sha: event.binding.sha, iteration: event.binding.iteration,
              attempt: event.binding.attempt, state: "ready", source: comment.url });
          } else {
            const correction = this.receipt(event.correctionId || "");
            if (correction.admission !== "admitted" || !this.correctedCandidate(correction, policy)) throw new Error("Verification correction is not current");
            const work = this.work().find(item => item.id === `${event.correctionId}:verification`);
            if (!work) throw new Error("Verification lacks admitted work");
            this.saveWork({ ...work, state: "completed", outcome: event.eventId });
          }
        }
        this.save(receipt);
      }
      this.refreshWork(policy);
      return this.work();
    });
  }
  claim(id: string, owner: string): FeedbackWork {
    return this.transaction(() => {
      if (owner !== this.policy().owner) throw new Error("Directed issue work belongs to the retained run owner");
      const work = this.work().find(item => item.id === id);
      if (!work || work.sha !== this.policy().candidate.sha || work.iteration !== this.policy().candidate.iteration ||
          !["ready", "active"].includes(work.state)) throw new Error("Issue work is not ready for this candidate");
      const claimed: FeedbackWork = { ...work, state: "active" }; this.saveWork(claimed); return claimed;
    });
  }
  /** A resolution is feedback only; it cannot replace independent quality receipt admission. */
  resolution(findingId: string): FeedbackEvent | undefined {
    return this.receipts().filter(receipt => receipt.admission === "admitted" && receipt.event.type === "verification" &&
      receipt.event.findingId === findingId && this.current(receipt.event.binding)).at(-1)?.event;
  }
  project(transport: FeedbackTransport): void {
    this.transaction(() => {
      const policy = this.policy();
      for (const receipt of this.receipts()) {
        if (!receipt.comment) continue;
        const event = receipt.event;
        const work = this.work().find(item => item.eventId === event.eventId);
        const resolution = this.resolution(event.findingId);
        const superseded = receipt.admission === "superseded" || work?.state === "superseded" ||
          (work?.outcome && this.receipt(work.outcome).admission === "superseded") ||
          (event.type === "verification" && !this.current(event.binding));
        const status = superseded ? "superseded candidate (history retained)" :
          receipt.admission === "pending" ? "publication observed; awaiting admission" :
          resolution ? `verification ${resolution.resolved ? "resolved" : "unresolved"} for ${resolution.binding.sha}` : work?.state || receipt.admission;
        const body = `${eventBody(event)}\n\n### Directed work status\n${status}\n` +
          `Finding: \`${event.findingId}\`${event.correctionId ? `; correction: \`${event.correctionId}\`` : ""}.\n` +
          (work ? `Work: \`${work.id}\`; owner: \`${work.owner}\`; role: ${work.role}; state: ${work.state}.\n` : "") +
          "This status records issue feedback, not current quality acceptance.\n";
        if (receipt.comment.body !== body) {
          transport.update(policy.issue, receipt.comment.id, body);
          receipt.comment.body = body; this.save(receipt);
        }
      }
    });
  }
}

/** Existing run ownership and canonical scope are authority; issue text is never authority. */
export function authorizeFeedbackOwner(state: string, owner: string): { repo: string; worktree: string; run: string; issue: string } {
  const receipt = JSON.parse(readFileSync(join(state, "receipt.json"), "utf8"));
  const identity = JSON.parse(readFileSync(join(state, "identity"), "utf8"));
  const execution = receipt.initial?.execution;
  const issueParam = (execution?.parameters as string[] | undefined)?.find(value => /^ISSUE=[1-9][0-9]*$/.test(value));
  if (receipt.schemaVersion !== 1 || receipt.runReceipt?.dag !== "feature" || !issueParam || !owner ||
      execution.ompSession !== owner || identity.session !== owner || identity.run !== receipt.runReceipt.run ||
      identity.primary !== execution.primary || realpathSync(identity.primary) !== identity.primary || realpathSync(identity.worktree) !== identity.worktree) throw new Error("Issue feedback owner/scope differs from the existing admitted run");
  const canonicalState = execFileSync("git", ["-C", identity.primary, "rev-parse", "--path-format=absolute", "--git-path", `dagu-feature/runs/${identity.run}`], { encoding: "utf8" }).trim();
  const common = (path: string) => realpathSync(execFileSync("git", ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
  if (realpathSync(state) !== realpathSync(canonicalState) || common(identity.primary) !== common(identity.worktree)) throw new Error("Issue feedback run/worktree is outside the admitted canonical repository");
  const origin = execFileSync("git", ["-C", identity.primary, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  const repository = /(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/.exec(origin)?.[1];
  if (!repository) throw new Error("Issue feedback requires the admitted GitHub repository");
  return { repo: identity.primary, worktree: identity.worktree, run: identity.run, issue: `${repository}#${issueParam.slice(6)}` };
}

let authenticatedGithubLogin: string | undefined;
export function githubFeedbackTransport(): FeedbackTransport {
  const api = (...args: string[]) => JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
  const endpoint = (issue: string) => `repos/${issue.replace("#", "/issues/")}/comments`;
  const comment = (row: { id: number; html_url: string; body: string; user: { login: string } }): FeedbackComment => ({ id: row.id, url: row.html_url, body: row.body, author: row.user.login });
  return {
    authenticatedLogin: () => authenticatedGithubLogin ??= api("user").login,
    list: issue => (api("--paginate", "--slurp", `${endpoint(issue)}?per_page=100`) as Parameters<typeof comment>[0][][]).flat().map(comment),
    create: (issue, body) => comment(api(endpoint(issue), "-f", `body=${body}`)),
    update: (issue, id, body) => { api(`repos/${issue.split("#")[0]}/issues/comments/${id}`, "--method", "PATCH", "-f", `body=${body}`); },
  };
}
