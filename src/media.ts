// Vision input (image attachments) for the harness.
//
// Scope (deliberate): PNG, JPEG, GIF, WebP only — the same four OpenCode
// passes as image media. PDF, AVIF, BMP, audio, video, and other binaries
// are rejected with an actionable convert-first error, never silently.
// No resize/re-encode dependency (zero-dep policy): oversize images are
// rejected with guidance instead of downscaled.
//
// Design (blast-radius minimal):
// - History/transcript/session stay plain strings. The `read` tool stores
//   image bytes under ~/.atom/media/ and returns a short descriptor token
//   `[media:<id> <mime> <bytes>B]`. The TUI renders it as one text line;
//   session.json stays small; /resume keeps working.
// - Expansion happens at exactly one point per POST kind (openai-chat in
//   zen.ts, anthropic-messages + gemini-generate in adapters.ts), which
//   resolve descriptor tokens into provider-native image blocks. Missing
//   files (pruned, deleted home) degrade to a text placeholder — never a
//   crash, never a dropped turn.
// - Compaction/summarization and text-only-model fallback use strip mode:
//   descriptors become `[image: <name>]` prose markers, so the summarizer
//   never pays for pixels.
// - Context accounting stays honest: messageChars adds the deterministic
//   base64 wire cost (ceil(bytes*4/3)) per descriptor — see
//   mediaWireChars Bash in context-manager.ts.
import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import { atomDir } from "./auth.js";

export const SUPPORTED_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

// Ingest cap per image (raw bytes). Over it the read tool refuses with
// guidance instead of downscaling (no image codec dependency).
export const MEDIA_MAX_BYTES = 8 * 1024 * 1024;
// Stored media older than this is pruned best-effort on the next media
// write (fail-open — pruning never breaks reads).
export const MEDIA_PRUNE_AFTER_MS = 7 * 24 * 3600 * 1000;

export const MEDIA_DIRNAME = "media";

// Descriptor token embedded in tool results / history text:
// `[media:<id> <mime> <bytes>B]`, e.g. `[media:k3xq9z image/png 41204B]`.
export const MEDIA_RE =
  /\[media:([A-Za-z0-9_-]{1,64}) ([a-z]+\/[a-z0-9.+-]+) (\d+)B\]/g;

export function mediaDescriptor(id: string, mime: string, bytes: number): string {
  return `[media:${id} ${mime} ${bytes}B]`;
}

