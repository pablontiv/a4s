// PoC a4s#149: read-only dashboard over live omp session transcripts.
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";

const SESS = `${process.env.HOME}/.omp/agent/sessions`;
const PORT = Number(process.env.PORT ?? 7788);
const SESS_RE = SESS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ROOT_RE = new RegExp(`^${SESS_RE}/[^/]+/[^/]+\\.jsonl$`);
const SUB_RE = new RegExp(`^${SESS_RE}/[^/]+/[^/]+/[^/]+\\.jsonl$`);
const STALE_MS = 15 * 60_000;

type Task = { content: string; status: string };
type Phase = { name: string; tasks: Task[] };
type Option = string | { label: string };
type Question = { question?: string; options?: Option[] };
type Block = { type: string; text?: string; name?: string; id?: string; arguments?: Question & { questions?: Question[] } };
type Entry = {
  type: string;
  id?: string;
  timestamp?: string;
  cwd?: string;
  title?: string;
  model?: string;
  customType?: string;
  data?: { toolCallId?: string; toolName?: string; intent?: string; startedAt?: string };
  message?: {
    role?: string;
    stopReason?: string;
    content?: Block[] | string;
    usage?: { totalTokens?: number; cost?: { total?: number } };
    toolCallId?: string;
    toolName?: string;
    details?: { phases?: Phase[] };
  };
};
type Ask = { id: string; at: number; questions: { question: string; options: string[] }[] };
type FileState = {
  offset: number;
  rest: string;
  id: string;
  cwd: string;
  title: string;
  model: string;
  phases: Phase[];
  asks: Map<string, Ask>;
  tools: Map<string, { name: string; intent: string; startedAt: number }>;
  lastRole: string;
  lastStop: string;
  lastAt: number;
  lastAssistantId: string;
  lastAssistantText: string;
  cost: number;
  tokens: number;
};
type OrcaTerminal = { handle: string; worktreePath: string; title: string | null };
type Proc = { pid: number; tty: string; cwd: string; file: string | null; mapping: "fd" | "inferida"; subagents: number };

const files = new Map<string, FileState>();

const sh = (cmd: string[]) => Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" }).stdout.toString();

function apply(s: FileState, e: Entry) {
  const ts = Date.parse(e.timestamp ?? "") || 0;
  if (e.type === "session") {
    s.id = e.id ?? "";
    s.cwd = e.cwd ?? "";
  } else if (e.type === "title_change") s.title = e.title ?? s.title;
  else if (e.type === "model_change") s.model = e.model ?? s.model;
  else if (e.type === "custom" && e.customType === "tool_execution_start" && e.data?.toolCallId) {
    const d = e.data;
    s.tools.set(d.toolCallId, { name: d.toolName ?? "", intent: d.intent ?? "", startedAt: Date.parse(d.startedAt ?? "") || ts });
    s.lastAt = ts;
  } else if (e.type === "message" && e.message) {
    const m = e.message;
    const blocks = Array.isArray(m.content) ? m.content : [];
    s.lastRole = m.role ?? "";
    s.lastAt = ts;
    if (m.role === "assistant") {
      s.lastStop = m.stopReason ?? "";
      s.lastAssistantId = e.id ?? "";
      const text = blocks.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("\n").trim();
      if (text) s.lastAssistantText = text;
      s.cost += m.usage?.cost?.total ?? 0;
      s.tokens += m.usage?.totalTokens ?? 0;
      for (const b of blocks) {
        if (b.type !== "toolCall" || b.name !== "ask" || !b.id) continue;
        const qs = b.arguments?.questions ?? [b.arguments ?? {}];
        s.asks.set(b.id, {
          id: b.id,
          at: ts,
          questions: qs.map((q) => ({
            question: q.question ?? "",
            options: (q.options ?? []).map((o) => (typeof o === "string" ? o : o.label)),
          })),
        });
      }
    } else if (m.role === "toolResult" && m.toolCallId) {
      s.asks.delete(m.toolCallId);
      s.tools.delete(m.toolCallId);
      if (m.toolName === "todo" && Array.isArray(m.details?.phases)) s.phases = m.details.phases;
    } else if (m.role === "user") {
      s.asks.clear();
      s.tools.clear();
    }
  }
}

