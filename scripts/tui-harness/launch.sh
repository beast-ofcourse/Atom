#!/usr/bin/env bash
# Harness TUI launcher: cd to repo, run built CLI, keep pane on exit.
cd "C:/Users/Bhavin/Videos/WEB dev/Opensource porjects/Atom" || exit 99
node dist/cli.js
echo "CLI_EXIT=$?"
sleep 30
