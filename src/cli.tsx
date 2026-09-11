#!/usr/bin/env node
// Ink entry point for the Atom chatbot (multi-provider).
// Default provider: Kilo Gateway, OpenAI-compatible Chat Completions.
//   Default: POST https://api.kilo.ai/api/gateway/chat/completions
//   Auth:    anonymous free models need no key; $KILO_API_KEY wins,
//            else ~/.atom/auth.json (see /provider). Other providers use
//            their own env vars or stored keys (see README providers table).
//   Model:   live /models catalog (default: kilo-auto/free)
import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  endpointConfig,
} from "./zen.js";
import { loadAuth, resolveApiKey } from "./auth.js";
import { parseExtensionFlags } from "./extensions.js";
import { writeTelemetryDashboard } from "./telemetry-dashboard.js";

const args = process.argv.slice(2);
// Extension trust lockdown (ticket 07): --no-extensions (--lockdown alias)
// boots with zero third-party extensions; --enable/--disable-extension take
// repeatable `*`/`?` patterns over extension names (CLI wins over atom.json).
const extFlags = parseExtensionFlags(args);
if (args.includes("--dashboard")) {
  // Local observability dashboard without starting the TUI: render every
  // stored session to ~/.atom/telemetry/dashboard.html and print the path.
  const out = writeTelemetryDashboard();
  if (out) {
    console.log(
      `Observability dashboard written to ${out} — open it in a browser. Local file, nothing uploaded.`
    );
    process.exit(0);
  }
  console.error("Dashboard failed to write — telemetry store unavailable.");
  process.exit(1);
}
if (args.includes("--serve")) {
  // Local observability webUI: serve the live dashboard + read-only JSON API
  // on loopback (Ctrl+C stops). The static --dashboard file is untouched.
  const flagValue = (name: string): string | undefined => {
    const eq = args.find((a) => a.startsWith(`${name}=`));
    if (eq !== undefined) return eq.slice(name.length + 1);
    const i = args.indexOf(name);
    if (i !== -1 && i + 1 < args.length) {
      const next = args[i + 1] as string;
      if (!next.startsWith("-")) return next;
    }
    return undefined;
  };
  (async () => {
    const { resolveTelemetryPort, startTelemetryServer } = await import("./telemetry-server.js");
    const server = await startTelemetryServer({ port: resolveTelemetryPort(process.env, flagValue("--port")) });
    console.log(`ATOM observability webUI at ${server.url} (loopback-only, read-only — Ctrl+C to stop).`);
    console.log(`JSON API: ${server.url}api/health · ${server.url}api/aggregates · ${server.url}api/sessions`);
    const stop = () => {
      server.close().then(
        () => process.exit(0),
        () => process.exit(0)
      );
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await new Promise(() => {});
  })().catch((e) => {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`Observability webUI failed to start (${detail}). Is the port already in use? Try --port <n>.`);
    process.exit(1);
  });
} else if (args.includes("--help") || args.includes("-h")) {
  console.log(`Atom chatbot (Ink TUI)
Usage: npm start
Flags: --dashboard (write ~/.atom/telemetry/dashboard.html and exit)
       --serve [--port <n>] (serve the live dashboard webUI on loopback and keep running)
       --no-extensions (--lockdown alias: boot with zero third-party extensions; builtins unchanged)
       --enable-extension <glob> (repeatable; only matching extensions load)
       --disable-extension <glob> (repeatable; wins over --enable-extension)
Env:
  KILO_API_KEY  optional (Kilo free models work anonymously; get a key at https://kilo.ai) — env wins over ~/.atom/auth.json
  OPENCODE_ZEN_API_KEY  optional when ~/.atom/auth.json has a zen key (get one at https://opencode.ai/auth)
  OPENAI_API_KEY / ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / MISTRAL_API_KEY / GEMINI_API_KEY (GOOGLE_API_KEY alias)  optional per provider (env wins over stored)
  OPENCODE_ZEN_MODEL    optional (default: ${DEFAULT_MODEL}; when set, wins over the saved /model)
  OPENCODE_ZEN_ENDPOINT optional (default: ${DEFAULT_ENDPOINT})
 Commands: /model (model picker) | /models [refresh] (local discovery refresh; Kilo catalog refresh when Kilo is active) | /provider (provider + key picker) | /effort (reasoning-effort picker) | /goal <objective> (pin one session objective; bare shows it, pause/resume/clear manage it) | /compact [focus] (summarize older turns) | /tools | /skills (list installed skills) | /skill:name (invoke) | /context (context usage) | /queue + /steer (follow-ups while busy) | /autoscroll (toggle follow new output) | /thinking (toggle reasoning visibility) | /mode | /trust | /allow | /deny | /rules | /clear | /new (fresh conversation, previous kept) | /rename <name> (rename current session) | /session (switch session picker) | /resume (restore last saved session) | /telemetry | /dashboard | /rewind | /help | /exit | /quit — Tab cycles the permission mode normal → yolo → plan → normal (extension slash commands appear in the / menu and palette, not in this static list)
Providers: kilo (default; anonymous free models, key optional)/opencode-zen/openai/anthropic/deepseek/mistral/google-gemini/openai-compatible (keys in ~/.atom/auth.json, 0600 POSIX; use /provider to paste one) + local auto-discovery: ollama (:11434), lmstudio (:1234), llamacpp (:8080) — no keys needed, overrides via ATOM_OLLAMA_URL/ATOM_LMSTUDIO_URL/ATOM_LLAMACPP_URL.
Effort (Auto/Low/Medium/High/Max) applies on every provider: reasoning_effort for OpenAI-chat kinds, thinking budgets for Anthropic, thinking levels for Gemini. Auto omits the knob.`);
  process.exit(0);
}

