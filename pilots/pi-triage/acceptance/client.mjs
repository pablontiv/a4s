// A disposable stand-in for an interface process, not T3 or a Dagu backend.
const [origin, dag, data] = process.argv.slice(2);
const url = new URL(origin);
if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" ||
    !/^\/a4s-pi-triage-[0-9a-f-]+$/.test(url.pathname) || dag !== "pi-triage-slice") {
  throw new Error("Solo se admite la estación local privada del harness.");
}
const response = await fetch(`${origin}/api/v1/dags/${dag}/start`, {
  method: "POST", headers: { "content-type": "application/json" }, body: data,
  redirect: "error", signal: AbortSignal.timeout(5_000),
});
process.send({ status: response.status, ok: response.ok, text: await response.text() });
// Remain alive until the harness closes this interface. There is no backend child.
process.on("disconnect", () => process.exit());