// Magic-byte sniff over the file head. Returns the image mime when the
// bytes are a supported image, else null (caller falls through to the
// text path or the unsupported-binary error).
export function sniffImageMime(head: Uint8Array): string | null {
  const b = head;
  const n = b.length;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    n >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (n >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF: "GIF87a" / "GIF89a"
  if (
    n >= 6 &&
    b[0] === 0x47 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x38 &&
    (b[4] === 0x37 || b[4] === 0x39) &&
    b[5] === 0x61
  ) {
    return "image/gif";
  }
  // WebP: "RIFF" + 4 size bytes + "WEBP"
  if (
    n >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

// True when the head looks like a PDF (%PDF magic). PDFs are rejected as
// vision input with convert-first guidance (see unsupportedBinaryError).
export function sniffPdf(head: Uint8Array): boolean {
  return (
    head.length >= 4 &&
    head[0] === 0x25 &&
    head[1] === 0x50 &&
    head[2] === 0x44 &&
    head[3] === 0x46
  );
}

// Actionable error for binaries the harness cannot send as vision input.
// Never throws; the model gets conversion guidance it can act on via bash.
export function unsupportedBinaryError(
  filePath: string,
  kind: "pdf" | "binary",
  sizeBytes?: number
): string {
  const size = typeof sizeBytes === "number" ? ` (${sizeBytes} bytes)` : "";
  if (kind === "pdf") {
    return (
      `Error: cannot read ${filePath}${size} as vision input — PDFs are not supported. ` +
      `Convert it first: export pages as PNG (e.g. \`pdftoppm -png ${filePath} page\`) and read the PNG, ` +
      `or extract text (e.g. \`pdftotext ${filePath} -\`) and read that instead.`
    );
  }
  return (
    `Error: cannot read ${filePath}${size} — unsupported binary (only PNG, JPEG, GIF, WebP images ` +
    `are read as vision input). Convert it to a supported image or extract its text first, then read that.`
  );
}

export function oversizeImageError(filePath: string, sizeBytes: number): string {
  const mb = (MEDIA_MAX_BYTES / (1024 * 1024)).toFixed(0);
  return (
    `Error: ${filePath} is ${sizeBytes} bytes (over the ${mb} MiB image cap) — downscale it ` +
    `first (e.g. with Python PIL or ImageMagick) and read the smaller file.`
  );
}

// ---- Disk-backed media store -------------------------------------------
// Files: <id>.bin (raw bytes) + <id>.json ({mime,name,bytes}). Fail-open
// everywhere: store/load/prune never throw.

export type StoredMedia = {
  mime: string;
  name: string;
  bytes: number;
  base64: string;
};

export function mediaDir(home?: string): string {
  return path.join(atomDir(home), MEDIA_DIRNAME);
}

function mediaId(): string {
  return `${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
}

export async function saveMedia(
  raw: Buffer,
  mime: string,
  name: string,
  home?: string
): Promise<{ id: string }> {
  const dir = mediaDir(home);
  try {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    // fail-open: write below still attempted
  }
  const id = mediaId();
  try {
    await fsp.writeFile(path.join(dir, `${id}.bin`), raw);
    await fsp.writeFile(
      path.join(dir, `${id}.json`),
      JSON.stringify({ mime, name, bytes: raw.length })
    );
  } catch {
    // fail-open: descriptor still returned; POST lowering degrades to a
    // placeholder when the files are unreadable.
  }
  pruneMedia(dir);
  return { id };
}

export function loadMedia(id: string, home?: string): StoredMedia | null {
  try {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
    const dir = mediaDir(home);
    const metaRaw = fs.readFileSync(path.join(dir, `${id}.json`), "utf8");
    const meta = JSON.parse(metaRaw) as { mime?: unknown; name?: unknown; bytes?: unknown };
    if (typeof meta.mime !== "string" || !SUPPORTED_IMAGE_MIMES.has(meta.mime)) return null;
    const raw = fs.readFileSync(path.join(dir, `${id}.bin`));
    return {
      mime: meta.mime,
      name: typeof meta.name === "string" ? meta.name : id,
      bytes: raw.length,
      base64: raw.toString("base64"),
    };
  } catch {
    return null;
  }
}

// Delete stored media older than MEDIA_PRUNE_AFTER_MS. Fire-and-forget,
// best-effort, never throws (called without await).
function pruneMedia(dir: string): void {
  try {
    const cutoff = Date.now() - MEDIA_PRUNE_AFTER_MS;
    void fsp
      .readdir(dir)
      .then(async (entries) => {
        for (const e of entries) {
          if (!e.endsWith(".bin") && !e.endsWith(".json")) continue;
          const p = path.join(dir, e);
          try {
            const st = await fsp.stat(p);
            if (st.mtimeMs < cutoff) await fsp.rm(p, { force: true });
          } catch {
            // per-file fail-open
          }
        }
      })
      .catch(() => {});
  } catch {
    // fail-open
  }
}

// ---- Descriptor helpers (pure, no I/O) -----------------------------------

// Deterministic wire cost of the descriptors in a string: base64 inflates
// raw bytes by exactly 4/3. Used by messageChars so context accounting
// stays honest.
export function mediaWireChars(content: string): number {
  let n = 0;
  MEDIA_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MEDIA_RE.exec(content)) !== null) {
    const bytes = Number(m[3]);
    if (Number.isFinite(bytes) && bytes > 0) n += Math.ceil(bytes / 3) * 4;
  }
  MEDIA_RE.lastIndex = 0;
  return n;
}

export function hasMediaRefs(content: string): boolean {
  MEDIA_RE.lastIndex = 0;
  const hit = MEDIA_RE.test(content);
  MEDIA_RE.lastIndex = 0;
  return hit;
}

// Strip mode: descriptors become prose markers. Used for compaction /
// summarization POSTs and the text-only-model fallback retry.
export function stripMedia(content: string): string {
  MEDIA_RE.lastIndex = 0;
  const out = content.replace(MEDIA_RE, (_tok, _id, mime) => `[image omitted: ${mime}]`);
  MEDIA_RE.lastIndex = 0;
  return out;
}

// Server-authoritative image rejection: a 400 naming image/vision input
// means this model/deployment takes no images — the caller retries once
// with media stripped (mirrors the reasoning-effort knob precedent).
export function isImageRejection(errText: string): boolean {
  if (!/image|vision|multimodal|media|picture/i.test(errText)) return false;
  return /not supported|unsupported|does not support|do not support|cannot (read|see|view|process|accept)|invalid image|no.*vision|vision.*not|400/i.test(
    errText
  );
}

// ---- POST-time resolution (does I/O: call only at body build) ------------

export type ResolvedMedia =
  | { ok: true; id: string; mime: string; name: string; base64: string }
  | { ok: false; id: string };

export type ResolvedContent = {
  // Descriptor tokens replaced with `[image: <name>]` markers
  // (missing files become `[image unavailable: <id>]`).
  text: string;
  media: ResolvedMedia[];
};

export function resolveMediaRefs(content: string, home?: string): ResolvedContent {
  const media: ResolvedMedia[] = [];
  MEDIA_RE.lastIndex = 0;
  const text = content.replace(
    MEDIA_RE,
    (_tok: string, id: string, _mime: string, _bytes: string) => {
      const loaded = loadMedia(id, home);
      if (!loaded) {
        media.push({ ok: false, id });
        return `[image unavailable: ${id}]`;
      }
      media.push({ ok: true, id, mime: loaded.mime, name: loaded.name, base64: loaded.base64 });
      return `[image: ${loaded.name}]`;
    }
  );
  MEDIA_RE.lastIndex = 0;
  return { text, media };
}

// Per-POST media option: strip mode replaces descriptors with prose
// markers instead of expanding them (compaction/summarization POSTs and
// the text-only-model fallback retry). Threaded through ProviderChatOpts
// like disableTools/maxOutputTokens.
export type MediaOpts = {
  stripMedia?: boolean;
};

export function historyHasMedia(history: Array<Record<string, unknown>>): boolean {
  for (const m of history) {
    const c = (m as { content?: unknown }).content;
    if (typeof c === "string" && hasMediaRefs(c)) return true;
  }
  return false;
}

// OpenAI-chat lowering for one message content: string in, string out when
// no descriptors are present (byte-identical — existing payload tests hold),
// else a text + image_url parts array. System role always strips.
export function lowerOpenAIContent(
  role: string,
  content: string,
  mode: "send" | "strip" = "send",
  home?: string
): string | Array<Record<string, unknown>> {
  if (!hasMediaRefs(content)) return content;
  if (mode === "strip" || role === "system") return stripMedia(content);
  const { text, media } = resolveMediaRefs(content, home);
  const parts: Array<Record<string, unknown>> = [{ type: "text", text }];
  for (const m of media) {
    if (!m.ok) continue; // placeholder already inline in text
    parts.push({
      type: "image_url",
      image_url: { url: `data:${m.mime};base64,${m.base64}` },
    });
  }
  return parts;
}
