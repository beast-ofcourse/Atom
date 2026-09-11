// Local observability dashboard renderer (pure: sessions in, HTML out).
//
// Produces a single self-contained HTML file (inline CSS + vanilla JS, no CDN,
// no external requests — it works over file:// with no network). Open it from
// disk; nothing is uploaded anywhere.
//
// Honesty rules enforced here, not just documented:
// - Every metric that can be absent renders as "n/a" with a title explaining
//   why (e.g. "not reported by provider"). Zero is only shown when zero was
//   measured (e.g. zero failed calls out of N recorded calls).
// - Cost is always n/a until a provider reports it (no pricing tables, no
//   token × price synthesis — see TELEMETRY_COST_NOTE).
// - Tool rows never show token counts (tools don't consume model tokens);
//   usage lives on model calls and turn/session aggregates, labeled as
//   API-reported only.
// - An empty store renders an honest empty state, never placeholder charts.
//
// Drill-down: session → turn → iteration → model call / tool call → result
// preview. All dynamic strings are HTML-escaped.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  TELEMETRY_COST_NOTE,
  loadTelemetrySessions,
  summarizeTelemetry,
  telemetryDashboardFilePath,
  telemetryDir,
  type TelemetryAggregates,
  type TelemetrySession,
  type TokenUsage,
} from "./telemetry.js";

export type DashboardOptions = {
  generatedAt?: string;
  sourceDir?: string | null;
  atomVersion?: string | null;
  corruptFiles?: number;
  // Live-served mode (used by the webUI server, never by the static file):
  // injects a meta refresh plus a "live" pill. Absent/<=0 keeps the static
  // output byte-identical.
  refreshSeconds?: number;
};