function load(path: string): FileState {
  let s = files.get(path);
  if (!s) {
    s = {
      offset: 0, rest: "", id: "", cwd: "", title: "", model: "", phases: [], asks: new Map(), tools: new Map(),
      lastRole: "", lastStop: "", lastAt: 0, lastAssistantId: "", lastAssistantText: "", cost: 0, tokens: 0,
    };
    files.set(path, s);
  }
  const fd = openSync(path, "r");
  try {
    // Line 1 is a padded `title` record omp rewrites in place, so re-read it every poll.
    const head = Buffer.alloc(4096);
    const firstLine = head.subarray(0, readSync(fd, head, 0, head.length, 0)).toString("utf8").split("\n")[0];
    try {
      // Transcript lines are omp's own persisted record format.
      const first = JSON.parse(firstLine) as Entry;
      if (first.type === "title" && first.title) s.title = first.title;
    } catch {}
    const size = statSync(path).size;
    if (size > s.offset) {
      const buf = Buffer.alloc(size - s.offset);
      readSync(fd, buf, 0, buf.length, s.offset);
      s.offset = size;
      const lines = (s.rest + buf.toString("utf8")).split("\n");
      s.rest = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        try {
          apply(s, JSON.parse(line) as Entry);
        } catch {}
      }
    }
  } finally {
    closeSync(fd);
  }
  return s;
}

