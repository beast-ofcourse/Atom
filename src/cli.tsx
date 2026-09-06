#!/usr/bin/env node
// Ink entry point for the minimal Atom chatbot.
// Provider: OpenCode Zen, OpenAI-compatible Chat Completions endpoint.
//   Default: POST https://opencode.ai/zen/v1/chat/completions
//   Auth:    Authorization: Bearer $OPENCODE_ZEN_API_KEY (key from https://opencode.ai/auth)
//   Model:   $OPENCODE_ZEN_MODEL (default: big-pickle)
import React from "react";
import { render } from "ink";
import { App, MissingKey } from "./App.js";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  endpointConfig,
} from "./zen.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Atom chatbot (Ink TUI)
Usage: npm start
Env:
  OPENCODE_ZEN_API_KEY  required (get one at https://opencode.ai/auth)
  OPENCODE_ZEN_MODEL    optional (default: ${DEFAULT_MODEL})
  OPENCODE_ZEN_ENDPOINT optional (default: ${DEFAULT_ENDPOINT})
Commands: /model (model picker) | /tools | /mode | /yolo (toggle) | /clear | /help | /exit | /quit
Note: only chat/completions-family models work here
  (DeepSeek/Kimi/GLM/MiniMax/Big Pickle/free chat models). Responses/Messages/
  Gemini families use different Zen paths (see https://opencode.ai/docs/zen).`);
  process.exit(0);
}

const { endpoint, apiKey, model } = endpointConfig();

if (!apiKey) {
  // Error screen (not just stderr): render one frame, then exit nonzero.
  const app = render(<MissingKey />);
  setTimeout(() => {
    app.unmount();
    process.exitCode = 1;
  }, 200);
} else {
  render(<App apiKey={apiKey} endpoint={endpoint} initialModel={model} />);
}
