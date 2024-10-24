import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readServiceEnvironment, serviceEnvironmentPath } from "../src/service-environment.ts";
import { declareService } from "../../issue-lifecycle/test/fixtures/service-environment.ts";

test("service declaration is explicitly selected, literal and independent of caller PATH", () => {
  const home = mkdtempSync(join(tmpdir(), "a4s-service-contract-"));
  try {
    const env = declareService(home, "http://127.0.0.1:18765");
    const before = readFileSync(env.A4S_SERVICE_ENV!, "utf8");
    const expected = JSON.parse(before);
    for (const PATH of ["/unrelated", process.env.PATH]) assert.deepEqual(readServiceEnvironment({ ...env, PATH }), expected);
    assert.deepEqual(readServiceEnvironment({ A4S_SERVICE_ENV: env.A4S_SERVICE_ENV }), expected);
    assert.equal(readFileSync(env.A4S_SERVICE_ENV!, "utf8"), before);
    assert.throws(() => readServiceEnvironment({ A4S_SERVICE_ENV: "relative.json" }), /field=A4S_SERVICE_ENV/);
    assert.throws(() => readServiceEnvironment({ A4S_SERVICE_ENV: join(home, "absent") }), /field=A4S_SERVICE_ENV.*cannot read/);
    assert.throws(() => readServiceEnvironment({ A4S_SERVICE_ENV: home }), /field=A4S_SERVICE_ENV.*cannot read/);
    assert.throws(() => readServiceEnvironment({ ...env, DAGU_HOME: join(home, "other") }), /field=DAGU_HOME.*does not match/);
    assert.throws(() => readServiceEnvironment({ ...env, DAGU_URL: "http://127.0.0.1:18766" }), /field=DAGU_URL.*does not match/);
    assert.throws(() => readServiceEnvironment({ ...env, DAGU_PORT: "8080" }), /field=DAGU_PORT.*does not match/);
    assert.equal(readServiceEnvironment({ ...env, DAGU_PORT: "18765" }).DAGU_URL, expected.DAGU_URL);
    writeFileSync(env.A4S_SERVICE_ENV!, JSON.stringify({ ...expected, DAGU_URL: `${expected.DAGU_URL}///` }));
    assert.equal(readServiceEnvironment(env).DAGU_URL, expected.DAGU_URL);
    for (const [field, values] of Object.entries({
      DAGU_URL: [undefined, "", 1, "not a URL", "https://127.0.0.1:1234", "http://example.com:1234", "http://user:pass@localhost:1234", "http://localhost:0", "http://localhost:1234/path", "http://localhost:1234?auth=x"],
      DAGU_HOME: [undefined, "", 1, "relative", "~/dagu", "/bad\npath", join(home, "absent"), env.A4S_SERVICE_ENV],
      PATH: [undefined, "", 1, "relative", "/bin:", "/missing-service-tools"],
    })) {
      for (const value of values) {
        writeFileSync(env.A4S_SERVICE_ENV!, JSON.stringify({ ...expected, [field]: value }));
        assert.throws(() => readServiceEnvironment({ A4S_SERVICE_ENV: env.A4S_SERVICE_ENV, PATH: process.env.PATH }), new RegExp(`field=${field}`));
      }
    }
    for (const text of ["{broken", "null", "[]"]) {
      writeFileSync(env.A4S_SERVICE_ENV!, text);
      assert.throws(() => readServiceEnvironment(env), /field=A4S_SERVICE_ENV/);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("declaration discovery uses XDG, then user home, with an explicit absolute override", () => {
  const home = mkdtempSync(join(tmpdir(), "a4s default service "));
  try {
    const override = declareService(home, "http://127.0.0.1:18765");
    const expected = readServiceEnvironment(override);
    const config = join(home, "xdg config");
    const xdgFile = join(config, "a4s", "service-environment.json");
    const homeFile = join(home, ".config", "a4s", "service-environment.json");
    for (const file of [xdgFile, homeFile]) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify(expected));
    }
    assert.deepEqual(readServiceEnvironment({ HOME: home, XDG_CONFIG_HOME: config }), expected);
    for (const XDG_CONFIG_HOME of [undefined, "", "relative"]) {
      assert.equal(serviceEnvironmentPath({ HOME: home, XDG_CONFIG_HOME }), homeFile);
      assert.deepEqual(readServiceEnvironment({ HOME: home, XDG_CONFIG_HOME }), expected);
    }
    assert.equal(serviceEnvironmentPath({}), join(homedir(), ".config", "a4s", "service-environment.json"));
    writeFileSync(xdgFile, "{broken default");
    assert.deepEqual(readServiceEnvironment({ ...override, HOME: home, XDG_CONFIG_HOME: config }), expected);
    assert.throws(() => readServiceEnvironment({ HOME: home, XDG_CONFIG_HOME: config }), /malformed JSON/);
    assert.throws(() => readServiceEnvironment({ A4S_SERVICE_ENV: "", HOME: home }), /field=A4S_SERVICE_ENV/);
    const missing = join(home, "missing config");
    assert.throws(() => readServiceEnvironment({ HOME: home, XDG_CONFIG_HOME: missing }), error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(join(missing, "a4s", "service-environment.json")));
      assert.match(error.message, /ready=no.*cannot read declaration/);
      return true;
    });
    rmSync(homeFile);
    assert.throws(() => readServiceEnvironment({ HOME: home }), error => {
      assert.ok(error instanceof Error && error.message.includes(homeFile));
      return true;
    });
    assert.throws(() => readServiceEnvironment({ ...override, A4S_SERVICE_ENV: join(home, "missing override"), XDG_CONFIG_HOME: config }), /cannot read declaration/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
