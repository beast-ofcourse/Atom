// Web executors: webfetch retrieval (SSRF-gated per URL and redirect hop)
// and websearch discovery. Node builtins + global fetch only.
import { promises as dns } from "node:dns";
import * as net from "node:net";
import { loadAtomConfig } from "../config.js";
import {
  classifyIp,
  defaultNetworkPolicy,
  isRedirectStatus,
  zoneAllows,
  zoneForAddresses,
  type NetworkPolicy,
  type NetworkZone,
  type ResolveHost,
} from "../policy.js";
import { appendOverflow } from "./overflow.js";
import { err, READ_CHAR_CAP, truncateHead } from "./shared.js";
// ---- Web tools (webfetch retrieval / websearch discovery) ----

const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const WEBFETCH_DOWNLOAD_CAP = 1024 * 1024; // ~1MB download cap
const WEBSEARCH_QUERY_CAP = 500;
const WEBSEARCH_TIMEOUT_MS = 30000;

// Decode common named entities plus decimal/hex numeric refs. Unknown
// entities are left as-is.
function decodeHtmlEntities(s: string): string {
  const numeric = s
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex: string) => {
      const cp = parseInt(hex, 16);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&#([0-9]+);/g, (m, dec: string) => {
      const cp = parseInt(dec, 10);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    });
  return numeric
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// Minimal HTML -> text: drop comments and script/style/noscript/template
// blocks, map block tags to line breaks, strip remaining tags to spaces,
// decode entities, collapse whitespace. Paragraph breaks (~double newline)
// are preserved.
function htmlToText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|template)[\s>][\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(
    /<\/?(?:p|div|br|li|[ou]l|h[1-6]|tr|t[bdh]|table|section|article|header|footer|main|nav|aside|figure|figcaption|blockquote|pre|hr|dd|dt|dl)[^>]*>/gi,
    "\n"
  );
  s = s.replace(/<[^<>]*>/g, " ");
  s = decodeHtmlEntities(s);
  s = s.replace(/\r\n?/g, "\n");
  s = s.replace(/[ \t\f\v ]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// Read a fetch Response body, aborting (cancelling the reader) once ~cap
// bytes are buffered. Falls back to res.text() when the body is not a
// stream (null-body responses, non-standard fetch mocks).
async function readBodyCapped(
  res: Response,
  capBytes: number
): Promise<{ text: string; truncated: boolean }> {
  const body = (res as unknown as { body?: unknown }).body as
    | { getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?: () => Promise<void> | void; releaseLock?: () => void } }
    | null
    | undefined;
  if (body != null && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        if (total + value.byteLength > capBytes) {
          const keep = capBytes - total;
          if (keep > 0) {
            chunks.push(value.slice(0, keep));
            total += keep;
          }
          truncated = true;
          try {
            await reader.cancel?.();
          } catch {
            // ignore cancel errors
          }
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      try {
        reader.releaseLock?.();
      } catch {
        // ignore
      }
    }
    const buf = Buffer.concat(
      chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))
    );
    return { text: buf.toString("utf8"), truncated };
  }
  const text = await res.text();
  if (text.length > capBytes) return { text: text.slice(0, capBytes), truncated: true };
  return { text, truncated: false };
}

export type WebfetchArgs = { url: string; format?: string; timeoutMs?: number };

// Webfetch network surface (SSRF-aware). The policy gates the initial URL
// AND every redirect hop (opaque `redirect: "follow"` would let a public URL
// bounce to 169.254.169.254 or localhost unseen). `resolveHost` is injectable
// so tests never touch real DNS.
export type WebfetchOptions = {
  policy?: NetworkPolicy;
  resolveHost?: ResolveHost;
};

const WEBFETCH_MAX_REDIRECTS = 5;

