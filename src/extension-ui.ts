// Extension UI surface (ticket 10): the dependency-free render model behind
// ExtensionAPI.setStatusSegment/setWidget/notify/promptUser. No imports, no
// React — like extension-commands.ts and tools/intercept.ts — so the host,
// the App, and pure unit tests share it with no cycle: the host validates
// and stages here, the App renders from here, nobody imports the other.
//
// Shapes:
// - Status: one text slot per extension (upsert by owner name). The bar
//   budget lives with the render (status-bar.tsx states the fixed-width
//   rule); this module only validates shape so a bad segment fails
//   activation loudly instead of corrupting the bar.
// - Widget: titled text blocks keyed by owner + id (default "main"),
//   rendered by the App in the configured placement. "panel" is the only
//   placement in v1 (the bordered panel above the input zone, beside the
//   todo panel) — unknown placements throw fail-closed so a typo surfaces
//   at activation instead of rendering nowhere.
// - Notices: transient fire-and-forget strings the App drains into the
//   transcript (one `(owner) message` info line each). Sync and bounded
//   by flow — notify() never blocks, headless or not; the host caps the
//   staged queue drop-oldest (EXT_NOTICE_CAP in extensions.ts).
// - Dialogs: validated { question, options, allowCustom } specs mirroring
//   the QuestionBox the App fulfills them with (same option caps the modal
//   already assumes). The pending-promise mechanics live in extensions.ts
//   (runtime-local, generation-bound); this module only validates shape.

export const EXT_STATUS_SEGMENT_MAX = 24;

export const EXT_STATUS_TOTAL_MAX = 40;

export const EXT_WIDGET_TITLE_MAX = 48;

export const EXT_WIDGET_TEXT_MAX = 500;

export const EXT_NOTIFY_MAX = 200;

export const EXT_DIALOG_QUESTION_MAX = 200;

export const EXT_DIALOG_OPTIONS_MAX = 8;

export const EXT_DIALOG_OPTION_MAX = 80;

// v1 widget placements. The App renders "panel" above the input zone;
// anything else is a loud validation error (never a silent nowhere).
export const EXT_WIDGET_PLACEMENTS = ["panel"] as const;

export type ExtensionWidgetPlacement = (typeof EXT_WIDGET_PLACEMENTS)[number];

export type ExtensionWidgetDef = {
  /** Widget id within the extension (default "main"); [a-z0-9_-], 1-32 chars. */
  id?: string;
  /** Where the App renders the widget (v1: "panel" only). */
  placement: string;
  /** Panel heading (1-48 chars). */
  title: string;
  /** Panel body (1-500 chars, plain text). */
  text: string;
};

export type ValidatedWidgetDef = {
  id: string;
  placement: ExtensionWidgetPlacement;
  title: string;
  text: string;
};

export type ExtensionDialogDef = {
  /** Modal heading (1-200 chars). */
  question: string;
  /** Picker options (when absent/empty with allowCustom, free text only). */
  options?: string[];
  /** Whether typing a custom answer is allowed (default false). */
  allowCustom?: boolean;
};

export type ValidatedDialogDef = {
  question: string;
  options: string[];
  allowCustom: boolean;
};

const WIDGET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorFor(owner: string, what: string): string {
  return `extension "${owner}" ${what}`;
}

/** Validate a status segment. Throws Error on any problem. Returns the trimmed text. */
export function validateStatusSegment(owner: string, text: unknown): string {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error(errorFor(owner, "status segment needs a non-empty string"));
  }
  if (text.length > EXT_STATUS_SEGMENT_MAX * 4) {
    throw new Error(
      errorFor(owner, `status segment is too long (${text.length} chars, max ${EXT_STATUS_SEGMENT_MAX * 4})`)
    );
  }
  return text;
}

