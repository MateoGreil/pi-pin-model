import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const PIN_FILE = join(AGENT_DIR, "pinned-model.json");
const SETTINGS_FILE = join(AGENT_DIR, "settings.json");

interface Pin {
  provider: string;
  model: string;
  thinkingLevel?: string;
}

function readPin(): Pin | null {
  try {
    const data = JSON.parse(readFileSync(PIN_FILE, "utf-8"));
    if (typeof data.provider === "string" && typeof data.model === "string") {
      const pin: Pin = { provider: data.provider, model: data.model };
      if (typeof data.thinkingLevel === "string") pin.thinkingLevel = data.thinkingLevel;
      return pin;
    }
  } catch {}
  return null;
}

function writePin(pin: Pin): void {
  mkdirSync(dirname(PIN_FILE), { recursive: true });
  writeFileSync(PIN_FILE, `${JSON.stringify(pin, null, 2)}\n`, "utf-8");
}

function readSettingsDefaults(): Pin | null {
  try {
    const data = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    if (typeof data.defaultProvider === "string" && typeof data.defaultModel === "string") {
      const pin: Pin = { provider: data.defaultProvider, model: data.defaultModel };
      if (typeof data.defaultThinkingLevel === "string") pin.thinkingLevel = data.defaultThinkingLevel;
      return pin;
    }
  } catch {}
  return null;
}

function writeSettingsDefaults(pin: Pin): void {
  try {
    const data = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    data.defaultProvider = pin.provider;
    data.defaultModel = pin.model;
    if (pin.thinkingLevel !== undefined) data.defaultThinkingLevel = pin.thinkingLevel;
    writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error(`[pin-model] failed to write settings: ${e}`);
  }
}

function restoreIfDrifted(pin: Pin): boolean {
  const cur = readSettingsDefaults();
  const drifted =
    !!cur &&
    (cur.provider !== pin.provider ||
      cur.model !== pin.model ||
      (pin.thinkingLevel !== undefined && cur.thinkingLevel !== pin.thinkingLevel));
  if (drifted) {
    writeSettingsDefaults(pin);
    return true;
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  if (!existsSync(PIN_FILE)) {
    const current = readSettingsDefaults();
    if (current) writePin(current);
  }

  pi.on("session_start", async () => {
    const pin = readPin();
    if (pin) restoreIfDrifted(pin);
  });

  pi.on("model_select", async (event, ctx) => {
    const pin = readPin();
    if (!pin) return;
    const { source, model } = event as {
      source: string;
      model: { provider: string; id: string };
    };
    if (source === "restore") return;
    ctx.ui.notify(
      `Session: ${model.provider}/${model.id} · default pinned → ${pin.provider}/${pin.model}`,
      "info",
    );
  });

  pi.on("session_shutdown", async () => {
    const pin = readPin();
    if (pin) restoreIfDrifted(pin);
  });

  pi.registerCommand("pin-model", {
    description:
      "Pin the default model so mid-session /model switches don't overwrite it. " +
      "Usage: /pin-model [provider/model | --show | --clear]",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();

      if (trimmed === "--show") {
        const pin = readPin();
        ctx.ui.notify(
          pin ? `Pinned default: ${pin.provider}/${pin.model}` : "No pinned model.",
          "info",
        );
        return;
      }

      if (trimmed === "--clear") {
        rmSync(PIN_FILE, { force: true });
        ctx.ui.notify(
          "Pin cleared. Mid-session switches will persist again (pi default behavior).",
          "info",
        );
        return;
      }

      let pin: Pin | null = null;
      if (trimmed) {
        const slash = trimmed.indexOf("/");
        if (slash > 0) {
          pin = { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
        }
      } else if (ctx.model) {
        pin = { provider: ctx.model.provider, model: ctx.model.id };
      }

      if (!pin) {
        ctx.ui.notify(
          "Usage: /pin-model [provider/model]  (or run it with the desired model active)",
          "warning",
        );
        return;
      }

      writePin(pin);
      restoreIfDrifted(pin);
      ctx.ui.notify(
        `Default pinned → ${pin.provider}/${pin.model}. Mid-session switches won't change it.`,
        "info",
      );
    },
  });
}
