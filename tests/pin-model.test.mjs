import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const worktreeRoot = fileURLToPath(new URL("../", import.meta.url));
const defaults = {
  defaultProvider: "anthropic",
  defaultModel: "claude-sonnet-4-5",
  defaultThinkingLevel: "high",
  theme: "dark",
  editorPaddingX: 2,
  packages: ["./example-extension"],
  retry: { enabled: false, maxRetries: 2 },
};
const originalPin = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  thinkingLevel: "high",
};
let importNumber = 0;

function createInstance(extension) {
  const handlers = new Map();
  const commands = new Map();
  const notifications = [];
  const ctx = {
    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    thinkingLevel: "high",
    ui: { notify: (...args) => notifications.push(args) },
  };
  extension({
    on(name, handler) {
      assert.equal(handlers.has(name), false);
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    registerCommand(name, command) {
      assert.equal(commands.has(name), false);
      commands.set(name, command);
    },
  });
  assert.deepEqual([...handlers.keys()], ["session_start", "model_select", "session_shutdown"]);
  assert.deepEqual([...commands.keys()], ["pin-model"]);
  return {
    ctx,
    notifications,
    emit: (name, event = {}) => handlers.get(name)(event, ctx),
    command: (args) => commands.get("pin-model").handler(args, ctx),
  };
}

async function createHarness(t, { settings = defaults, pin } = {}) {
  const temporaryRoot = join(worktreeRoot, ".worktrees");
  mkdirSync(temporaryRoot, { recursive: true });
  const dir = mkdtempSync(join(temporaryRoot, "pin-model-test-"));
  const settingsPath = join(dir, "settings.json");
  const pinPath = join(dir, "pinned-model.json");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  });
  if (settings !== null) {
    writeFileSync(settingsPath, typeof settings === "string" ? settings : JSON.stringify(settings));
  }
  if (pin !== undefined) {
    writeFileSync(pinPath, typeof pin === "string" ? pin : JSON.stringify(pin));
  }
  process.env.PI_CODING_AGENT_DIR = dir;
  const moduleUrl = new URL("../src/index.ts", import.meta.url);
  moduleUrl.searchParams.set("test", String(++importNumber));
  const { default: extension } = await import(moduleUrl.href);
  const instance = createInstance(extension);
  return {
    ...instance,
    dir,
    settingsPath,
    pinPath,
    createInstance: () => createInstance(extension),
    readSettings: () => JSON.parse(readFileSync(settingsPath, "utf8")),
    readPin: () => JSON.parse(readFileSync(pinPath, "utf8")),
    writeSettings: (data) => writeFileSync(settingsPath, JSON.stringify(data)),
  };
}

test("automatically seeds a missing pin from defaults, including thinking, in an isolated directory", async (t) => {
  const h = await createHarness(t);
  assert.ok(h.dir.startsWith(join(worktreeRoot, ".worktrees", "pin-model-test-")));
  assert.equal(process.env.PI_CODING_AGENT_DIR, h.dir);
  assert.deepEqual(h.readPin(), originalPin);
  assert.deepEqual(h.readSettings(), defaults);
  assert.deepEqual(h.notifications, []);
});

test("auto-seeding omits thinking when settings have no thinking default", async (t) => {
  const { defaultThinkingLevel, ...settings } = defaults;
  const h = await createHarness(t, { settings });
  assert.deepEqual(h.readPin(), { provider: "anthropic", model: "claude-sonnet-4-5" });
  assert.deepEqual(h.readSettings(), settings);
});

test("loading preserves an existing pin and defers restoration until a lifecycle event", async (t) => {
  const settings = { ...defaults, defaultProvider: "openai", defaultModel: "example-model" };
  const h = await createHarness(t, { settings, pin: originalPin });
  assert.deepEqual(h.readPin(), originalPin);
  assert.deepEqual(h.readSettings(), settings);
  await h.emit("session_start", { reason: "startup" });
  assert.deepEqual(h.readSettings(), defaults);
});

for (const eventName of ["session_start", "session_shutdown"]) {
  test(`${eventName} restores provider, model, and thinking while preserving unrelated fields`, async (t) => {
    const h = await createHarness(t);
    const drifted = {
      ...defaults,
      defaultProvider: "openai",
      defaultModel: "example-model",
      defaultThinkingLevel: "low",
      theme: "light",
      extraState: { keep: ["example", 7] },
    };
    h.writeSettings(drifted);
    await h.emit(eventName, { reason: eventName === "session_start" ? "resume" : "new" });
    assert.deepEqual(h.readSettings(), {
      ...drifted,
      defaultProvider: defaults.defaultProvider,
      defaultModel: defaults.defaultModel,
      defaultThinkingLevel: defaults.defaultThinkingLevel,
    });
    assert.deepEqual(h.readPin(), originalPin);
    assert.deepEqual(h.notifications, []);
  });
}

