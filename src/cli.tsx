#!/usr/bin/env node
// Ink entry point for the Atom chatbot (multi-provider).
// Default provider: Kilo Gateway, OpenAI-compatible Chat Completions.
//   Default: POST https://api.kilo.ai/api/gateway/chat/completions
//   Auth:    anonymous free models need no key; $KILO_API_KEY wins,
//            else ~/.atom/auth.json (see /provider). Other providers use
//            their own env vars or stored keys (see README providers table).
//   Model:   live /models catalog (default: kilo-auto/free)
// No static heavy imports here (Extreme-fast 4.1): React/ink/App/zen pull
// ~700 ms of module load (yoga native binding). Exit-path flags above use
// only dynamic imports; the TUI branch below imports lazily (react-jsx
// runtime needs no React in scope).

const args = process.argv.slice(2);
// --help FIRST, before any heavy import (Extreme-fast 4.1): React/ink/App
// cost ~700 ms of module load (yoga native binding); the help text needs
// only the model + endpoint defaults, dynamically imported from zen.js.
if (args.includes("--help") || args.includes("-h")) {
  (async () => {
    const { DEFAULT_ENDPOINT, DEFAULT_MODEL } = await import("./zen.js");
    console.log(`Atom chatbot (Ink TUI)
Usage: npm start
Flags: --dashboard (write ~/.atom/telemetry/dashboard.html and exit)
        --serve [--port <n>] (serve the live dashboard webUI on loopback and keep running)
        --web [--port <n>] (serve the agentic WebUI on loopback and keep running)
       --no-extensions (--lockdown alias: boot with zero third-party extensions; builtins unchanged)
       --enable-extension <glob> (repeatable; only matching extensions load)
       --disable-extension <glob> (repeatable; wins over --enable-extension)
Env:
  KILO_API_KEY  optional (Kilo free models work anonymously; get a key at https://kilo.ai) — env wins over ~/.atom/auth.json
  OPENCODE_ZEN_API_KEY  optional when ~/.atom/auth.json has a zen key (get one at https://opencode.ai/auth)
  OPENAI_API_KEY / ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / MISTRAL_API_KEY / GEMINI_API_KEY (GOOGLE_API_KEY alias)  optional per provider (env wins over stored)
  OPENCODE_ZEN_MODEL    optional (default: ${DEFAULT_MODEL}; when set, wins over the saved /model)
  OPENCODE_ZEN_ENDPOINT optional (default: ${DEFAULT_ENDPOINT})
  Commands: /model [filter|refresh] (model picker; refresh re-probes local servers, Kilo catalog refresh when Kilo is active) | /provider (provider + key picker) | /effort (reasoning-effort picker) | /goal <objective> (pin one session objective; bare shows it, pause/resume/clear manage it; model tools mirror the slash) | /compact [focus] (summarize older turns) | /tools | /skill (skill picker) | /skill:name (invoke) | /context (context usage) | /queue + /steer (follow-ups while busy) | /autoscroll (toggle follow new output) | /thinking (toggle reasoning visibility) | /mode | /trust | /allow | /deny | /rules | /clear | /new (fresh conversation, previous kept) | /rename <name> (rename current session) | /session (switch session picker) | /resume (restore last saved session) | /telemetry | /dashboard | /rewind | /reload (re-read config, skills, extensions, MCP servers, instructions; conversation, session, trust, mode kept) | /help | /exit | /quit — Tab cycles the permission mode normal → yolo → plan → normal (extension slash commands appear in the / menu and palette, not in this static list)
Providers: kilo (default; anonymous free models, key optional)/opencode-zen/openai/anthropic/deepseek/mistral/google-gemini/groq/xai/zai/openrouter/cerebras/openai-compatible (keys in ~/.atom/auth.json, 0600 POSIX; use /provider to paste one) + local auto-discovery: ollama (:11434), lmstudio (:1234), llamacpp (:8080) — no keys needed, overrides via ATOM_OLLAMA_URL/ATOM_LMSTUDIO_URL/ATOM_LLAMACPP_URL.
Effort (Auto/Low/Medium/High/Max) applies on every provider: reasoning_effort for OpenAI-chat kinds, thinking budgets for Anthropic, thinking levels for Gemini. Auto omits the knob.`);
    process.exit(0);
  })().catch((e) => {
    console.error(`Help failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
} else if (args.includes("--mcp-list")) {
  (async () => {
    const { loadAtomConfig } = await import("./config.js");
    const { mcpManager } = await import("./mcp/manager.js");
    const configured = loadAtomConfig().config.mcp ?? {};
    await mcpManager.refresh();
    const status = mcpManager.status();
    const names = Object.keys(configured);
    if (names.length === 0) {
      console.log(
        'No MCP servers configured. Add one to atom.json under "mcp".',
      );
      process.exit(0);
    }
    for (const name of names) {
      const s = status[name] ?? { status: "disabled" as const };
      const detail =
        s.status === "connected"
          ? `connected (${s.tools} tool(s))`
          : s.status === "failed"
            ? `failed: ${s.error}`
            : s.status;
      console.log(`${name}: ${detail}`);
    }
    await mcpManager.shutdown();
    process.exit(0);
  })().catch((e) => {
    console.error(
      `MCP status failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  });
} else if (args.includes("--mcp-auth") || args.includes("--mcp-logout")) {
  const flag = args.includes("--mcp-auth") ? "--mcp-auth" : "--mcp-logout";
  const at = args.indexOf(flag);
  const server =
    at !== -1 && at + 1 < args.length ? (args[at + 1] as string) : undefined;
  (async () => {
    if (!server || server.startsWith("-")) {
      console.error(`Usage: atom ${flag} <server-name>`);
      process.exit(2);
    }
    const { mcpAuthenticate, mcpRemoveAuth } = await import("./mcp/manager.js");
    if (flag === "--mcp-logout") {
      const removed = await mcpRemoveAuth(server);
      console.log(
        removed
          ? `Removed stored MCP credentials for "${server}".`
          : `No stored MCP credentials for "${server}".`,
      );
      process.exit(0);
    }
    console.log(
      `Starting OAuth for MCP server "${server}" — authorize in your browser.`,
    );
    const status = await mcpAuthenticate(server, {
      onRedirect: (url) => console.log(`Authorize here: ${url}`),
    });
    if (status.status === "connected") {
      console.log(
        `MCP server "${server}" authenticated (${status.tools} tool(s)).`,
      );
      process.exit(0);
    }
    if (status.status === "failed")
      console.error(`MCP authentication failed: ${status.error}`);
    else
      console.error(
        `MCP server "${server}" still needs authentication (${status.status}).`,
      );
    process.exit(1);
  })().catch((e) => {
    console.error(
      `MCP auth failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  });
}
// Extension trust lockdown (ticket 07): --no-extensions (--lockdown alias)
// boots with zero third-party extensions; --enable/--disable-extension take
// repeatable `*`/`?` patterns over extension names (CLI wins over atom.json).
// Parsed lazily in the TUI branch below (imports extensions.js + jiti) —
// exit-path flags above never pay for it.
if (args.includes("--dashboard")) {
  // Local observability dashboard without starting the TUI: render every
  // stored session to ~/.atom/telemetry/dashboard.html and print the path.
  (async () => {
    const { writeTelemetryDashboard } =
      await import("./telemetry-dashboard.js");
    const out = writeTelemetryDashboard();
    if (out) {
      console.log(
        `Observability dashboard written to ${out} — open it in a browser. Local file, nothing uploaded.`,
      );
      process.exit(0);
    }
    console.error("Dashboard failed to write — telemetry store unavailable.");
    process.exit(1);
  })().catch((e) => {
    console.error(
      `Dashboard failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  });
}
if (args.includes("--web")) {
  // ATOM WebUI: local agentic frontend over the same runtime as the TUI
  // (loopback-only, Ctrl+C stops). The TUI below never starts alongside it.
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
    const { resolveWebPort, startWebServer } = await import("./web/server.js");
    const server = await startWebServer({
      port: resolveWebPort(process.env, flagValue("--port")),
    });
    console.log(
      `ATOM WebUI at ${server.url} (loopback-only — Ctrl+C to stop).`,
    );
    console.log(
      `JSON API: ${server.url}api/health · ${server.url}api/providers · ${server.url}api/sessions`,
    );
    const stop = () => {
      server.close().then(
        () => process.exit(0),
        () => process.exit(0),
      );
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await new Promise(() => {});
  })().catch((e) => {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(
      `ATOM WebUI failed to start (${detail}). Is the port already in use? Try --port <n>.`,
    );
    process.exit(1);
  });
} else if (args.includes("--serve")) {
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
    const { resolveTelemetryPort, startTelemetryServer } =
      await import("./telemetry-server.js");
    const server = await startTelemetryServer({
      port: resolveTelemetryPort(process.env, flagValue("--port")),
    });
    console.log(
      `ATOM observability webUI at ${server.url} (loopback-only, read-only — Ctrl+C to stop).`,
    );
    console.log(
      `JSON API: ${server.url}api/health · ${server.url}api/aggregates · ${server.url}api/sessions`,
    );
    const stop = () => {
      server.close().then(
        () => process.exit(0),
        () => process.exit(0),
      );
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await new Promise(() => {});
  })().catch((e) => {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(
      `Observability webUI failed to start (${detail}). Is the port already in use? Try --port <n>.`,
    );
    process.exit(1);
  });
}

