#!/usr/bin/env node
// Ink entry point for the Atom chatbot (multi-provider).
// Default provider: OpenCode Zen, OpenAI-compatible Chat Completions.
//   Default: POST https://opencode.ai/zen/v1/chat/completions
//   Auth:    $OPENCODE_ZEN_API_KEY (https://opencode.ai/auth) wins,
//            else ~/.atom/auth.json (see /provider). Other providers use
//            their own env vars or stored keys (see README providers table).
//   Model:   $OPENCODE_ZEN_MODEL (default: big-pickle)
import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  endpointConfig,
} from "./zen.js";
import { loadAuth, resolveApiKey } from "./auth.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Atom chatbot (Ink TUI)
Usage: npm start
Env:
  OPENCODE_ZEN_API_KEY  optional when ~/.atom/auth.json has a zen key (get one at https://opencode.ai/auth)
  OPENAI_API_KEY / ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / MISTRAL_API_KEY / GEMINI_API_KEY (GOOGLE_API_KEY alias)  optional per provider (env wins over stored)
  OPENCODE_ZEN_MODEL    optional (default: ${DEFAULT_MODEL})
  OPENCODE_ZEN_ENDPOINT optional (default: ${DEFAULT_ENDPOINT})
Commands: /model (model picker) | /provider (provider + key picker) | /effort (reasoning-effort picker) | /tools | /mode | /yolo (toggle) | /clear | /resume (restore last saved session) | /help | /exit | /quit
Providers: opencode-zen/openai/anthropic/deepseek/mistral/google-gemini/openai-compatible (keys in ~/.atom/auth.json, 0600 POSIX; use /provider to paste one).
Note: reasoning_effort is sent only for opencode-zen supported models.`);
  process.exit(0);
}

const { endpoint, apiKey: envKey, model } = endpointConfig();
// Stored zen key (from a previous /provider paste) applies when no env key.
const storedZen = resolveApiKey("opencode-zen", loadAuth());
const apiKey = envKey || storedZen;

// Always start the TUI (even without a key) so /provider can paste one.
// Chatting without a key for the active provider errors inline with a
// /provider pointer; nothing is POSTed.
render(<App apiKey={apiKey} endpoint={endpoint} initialModel={model} />);