test("thinking-only drift is restored even when provider and model still match", async (t) => {
  const h = await createHarness(t);
  h.writeSettings({ ...defaults, defaultThinkingLevel: "off" });
  await h.emit("session_start");
  assert.deepEqual(h.readSettings(), defaults);
});

test("matching defaults are not rewritten or reformatted at lifecycle boundaries", async (t) => {
  const rawSettings = `${JSON.stringify(defaults)}\n\n`;
  const h = await createHarness(t, { settings: rawSettings, pin: originalPin });
  await h.emit("session_start");
  await h.emit("session_shutdown");
  assert.equal(readFileSync(h.settingsPath, "utf8"), rawSettings);
});

test("a pin without thinking restores only provider and model", async (t) => {
  const pin = { provider: "anthropic", model: "claude-sonnet-4-5" };
  const settings = {
    ...defaults,
    defaultProvider: "openai",
    defaultModel: "example-model",
    defaultThinkingLevel: "low",
  };
  const h = await createHarness(t, { settings, pin });
  await h.emit("session_shutdown");
  assert.deepEqual(h.readSettings(), { ...defaults, defaultThinkingLevel: "low" });
  assert.deepEqual(h.readPin(), pin);
});

test("--show reports the pinned provider/model without modifying either file", async (t) => {
  const h = await createHarness(t);
  const settingsBefore = readFileSync(h.settingsPath, "utf8");
  const pinBefore = readFileSync(h.pinPath, "utf8");
  await h.command("  --show  ");
  assert.deepEqual(h.notifications, [["Pinned default: anthropic/claude-sonnet-4-5", "info"]]);
  assert.equal(readFileSync(h.settingsPath, "utf8"), settingsBefore);
  assert.equal(readFileSync(h.pinPath, "utf8"), pinBefore);
});

test("--clear removes only the pin and stops restoration/selection notices in the current instance", async (t) => {
  const h = await createHarness(t);
  const drifted = { ...defaults, defaultProvider: "openai", defaultModel: "example-model" };
  h.writeSettings(drifted);
  const settingsBefore = readFileSync(h.settingsPath, "utf8");
  await h.command("--clear");
  assert.equal(existsSync(h.pinPath), false);
  assert.equal(readFileSync(h.settingsPath, "utf8"), settingsBefore);
  await h.emit("model_select", { source: "set", model: { provider: "openai", id: "example-model" } });
  await h.emit("session_start");
  await h.emit("session_shutdown");
  assert.equal(readFileSync(h.settingsPath, "utf8"), settingsBefore);
  await h.command("--show");
  assert.deepEqual(h.notifications, [
    ["Pin cleared. Mid-session switches will persist again (pi default behavior).", "info"],
    ["No pinned model.", "info"],
  ]);
  await h.command("--clear");
  assert.equal(existsSync(h.pinPath), false);
});

test("a new extension instance re-seeds a cleared pin from the current saved defaults", async (t) => {
  const h = await createHarness(t);
  await h.command("--clear");
  h.writeSettings({ ...defaults, defaultProvider: "openai", defaultModel: "example-model" });
  const next = h.createInstance();
  await next.emit("session_start", { reason: "reload" });
  assert.deepEqual(h.readPin(), { provider: "openai", model: "example-model", thinkingLevel: "high" });
  assert.deepEqual(h.readSettings(), { ...defaults, defaultProvider: "openai", defaultModel: "example-model" });
});

test("explicit provider/model pinning restores defaults immediately and does not switch the active model", async (t) => {
  const h = await createHarness(t);
  const active = structuredClone(h.ctx.model);
  await h.command("  openai/example/model-id  ");
  assert.deepEqual(h.readPin(), { provider: "openai", model: "example/model-id" });
  assert.deepEqual(h.readSettings(), { ...defaults, defaultProvider: "openai", defaultModel: "example/model-id" });
  assert.deepEqual(h.ctx.model, active);
  assert.deepEqual(h.notifications, [[
    "Default pinned → openai/example/model-id. Mid-session switches won't change it.",
    "info",
  ]]);
});