// (--help is handled first, above — no duplicate clause here.)

// Always start the TUI (even without a key) so /provider can paste one.
// Chatting without a key for the active provider errors inline with a
// /provider pointer; nothing is POSTed.
// --serve/--web/--mcp-* park above (the server or MCP IIFEs hold the event
// loop and exit), so the TUI must never start alongside them: each is a
// standalone mode like --dashboard.
// TUI branch is fully lazy (Extreme-fast 4.1): zen/auth/extensions/ink/App
// load only here — exit-path flags above never pay for them.
if (
  !args.includes("--serve") &&
  !args.includes("--web") &&
  !args.includes("--dashboard") &&
  !args.includes("--mcp-list") &&
  !args.includes("--mcp-auth") &&
  !args.includes("--mcp-logout")
) {
  (async () => {
    const { endpointConfig } = await import("./zen.js");
    const { loadAuth, resolveApiKey } = await import("./auth.js");
    const { parseExtensionFlags } = await import("./extensions.js");
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
    const extFlags = parseExtensionFlags(args);
    const { render } = await import("ink");
    const { App } = await import("./App.js");
    // MCP servers (tickets 01/02): connect in the background so server tools
    // join the model-visible catalog as soon as they list. Fire-and-forget by
    // design: startup never blocks on servers, and every failure stays
    // per-server inside the manager (failed/disabled/needs_auth).
    // Imported here (not above) so the manager's SDK loads off the
    // first-paint path but still refreshes before App mounts.
    const { refreshMcpTools } = await import("./mcp/manager.js");
    refreshMcpTools().catch(() => {});
    // Production frame policy (Ink 7.1.1), measured with
    // scripts/bench-render.mjs (real render root, fake TTY, 100x30):
    // - incrementalRendering: only changed terminal lines rewrite per frame.
    //   Streaming paints touch the live tail + status bar, not the scrollback.
    //   Measured ~3x fewer stdout bytes than full-frame on sustained
    //   streaming (paced 300-token run: ~66KB vs ~195KB) with identical
    //   frames — strictly less flicker, zero behavior change. Compatible
    //   with the whole UI (no full-screen chrome depends on reprints).
    //   Escape hatch: ATOM_INCREMENTAL=0 restores full-frame rendering.
    // - maxFps: 30 (Extreme-fast 1A.3 decision, measured — see below). The
    //   adaptive paint scheduler emits dense-stream paints on 16 ms windows,
    //   but raising Ink to 60 fps cost +33% bytes, +43% clears and +14%
    //   avgRender on the paced bench with no latency win outside render
    //   quanta (keystroke/token latency is dominated by Ink's 20 ms input
    //   flush + App scheduling, not the frame cap). 30 fps stays: sparse
    //   streams coalesce at 64 ms scheduler windows, dense streams paint on
    //   scheduler-hot 16 ms windows downsampled to 33 ms frames — all of the
    //   latency win, none of the byte/clear cost.
    // - concurrent: enables React concurrent features (useTransition /
    //   useDeferredValue) for future deferral of expensive subtrees.
    //   Measured neutral vs sync mode (frames/bytes within noise), kept for
    //   the deferral option, not for current gains.
    // Not configurable here (and intentionally so): full-screen clears come
    // from frame geometry (win32 clears whenever the frame fills the
    // viewport), so they are fixed by keeping the live frame short
    // (windowed thinking, capped approval preview, coalesced paints) —
    // no render flag can substitute for that.
    // Tests are unaffected: they render via ink-testing-library, not here.
    render(
      <App
        apiKey={apiKey}
        endpoint={endpoint}
        initialModel={envModel}
        restorePrefs
        extensionsLockdown={extFlags.lockdown}
        enableExtensions={extFlags.enable}
        disableExtensions={extFlags.disable}
      />,
      {
        incrementalRendering: process.env.ATOM_INCREMENTAL !== "0",
        maxFps: 30,
        concurrent: true,
      },
    );
  })().catch((e) => {
    console.error(
      `Atom failed to start: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  });
}
