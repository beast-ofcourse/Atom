// Ink render benchmark: measures real terminal bytes, frame counts, Yoga
// render time, and full-screen clears per scenario x render config.
// Hermetic: temp ATOM_HOME, mocked fetch, fake TTY streams, dist build.
// Usage: node scripts/bench-render.mjs [scenario] [config]
//   scenarios: idle | burst | long | paced | blocks | tools | input | all (default: all)
//   configs:   A | B | C | D | all (default: all)
//     A = current: incremental + maxFps 30 + concurrent
//     B = incremental + maxFps 15 + concurrent
//     C = full-frame  + maxFps 30 + concurrent
//     D = incremental + maxFps 30 + sync (concurrent off)
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "atom-bench-"));
process.env.ATOM_HOME = TMP;

const { default: React } = await import("react");
const ink = await import("ink");
const { App } = await import("../dist/App.js");
const { emptyLocalSnapshot } = await import("../dist/local-discovery.js");

const CLEAR_RE = /\x1B\[2J|\x1B\[3J/g;
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const strip = (s) => s.replace(ANSI_RE, "");

function fakeStdout(columns = 100, rows = 30) {
  const sink = new EventEmitter();
  sink.isTTY = true;
  sink.columns = columns;
  sink.rows = rows;
  sink.bytes = 0;
  sink.writes = 0;
  sink.clears = 0;
  sink.buf = "";
  sink.write = (chunk) => {
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    sink.bytes += Buffer.byteLength(s);
    sink.writes += 1;
    sink.clears += (s.match(CLEAR_RE) || []).length;
    sink.buf += s;
    return true;
  };
  return sink;
}

function fakeStdin() {
  const sink = new EventEmitter();
  sink.isTTY = true;
  sink.setRawMode = () => {};
  sink.resume = () => {};
  sink.pause = () => {};
  sink.ref = () => {};
  sink.unref = () => {};
  sink.setEncoding = () => {};
  sink._chunks = [];
  // Ink v7 consumes stdin via the 'readable' + read() pull model.
  sink.read = () => (sink._chunks.length > 0 ? sink._chunks.shift() : null);
  sink.write = (data) => {
    sink._chunks.push(String(data));
    sink.emit("readable");
  };
  return sink;
}

const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
const SSE_DONE = "data: [DONE]\n\n";
const contentChunk = (content) => sse({ choices: [{ delta: { content } }] });
const thinkingChunk = (content) =>
  sse({ choices: [{ delta: { reasoning_content: content } }] });

function sseResponse(chunks) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const x of chunks) c.enqueue(enc.encode(x));
        c.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

function jsonResponse(message) {
  return { ok: true, json: async () => ({ choices: [{ message }] }) };
}

const toolChunk = (id, name, args) =>
  sse({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  });
function textMsg(content) {
  return { message: { content } };
}

const fakeDiscovery = () => ({
  snapshot: () => emptyLocalSnapshot(),
  refresh: async () => emptyLocalSnapshot(),
});

async function runScenario(name, config, opts) {
  const stdout = fakeStdout();
  const stdin = fakeStdin();
  let frames = 0;
  let renderMs = 0;
  let maxRenderMs = 0;
  const renderOpts = {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: false,
    ...config,
    onRender: ({ renderTime }) => {
      frames += 1;
      renderMs += renderTime;
      if (renderTime > maxRenderMs) maxRenderMs = renderTime;
    },
  };
  const app = ink.render(
    React.createElement(App, {
      apiKey: "bench-key",
      endpoint: "https://bench.invalid/v1/chat/completions",
      initialModel: "bench-model",
      initialModels: ["bench-model"],
      authHome: TMP,
      skillDirs: { projectDir: TMP, homeDir: TMP },
      configDirs: { projectDir: TMP, homeDir: TMP },
      localDiscovery: fakeDiscovery(),
    }),
    renderOpts
  );
  const bytes0 = stdout.bytes;
  const frames0 = frames;
  const text = () => strip(stdout.buf);
  async function waitFor(needle, timeout = 15000) {
    const start = Date.now();
    for (;;) {
      if (text().includes(needle)) return;
      if (Date.now() - start > timeout) {
        console.error(`[${name}] TAIL: ` + JSON.stringify(text().slice(-600)));
        throw new Error(`[${name}] timed out waiting for ${JSON.stringify(needle)}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  const type = async (s) => {
    for (const ch of s) {
      stdin.write(ch);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const t0 = Date.now();
  const extra = {};
  try {
    await opts.drive({ app, stdin, type, waitFor, text, extra });
  } finally {
    const wallMs = Date.now() - t0;
    const result = {
      scenario: name,
      wallMs,
      fetchCalls: globalThis.__fetchCalls ?? 0,
      frames: frames - frames0,
      bytes: stdout.bytes - bytes0,
      writes: stdout.writes,
      clears: stdout.clears,
      avgRenderMs: frames - frames0 > 0 ? renderMs / (frames - frames0) : 0,
      maxRenderMs,
      ...extra,
    };
    app.unmount();
    await new Promise((r) => setTimeout(r, 100));
    return result;
  }
}

function pacedSseResponse(n, gapMs) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        (async () => {
          for (let i = 0; i < n; i++) {
            c.enqueue(enc.encode(contentChunk(`pace${i} `)));
            await new Promise((r) => setTimeout(r, gapMs));
          }
          c.enqueue(enc.encode(SSE_DONE));
          c.close();
        })();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

// ---- scenarios (each self-contained: queue fetch script, drive input) ----
const scenarios = {
  idle: {
    script: [],
    drive: async () => {
      await new Promise((r) => setTimeout(r, 2000));
    },
  },
  burst: {
    script: () => {
      const chunks = [];
      for (let i = 0; i < 500; i++) chunks.push(contentChunk(`tok${i} `));
      chunks.push(SSE_DONE);
      return [async () => sseResponse(chunks), async () => jsonResponse(textMsg("BURST-DONE"))];
    },
    drive: async ({ type, stdin, waitFor }) => {
      await type("burst test");
      stdin.write("\r");
      await waitFor("tok499");
      await new Promise((r) => setTimeout(r, 1500));
    },
  },
  long: {
    script: () => {
      const chunks = [];
      for (let i = 0; i < 2000; i++) chunks.push(contentChunk(`word${i} `));
      chunks.push(SSE_DONE);
      return [async () => sseResponse(chunks), async () => jsonResponse(textMsg("LONG-DONE"))];
    },
    drive: async ({ type, stdin, waitFor }) => {
      await type("long test");
      stdin.write("\r");
      await waitFor("word1999");
      await new Promise((r) => setTimeout(r, 1500));
    },
  },
  paced: {
    script: () => [async () => pacedSseResponse(300, 10)],
    drive: async ({ type, stdin, waitFor }) => {
      await type("paced test");
      stdin.write("\r");
      await waitFor("pace299");
      await new Promise((r) => setTimeout(r, 1500));
    },
  },
  blocks: {
    // Multi-block streaming (ticket 06): interleaved thinking + text deltas
    // build stepBlocks; paints ride one paint-scheduler flush per window.
    // Gates fail if the ordered-block renderer regresses byte/render cost.
    script: () => {
      const chunks = [];
      for (let i = 0; i < 80; i++) {
        chunks.push(thinkingChunk(`plan-step${i} `));
        chunks.push(contentChunk(`answer${i} `));
      }
      chunks.push(SSE_DONE);
      return [async () => sseResponse(chunks), async () => jsonResponse(textMsg("BLOCKS-DONE"))];
    },
    drive: async ({ type, stdin, waitFor }) => {
      await type("block stream test");
      stdin.write("\r");
      await waitFor("answer79");
      await new Promise((r) => setTimeout(r, 1500));
    },
  },
  tools: {
    // Production shape: tool calls streamed as deltas, then a final text.
    script: () => [
      async () => sseResponse([contentChunk("checking "), toolChunk("c1", "glob", { pattern: "*.md" }), SSE_DONE]),
      async () => sseResponse([contentChunk("reading "), toolChunk("c2", "read", { path: "package.json", limit: 5 }), SSE_DONE]),
      async () => sseResponse([contentChunk("TOOLS-DONE"), SSE_DONE]),
    ],
    drive: async ({ type, stdin, waitFor }) => {
      await type("\t"); // normal -> yolo (auto-approve tools)
      await new Promise((r) => setTimeout(r, 300));
      await type("tool test");
      stdin.write("\r");
      await waitFor("TOOLS-DONE");
      await new Promise((r) => setTimeout(r, 300));
    },
  },
  input: {
    // Keystroke-to-paint latency: 20 chars typed idle (no submit), each
    // keystroke timed from stdin write to painted echo. Reports keyP50ms /
    // keyP95ms alongside the standard frame/byte row.
    script: [],
    drive: async ({ stdin, text, extra }) => {
      const lat = [];
      let typed = "";
      for (const ch of "abcdefghijklmnopqrst") {
        typed += ch;
        const t0 = Date.now();
        stdin.write(ch);
        for (;;) {
          if (text().includes(typed)) break;
          if (Date.now() - t0 > 2000) throw new Error(`[input] echo timeout at ${JSON.stringify(typed)}`);
          // 10 ms polls: tight enough to resolve frames, loose enough not
          // to starve the loop Ink renders on (2 ms polls inflate the
          // measurement by crowding out paint macrotasks).
          await new Promise((r) => setTimeout(r, 10));
        }
        lat.push(Date.now() - t0);
      }
      lat.sort((a, b) => a - b);
      extra.keyP50ms = lat[10];
      extra.keyP95ms = lat[18];
      await new Promise((r) => setTimeout(r, 300));
    },
  },
};

const configs = {
  A: { incrementalRendering: true, maxFps: 30, concurrent: true },
  B: { incrementalRendering: true, maxFps: 15, concurrent: true },
  C: { incrementalRendering: false, maxFps: 30, concurrent: true },
  D: { incrementalRendering: true, maxFps: 30, concurrent: false },
};

const wantScen = process.argv[2] ?? "all";
const wantCfg = process.argv[3] ?? "all";
const scenNames = wantScen === "all" ? Object.keys(scenarios) : [wantScen];
const cfgNames = wantCfg === "all" ? Object.keys(configs) : [wantCfg];

const rows = [];
for (const cfg of cfgNames) {
  for (const scn of scenNames) {
    const script = scenarios[scn].script;
    const queue = typeof script === "function" ? script() : [...script];
    globalThis.fetch = async (url, init) => {
      globalThis.__fetchCalls = (globalThis.__fetchCalls ?? 0) + 1;
      const body = (() => {
        try {
          const p = JSON.parse(init?.body ?? "{}");
          const msgs = p.messages ?? [];
          const last = msgs[msgs.length - 1] ?? {};
          return JSON.stringify(last).slice(0, 120);
        } catch {
          return "?";
        }
      })();
      console.error(`[fetch #${globalThis.__fetchCalls}] ${String(url)} lastMsg=${body}`);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (!next) throw new Error("fetch script exhausted");
      return next();
    };
    const row = await runScenario(scn, configs[cfg], scenarios[scn]);
    rows.push({ config: cfg, ...row });
    console.log(
      `cfg=${cfg} scen=${scn} wall=${row.wallMs}ms frames=${row.frames} ` +
        `bytes=${row.bytes} writes=${row.writes} clears=${row.clears} ` +
        `avgRender=${row.avgRenderMs.toFixed(2)}ms maxRender=${row.maxRenderMs.toFixed(2)}ms`
    );
  }
}
console.log(JSON.stringify(rows, null, 1));
