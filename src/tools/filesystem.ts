// Filesystem executors: read/write/edit. Every mutation snapshots prior
// bytes first (see snapshots.ts); validation failures return before capture.
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { capturePriorBytes } from "../snapshots.js";
import { contentHash, fingerprintKey, readFingerprints } from "./fingerprints.js";
import { appendOverflow } from "./overflow.js";
import { err, invalidCall, READ_CHAR_CAP, resolveSandbox } from "./shared.js";
export type ReadArgs = { path: string; offset?: number; limit?: number };

// offset/limit are 1-based line numbers. Output capped at ~64KB.
export async function readTool(args: ReadArgs, cwd: string = process.cwd()): Promise<string> {
  try {
    const r = resolveSandbox(args?.path, cwd);
    if (r.error || !r.abs) return r.error ?? err("bad path");
    let st;
    try {
      st = await fsp.stat(r.abs);
    } catch {
      return err(`no such file or directory: ${args.path}`);
    }
    if (st.isDirectory()) {
      const entries = await fsp.readdir(r.abs, { withFileTypes: true });
      const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return `Directory listing for ${args.path}:\n${lines.join("\n")}`;
    }
    let text: string;
    try {
      text = await fsp.readFile(r.abs, "utf8");
    } catch {
      return err(`cannot read file: ${args.path}`);
    }
    readFingerprints.set(fingerprintKey(r.abs), contentHash(text));
    if (text.length === 0) return "";
    const offset = Math.max(1, Math.floor(args.offset ?? 1));
    const limit = Math.max(1, Math.floor(args.limit ?? Number.MAX_SAFE_INTEGER));
    const window = text.split("\n").slice(offset - 1, offset - 1 + limit);
    let out = window.map((line, i) => `${offset + i}: ${line}`).join("\n");
    if (out.length > READ_CHAR_CAP) {
      const full = out;
      out = appendOverflow(full.slice(0, READ_CHAR_CAP), "\n[truncated: output exceeded 64KB]", "file output", full);
    }
    return out;
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export type WriteArgs = { path: string; content: string };

export async function writeTool(args: WriteArgs, cwd: string = process.cwd()): Promise<string> {
  try {
    const r = resolveSandbox(args?.path, cwd);
    if (r.error || !r.abs) return r.error ?? err("bad path");
    if (typeof args.content !== "string") return err("content must be a string");
    // Ticket 01 (/rewind): silent pre-mutation snapshot — every write is
    // covered regardless of caller, and capture never fails this call.
    await capturePriorBytes(r.abs, `write ${args.path}`);
    await fsp.mkdir(path.dirname(r.abs), { recursive: true });
    await fsp.writeFile(r.abs, args.content, "utf8");
    readFingerprints.set(fingerprintKey(r.abs), contentHash(args.content));
    return `Wrote ${Buffer.byteLength(args.content, "utf8")} bytes to ${args.path}`;
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export type EditArgs = { path: string; oldString: string; newString: string; replaceAll?: boolean };

export async function editTool(args: EditArgs, cwd: string = process.cwd()): Promise<string> {
  try {
    const r = resolveSandbox(args?.path, cwd);
    if (r.error || !r.abs) return r.error ?? err("bad path");
    if (typeof args.oldString !== "string" || args.oldString.length === 0) {
      return err("oldString must be a non-empty string");
    }
    if (typeof args.newString !== "string") return err("newString must be a string");
    let text: string;
    try {
      text = await fsp.readFile(r.abs, "utf8");
    } catch {
      return err(`no such file or directory: ${args.path}`);
    }
    const key = fingerprintKey(r.abs);
    const known = readFingerprints.get(key);
    if (known !== undefined && contentHash(text) !== known) {
      return invalidCall(
        `stale read — ${args.path} changed since you last read it. Read it again before editing`
      );
    }
    const count = text.split(args.oldString).length - 1;
    if (count === 0) return err(`no match for oldString in ${args.path}`);
    if (count > 1 && !args.replaceAll) {
      return err(`oldString matches ${count} times in ${args.path}; pass replaceAll=true to replace all`);
    }
    const next =
      args.replaceAll
        ? text.split(args.oldString).join(args.newString)
        : text.replace(args.oldString, args.newString);
    // Ticket 01 (/rewind): silent pre-mutation snapshot (see writeTool).
    await capturePriorBytes(r.abs, `edit ${args.path}`);
    await fsp.writeFile(r.abs, next, "utf8");
    readFingerprints.set(key, contentHash(next));
    return `Edited ${args.path}: replaced ${args.replaceAll ? count : 1} occurrence(s)`;
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

