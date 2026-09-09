// Prompt-cache architecture: ATOM intentionally constructs a cache-friendly
// prompt, and each provider decides how that cache is actually realized.
//
// Conceptual split (every POST):
//   STABLE PREFIX (byte-identical across POSTs, cacheable)
//     - system instructions (src/system.ts one-liner)
//     - project instructions (AGENTS.md overlay)
//     - tool definitions (source order, stable serialization)
//   DYNAMIC SUFFIX (changes constantly, never cached as prefix)
//     - environment block (timestamps, git status â€” refreshed per turn)
//     - current conversation, tool calls/results, skill injections,
//       todo state, task state
//
// Deliberate non-goals (documented, not oversights):
// - No Tier-1 skill catalog is injected: the deterministic local matcher
//   owns skill discovery, so skill metadata never enters the prefix
//   unsolicited. Loaded skill bodies ride the dynamic suffix (they change
//   turn to turn); their references stay on demand.
// - The cwd/node tail of the env block rides the dynamic suffix with the
//   timestamp â€” splitting that one line further is not worth the fragility;
//   it is ~200 chars.
// - Gemini explicit cache objects (a separate resource lifecycle with its own
//   create/reference/TTL calls) are out of scope; Gemini uses implicit
//   prefix stability like everyone else.
//
// The split reuses the env-block boundary history[0] already carries:
// `stripEnvBlock` separates the stable base from the trailing `[env ...]`
// block, so NO storage format changes â€” histories with no env block (tests,
// old saves) assemble to a single stable system message, byte-identical to
// the pre-cache wire shape.
//
// Layering (AgentRuntime â†’ ContextManager â†’ assembled context â†’
// ProviderAdapter): this module owns the neutral assembly + policy + caps.
// The agent loop never sees caching (no loop changes); adapters translate
// the assembly into kind-specific wire shapes (Anthropic blocks+breakpoints,
// OpenAI-shape message split, Gemini parts split).
//
// Prompt caching itself is NEVER implemented here â€” this is the foundation:
// deterministic assembly, capability declarations, usage-field plumbing, and
// instrumentation. Cost/latency wins come from providers honoring it.

import { createHash } from "node:crypto";
import { stripEnvBlock } from "./env-block.js";
import { estimateTokensForChars } from "./context-manager.js";
import { getProvider } from "./providers.js";
import type { ProviderId } from "./providers.js";
import type { ChatMessage } from "./zen.js";

// ---- Provider capability abstraction ----

export type CacheSupport = {
  // Explicit cache_control-style breakpoints on the wire (Anthropic).
  explicitBreakpoints: boolean;
  // Benefits from byte-stable prefixes automatically (no markers needed).
  implicitPrefix: boolean;
  // Response usage exposes cache read/write counters we parse.
  usageCacheFields: boolean;
  // Human note (TTL semantics, field names, caveats).
  notes: string;
};

// Declared caching support lives on the provider registry itself
// (ProviderDef.cache in providers.ts — the single declaration point).
// Unknown ids get the conservative all-false default (compatibility first —
// never assume).
export function providerCacheSupport(id: string): CacheSupport {
  return (
    getProvider(id)?.cache ?? {
      explicitBreakpoints: false,
      implicitPrefix: false,
      usageCacheFields: false,
      notes: "unknown provider — no caching assumed",
    }
  );
}

// ---- Stable-prefix assembly (pure, deterministic) ----

// ---- Stable-prefix assembly (pure, deterministic) ----

export type AssembledPrefix = {
  // Byte-stable across POSTs: base instructions + project overlay.
  stableSystem: string;
  // The trailing env block (timestamps, git status), or null when history[0]
  // carries none (tests, old saves) â€” callers then use the legacy shape.
  dynamicSystem: string | null;
  // sha1 hex of the stable serialization (stable system + tools marker).
  // Change detection + instrumentation, NOT a provider cache token.
  fingerprint: string;
  // Estimated sizes for instrumentation.
  stableTokens: number;
};

export type AssemblePrefixArgs = {
  // history[0]-style system content (stable base + optional env tail).
  systemContent: string;
  // Stable-stringified tool schemas actually sent, or undefined when the
  // request carries no tools (compaction path) â€” the fingerprint covers
  // whichever case applies so the two shapes never alias.
  toolsJson?: string;
};

// Fresh `{type:"ephemeral"}` breakpoint per call (never a shared object â€”
// callers embed it into request bodies they own).
export function ephemeralBreakpoint(): { type: string } {
  return { type: "ephemeral" };
}

// OpenAI-shape head split: history[0]'s env tail becomes its own system
// message ([stable, dynamic, ...rest]). Returns the input array UNTOUCHED
// when there is nothing to split (no system head, or no env tail) — callers
// then send the legacy shape byte-identically. Always returns a NEW array
// when splitting (never mutates the loop's history; rollback indices and the
// ledger keep pointing at the original).
export function splitSystemHead(history: ChatMessage[]): ChatMessage[] {
  const first = history[0];
  if (!first || first.role !== "system" || typeof first.content !== "string") {
    return history;
  }
  const prefix = assemblePrefix({ systemContent: first.content });
  if (prefix.dynamicSystem === null || prefix.stableSystem.trim().length === 0) {
    return history;
  }
  return [
    { role: "system", content: prefix.stableSystem },
    { role: "system", content: prefix.dynamicSystem },
    ...history.slice(1),
  ];
}

function sha1Hex(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

export function assemblePrefix(args: AssemblePrefixArgs): AssembledPrefix {
  const stableSystem = stripEnvBlock(args.systemContent);
  const tail = args.systemContent.slice(stableSystem.length);
  const dynamicSystem = tail.trim().length > 0 ? tail.trim() : null;
  const toolsPart = args.toolsJson ?? "<no-tools>";
  // Length-prefixed so contents can never alias across the boundary.
  const fingerprint = sha1Hex(`${stableSystem.length}:${stableSystem}\n${toolsPart.length}:${toolsPart}`);
  return {
    stableSystem,
    dynamicSystem,
    fingerprint,
    stableTokens: estimateTokensForChars(stableSystem.length + (args.toolsJson?.length ?? 0)),
  };
}