// Default hostname resolver: literal IPs classify directly (no DNS);
// "localhost" pins loopback without depending on resolver config; everything
// else resolves via the system resolver (all addresses — a hostname
// straddling zones is gated by its most sensitive one). Never throws: DNS
// failure yields [] (the caller blocks unresolvable hosts fail-closed).
async function defaultResolveHost(host: string): Promise<string[]> {
  try {
    if (host.toLowerCase() === "localhost") return ["127.0.0.1"];
    const records = await dns.lookup(host, { all: true });
    return records.map((r) => r.address);
  } catch {
    return [];
  }
}

function loadNetworkPolicy(): NetworkPolicy {
  try {
    const file = loadAtomConfig().config.network;
    if (!file) return defaultNetworkPolicy();
    return { ...defaultNetworkPolicy(), ...file };
  } catch {
    return defaultNetworkPolicy();
  }
}

export type UrlPolicyCheck =
  | { ok: true; zone: NetworkZone; url: string }
  | { ok: false; error: string };

// Gate one URL against the network policy (initial URL and EVERY redirect
// hop — redirects must never bypass it). Checks, in order: parseable,
// http(s) scheme, no embedded credentials, resolvable/classifiable host,
// zone allowed by policy. Known limitation (documented, not solved here):
// DNS rebinding between this check and fetch (TOCTOU) — mitigating that
// needs connection-level IP pinning, which global fetch does not offer.
export async function checkUrlAgainstPolicy(
  rawUrl: string,
  policy: NetworkPolicy,
  resolve: ResolveHost = defaultResolveHost
): Promise<UrlPolicyCheck> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: `Error: invalid URL: ${rawUrl}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `Error: unsupported URL scheme (only http/https allowed): ${parsed.protocol}` };
  }
  // Credential-bearing URLs are an exfiltration shape (model-generated URLs
  // should never carry userinfo); reject before any DNS or fetch.
  if (parsed.username || parsed.password) {
    return { ok: false, error: `Error: URLs with credentials are not allowed` };
  }
  let host = parsed.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host) return { ok: false, error: `Error: invalid URL: ${rawUrl}` };
  // Bracketed IPv6 literals as carried by URL.hostname.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  let zone: NetworkZone;
  if (net.isIP(bare) !== 0) {
    const direct = classifyIp(bare);
    zone = direct === "invalid" ? "blocked" : direct;
  } else {
    let addresses: string[];
    try {
      addresses = await resolve(host);
    } catch {
      addresses = [];
    }
    if (addresses.length === 0) {
      return { ok: false, error: `Error: cannot resolve host: ${host}` };
    }
    zone = zoneForAddresses(addresses);
  }
  if (zone === "blocked" || !zoneAllows(zone, policy)) {
    const key =
      zone === "public"
        ? "allowPublic"
        : zone === "localhost"
          ? "allowLocalhost"
          : zone === "private"
            ? "allowPrivate"
            : "allowLinkLocal";
    const reason =
      zone === "blocked"
        ? "unresolvable address"
        : `network policy blocks ${zone} URLs (atom.json network.${key})`;
    return { ok: false, error: `Error: ${reason}: ${rawUrl}` };
  }
  return { ok: true, zone, url: parsed.toString() };
}

// Fetch a page (retrieval). http:// is auto-upgraded to https:// (noted);
// only http/https schemes are allowed. Downloads are capped at ~1MB and
// output at ~64KB (both noted when truncated). markdown/text return page
// text (non-HTML content-types pass through as text); html returns the raw
// body. Network policy (SSRF): the initial URL and EVERY redirect hop are
// gated by zone (public/localhost/private/link-local/blocked) — redirects
// are followed manually (cap 5, loop-detected) so a public URL can never
// bounce to localhost/metadata unseen. Error strings, never throws.
export async function webfetchTool(
  args: WebfetchArgs,
  opts?: WebfetchOptions
): Promise<string> {
  try {
    const rawUrl = typeof args?.url === "string" ? args.url.trim() : "";
    if (!rawUrl) return err("url must be a non-empty string");
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return err(`invalid URL: ${rawUrl}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return err(`unsupported URL scheme (only http/https allowed): ${parsed.protocol}`);
    }
    const format = args?.format ?? "markdown";
    if (format !== "markdown" && format !== "text" && format !== "html") {
      return err('format must be "markdown", "text", or "html"');
    }
    const t = args?.timeoutMs;
    const timeoutMs =
      typeof t === "number" && Number.isFinite(t)
        ? Math.min(Math.max(Math.floor(t), 1), 120000)
        : 30000;
    let target = parsed.toString();
    let upgraded = false;
    if (parsed.protocol === "http:") {
      parsed.protocol = "https:";
      target = parsed.toString();
      upgraded = true;
    }
    const policy = opts?.policy ?? loadNetworkPolicy();
    const resolve = opts?.resolveHost ?? defaultResolveHost;
    const first = await checkUrlAgainstPolicy(target, policy, resolve);
    if (!first.ok) return first.error;
    target = first.url;
    const visited = new Set<string>([target]);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    let hops = 0;
    try {
      for (;;) {
        res = await fetch(target, {
          redirect: "manual",
          signal: ctrl.signal,
          headers: {
            "User-Agent": WEB_UA,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        });
        const status = typeof res.status === "number" ? res.status : 0;
        if (!isRedirectStatus(status)) break;
        // Best-effort socket release before following (mocks may lack a body).
        try {
          await res.body?.cancel?.();
        } catch {
          // ignore — the next fetch proceeds regardless
        }
        const loc = res.headers?.get?.("location") ?? null;
        if (!loc) return err(`webfetch redirect without location: ${target}`);
        let next: URL;
        try {
          next = new URL(loc, target);
        } catch {
          return err(`webfetch invalid redirect location from ${target}`);
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          return err(`webfetch redirect to unsupported scheme (${next.protocol}): ${target}`);
        }
        if (visited.has(next.toString())) {
          return err(`webfetch redirect loop detected: ${target}`);
        }
        visited.add(next.toString());
        hops += 1;
        if (hops > WEBFETCH_MAX_REDIRECTS) {
          return err(`webfetch too many redirects (>${WEBFETCH_MAX_REDIRECTS}): ${target}`);
        }
        const hop = await checkUrlAgainstPolicy(next.toString(), policy, resolve);
        if (!hop.ok) return hop.error;
        target = hop.url;
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        return err(`webfetch timed out after ${timeoutMs}ms: ${target}`);
      }
      return err(`webfetch failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return err(`webfetch HTTP ${res.status} for ${target}`);
    let body: string;
    let downloadTruncated = false;
    try {
      const capped = await readBodyCapped(res, WEBFETCH_DOWNLOAD_CAP);
      body = capped.text;
      downloadTruncated = capped.truncated;
    } catch (e) {
      return err(`webfetch failed reading response: ${e instanceof Error ? e.message : String(e)}`);
    }
    const contentType = res.headers?.get?.("content-type") ?? "";
    const isHtml = contentType.trim() === "" || /html|xhtml/i.test(contentType);
    const out = format === "html" || !isHtml ? body : htmlToText(body);
    const prefix = upgraded ? "[note: upgraded http:// to https://]\n" : "";
    const notes: string[] = [];
    if (hops > 0) notes.push(`[note: followed ${hops} redirect(s) to ${target}]`);
    let text = out;
    if (downloadTruncated) notes.push("[truncated: download exceeded ~1MB]");
    if (text.length > READ_CHAR_CAP) {
      const full = text;
      const t = truncateHead(full, READ_CHAR_CAP, "\n[truncated: output exceeded 64KB]");
      text = t.head;
      notes.push(t.note.replace(/^\n/, ""));
      // Single spill: recover the pointer line from the composed tail.
      const tailed = appendOverflow(t.head, t.note, "converted page text", full);
      const overflowLine = tailed.slice((t.head + t.note + "\n").length);
      if (overflowLine.startsWith("[overflow:")) notes.push(overflowLine);
    }
    return prefix + text + (notes.length > 0 ? "\n" + notes.join("\n") : "");
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// Unwrap a DuckDuckGo /l/ redirect (?uddg=<encoded target>) to the real
// target URL; pass direct http(s) hrefs through. Anything else is dropped.
function cleanDdgUrl(href: string): string {
  const h = decodeHtmlEntities(href.trim());
  if (!h) return "";
  const abs = h.startsWith("//") ? `https:${h}` : h;
  try {
    const u = new URL(abs, "https://html.duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return uddg;
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
    return "";
  } catch {
    return "";
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export type DdgResult = { title: string; url: string; snippet: string };

// Parse DuckDuckGo HTML endpoint results with regex: split on result
// container divs, then take the first result__a anchor (title/url) and the
// result__snippet (a or div) per block. Blocks without a usable title/url
// are skipped.
export function parseDdgResults(html: string): DdgResult[] {
  const out: DdgResult[] = [];
  try {
    const chunks = html.split(/<div\b[^>]*\bclass="result[\s"']/i);
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      let title = "";
      let url = "";
      const anchors = chunk.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi);
      for (const m of anchors) {
        if (!/\bresult__a\b/.test(m[1]!)) continue;
        const href = /href\s*=\s*"([^"]*)"/i.exec(m[1]!)?.[1] ?? "";
        url = cleanDdgUrl(href);
        title = oneLine(htmlToText(m[2] ?? ""));
        break;
      }
      if (!title || !url) continue;
      const snip = /result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/i.exec(chunk);
      const snippet = snip ? oneLine(htmlToText(snip[1] ?? "")) : "";
      out.push({ title, url, snippet });
    }
  } catch {
    return out;
  }
  return out;
}

export type WebsearchArgs = { query: string; numResults?: number; site?: string };

// Search the web (discovery) via the keyless DuckDuckGo HTML endpoint —
// best-effort: DDG bot protection may answer 403, surfaced as an error
// string. Returns numbered "title — url" + snippet blocks, or "No results.".
// Error strings, never throws.
export async function websearchTool(args: WebsearchArgs): Promise<string> {
  try {
    const raw = typeof args?.query === "string" ? args.query.trim() : "";
    if (!raw) return err("query must be a non-empty string");
    // Client-side domain scoping (no server-side filters on this backend):
    // `site: "example.com"` appends a `site:` operator to the query.
    const site = typeof args?.site === "string" ? args.site.trim() : "";
    const scoped = site ? `${raw} site:${site}` : raw;
    const query = scoped.length > WEBSEARCH_QUERY_CAP ? scoped.slice(0, WEBSEARCH_QUERY_CAP) : scoped;
    const n = args?.numResults;
    const numResults =
      typeof n === "number" && Number.isFinite(n)
        ? Math.min(Math.max(Math.floor(n), 1), 20)
        : 8;
    const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), WEBSEARCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(endpoint, {
        signal: ctrl.signal,
        headers: { "User-Agent": WEB_UA, Accept: "text/html,*/*;q=0.8" },
      });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        return err(`websearch timed out after ${WEBSEARCH_TIMEOUT_MS}ms`);
      }
      return err(`websearch failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 403) {
      return err("websearch blocked by DuckDuckGo bot protection (HTTP 403; best-effort search — retry later)");
    }
    if (!res.ok) return err(`websearch HTTP ${res.status}`);
    let html: string;
    try {
      html = await res.text();
    } catch (e) {
      return err(`websearch failed reading response: ${e instanceof Error ? e.message : String(e)}`);
    }
    const results = parseDdgResults(html).slice(0, numResults);
    if (results.length === 0) return "No results.";
    return results
      .map((r, i) => {
        const head = `${i + 1}. ${r.title} — ${r.url}`;
        return r.snippet ? `${head}\n   ${r.snippet}` : head;
      })
      .join("\n");
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

