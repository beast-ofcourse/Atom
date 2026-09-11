// Goal evaluator fallback (ticket 04): one bounded, read-only judge call
// for a goal turn that ends with no disposition report. Follows the
// compaction summary-POST precedent (requestCompactSummary in src/compact.ts):
// same provider/model, tools disabled, capped output, single attempt, throws
// on failure (the loop turns that into a pause, never a crash).
//
// Split of responsibilities: the loop owns WHEN (report-less turn end) and
// WHAT NEXT (consumed verdicts flow through the model-report path); this
// module owns the request shape, the judge prompt, and the transport. App
// builds the full request from its live provider/key/model refs; unit tests
// inject a fake GoalJudgeRunner through AgenticOpts without fetch mocks.
import { chatCompletionForProvider, type ChatMessage, type Usage } from "../zen.js";
import type { ProviderId } from "../providers.js";
import { parseGoalJudgeVerdict, type GoalDisposition } from "../goal.js";

// Output cap for the judge POST: a verdict is a few dozen tokens of JSON —
// 256 leaves headroom for a short reason without letting the judge write prose.
export const GOAL_JUDGE_MAX_TOKENS = 256;

// What the loop hands the runner: the goal text plus the recent transcript
// tail only (see recentTurnsForJudge in goal.ts — never the full history).
export type GoalJudgeInput = {
  goal: string;
  turns: ChatMessage[];
};

// Full transport request (CompactSummaryRequest-shaped): the runner fills
// provider/apiKey/model from live refs; tests never construct this.
export type GoalJudgeRequest = GoalJudgeInput & {
  provider: ProviderId;
  apiKey: string;
  model: string;
  systemContent?: string;
  baseURL?: string;
  endpointOverride?: string;
  signal?: AbortSignal | null;
  maxOutputTokens?: number;
  onUsage?: (usage: Usage) => void;
};

// Injected seam on AgenticOpts: return a clear verdict, or null when the
// judge output is anything but a clear verdict (the loop pauses on null).
// Throwing also pauses (the loop guards the call) — never crashes the turn.
export type GoalJudgeRunner = (input: GoalJudgeInput) => Promise<GoalDisposition | null>;

// The judge instruction: goal text plus the demand for one strict
// machine-readable verdict. No tools are offered, so there is nothing to
// call — the transcript above is the only evidence.
export function buildGoalJudgeInstruction(goal: string): string {
  return (
    `You are judging whether a coding-goal turn advanced. Goal: "${goal}".\n` +
    `The recent transcript turns are above. Decide the turn outcome and answer ` +
    `with a single JSON object only (no prose, no code fences):\n` +
    `{"status": "continue", "next": "<concrete next action>"} — work remains; name the next action.\n` +
    `{"status": "complete", "reason": "<why the goal is done>"} — the goal is fully achieved.\n` +
    `{"status": "blocked", "reason": "<what blocks progress>"} — a genuine blocker, not mere remaining work.\n` +
    `Rules: no tools are available for this request — judge from the transcript only, ` +
    `answer with the JSON object only.`
  );
}

export function buildGoalJudgeMessages(
  systemContent: string | undefined,
  goal: string,
  turns: ChatMessage[]
): ChatMessage[] {
  const system =
    typeof systemContent === "string" && systemContent.length > 0
      ? systemContent
      : "You are a concise engineering judge.";
  return [
    { role: "system", content: system },
    ...turns.map((m) => ({ ...m }) as ChatMessage),
    { role: "user", content: buildGoalJudgeInstruction(goal) },
  ];
}

// Judge POST: SAME provider/model via the existing chat path but TOOLS
// DISABLED (no `tools` key in the POST body) and output capped
// (max_tokens/maxOutputTokens per kind — see zen.ts/adapters.ts). Single
// attempt, no retry — bounded by construction. Returns the parsed verdict,
// or null when the judge output is anything but a clear verdict (tolerant
// parsing lives in parseGoalJudgeVerdict). Transport failures and empty
// replies throw with history untouched (the loop pauses on them).
export async function requestGoalVerdict(req: GoalJudgeRequest): Promise<GoalDisposition | null> {
  const messages = buildGoalJudgeMessages(req.systemContent, req.goal, req.turns);
  const res = await chatCompletionForProvider(req.provider, req.apiKey, req.model, messages, {
    baseURL: req.baseURL,
    endpointOverride: req.endpointOverride,
    disableTools: true,
    maxOutputTokens: req.maxOutputTokens ?? GOAL_JUDGE_MAX_TOKENS,
    ...(req.signal ? { signal: req.signal } : {}),
  });
  // Totals keep accumulating: forward real judge usage when present.
  if (res.usage !== undefined) {
    try {
      req.onUsage?.(res.usage);
    } catch {
      // observer errors never break the judge
    }
  }
  const text = (res.content ?? "").trim();
  if (!text) throw new Error("Empty reply from model (unexpected payload).");
  return parseGoalJudgeVerdict(text);
}