function discover(): Proc[] {
  const procs = new Map<number, Proc>();
  for (const line of sh(["ps", "-axo", "pid=,tty=,command="]).split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+bun \S+\/bin\/omp(\s|$)/);
    if (!m || m[2] === "??") continue; // interactive sessions only
    procs.set(Number(m[1]), { pid: Number(m[1]), tty: m[2], cwd: "", file: null, mapping: "fd", subagents: 0 });
  }
  if (!procs.size) return [];
  let pid = 0;
  let fd = "";
  for (const line of sh(["lsof", "-nP", "-p", [...procs.keys()].join(","), "-Fpfn"]).split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "f") fd = line.slice(1);
    else if (line[0] === "n") {
      const p = procs.get(pid);
      if (!p) continue;
      const name = line.slice(1);
      if (fd === "cwd") p.cwd = name;
      else if (ROOT_RE.test(name)) p.file = name;
      else if (SUB_RE.test(name)) p.subagents++;
    }
  }
  const claimed = new Set([...procs.values()].flatMap((p) => (p.file ? [p.file] : [])));
  for (const p of procs.values()) {
    if (p.file || !p.cwd) continue;
    // Resumed session with no write yet holds no fd: take the newest unclaimed transcript for that cwd.
    const dir = `${SESS}/-${p.cwd.replaceAll("/", "-")}--`;
    try {
      const cand = readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl") && !claimed.has(`${dir}/${f}`))
        .map((f) => ({ path: `${dir}/${f}`, mtime: statSync(`${dir}/${f}`).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0];
      if (cand) {
        p.file = cand.path;
        p.mapping = "inferida";
        claimed.add(cand.path);
      }
    } catch {}
  }
  return [...procs.values()];
}

let orca = { at: 0, terms: [] as OrcaTerminal[] };
function orcaTerminals(): OrcaTerminal[] {
  if (Date.now() - orca.at > 10_000) {
    let terms: OrcaTerminal[] = [];
    try {
      // Orca CLI JSON envelope: { result: { terminals: [...] } }; its own documented output.
      const envelope = JSON.parse(sh(["orca", "terminal", "list", "--json"])) as { result?: { terminals?: OrcaTerminal[] } };
      terms = envelope.result?.terminals ?? [];
    } catch {}
    orca = { at: Date.now(), terms };
  }
  return orca.terms;
}

function snapshot() {
  const now = Date.now();
  const terms = orcaTerminals();
  const rows = discover().flatMap((p) => {
    if (!p.file) return [];
    const s = load(p.file);
    const pending = [...s.tools.values()].filter((t) => t.name !== "ask").sort((a, b) => b.startedAt - a.startedAt);
    let state: string;
    if (s.asks.size) state = "esperando";
    else if (s.lastRole === "assistant" && s.lastStop === "stop") state = "terminado";
    else if (s.lastRole === "assistant" && (s.lastStop === "aborted" || s.lastStop === "error")) state = "detenido";
    else if (s.lastRole && (pending.length || now - s.lastAt < STALE_MS)) state = "trabajando";
    else state = "inactiva";
    const all = s.phases.flatMap((ph) => ph.tasks);
    // omp's todo HUD shows the active phase as "<roman>. <name> · done/total".
    const phaseIdx = Math.max(
      0,
      [
        s.phases.findIndex((ph) => ph.tasks.some((t) => t.status === "in_progress")),
        s.phases.findIndex((ph) => ph.tasks.some((t) => t.status === "pending")),
        s.phases.length - 1,
      ].find((i) => i >= 0) ?? 0,
    );
    const phase = s.phases[phaseIdx];
    // omp sets the terminal title to "π - <session title> - <cwd basename>"; the session cwd may sit outside the Orca worktree.
    const key = s.title.trim().slice(0, 40);
    const base = s.cwd.split("/").pop() ?? "";
    const term = key
      ? terms.find((t) => (t.title ?? "").includes(key) && (t.title ?? "").endsWith(` - ${base}`)) ??
        terms.find((t) => t.worktreePath === s.cwd && (t.title ?? "").includes(key))
      : undefined;
    return [{
      pid: p.pid, tty: p.tty, mapping: p.mapping, file: p.file, subagents: p.subagents,
      id: s.id, cwd: s.cwd, repo: s.cwd.split("/").pop() ?? "", title: s.title || "(sin título)", model: s.model,
      state, lastAt: s.lastAt, lastAssistantId: s.lastAssistantId, lastAssistantText: s.lastAssistantText.slice(0, 400),
      asks: [...s.asks.values()],
      current: pending[0] ? { tool: pending[0].name, intent: pending[0].intent, elapsedMs: now - pending[0].startedAt } : null,
      todo: s.phases.length
        ? {
            phaseNo: phaseIdx + 1,
            phase: phase?.name ?? "",
            done: phase?.tasks.filter((t) => t.status === "completed").length ?? 0,
            total: phase?.tasks.length ?? 0,
            allDone: all.filter((t) => t.status === "completed").length,
            allTotal: all.length,
            tasks: phase?.tasks ?? [],
          }
        : null,
      cost: s.cost, tokens: s.tokens,
      terminal: term?.handle ?? null,
      terminalMatch: term ? "título" : "",
    }];
  });
  // omp's OSC title is lost when Orca's terminal host restarts under a running session (title null):
  // pair the one unclaimed terminal of a worktree with the one unpaired session of that cwd.
  const claimed = new Set(rows.flatMap((r) => (r.terminal ? [r.terminal] : [])));
  for (const r of rows) {
    if (r.terminal) continue;
    const freeTerms = terms.filter((t) => t.worktreePath === r.cwd && !claimed.has(t.handle));
    const freeRows = rows.filter((o) => o.cwd === r.cwd && !o.terminal);
    if (freeTerms.length === 1 && freeRows.length === 1) {
      r.terminal = freeTerms[0].handle;
      r.terminalMatch = "única en cwd";
      claimed.add(r.terminal);
    }
  }
  return rows;
}

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/sessions") return Response.json({ at: Date.now(), sessions: snapshot() });
    if (url.pathname === "/api/focus" && req.method === "POST") {
      const body: unknown = await req.json();
      const handle = body && typeof body === "object" && "handle" in body ? body.handle : undefined;
      if (typeof handle !== "string" || !/^term_[0-9a-f-]+$/.test(handle)) return new Response("bad handle", { status: 400 });
      return new Response(sh(["orca", "terminal", "switch", "--terminal", handle, "--json"]), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/") return new Response(Bun.file(`${import.meta.dir}/index.html`));
    return new Response("not found", { status: 404 });
  },
});
console.log(`omp dashboard on http://127.0.0.1:${PORT}`);