/** Validate a widget definition. Throws Error on any problem. */
export function validateWidgetDef(owner: string, def: ExtensionWidgetDef): ValidatedWidgetDef {
  if (!isRecord(def)) throw new Error(errorFor(owner, "widget definition must be an object"));
  const id = def.id === undefined ? "main" : def.id;
  if (typeof id !== "string" || !WIDGET_ID_RE.test(id)) {
    throw new Error(
      errorFor(owner, `widget has an invalid id ${JSON.stringify(def.id)} (want 1-32 char a-z0-9_-, default "main")`)
    );
  }
  if (!(EXT_WIDGET_PLACEMENTS as readonly string[]).includes(def.placement)) {
    throw new Error(
      errorFor(owner, `widget "${id}" has an unknown placement ${JSON.stringify(def.placement)} (want one of: ${EXT_WIDGET_PLACEMENTS.join(", ")})`)
    );
  }
  if (typeof def.title !== "string" || def.title.trim().length === 0) {
    throw new Error(errorFor(owner, `widget "${id}" needs a non-empty title`));
  }
  if (def.title.length > EXT_WIDGET_TITLE_MAX) {
    throw new Error(
      errorFor(owner, `widget "${id}" title is too long (${def.title.length} chars, max ${EXT_WIDGET_TITLE_MAX})`)
    );
  }
  if (typeof def.text !== "string" || def.text.trim().length === 0) {
    throw new Error(errorFor(owner, `widget "${id}" needs a non-empty text body`));
  }
  if (def.text.length > EXT_WIDGET_TEXT_MAX) {
    throw new Error(
      errorFor(owner, `widget "${id}" text is too long (${def.text.length} chars, max ${EXT_WIDGET_TEXT_MAX})`)
    );
  }
  return { id, placement: def.placement as ExtensionWidgetPlacement, title: def.title, text: def.text };
}

/** Validate a notification message. Throws Error on any problem. Returns the message. */
export function validateNotifyMessage(owner: string, message: unknown): string {
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new Error(errorFor(owner, "notification needs a non-empty string"));
  }
  if (message.length > EXT_NOTIFY_MAX * 4) {
    throw new Error(
      errorFor(owner, `notification is too long (${message.length} chars, max ${EXT_NOTIFY_MAX * 4})`)
    );
  }
  return message;
}

/** Validate a dialog spec. Throws Error on any problem. */
export function validateDialogDef(owner: string, def: ExtensionDialogDef): ValidatedDialogDef {
  if (!isRecord(def)) throw new Error(errorFor(owner, "dialog definition must be an object"));
  if (typeof def.question !== "string" || def.question.trim().length === 0) {
    throw new Error(errorFor(owner, "dialog needs a non-empty question"));
  }
  if (def.question.length > EXT_DIALOG_QUESTION_MAX) {
    throw new Error(
      errorFor(owner, `dialog question is too long (${def.question.length} chars, max ${EXT_DIALOG_QUESTION_MAX})`)
    );
  }
  const options = def.options === undefined ? [] : def.options;
  if (!Array.isArray(options)) {
    throw new Error(errorFor(owner, "dialog options must be an array of strings"));
  }
  if (options.length > EXT_DIALOG_OPTIONS_MAX) {
    throw new Error(
      errorFor(owner, `dialog has too many options (${options.length}, max ${EXT_DIALOG_OPTIONS_MAX})`)
    );
  }
  for (const o of options) {
    if (typeof o !== "string" || o.trim().length === 0) {
      throw new Error(errorFor(owner, "dialog options must be non-empty strings"));
    }
    if (o.length > EXT_DIALOG_OPTION_MAX) {
      throw new Error(
        errorFor(owner, `dialog option is too long (${o.length} chars, max ${EXT_DIALOG_OPTION_MAX})`)
      );
    }
  }
  if (!options.length && def.allowCustom !== true) {
    throw new Error(errorFor(owner, "dialog needs options or allowCustom: true (nothing to answer with)"));
  }
  return { question: def.question, options: [...options], allowCustom: def.allowCustom === true };
}

// Truncate text to n chars max for tight widths (`…/tail` keeps the
// meaningful end, the status-bar convention). n < 4 yields "" (the caller
// drops the segment instead of rendering a stub).
export function truncateSegment(s: string, n: number): string {
  if (s.length <= n) return s;
  if (n < 4) return "";
  return `…/${s.slice(-(n - 3))}`;
}

// Pure status-bar text for extension segments (unit-tested; the bar itself
// only decides fit-or-drop against the terminal width, never the content).
// Each segment truncates to EXT_STATUS_SEGMENT_MAX, joined with " · "; the
// total caps at EXT_STATUS_TOTAL_MAX with trailing segments dropped whole
// (never a mid-segment cut past the per-segment truncation). Null when
// nothing renderable remains.
export function formatExtensionStatusText(segments: string[]): string | null {
  const parts: string[] = [];
  let len = 0;
  for (const raw of segments) {
    if (typeof raw !== "string") continue;
    const text = raw.trim();
    if (!text) continue;
    const seg = truncateSegment(text, EXT_STATUS_SEGMENT_MAX);
    if (!seg) continue;
    const add = (parts.length > 0 ? 3 : 0) + seg.length;
    if (len + add > EXT_STATUS_TOTAL_MAX) continue;
    parts.push(seg);
    len += add;
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