test("pinning the active model omits its thinking level and preserves the saved thinking default", async (t) => {
  const h = await createHarness(t);
  h.ctx.model = { provider: "example-provider", id: "example-model" };
  h.ctx.thinkingLevel = "max";
  await h.command(undefined);
  assert.deepEqual(h.readPin(), { provider: "example-provider", model: "example-model" });
  assert.deepEqual(h.readSettings(), {
    ...defaults,
    defaultProvider: "example-provider",
    defaultModel: "example-model",
    defaultThinkingLevel: "high",
  });
  assert.deepEqual(h.ctx.model, { provider: "example-provider", id: "example-model" });
});

test("invalid arguments or an unavailable current model warn without changing files", async (t) => {
  const h = await createHarness(t);
  const settingsBefore = readFileSync(h.settingsPath, "utf8");
  const pinBefore = readFileSync(h.pinPath, "utf8");
  await h.command("missing-separator");
  h.ctx.model = undefined;
  await h.command("");
  const warning = ["Usage: /pin-model [provider/model]  (or run it with the desired model active)", "warning"];
  assert.deepEqual(h.notifications, [warning, warning]);
  assert.equal(readFileSync(h.settingsPath, "utf8"), settingsBefore);
  assert.equal(readFileSync(h.pinPath, "utf8"), pinBefore);
});

test("session model switches notify without immediate restoration and ignore source restore", async (t) => {
  const h = await createHarness(t);
  const selected = { provider: "openai", id: "example-model" };
  h.ctx.model = selected;
  const drifted = { ...defaults, defaultProvider: selected.provider, defaultModel: selected.id };
  h.writeSettings(drifted);
  for (const source of ["set", "cycle", "restore"]) {
    await h.emit("model_select", { source, model: selected });
    assert.deepEqual(h.readSettings(), drifted);
    assert.deepEqual(h.readPin(), originalPin);
    assert.equal(h.ctx.model, selected);
  }
  const notice = ["Session: openai/example-model · default pinned → anthropic/claude-sonnet-4-5", "info"];
  assert.deepEqual(h.notifications, [notice, notice]);
  await h.emit("session_shutdown", { reason: "resume" });
  assert.deepEqual(h.readSettings(), defaults);
  assert.equal(h.ctx.model, selected);
});

test("session replacements preserve the pin across shutdown and a fresh instance's startup", async (t) => {
  const h = await createHarness(t);
  let instance = h;
  for (const reason of ["new", "resume", "fork"]) {
    const drifted = { ...defaults, defaultProvider: "openai", defaultModel: `example-${reason}` };
    h.writeSettings(drifted);
    await instance.emit("session_shutdown", { reason });
    assert.deepEqual(h.readSettings(), defaults);
    instance = h.createInstance();
    instance.ctx.model = { provider: "openai", id: `session-${reason}` };
    h.writeSettings(drifted);
    await instance.emit("session_start", { reason });
    assert.deepEqual(h.readSettings(), defaults);
    assert.deepEqual(h.readPin(), originalPin);
    assert.deepEqual(instance.ctx.model, { provider: "openai", id: `session-${reason}` });
    assert.deepEqual(instance.notifications, []);
  }
});

test("missing settings are not created, even when explicitly pinning a model", async (t) => {
  const h = await createHarness(t, { settings: null });
  assert.equal(existsSync(h.pinPath), false);
  await h.command("--show");
  assert.deepEqual(h.notifications, [["No pinned model.", "info"]]);
  await h.command("openai/example-model");
  await h.emit("session_start");
  await h.emit("session_shutdown");
  assert.equal(existsSync(h.settingsPath), false);
  assert.deepEqual(h.readPin(), { provider: "openai", model: "example-model" });
});

test("malformed settings are left untouched at lifecycle boundaries", async (t) => {
  const rawSettings = "{invalid JSON";
  const h = await createHarness(t, { settings: rawSettings, pin: originalPin });
  await h.emit("session_start");
  await h.emit("session_shutdown");
  assert.equal(readFileSync(h.settingsPath, "utf8"), rawSettings);
  assert.deepEqual(h.readPin(), originalPin);
});

test("an existing malformed pin is not silently replaced or used for restoration", async (t) => {
  const h = await createHarness(t, { pin: "{invalid JSON" });
  await h.emit("session_start");
  await h.emit("session_shutdown");
  await h.command("--show");
  assert.deepEqual(h.notifications, [["No pinned model.", "info"]]);
  assert.equal(readFileSync(h.pinPath, "utf8"), "{invalid JSON");
  assert.deepEqual(h.readSettings(), defaults);
});
