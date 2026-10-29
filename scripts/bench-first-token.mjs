// First-token proxy bench (Performance Gate v2, task 0C): wall-clock from
// agent-loop start ("enter") to the outbound provider request being fully
// assembled, with zero network. The real chatFn path is used — chatCompletion
// builds the wire payload (context hooks, stable-prefix split, media lowering,
// tool schema array, JSON.stringify of the body) — but globalThis.fetch is
// stubbed in-process, so the timer stops exactly at "request fully assembled":
//   measured:   prompt assembly + adapter serialize + dispatch (loop-side cost)
//   NOT measured: HTTP transit, server queueing, model time-to-first-token.
// That network half is inherently ungatable (provider variance); this bench
// gates only the build overhead. Requires `npm run build` first (imports dist/).
// Usage: node scripts/bench-first-token.mjs [reps]   (default 10)
// Prints one JSON row: {script, case, reps, firstTokenMsMedian, firstTokenMsP95,
// firstTokenMsArray} — per-rep ms from loop start to the stubbed fetch being
// invoked. Exits 1 if any rep fails to reach the fetch (a gateable row must
// reflect every rep, not the survivors).
const REPS = Math.max(1, Number(process.argv[2] ?? 10));
const MEDIAN = (sorted) => sorted[Math.floor((sorted.length - 1) / 2)];
const P95 = (sorted) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];

const { runLoopWithChat, chatCompletion, DEFAULT_ENDPOINT, SYSTEM_PROMPT } = await import("../dist/zen.js");

// Small representative turn: real system prompt plus a mid-length conversation.
// No tool calls in history — the tool schema array is still attached by
// chatCompletion itself, so serialization work stays representative.
function benchHistory() {
  const history = [{ role: "system", content: SYSTEM_PROMPT }];
  for (let i = 0; i < 30; i += 1) {
    history.push({ role: "user", content: `report the contents of f${i}.txt` });
    history.push({ role: "assistant", content: `f${i}.txt has two lines; needle-${i % 7} appears once.` });
  }
  history.push({ role: "user", content: "now read f0.txt and summarize." });
  return history;
}

const realFetch = globalThis.fetch;

async function timeOneRep() {
  const t0 = performance.now();
  let firstFetchMs = null;
  globalThis.fetch = async () => {
    firstFetchMs = performance.now() - t0;
    // Non-stream JSON body — chatCompletion's hasStreamBody fallback accepts it
    // (stream:true is requested, but the path consumes any server reply shape).
    return {
      ok: true,
      status: 200,
      body: null,
      json: async () => ({ choices: [{ message: { content: "done" } }] }),
    };
  };
  try {
    const result = await runLoopWithChat(
      (history, opts) => chatCompletion(DEFAULT_ENDPOINT, undefined, "bench-model", history, opts),
      benchHistory(),
      { execute: async () => "ok", sleep: async () => {} },
    );
    if (firstFetchMs === null) {
      return { ms: null, error: "loop finished without reaching fetch" };
    }
    const text = typeof result === "string" ? result : "";
    if (text.trim() === "") {
      return { ms: null, error: "loop returned empty content — non-stream reply path drifted" };
    }
    return { ms: firstFetchMs, error: null };
  } catch (err) {
    return { ms: null, error: String(err).slice(0, 300) };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const walls = [];
for (let i = 0; i < REPS; i += 1) {
  const r = await timeOneRep();
  if (r.error !== null) {
    console.log(JSON.stringify({
      script: "bench-first-token", case: "first-token", status: "error",
      reason: r.error, completedReps: walls.length,
    }));
    process.exit(1);
  }
  walls.push(r.ms);
}
walls.sort((a, b) => a - b);
console.log(JSON.stringify({
  script: "bench-first-token",
  case: "first-token",
  reps: walls.length,
  firstTokenMsMedian: +MEDIAN(walls).toFixed(1),
  firstTokenMsP95: +P95(walls).toFixed(1),
  firstTokenMsArray: walls.map((v) => +v.toFixed(1)),
}));