export function escapeHtml(value: unknown): string {
  const s = typeof value === "string" ? value : String(value ?? "");
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtCount(n: number): string {
  try {
    return Math.floor(n).toLocaleString("en-US");
  } catch {
    return String(Math.floor(n));
  }
}

function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) {
    return `<span class="na" title="Not measured — no timed calls were recorded.">n/a</span>`;
  }
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60000).toFixed(1)} min`;
}

function fmtTokens(value: number | undefined, reported: boolean, label: string): string {
  if (!reported || value === undefined) {
    return `<span class="na" title="${escapeHtml(label)}">n/a</span>`;
  }
  return fmtCount(value);
}

function usageCell(usage: TokenUsage, reported: boolean): string {
  if (!reported) {
    return `<span class="na" title="No model call in scope reported token usage. The provider did not send a usage payload.">n/a</span>`;
  }
  const parts: string[] = [];
  if (usage.prompt_tokens !== undefined) parts.push(`in ${fmtCount(usage.prompt_tokens)}`);
  if (usage.completion_tokens !== undefined) parts.push(`out ${fmtCount(usage.completion_tokens)}`);
  if (usage.cacheReadTokens !== undefined) parts.push(`cache-read ${fmtCount(usage.cacheReadTokens)}`);
  if (usage.cacheWriteTokens !== undefined) parts.push(`cache-write ${fmtCount(usage.cacheWriteTokens)}`);
  if (usage.total_tokens !== undefined) parts.push(`total ${fmtCount(usage.total_tokens)}`);
  return escapeHtml(parts.length > 0 ? parts.join(" · ") : "reported (empty)");
}

function sessionTokens(s: TelemetrySession): { usage: TokenUsage; reported: boolean } {
  const usage: TokenUsage = {};
  let reported = false;
  for (const t of s.turns) {
    if (!t.usageReported) continue;
    reported = true;
    (["prompt_tokens", "completion_tokens", "total_tokens", "cacheReadTokens", "cacheWriteTokens"] as const).forEach(
      (k) => {
        if (t.usage[k] !== undefined) usage[k] = (usage[k] ?? 0) + (t.usage[k] as number);
      }
    );
  }
  return { usage, reported };
}

function turnTokensTotal(t: { usage: TokenUsage; usageReported: boolean }): number | null {
  if (!t.usageReported) return null;
  if (t.usage.total_tokens !== undefined) return t.usage.total_tokens;
  const sum = (t.usage.prompt_tokens ?? 0) + (t.usage.completion_tokens ?? 0);
  return sum > 0 || t.usage.prompt_tokens !== undefined || t.usage.completion_tokens !== undefined ? sum : null;
}

function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function fmtTime(iso: string | null): string {
  if (!iso) return `<span class="na">n/a</span>`;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return escapeHtml(iso);
    return escapeHtml(d.toLocaleString());
  } catch {
    return escapeHtml(iso);
  }
}

// --- SVG charts (measured data only; empty states handled by callers) ---

function barRow(label: string, value: number, max: number, extra: string, okWidth?: number, failWidth?: number): string {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  const ok = okWidth !== undefined && failWidth !== undefined;
  const bar = ok
    ? `<span class="bar"><span class="seg-ok" style="width:${okWidth}%"></span><span class="seg-fail" style="width:${failWidth}%"></span></span>`
    : `<span class="bar"><span class="fill" style="width:${pct}%"></span></span>`;
  return `<div class="brow"><span class="blabel" title="${escapeHtml(label)}">${escapeHtml(label)}</span>${bar}<span class="bval">${extra}</span></div>`;
}

function toolChart(agg: TelemetryAggregates): string {
  if (agg.byTool.length === 0) {
    return `<p class="empty">No tool calls recorded yet.</p>`;
  }
  const max = Math.max(...agg.byTool.map((t) => t.calls));
  const rows = agg.byTool.slice(0, 15).map((t) => {
    const okPct = t.calls > 0 ? Math.round((t.succeeded / t.calls) * 100) : 0;
    const failPct = t.calls > 0 ? Math.max(t.failed > 0 ? 2 : 0, Math.round((t.failed / t.calls) * 100)) : 0;
    return barRow(
      t.name,
      t.calls,
      max,
      `${fmtCount(t.calls)} · ok ${fmtCount(t.succeeded)} · fail ${fmtCount(t.failed)} · avg ${fmtMs(t.avgDurationMs)}`,
      okPct,
      failPct
    );
  });
  const more = agg.byTool.length > 15 ? `<p class="empty">+ ${agg.byTool.length - 15} more tool(s) in the table below.</p>` : "";
  return `<div class="bars legend-ok-fail">${rows.join("")}</div>${more}
  <p class="legend"><span class="sw-ok"></span> succeeded <span class="sw-fail"></span> failed</p>`;
}

function tokensChart(sessions: TelemetrySession[]): string {
  const withUsage = sessions
    .map((s) => ({ s, total: turnTokensTotal({ usage: sessionTokens(s).usage, usageReported: sessionTokens(s).reported }) }))
    .filter((e) => e.total !== null) as Array<{ s: TelemetrySession; total: number }>;
  if (withUsage.length === 0) {
    return `<p class="empty">No token usage reported yet — providers send usage per model call; nothing is estimated.</p>`;
  }
  const top = [...withUsage].sort((a, b) => b.total - a.total).slice(0, 20);
  const max = Math.max(...top.map((e) => e.total));
  const rows = top.map((e) =>
    barRow(
      `${shortId(e.s.sessionId)} · ${e.s.model}`,
      e.total,
      max,
      fmtCount(e.total)
    )
  );
  const skipped = withUsage.length > 20 ? `<p class="empty">Top 20 of ${withUsage.length} sessions with reported usage.</p>` : "";
  const unreported = sessions.length - withUsage.length;
  const note =
    unreported > 0
      ? `<p class="empty">${unreported} session(s) reported no usage and are excluded (not shown as zero).</p>`
      : "";
  return `<div class="bars">${rows.join("")}</div>${skipped}${note}`;
}

function outcomesChart(agg: TelemetryAggregates): string {
  const total = agg.turns;
  if (total === 0) return `<p class="empty">No turns recorded yet.</p>`;
  const order: Array<[string, number, string]> = [
    ["completed", agg.outcomes.completed, "seg-ok"],
    ["blocked", agg.outcomes.blocked, "seg-warn"],
    ["unverified", agg.outcomes.unverified, "seg-warn"],
    ["budget-exceeded", agg.outcomes["budget-exceeded"], "seg-warn"],
    ["failed", agg.outcomes.failed, "seg-fail"],
    ["cancelled", agg.outcomes.cancelled, "seg-mute"],
    ["pending", agg.outcomes.pending, "seg-mute"],
  ];
  const segs = order
    .filter(([, n]) => n > 0)
    .map(([label, n, cls]) => {
      const pct = Math.max(n > 0 ? 3 : 0, Math.round((n / total) * 100));
      return `<span class="${cls}" style="width:${pct}%" title="${escapeHtml(label)}: ${n}"></span>`;
    })
    .join("");
  const legend = order
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `<span class="pill">${escapeHtml(label)} ${n}</span>`)
    .join(" ");
  return `<div class="stacked">${segs}</div><p class="legend">${legend}</p>`;
}

function latencyChart(agg: TelemetryAggregates): string {
  const rows = agg.byTool.filter((t) => t.avgDurationMs !== null).sort((a, b) => (b.avgDurationMs as number) - (a.avgDurationMs as number)).slice(0, 12);
  if (rows.length === 0) return `<p class="empty">No timed tool calls recorded yet.</p>`;
  const max = Math.max(...rows.map((t) => t.avgDurationMs as number));
  return `<div class="bars">${rows
    .map((t) => barRow(t.name, t.avgDurationMs as number, max, `avg ${fmtMs(t.avgDurationMs)} · ${fmtCount(t.calls)} call(s)`))
    .join("")}</div>`;
}

// --- Session detail ---

function modelCallRows(turnId: string, s: TelemetrySession["turns"][number]): string {
  if (s.modelCalls.length === 0) return `<p class="empty">No model calls recorded for this turn.</p>`;
  const rows = s.modelCalls.map((m) => {
    const retries =
      m.retries.length > 0
        ? `<ul class="retries">${m.retries
            .map(
              (r) =>
                `<li>retry${r.attempt !== null ? ` #${r.attempt}` : ""}${r.status !== null ? ` · HTTP ${r.status}` : ""}${r.delayMs !== null ? ` · after ${r.delayMs} ms` : ""} · <span class="mono">${escapeHtml(r.detail)}</span></li>`
            )
            .join("")}</ul>`
        : `<span class="na" title="No transport retries preceded this call.">none</span>`;
    return `<tr>
      <td class="mono">${escapeHtml(m.id)}</td>
      <td>iter ${m.iteration + 1}</td>
      <td>${escapeHtml(m.provider)} · ${escapeHtml(m.model)}</td>
      <td>${fmtMs(m.durationMs)}</td>
      <td>${usageCell(m.usage ?? {}, m.usageReported)}</td>
      <td>${m.reasoningLabel ? escapeHtml(m.reasoningLabel) : `<span class="na" title="The response carried no reasoning metadata.">n/a</span>`}</td>
      <td>${m.toolCallCount}</td>
      <td>${escapeHtml(m.finishReason)}${m.error ? `<br><span class="err">${escapeHtml(m.error)}</span>` : ""}</td>
      <td>${retries}</td>
    </tr>`;
  });
  void turnId;
  return `<table class="detail"><thead><tr><th>Call</th><th>Iteration</th><th>Provider · model</th><th>Latency</th><th>Tokens (reported)</th><th>Reasoning</th><th>Tool calls</th><th>Finish</th><th>Retries</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function toolCallRows(s: TelemetrySession["turns"][number]): string {
  if (s.toolCalls.length === 0) return `<p class="empty">No tool calls in this turn (final answer with no tool use).</p>`;
  const rows = s.toolCalls.map((c) => {
    const status = c.success
      ? `<span class="ok">ok</span>`
      : `<span class="err">fail · ${escapeHtml(c.errorKind ?? "tool-error")}</span>`;
    const batch = c.batchSize > 1 ? `<br><span class="mute">batch ${c.batchIndex + 1}/${c.batchSize}</span>` : "";
    const argsNote = c.argsTruncated ? `<br><span class="mute">truncated · ${fmtCount(c.argsChars)} chars total</span>` : "";
    const resultNote = c.resultTruncated
      ? `<br><span class="mute">truncated · ${fmtCount(c.resultChars)} chars total</span>`
      : `<br><span class="mute">${fmtCount(c.resultChars)} chars</span>`;
    return `<tr>
      <td class="mono">${escapeHtml(c.id)}</td>
      <td>iter ${c.iteration + 1}</td>
      <td><span class="mono">${escapeHtml(c.name)}</span>${batch}<br>${status}</td>
      <td>${fmtMs(c.durationMs)}</td>
      <td><span class="na" title="Tools do not consume model tokens. Token usage is reported per model call above — never attributed to tools.">n/a</span></td>
      <td><details><summary>args</summary><pre>${escapeHtml(c.argsPreview)}</pre>${argsNote}</details></td>
      <td><details><summary>result</summary><pre>${escapeHtml(c.resultPreview)}</pre>${resultNote}</details></td>
    </tr>`;
  });
  return `<table class="detail"><thead><tr><th>Call</th><th>Iteration</th><th>Tool · status</th><th>Duration</th><th>Tokens</th><th>Args</th><th>Result</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function iterationTimeline(s: TelemetrySession["turns"][number]): string {
  if (s.iterations.length === 0) return `<p class="empty">No iterations recorded.</p>`;
  const max = Math.max(1, ...s.iterations.map((i) => i.durationMs));
  const rows = s.iterations.map((i) => {
    const pct = Math.max(3, Math.round((i.durationMs / max) * 100));
    const tools = i.toolCallIds.length > 0 ? ` · ${i.toolCallIds.length} tool(s)` : " · final";
    return `<div class="trow"><span class="tlabel">iter ${i.step + 1}</span><span class="tbar"><span class="tfill" style="width:${pct}%"></span></span><span class="tval">${fmtMs(i.durationMs)}${escapeHtml(tools)}</span></div>`;
  });
  return `<div class="timeline">${rows.join("")}</div>`;
}

// Goal fragment for one turn (ticket 09): rendered only when the trace
// carries a goal snapshot — absent or malformed reads as no-goal and renders
// nothing (never a fake claim). Counters show only when reported.
function goalFragment(t: TelemetrySession["turns"][number]): string {
  const g = t.goal;
  if (!g || typeof g.objective !== "string" || g.objective.length === 0) return "";
  const state = g.active === true ? "active" : "paused";
  const bits: string[] = [];
  if (typeof g.turns === "number") bits.push(`${fmtCount(g.turns)} turn(s)`);
  if (typeof g.requests === "number") bits.push(`${fmtCount(g.requests)} request(s)`);
  if (typeof g.tokens === "number") bits.push(`${fmtCount(g.tokens)} tokens`);
  if (typeof g.workMs === "number") bits.push(fmtMs(g.workMs));
  const counters = bits.length > 0 ? ` <span class="mute">(${bits.join(" · ")})</span>` : "";
  return `<p><strong>Goal:</strong> <span class="mono">${escapeHtml(g.objective)}</span> <span class="pill">${state}</span>${counters}</p>`;
}

function turnBlock(t: TelemetrySession["turns"][number]): string {
  const outcomeCls = t.outcome === "completed" ? "ok" : t.outcome === "failed" ? "err" : "warn";
  const total = turnTokensTotal(t);
  // Loop-harness rollup (present only when the loop reported stats for this
  // turn — older sessions render exactly as before).
  const loopBits: string[] = [];
  if (t.loop) {
    if (t.loop.cacheHits > 0) loopBits.push(`read-cache hits ${fmtCount(t.loop.cacheHits)}`);
    if (t.loop.repetitionHits > 0) loopBits.push(`loop-guard hits ${fmtCount(t.loop.repetitionHits)}`);
    if (t.loop.bottleneckName) {
      loopBits.push(
        `bottleneck ${escapeHtml(t.loop.bottleneckName)}` +
          (t.loop.bottleneckMs !== undefined ? ` ${fmtMs(t.loop.bottleneckMs)}` : "")
      );
    }
    if (t.loop.truncations > 0) loopBits.push(`truncated ${fmtCount(t.loop.truncations)} turn(s)`);
  }
  const head =
    `<span class="${outcomeCls}">${escapeHtml(t.outcome)}</span>` +
    ` · ${fmtMs(t.durationMs)}` +
    ` · ${t.modelCalls.length} model call(s)` +
    ` · ${t.toolCalls.length} tool call(s)` +
    ` · retries ${t.retryCount}` +
    ` · tokens ${total !== null ? fmtCount(total) : `<span class="na" title="No model call in this turn reported usage.">n/a</span>`}` +
    (loopBits.length > 0 ? ` · ${loopBits.join(" · ")}` : "");
  return `<details class="turn" data-outcome="${escapeHtml(t.outcome)}">
    <summary><span class="mono">${escapeHtml(t.id)}</span> · ${fmtTime(t.startedAt)} · ${escapeHtml(t.provider)} · ${escapeHtml(t.model)} · ${head}</summary>
    <div class="turnbody">
      <p><strong>Input:</strong> <span class="mono">${escapeHtml(t.inputPreview)}</span> <span class="mute">(${fmtCount(t.inputChars)} chars)</span></p>
      ${goalFragment(t)}
      ${t.error ? `<p><strong>Error:</strong> <span class="err">${escapeHtml(t.error)}</span></p>` : ""}
      ${t.replyPreview ? `<p><strong>Reply:</strong> <span class="mono">${escapeHtml(t.replyPreview)}</span></p>` : ""}
      <h5>Timeline</h5>
      ${iterationTimeline(t)}
      <h5>Model calls</h5>
      ${modelCallRows(t.id, t)}
      <h5>Tool calls</h5>
      ${toolCallRows(t)}
    </div>
  </details>`;
}

function sessionBlock(s: TelemetrySession): string {
  const { usage, reported } = sessionTokens(s);
  const total = turnTokensTotal({ usage, usageReported: reported });
  const ok = s.turns.reduce((n, t) => n + t.toolCalls.filter((c) => c.success).length, 0);
  const tools = s.turns.reduce((n, t) => n + t.toolCalls.length, 0);
  const outcomes = s.turns.map((t) => t.outcome).join(" ");
  const subagents =
    s.subagents.length === 0
      ? `<p class="empty">No subagents recorded — this session ran the single-agent loop (depth 1). Delegated workers will appear here when a delegate tool is used.</p>`
      : `<ul>${s.subagents
          .map(
            (sub) =>
              `<li><span class="mono">${escapeHtml(sub.name)}</span> · ${escapeHtml(sub.status)} · ${fmtMs(sub.durationMs)}${sub.summaryPreview ? ` · <span class="mono">${escapeHtml(sub.summaryPreview)}</span>` : ""}</li>`
          )
          .join("")}</ul>`;
  const events =
    s.events.length === 0
      ? `<p class="empty">No session events.</p>`
      : `<ul>${s.events.map((e) => `<li>${fmtTime(e.at)} · <span class="mono">${escapeHtml(e.kind)}</span> · ${escapeHtml(e.detail)}</li>`).join("")}</ul>`;
  const turns =
    s.turns.length === 0
      ? `<p class="empty">No turns recorded in this session yet.</p>`
      : s.turns.map((t) => turnBlock(t)).join("");
  return `<details class="session" data-session data-provider="${escapeHtml(s.provider)}" data-model="${escapeHtml(s.model)}" data-outcomes="${escapeHtml(outcomes)}" data-search="${escapeHtml(`${s.sessionId} ${s.provider} ${s.model} ${s.project ?? ""}`.toLowerCase())}">
    <summary>
      <span class="mono">${escapeHtml(shortId(s.sessionId))}</span>
      <span class="mute">${fmtTime(s.startedAt)}</span>
      <span class="pill">${escapeHtml(s.provider)}</span>
      <span class="pill">${escapeHtml(s.model)}</span>
      <span>${s.turns.length} turn(s)</span>
      <span>tokens ${total !== null ? fmtCount(total) : `<span class="na" title="No turn in this session reported usage.">n/a</span>`}</span>
      <span>tools ${ok}/${tools}</span>
    </summary>
    <div class="sessbody">
      <table class="meta"><tbody>
        <tr><th>Session</th><td class="mono">${escapeHtml(s.sessionId)}</td></tr>
        <tr><th>Started / ended</th><td>${fmtTime(s.startedAt)} → ${s.endedAt ? fmtTime(s.endedAt) : "running"}</td></tr>
        <tr><th>Project</th><td>${s.project ? escapeHtml(s.project) : `<span class="na">n/a</span>`}</td></tr>
        <tr><th>Compaction spend</th><td>${usageCell(s.compactionUsage, s.compactionReported)} <span class="mute">(summary POSTs, kept separate from turn usage)</span></td></tr>
      </tbody></table>
      <h4>Subagents</h4>
      ${subagents}
      <h4>Events</h4>
      ${events}
      <h4>Turns</h4>
      ${turns}
    </div>
  </details>`;
}

// --- Page ---

// Render the dashboard for every stored session and write it atomically next
// to the store (telemetry/dashboard.html). Best-effort: returns the written
// path, or null (never throws) when the store is unreadable or the disk fails.
export function writeTelemetryDashboard(
  home?: string,
  opts: Omit<DashboardOptions, "sourceDir"> = {}
): string | null {
  try {
    const { sessions, corrupt } = loadTelemetrySessions(home);
    const html = buildDashboardHtml(sessions, {
      ...opts,
      sourceDir: telemetryDir(home),
      corruptFiles: corrupt,
    });
    const dir = telemetryDir(home);
    mkdirSync(dir, { recursive: true });
    const finalPath = telemetryDashboardFilePath(home);
    const tmpPath = path.join(dir, `.dashboard.tmp.${process.pid}`);
    writeFileSync(tmpPath, html, "utf8");
    renameSync(tmpPath, finalPath);
    return finalPath;
  } catch {
    return null;
  }
}

export function buildDashboardHtml(sessions: TelemetrySession[], opts: DashboardOptions = {}): string {
  const agg = summarizeTelemetry(sessions);
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const providers = [...new Set(sessions.flatMap((s) => s.turns.map((t) => t.provider)).concat(sessions.map((s) => s.provider)))].sort();
  const providerOptions = providers.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
  const corruptNote =
    opts.corruptFiles && opts.corruptFiles > 0
      ? `<p class="warn">${opts.corruptFiles} corrupt session file(s) were skipped (never crash the dashboard — see storage notes).</p>`
      : "";
  const successRate =
    agg.toolSuccessRate !== null
      ? `${(agg.toolSuccessRate * 100).toFixed(1)}%`
      : `<span class="na" title="No tool calls recorded — a rate over zero calls would be fake.">n/a</span>`;
  // Goal overview (ticket 09): present only when at least one stored turn
  // carried a goal snapshot — zero goal turns omit the card entirely (same
  // conditional-render precedent as the corrupt-file note above).
  const goalCard =
    agg.goalTurns > 0
      ? `<div class="card"><div class="k">Goal turns</div><div class="v">${fmtCount(agg.goalTurns)}</div></div>`
      : "";

  const refreshSeconds =
    typeof opts.refreshSeconds === "number" && Number.isFinite(opts.refreshSeconds)
      ? Math.floor(opts.refreshSeconds)
      : 0;
  const refreshMeta =
    refreshSeconds > 0 ? `\n<meta http-equiv="refresh" content="${refreshSeconds}">` : "";
  const livePill =
    refreshSeconds > 0
      ? ` · <span class="pill">live · refreshes every ${refreshSeconds}s</span>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${refreshMeta}
<title>ATOM Observability</title>
<style>
:root {
  color-scheme: dark;
  --bg: #0b0e14; --bg-soft: #0e131b; --panel: #131926; --panel-2: #0f1520;
  --line: #263042; --line-soft: #1c2433;
  --txt: #e8eef7; --mute: #93a0b4; --faint: #5f6b80;
  --ok: #3fb950; --fail: #f85149; --warn: #d29922; --acc: #58a6ff; --acc-soft: rgba(88, 166, 255, 0.12);
  --radius: 12px; --shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 76px; }
body {
  background:
    radial-gradient(1100px 320px at 15% -80px, rgba(88, 166, 255, 0.10), transparent 60%),
    radial-gradient(900px 300px at 90% -60px, rgba(63, 185, 80, 0.07), transparent 60%),
    var(--bg);
  background-attachment: fixed;
  color: var(--txt);
  font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
  margin: 0 auto; max-width: 1120px; padding: 28px 24px 40px;
  -webkit-font-smoothing: antialiased;
}
::selection { background: rgba(88, 166, 255, 0.35); }
a { color: var(--acc); }
:focus-visible { outline: 2px solid var(--acc); outline-offset: 2px; border-radius: 4px; }
/* Hero */
.hero { padding: 10px 0 4px; }
.kicker { display: inline-flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--acc); background: var(--acc-soft); border: 1px solid rgba(88, 166, 255, 0.35); border-radius: 999px; padding: 3px 12px; margin-bottom: 12px; }
.kicker .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 8px var(--ok); }
h1 { font-size: 30px; line-height: 1.2; letter-spacing: -0.02em; margin: 0 0 6px; }
h2 { font-size: 15px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--mute); border-bottom: 1px solid var(--line-soft); padding-bottom: 8px; margin: 36px 0 4px; }
h2 .hcount { color: var(--faint); font-weight: 600; }
h4 { margin: 18px 0 6px; font-size: 14px; } h5 { margin: 14px 0 6px; color: var(--mute); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
/* Sticky section nav */
.toc { position: sticky; top: 0; z-index: 20; display: flex; gap: 4px; flex-wrap: wrap; margin: 14px -24px 0; padding: 10px 24px; background: rgba(11, 14, 20, 0.86); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border-bottom: 1px solid var(--line-soft); }
.toc a { color: var(--mute); text-decoration: none; font-size: 12.5px; font-weight: 600; padding: 5px 12px; border-radius: 999px; border: 1px solid transparent; }
.toc a:hover { color: var(--txt); background: rgba(255, 255, 255, 0.05); border-color: var(--line); }
.sub, .mute { color: var(--mute); } .mono, pre, code { font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace; font-size: 0.92em; }
pre { background: #080b11; border: 1px solid var(--line-soft); border-radius: 8px; padding: 10px 12px; overflow: auto; max-height: 300px; white-space: pre-wrap; word-break: break-word; }
.na { color: var(--mute); font-style: italic; border-bottom: 1px dotted var(--mute); }
.ok { color: var(--ok); font-weight: 600; } .err { color: var(--fail); } .warn { color: var(--warn); }
/* Overview cards */
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 12px; margin: 16px 0; }
.card { position: relative; background: linear-gradient(180deg, rgba(255,255,255,0.025), transparent 40%), var(--panel); border: 1px solid var(--line-soft); border-radius: var(--radius); padding: 12px 14px; box-shadow: var(--shadow); transition: transform 120ms ease, border-color 120ms ease; overflow: hidden; }
.card::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 2px; background: linear-gradient(90deg, var(--acc), transparent 70%); opacity: 0.7; }
.card:hover { transform: translateY(-2px); border-color: var(--line); }
.card .k { color: var(--mute); font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
.card .v { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; margin-top: 2px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; } @media (max-width: 800px) { .grid2 { grid-template-columns: 1fr; } }
.panel { background: var(--panel); border: 1px solid var(--line-soft); border-radius: var(--radius); padding: 14px 16px; box-shadow: var(--shadow); }
/* Bar rows */
.brow { display: flex; align-items: center; gap: 10px; margin: 6px 0; }
.blabel { flex: 0 0 auto; width: min(220px, 28vw); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.bar { flex: 1 1 auto; min-width: 60px; background: #080b11; border: 1px solid var(--line-soft); border-radius: 999px; height: 14px; display: flex; overflow: hidden; }
.fill { background: linear-gradient(90deg, #2f7de1, var(--acc)); display: block; height: 100%; border-radius: 999px; }
.seg-ok { background: linear-gradient(90deg, #2ea043, var(--ok)); display: block; height: 100%; } .seg-fail { background: linear-gradient(90deg, #da3633, var(--fail)); display: block; height: 100%; }
.seg-warn { background: linear-gradient(90deg, #bb8009, var(--warn)); display: block; height: 100%; } .seg-mute { background: var(--faint); display: block; height: 100%; }
.bval { flex: 0 1 300px; min-width: 120px; color: var(--mute); font-size: 12px; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
.stacked { display: flex; height: 20px; border-radius: 999px; overflow: hidden; background: #080b11; border: 1px solid var(--line-soft); margin: 10px 0; }
.pill { background: rgba(255,255,255,0.04); border: 1px solid var(--line); border-radius: 999px; padding: 1px 10px; font-size: 12px; margin: 2px; display: inline-block; font-variant-numeric: tabular-nums; }
.legend { color: var(--mute); font-size: 12px; } .sw-ok, .sw-fail { display: inline-block; width: 10px; height: 10px; border-radius: 3px; } .sw-ok { background: var(--ok); box-shadow: 0 0 6px rgba(63,185,80,0.6); } .sw-fail { background: var(--fail); box-shadow: 0 0 6px rgba(248,81,73,0.6); }
.empty { color: var(--mute); font-style: italic; background: rgba(255,255,255,0.015); border: 1px dashed var(--line); border-radius: 8px; padding: 10px 12px; }
/* Tables */
table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 13px; }
th, td { border-bottom: 1px solid var(--line-soft); padding: 8px 10px; text-align: left; vertical-align: top; }
thead th { background: rgba(255,255,255,0.03); color: var(--mute); font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 1; }
tbody tr:hover td { background: rgba(88, 166, 255, 0.05); }
td { font-variant-numeric: tabular-nums; }
table.meta { width: auto; }
table.meta th { border: 1px solid var(--line-soft); }
table.meta td { border: 1px solid var(--line-soft); }
/* Drill-down */
details { background: var(--panel); border: 1px solid var(--line-soft); border-radius: var(--radius); margin: 10px 0; box-shadow: var(--shadow); transition: border-color 120ms ease; }
details:hover { border-color: var(--line); }
details[open] { border-color: rgba(88, 166, 255, 0.4); }
details summary { cursor: pointer; padding: 12px 14px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; list-style: none; border-radius: var(--radius); }
details summary::-webkit-details-marker { display: none; }
details summary::before { content: "▸"; color: var(--acc); font-weight: 700; transition: transform 120ms ease; }
details[open] > summary::before { transform: rotate(90deg); }
details .sessbody, details .turnbody { padding: 2px 14px 14px; border-top: 1px solid var(--line-soft); }
details.turn { background: var(--panel-2); }
.turnbody { overflow-x: auto; }
/* Filters */
.filters { display: flex; gap: 10px; flex-wrap: wrap; margin: 14px 0; align-items: center; }
.filters input, .filters select { background: #080b11; color: var(--txt); border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; font: inherit; }
.filters input:focus, .filters select:focus { border-color: var(--acc); outline: none; box-shadow: 0 0 0 3px var(--acc-soft); }
.filters input[type="search"] { flex: 1 1 220px; }
/* Timelines */
.trow { display: flex; align-items: center; gap: 10px; margin: 4px 0; }
.tlabel { flex: 0 0 64px; color: var(--mute); font-variant-numeric: tabular-nums; } .tbar { flex: 1; background: #080b11; border: 1px solid var(--line-soft); border-radius: 999px; height: 12px; overflow: hidden; } .tfill { background: linear-gradient(90deg, #2f7de1, var(--acc)); display: block; height: 100%; border-radius: 999px; } .tval { flex: 0 1 auto; color: var(--mute); font-size: 12px; font-variant-numeric: tabular-nums; }
ul.retries { margin: 4px 0; padding-left: 18px; color: var(--mute); font-size: 12px; }
.foot { color: var(--faint); font-size: 12px; margin-top: 32px; border-top: 1px solid var(--line-soft); padding-top: 12px; }
@media (max-width: 640px) {
  body { padding: 18px 14px 32px; }
  h1 { font-size: 24px; }
  .toc { margin: 12px -14px 0; padding: 8px 14px; }
  .brow { flex-wrap: wrap; }
  .blabel { width: auto; }
  .bar { flex: 1 1 100%; order: 3; }
  .bval { flex: 1 1 auto; text-align: left; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  * { transition: none !important; }
}
</style>
</head>
<body>
<header class="hero">
<div class="kicker"><span class="dot"></span>Local-only agent telemetry</div>
<h1>ATOM Observability</h1>
<p class="sub">Generated ${escapeHtml(generatedAt)}${opts.sourceDir ? ` · source <span class="mono">${escapeHtml(opts.sourceDir)}</span>` : ""}${opts.atomVersion ? ` · atom ${escapeHtml(opts.atomVersion)}` : ""}${livePill}</p>
<p class="sub">Private by design: this file was rendered on your machine from <span class="mono">~/.atom/telemetry/</span> and never leaves it. Previews are truncated and scrubbed of known provider secrets; API keys are never stored. Disable recording with <code>ATOM_TELEMETRY=0</code> or <code>"telemetry": {"enabled": false}</code> in <code>atom.json</code>.</p>
</header>
<nav class="toc" aria-label="Dashboard sections">
<a href="#overview">Overview</a><a href="#outcomes">Outcomes</a><a href="#tokens">Tokens</a><a href="#sessions">Sessions</a><a href="#honesty">Reading honestly</a>
</nav>
${corruptNote}

<h2 id="overview">Overview</h2>
<div class="cards">
<div class="card"><div class="k">Sessions</div><div class="v">${fmtCount(agg.sessions)}</div></div>
<div class="card"><div class="k">Turns</div><div class="v">${fmtCount(agg.turns)}</div></div>
<div class="card"><div class="k">Model calls</div><div class="v">${fmtCount(agg.modelCalls)}</div></div>
<div class="card"><div class="k">Tool calls</div><div class="v">${fmtCount(agg.toolCalls)}</div></div>
<div class="card"><div class="k">Tool success rate</div><div class="v">${successRate}</div></div>
<div class="card"><div class="k">Prompt tokens (reported)</div><div class="v">${fmtTokens(agg.usage.prompt_tokens, agg.usageReported, "No model call reported prompt_tokens.")}</div></div>
<div class="card"><div class="k">Completion tokens (reported)</div><div class="v">${fmtTokens(agg.usage.completion_tokens, agg.usageReported, "No model call reported completion_tokens.")}</div></div>
<div class="card"><div class="k">Cache read / write (reported)</div><div class="v">${fmtTokens(agg.usage.cacheReadTokens, agg.usageReported, "No provider reported cache-read counters.")} / ${fmtTokens(agg.usage.cacheWriteTokens, agg.usageReported, "No provider reported cache-write counters.")}</div></div>
<div class="card"><div class="k">Retries</div><div class="v">${fmtCount(agg.retries)}</div></div>
${goalCard}
<div class="card"><div class="k">Read-cache hits (local)</div><div class="v">${fmtCount(agg.cacheHits)}</div></div>
<div class="card"><div class="k">Loop-guard hits</div><div class="v">${fmtCount(agg.repetitionHits)}</div></div>
<div class="card"><div class="k">Avg model latency</div><div class="v">${fmtMs(agg.avgModelLatencyMs)}</div></div>
<div class="card"><div class="k">Avg tool duration</div><div class="v">${fmtMs(agg.avgToolDurationMs)}</div></div>
<div class="card"><div class="k">Total cost</div><div class="v"><span class="na" title="${escapeHtml(agg.costNote)}">n/a</span></div></div>
</div>

<h2 id="outcomes">Turn outcomes</h2>
<div class="panel">${outcomesChart(agg)}</div>

<div class="grid2">
<div><h2>Tool calls by tool</h2><div class="panel">${toolChart(agg)}</div></div>
<div><h2>Avg tool duration</h2><div class="panel">${latencyChart(agg)}</div></div>
</div>

<h2 id="tokens">Tokens per session <span class="hcount">(reported only)</span></h2>
<div class="panel">${tokensChart(sessions)}</div>

<h2 id="sessions">Sessions <span class="hcount">(${sessions.length})</span></h2>
<div class="filters">
<input id="q" type="search" placeholder="Filter sessions…" aria-label="Filter sessions">
<select id="fprov" aria-label="Filter by provider"><option value="">All providers</option>${providerOptions}</select>
<select id="fout" aria-label="Filter by turn outcome">
<option value="">Any outcome</option>
<option value="completed">completed</option><option value="blocked">blocked</option>
<option value="unverified">unverified</option><option value="budget-exceeded">budget-exceeded</option>
<option value="failed">failed</option><option value="cancelled">cancelled</option><option value="pending">pending</option>
</select>
<span class="mute" id="count"></span>
</div>
<div id="sessions">
${sessions.length === 0 ? `<p class="empty">No sessions recorded yet. Use the agent — one small file per session lands in <span class="mono">~/.atom/telemetry/sessions/</span> on every completed turn — then regenerate this page.</p>` : sessions.map((s) => sessionBlock(s)).join("")}
</div>

<h2 id="honesty">Reading this page honestly</h2>
<div class="panel"><ul>
<li><strong>n/a</strong> means <em>not measured or not reported</em> — never zero. Hover any n/a for the exact reason.</li>
<li><strong>Tokens</strong> come only from <code>usage</code> payloads the provider sent with a model call. Sessions without payloads are excluded from token charts (not plotted as zero).</li>
<li><strong>Cost</strong> is ${escapeHtml(TELEMETRY_COST_NOTE)}</li>
<li><strong>Tool tokens:</strong> tools do not consume model tokens, so tool rows show n/a by design; per-call usage lives on model calls.</li>
<li><strong>Retries</strong> are transport retries inside one model call (HTTP 429/5xx or network, up to 2 retries) and attach to the call they precede.</li>
<li><strong>Iterations</strong> are loop tool-round steps: one model call plus the tool calls it requested. Displayed 1-based.</li>
<li><strong>Subagents:</strong> ATOM v1 runs a single-agent loop, so sessions normally show none — that is the honest state, not missing data.</li>
<li><strong>Durations</strong> are measured wall-clock (<code>Date.now()</code> deltas around the awaited call), including parallel-batch members timed individually.</li>
</ul></div>

<p class="foot">ATOM local observability · session → turn → iteration → model/tool call → result · stored under <span class="mono">~/.atom/telemetry/sessions/</span> (one JSON file per session, 0600 POSIX).</p>

<script>
(function () {
  var q = document.getElementById("q");
  var fp = document.getElementById("fprov");
  var fo = document.getElementById("fout");
  var count = document.getElementById("count");
  function apply() {
    var needle = (q.value || "").toLowerCase();
    var prov = fp.value || "";
    var out = fo.value || "";
    var shown = 0, total = 0;
    var nodes = document.querySelectorAll("#sessions details[data-session]");
    for (var i = 0; i < nodes.length; i++) {
      total++;
      var el = nodes[i];
      var hay = el.getAttribute("data-search") || "";
      var okQ = !needle || hay.indexOf(needle) !== -1;
      var okP = !prov || el.getAttribute("data-provider") === prov;
      var outs = (el.getAttribute("data-outcomes") || "").split(" ");
      var okO = !out || outs.indexOf(out) !== -1;
      var show = okQ && okP && okO;
      el.style.display = show ? "" : "none";
      if (show) shown++;
    }
    count.textContent = "showing " + shown + " of " + total;
  }
  q.addEventListener("input", apply);
  fp.addEventListener("change", apply);
  fo.addEventListener("change", apply);
  apply();
})();
</script>
</body>
</html>`;
}