const { endpoint, apiKey: envKey } = endpointConfig();
// Stored zen key (from a previous /provider paste) applies when no env key.
const storedZen = resolveApiKey("opencode-zen", loadAuth());
const apiKey = envKey || storedZen;
// Explicit model only when OPENCODE_ZEN_MODEL is set: otherwise the saved
// provider/model/effort restore (restorePrefs), else the compiled default.
// Env wins over the save when set; the save wins over the default.
// The /model + /provider + /effort picks persist across restarts (saved on
// every completed turn and on clean exit); the conversation itself only ever
// restores via an explicit /resume.
// Explicit model only when OPENCODE_ZEN_MODEL is set and non-empty: a
// declared-but-empty entry (`OPENCODE_ZEN_MODEL=`, a common .env shape) must
// count as unset, or the empty string would win the model chain and every
// POST would carry an empty model id.
const envModel = process.env.OPENCODE_ZEN_MODEL?.trim() || undefined;

// Always start the TUI (even without a key) so /provider can paste one.
// Chatting without a key for the active provider errors inline with a
// /provider pointer; nothing is POSTed.
// --serve parks above (the server holds the event loop), so the TUI must
// never start alongside it: serve is a standalone mode like --dashboard.
if (!args.includes("--serve")) {
  // Production frame policy (Ink 7.1.1):
  // - incrementalRendering: only changed terminal lines rewrite per frame.
  //   Streaming paints touch the live tail + status bar, not the scrollback,
  //   so this cuts flicker and stdout bytes on every token flush.
  //   Escape hatch: ATOM_INCREMENTAL=0 restores full-frame rendering.
  // - maxFps: 30 keeps keystroke-to-paint latency low; token paints already
  //   coalesce to ~15fps via DRAFT_THROTTLE_MS, so Ink never does extra work.
  // - concurrent: enables React concurrent features (useTransition /
  //   useDeferredValue) for future deferral of expensive subtrees.
  // Tests are unaffected: they render via ink-testing-library, not here.
  render(<App apiKey={apiKey} endpoint={endpoint} initialModel={envModel} restorePrefs extensionsLockdown={extFlags.lockdown} enableExtensions={extFlags.enable} disableExtensions={extFlags.disable} />, {
    incrementalRendering: process.env.ATOM_INCREMENTAL !== "0",
    maxFps: 30,
    concurrent: true,
  });
}
