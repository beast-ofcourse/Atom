# Graph Report - Atom  (2026-09-10)

## Corpus Check
- 167 files · ~216,933 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1558 nodes · 3486 edges · 96 communities (86 shown, 10 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 11 edges (avg confidence: 0.66)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Config Loading
- Context Budget Manager
- Package Manifest
- Rollback Checkpoints
- Local Model Discovery
- Context Compaction
- Agent Loop Runtime
- Slash Menu Draft Input
- Skill Registry
- Directory Listing Cache
- Telemetry Tracing Core
- Config Path Resolution
- Agent Loop Types
- Auth Key Store
- Session Persistence
- Telemetry HTTP Server
- App Command Helpers
- Telemetry Dashboard HTML
- Provider Registry
- Tool Executor Todos
- Loop Error Guard
- Kilo Catalog Client
- Markdown Stream Renderer
- Turn End Gates
- Telemetry Recorder
- Telemetry Session Store
- Diff View Highlight
- Read Cache
- Diff Engine
- Loop Guard Tests
- Tool Registry Schemas
- TypeScript Config Root
- Provider Chat Completions
- Kilo Model Helpers
- Tool Scheduler Effects
- TUI Cursor Tests
- System Prompt Agent Tests
- Shell Background Tasks
- Transcript Renderer
- App Shell Tests
- Filesystem Tools Fingerprints
- Tool Entry Overflow
- Provider API Adapters
- Environment Block
- Command Palette Theme
- Prompt Cache Prefix
- Provider Routing Tests
- Queue Steer Tests
- Context Windows Status
- Side By Side Diff
- Approval Modals
- Observability Tests
- Build TypeScript Config
- Approval Diff Tests
- Activity Live Tail
- Tool Inspector Panel
- Plan Mode Tests
- SSE Stall Reader
- Model List Parsers
- Reasoning Effort Tests
- Streaming Tests
- Provider Flow Tests
- Response Usage Parsers
- Error Cards
- Picker Components
- Status Line Tests
- Config File Tests
- Prefs Restore Tests
- Skills Invoke Tests
- Input Smoothness Tests
- CLI Entry Args
- Session Diff Panel
- Skills Slash Tests
- Package Keywords
- Architecture Graph Tests
- Scrollback Tests
- Slash Polish Tests
- Build Output Tests
- Status Bar Tests
- Slash Menu Tests
- Submit Order Tests

## God Nodes (most connected - your core abstractions)
1. `../src/App.js` - 202 edges
2. `App()` - 106 edges
3. `runLoopWithChat()` - 45 edges
4. `ChatMessage` - 35 edges
5. `executeTool()` - 30 edges
6. `getProvider()` - 24 edges
7. `TelemetryRecorder` - 22 edges
8. `chatCompletion()` - 21 edges
9. `err()` - 20 edges
10. `fetchModelsForProviderWithStatus()` - 19 edges

## Surprising Connections (you probably didn't know these)
- `withFastList()` --calls--> `clearDirListingCache()`  [EXTRACTED]
  tests/fast-list.test.ts → src/tools/dir-cache.ts
- `chatFn()` --calls--> `chatCompletion()`  [EXTRACTED]
  tests/history-budget.test.tsx → src/zen.ts
- `writeGlobalConfig()` --calls--> `globalConfigPath()`  [EXTRACTED]
  tests/config.test.ts → src/config.ts
- `rule()` --calls--> `parseRuleInput()`  [EXTRACTED]
  tests/permissions.test.ts → src/permissions.ts
- `seedHome()` --calls--> `createTelemetryRecorder()`  [EXTRACTED]
  tests/telemetry-server.test.ts → src/telemetry.ts

## Import Cycles
- 3-file cycle: `src/adapters.ts -> src/prompt-cache.ts -> src/zen.ts -> src/adapters.ts`
- 3-file cycle: `src/context-manager.ts -> src/context-windows.ts -> src/zen.ts -> src/context-manager.ts`
- 3-file cycle: `src/policy.ts -> src/zen.ts -> src/telemetry.ts -> src/policy.ts`
- 3-file cycle: `src/agent/loop.ts -> src/config.ts -> src/zen.ts -> src/agent/loop.ts`
- 3-file cycle: `src/config.ts -> src/zen.ts -> src/context-manager.ts -> src/config.ts`
- 4-file cycle: `src/policy.ts -> src/zen.ts -> src/tools.ts -> src/tools/shell.ts -> src/policy.ts`
- 4-file cycle: `src/config.ts -> src/zen.ts -> src/tools.ts -> src/tools/web.ts -> src/config.ts`
- 4-file cycle: `src/policy.ts -> src/zen.ts -> src/tools.ts -> src/tools/web.ts -> src/policy.ts`
- 4-file cycle: `src/agent/loop.ts -> src/context-manager.ts -> src/context-windows.ts -> src/zen.ts -> src/agent/loop.ts`
- 4-file cycle: `src/agent/loop.ts -> src/telemetry.ts -> src/policy.ts -> src/zen.ts -> src/agent/loop.ts`
- 4-file cycle: `src/agent/types.ts -> src/telemetry.ts -> src/policy.ts -> src/zen.ts -> src/agent/types.ts`
- 4-file cycle: `src/agent/loop.ts -> src/config.ts -> src/policy.ts -> src/zen.ts -> src/agent/loop.ts`
- 4-file cycle: `src/config.ts -> src/policy.ts -> src/zen.ts -> src/context-manager.ts -> src/config.ts`
- 4-file cycle: `src/agent/loop.ts -> src/context-manager.ts -> src/config.ts -> src/zen.ts -> src/agent/loop.ts`
- 5-file cycle: `src/agent/gates.ts -> src/tools.ts -> src/tools/shell.ts -> src/policy.ts -> src/zen.ts -> src/agent/gates.ts`
- 5-file cycle: `src/agent/gates.ts -> src/tools.ts -> src/tools/web.ts -> src/config.ts -> src/zen.ts -> src/agent/gates.ts`
- 5-file cycle: `src/agent/gates.ts -> src/tools.ts -> src/tools/web.ts -> src/policy.ts -> src/zen.ts -> src/agent/gates.ts`
- 5-file cycle: `src/policy.ts -> src/zen.ts -> src/tools.ts -> src/tools/registry.ts -> src/tools/shell.ts -> src/policy.ts`
- 5-file cycle: `src/config.ts -> src/zen.ts -> src/tools.ts -> src/tools/registry.ts -> src/tools/web.ts -> src/config.ts`
- 5-file cycle: `src/policy.ts -> src/zen.ts -> src/tools.ts -> src/tools/registry.ts -> src/tools/web.ts -> src/policy.ts`

## Communities (96 total, 10 thin omitted)

### Community 0 - "Config Loading"
Cohesion: 0.06
Nodes (56): asFiniteNumber(), ATOM_CONFIG_FILENAME, AtomConfig, ConfigLoad, EFFORT_VALUES, isRecord(), parseLevel(), checkRules() (+48 more)

### Community 1 - "Context Budget Manager"
Cohesion: 0.07
Nodes (38): addFootprint(), bucketOf(), BudgetSource, CHARS_PER_TOKEN, ContextBudget, ContextManager, ContextManagerOptions, ContextUsage (+30 more)

### Community 2 - "Package Manifest"
Cohesion: 0.04
Nodes (45): ink, ink-testing-library, author, bin, atom, bugs, url, dependencies (+37 more)

### Community 3 - "Rollback Checkpoints"
Cohesion: 0.07
Nodes (29): cancelledTurnLine(), ROLLBACK_MODE, ROLLBACK_NOTES, RollbackMode, RollbackScope, Checkpoint, checkpoints, clearSnapshots() (+21 more)

### Community 4 - "Local Model Discovery"
Cohesion: 0.10
Nodes (35): asRecord(), createLocalDiscovery(), DiscoveredModel, discoverLlamaCpp(), discoverLMStudio(), discoverLocalProvider(), discoverOllama(), discoverOpenAICompatible() (+27 more)

### Community 5 - "Context Compaction"
Cohesion: 0.09
Nodes (31): formatKEst(), buildCompactedHistory(), buildCompactionInstruction(), buildSummaryMessages(), capToolOutputsInTail(), COMPACT_CHARS_PER_TOKEN, COMPACT_KEEP_TOKENS, COMPACT_SUMMARY_MAX_TOKENS (+23 more)

### Community 6 - "Agent Loop Runtime"
Cohesion: 0.12
Nodes (27): DEFAULT_MAX_TOTAL_TOOL_CALLS, DEFAULT_TOOL_TIMEOUT_MS, emptyResponseFollowUp(), executeWithTimeout(), isCancelError(), isEmptyReplyError(), MAX_EMPTY_ROUNDS, resolveMaxTotalToolCalls() (+19 more)

### Community 7 - "Slash Menu Draft Input"
Cohesion: 0.06
Nodes (35): ../src/App.js, AppProps, AUTOSCROLL_USAGE, buildSlashMenu(), DRAFT_THROTTLE_MS, DraftThrottler, DraftThrottlerOptions, filterSlashCommands() (+27 more)

### Community 8 - "Skill Registry"
Cohesion: 0.09
Nodes (26): AUTO_SKILL_BODY_CAP, CachedEntry, capSkillBodyForAuto(), contentWords(), createSkillRegistry(), discoverSkills(), firstParagraph(), frontBool() (+18 more)

### Community 9 - "Directory Listing Cache"
Cohesion: 0.10
Nodes (29): cacheStats, dirMtimeMs(), fastListEnabled(), filterSkipped(), getDirListingStats(), gitFile(), gitListFiles(), listFiles() (+21 more)

### Community 10 - "Telemetry Tracing Core"
Cohesion: 0.07
Nodes (30): emptyOutcomes(), finiteCount(), isRecord(), IterationTrace, ModelCallTrace, newSessionId(), OutcomeCounts, projectBasename() (+22 more)

### Community 11 - "Config Path Resolution"
Cohesion: 0.09
Nodes (22): openTodoNeedles(), toolStepBudget(), truncateHistory(), homeDir(), globalConfigPath(), loadAtomConfig(), projectConfigPath(), clampInt() (+14 more)

### Community 12 - "Agent Loop Types"
Cohesion: 0.11
Nodes (26): ApprovalDecision, EffortOpts, LoopStats, PermissionMode, Phase, ReasoningEffort, Role, StreamCallbacks (+18 more)

### Community 13 - "Auth Key Store"
Cohesion: 0.12
Nodes (22): atomDir(), AUTH_VERSION, AuthFile, authFilePath(), emptyAuth(), getEnvKey(), getStoredBaseURL(), getStoredKey() (+14 more)

### Community 14 - "Session Persistence"
Cohesion: 0.12
Nodes (21): isProviderId(), isNonEmptyString(), isRecord(), loadSession(), LoadSessionResult, SavedPrefs, SESSION_FILENAME, SESSION_VERSION (+13 more)

### Community 15 - "Telemetry HTTP Server"
Cohesion: 0.10
Nodes (26): createTelemetryRecorder(), emptyOutcomes(), handleRequest(), parseTelemetryPort(), resolveTelemetryPort(), sendHtml(), sendJson(), startTelemetryServer() (+18 more)

### Community 16 - "App Command Helpers"
Cohesion: 0.16
Nodes (25): App(), commandUsage(), createDraftThrottler(), elapsedSecsSince(), filterModelEntries(), filterSkillPicker(), helpListText(), isStalledSince() (+17 more)

### Community 17 - "Telemetry Dashboard HTML"
Cohesion: 0.22
Nodes (27): barRow(), buildDashboardHtml(), DashboardOptions, escapeHtml(), fmtCount(), fmtMs(), fmtTime(), fmtTokens() (+19 more)

### Community 18 - "Provider Registry"
Cohesion: 0.15
Nodes (24): validateProviderKey(), modelPickerEntries(), modelsCacheKey(), BY_ID, chatEndpointFor(), getProvider(), isLocalProviderId(), localBaseURLFor() (+16 more)

### Community 19 - "Tool Executor Todos"
Cohesion: 0.13
Nodes (20): executeTool(), READ_ONLY_TOOLS, TOOL_ONE_LINERS, invalidCall(), clearTodos(), getTodos(), renderTodos(), TODO_PRIORITIES (+12 more)

### Community 20 - "Loop Error Guard"
Cohesion: 0.11
Nodes (8): errorStreakFollowUp(), ErrorStreakTracker, POLLING_TOOLS, repetitionFollowUp(), RepetitionGuard, RepetitionGuardOptions, RepetitionNote, repetitionStopNotice()

### Community 21 - "Kilo Catalog Client"
Cohesion: 0.14
Nodes (23): cacheKey(), CacheSlot, catalogEntries(), entryId(), entryRecord(), fetchKiloModelsWithStatus(), finiteCount(), KILO_BASE_URL (+15 more)

### Community 22 - "Markdown Stream Renderer"
Cohesion: 0.13
Nodes (21): Block, cellPlain(), closeStreamingMarkers(), expandTabs(), InlineRun, isTableDelimiter(), MarkdownStream(), MarkdownText() (+13 more)

### Community 23 - "Turn End Gates"
Cohesion: 0.11
Nodes (14): bashExitCode(), CODE_EXTENSIONS, evaluateTurnEnd(), isCodePath(), isVerificationCommand(), MAX_VERIFY_ROUNDS, todoCompletionGate(), TURN_END_GATES (+6 more)

### Community 24 - "Telemetry Recorder"
Cohesion: 0.23
Nodes (5): addUsageInto(), cleanUsage(), TelemetryRecorder, toIso(), truncatePreview()

### Community 25 - "Telemetry Session Store"
Cohesion: 0.11
Nodes (11): classifyToolResult(), classifyTurnOutcome(), parseRetryDetail(), pruneTelemetrySessions(), resolveTelemetryEnabled(), saveTelemetrySession(), telemetryEnvOverride(), telemetrySessionFilePath() (+3 more)

### Community 26 - "Diff View Highlight"
Cohesion: 0.13
Nodes (18): DiffView, DiffViewInner(), DiffViewProps, LineBody(), syntaxColor(), WordRun, C_KEYWORDS, commentStyle() (+10 more)

### Community 27 - "Read Cache"
Cohesion: 0.16
Nodes (13): cache, cacheEnabled(), clearReadCache(), getCachedRead(), getReadCacheStats(), maxEntries(), ReadCacheEntry, readCacheKey() (+5 more)

### Community 28 - "Diff Engine"
Cohesion: 0.18
Nodes (19): computeDiff(), computeSideBySide(), DIFF_CONTEXT, DiffHunk, DiffLine, DiffResult, EditOp, flatRuns() (+11 more)

### Community 29 - "Loop Guard Tests"
Cohesion: 0.12
Nodes (4): AgenticOpts, ChatResult, planToolBatches(), WRITE

### Community 30 - "Tool Registry Schemas"
Cohesion: 0.16
Nodes (17): EditArgs, ReadArgs, WriteArgs, APPROVAL_PREVIEW_MAX_BYTES, APPROVAL_TOOLS, ApprovalDiff, AskQuestionArgs, askQuestionDetail() (+9 more)

### Community 31 - "TypeScript Config Root"
Cohesion: 0.12
Nodes (16): node, tests, compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, jsx, module (+8 more)

### Community 32 - "Provider Chat Completions"
Cohesion: 0.16
Nodes (14): anthropicHeaders(), geminiChatUrl(), geminiGenerateUrl(), geminiHeaders(), chatCompletion(), chatCompletionAnthropic(), chatCompletionGemini(), getRetryDelay() (+6 more)

### Community 33 - "Kilo Model Helpers"
Cohesion: 0.15
Nodes (15): clearKiloModelsCache(), isFreeKiloModel(), KILO_AUTO_MODEL, KILO_CHAT_ENDPOINT, KILO_FALLBACK_MODELS, KILO_MODELS_URL, kiloErrorMessage(), normalizeKiloChatError() (+7 more)

### Community 34 - "Tool Scheduler Effects"
Cohesion: 0.13
Nodes (8): FilesystemEffect, NetworkEffect, PlannedToolCall, ProcessEffect, SchedulableCall, TOOL_EFFECTS, ToolEffect, TOOL_DEFINITIONS

### Community 35 - "TUI Cursor Tests"
Cohesion: 0.12
Nodes (9): BS, ESC_CH, MODELS, NOTE: reply needle must be unique — "ok" matches the "token: n/a", NOTE: reply needle must be unique — "ok" matches the "token: n/a", NOTE: reply needle must be unique — "ok" matches the "token: n/a", NOTE: reply needle must be unique — "ok" matches the "token: n/a", NOTE: "hello back" is already a unique loop-entry reply needle (never (+1 more)

### Community 36 - "System Prompt Agent Tests"
Cohesion: 0.15
Nodes (8): ChatMessage, MAX_TOOL_STEPS, agentsFilePath(), buildSystemPrompt(), loadAgentsPrompt(), runAgenticLoop(), NOTE: needle must be unique — "ok" is a substring of the "token: n/a", TOOL_THEN_FINAL

### Community 37 - "Shell Background Tasks"
Cohesion: 0.27
Nodes (15): scrubSecrets(), clearDirListingCache(), appendOverflow(), err(), bashOutputTool(), bashTool(), bgDir(), BgTaskRecord (+7 more)

### Community 38 - "Transcript Renderer"
Cohesion: 0.14
Nodes (12): ATOM_ART, isAuditLabel(), resolveViewport(), SCROLL_PAGE_ITEMS, ScrollAction, SCROLLBACK_WINDOW, StaticItem, transcriptRenderProbe (+4 more)

### Community 39 - "App Shell Tests"
Cohesion: 0.13
Nodes (4): FALLBACK_MODELS, MODELS, NOTE: reply needle must be unique — "ok" is a substring of the, NOTE: "█" alone also matches the input cursor block, so wait for the

### Community 40 - "Filesystem Tools Fingerprints"
Cohesion: 0.34
Nodes (13): capturePriorBytes(), invalidateListingsForFile(), editTool(), readTool(), writeTool(), contentHash(), fingerprintKey(), forgetReadFingerprint() (+5 more)

### Community 41 - "Tool Entry Overflow"
Cohesion: 0.18
Nodes (5): overflowDir(), pruneOverflowFiles(), spillOverflow(), dirs, dirs

### Community 42 - "Provider API Adapters"
Cohesion: 0.18
Nodes (13): ANTHROPIC_MAX_TOKENS, ANTHROPIC_VERSION, AnthropicRequest, AnthropicSystemBlock, buildGeminiBody(), GEMINI_STRIPPED_SCHEMA_KEYS, GeminiRequest, MAX_SSE_STALL_TIMEOUT_MS (+5 more)

### Community 43 - "Environment Block"
Cohesion: 0.25
Nodes (11): buildEnvBlock(), ENV_BLOCK_CHAR_CAP, ENV_BLOCK_TAG, EnvBlockParts, getEnvBlock(), getGitInfo(), GitInfo, shortCwd() (+3 more)

### Community 44 - "Command Palette Theme"
Cohesion: 0.16
Nodes (11): PALETTE_CATEGORIES, PALETTE_CATEGORY_ORDER, PALETTE_HINTS, PALETTE_WINDOW, paletteCategory, PaletteEntry, PalettePanel, PalettePanelProps (+3 more)

### Community 45 - "Prompt Cache Prefix"
Cohesion: 0.26
Nodes (9): buildAnthropicBody(), AssembledPrefix, assemblePrefix(), AssemblePrefixArgs, CacheSupport, ephemeralBreakpoint(), providerCacheSupport(), sha1Hex() (+1 more)

### Community 46 - "Provider Routing Tests"
Cohesion: 0.17
Nodes (4): runAgenticLoopForProvider(), homes, savedEnv, threePlainTurns()

### Community 47 - "Queue Steer Tests"
Cohesion: 0.15
Nodes (3): dirs, PostedBody, savedEnv

### Community 48 - "Context Windows Status"
Cohesion: 0.27
Nodes (8): CONTEXT_WINDOWS, contextWindowFor(), formatTokenSegment(), totalTokens(), shrinkTo(), StatusBar, StatusBarProps, statusBarRenderProbe

### Community 49 - "Side By Side Diff"
Cohesion: 0.21
Nodes (11): SBSRow, DisplayCell, DisplayRow, fitRows(), padEnd(), SBS_NARROW_COLUMNS, SideBySideDiffView, SideBySideDiffViewProps (+3 more)

### Community 50 - "Approval Modals"
Cohesion: 0.20
Nodes (11): APPROVAL_DIFF_MAX_LINES, APPROVAL_OPTIONS, ApprovalBox, ApprovalBoxProps, ApprovalOption, approvalPreview(), approvalRenderProbe, approvalTitle() (+3 more)

### Community 51 - "Observability Tests"
Cohesion: 0.18
Nodes (6): homes, openProviderPicker(), NOTE: the first POST runs after the submit pipeline's async, savedEnv, seedKeys(), waitForFrame()

### Community 52 - "Build TypeScript Config"
Cohesion: 0.18
Nodes (10): ./tsconfig.json, compilerOptions, declaration, noEmit, outDir, rootDir, sourceMap, extends (+2 more)

### Community 53 - "Approval Diff Tests"
Cohesion: 0.20
Nodes (3): previewDiffForApproval(), previewLangFromPath(), CHANGE_THRESHOLD

### Community 54 - "Activity Live Tail"
Cohesion: 0.31
Nodes (7): Activity, activityText(), activityVerb(), parseActivityHint(), TOOL_VERBS, LiveTail(), LiveTailProps

### Community 55 - "Tool Inspector Panel"
Cohesion: 0.22
Nodes (9): formatDur(), InspectorPanel(), InspectorPanelProps, LIST_WINDOW, MAX_TOOL_RECORDS, STORE_CHARS, ToolRecord, VIEWPORT_LINES (+1 more)

### Community 56 - "Plan Mode Tests"
Cohesion: 0.22
Nodes (3): enterPlan(), MODELS, waitForFrame()

### Community 57 - "SSE Stall Reader"
Cohesion: 0.33
Nodes (8): collectSSEText(), DEFAULT_SSE_STALL_TIMEOUT_MS, isStallError(), readWithStall(), sseStallTimeoutMs(), finiteCount(), parseUsage(), readSSEMessage()

### Community 58 - "Model List Parsers"
Cohesion: 0.24
Nodes (5): entryId(), parseAnthropicModelsList(), parseGeminiModelsList(), parseOpenAIModelsList(), fetchModelsForProvider()

### Community 59 - "Reasoning Effort Tests"
Cohesion: 0.22
Nodes (5): EFFORT_OPTIONS, isEffortSupported(), REASONING_EFFORT_SUPPORTED_MODELS, reasoningEffortParam(), MODELS

### Community 60 - "Streaming Tests"
Cohesion: 0.27
Nodes (4): contentChunk(), sseData(), thinkingChunk(), toolChunk()

### Community 61 - "Provider Flow Tests"
Cohesion: 0.25
Nodes (5): homes, MODELS, openProviderPicker(), savedEnv, waitForFrame()

### Community 62 - "Response Usage Parsers"
Cohesion: 0.42
Nodes (9): buildAnthropicResult(), finiteCount(), fullText(), mergeUsage(), openAIUsage(), parseAnthropicJson(), parseGeminiJson(), readAnthropicSSEMessage() (+1 more)

### Community 63 - "Error Cards"
Cohesion: 0.28
Nodes (7): ClassifiedError, classifyToolError(), ErrorKind, KIND_COLOR, KIND_GLYPH, parseToolLabel(), titleCase()

### Community 64 - "Picker Components"
Cohesion: 0.22
Nodes (3): MODEL_PICKER_VISIBLE, PickerRowProps, PickerShellProps

### Community 70 - "Prefs Restore Tests"
Cohesion: 0.25
Nodes (4): homes, savedEnv, seedKeys(), ZEN_MODELS

### Community 71 - "Skills Invoke Tests"
Cohesion: 0.29
Nodes (3): dirs, emptyHome(), tmpDir()

### Community 74 - "CLI Entry Args"
Cohesion: 0.29
Nodes (6): args, { endpoint, apiKey: envKey }, storedZen, DEFAULT_ENDPOINT, DEFAULT_MODEL, endpointConfig()

### Community 75 - "Session Diff Panel"
Cohesion: 0.29
Nodes (5): DiffPreview, DIFF_PANEL_MAX_LINES, DiffPanelProps, groupSessionDiffs(), SessionFileDiff

### Community 78 - "Package Keywords"
Cohesion: 0.33
Nodes (6): keywords, ai-agent, chatbot, coding-agent, ink, tui

### Community 79 - "Architecture Graph Tests"
Cohesion: 0.60
Nodes (5): graph(), keyOf(), runtimeDeps(), SRC, srcFiles()

## Knowledge Gaps
- **365 isolated node(s):** `name`, `version`, `description`, `type`, `license` (+360 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **10 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `../src/App.js` connect `Slash Menu Draft Input` to `Config Loading`, `Context Budget Manager`, `Rollback Checkpoints`, `Local Model Discovery`, `Context Compaction`, `Agent Loop Runtime`, `Skill Registry`, `Telemetry Tracing Core`, `Config Path Resolution`, `Agent Loop Types`, `Auth Key Store`, `Session Persistence`, `Telemetry HTTP Server`, `App Command Helpers`, `Telemetry Dashboard HTML`, `Provider Registry`, `Tool Executor Todos`, `Kilo Catalog Client`, `Turn End Gates`, `Telemetry Recorder`, `Telemetry Session Store`, `Tool Registry Schemas`, `Kilo Model Helpers`, `Tool Scheduler Effects`, `System Prompt Agent Tests`, `Shell Background Tasks`, `App Shell Tests`, `Filesystem Tools Fingerprints`, `Tool Entry Overflow`, `Provider API Adapters`, `Environment Block`, `Command Palette Theme`, `Prompt Cache Prefix`, `Provider Routing Tests`, `Context Windows Status`, `Approval Diff Tests`, `Activity Live Tail`, `Reasoning Effort Tests`, `CLI Entry Args`, `Package Keywords`, `Scrollback Tests`?**
  _High betweenness centrality (0.354) - this node is a cross-community bridge._
- **Why does `ink` connect `Package Keywords` to `Picker Components`, `Transcript Renderer`, `Slash Menu Draft Input`, `CLI Entry Args`, `Session Diff Panel`, `Command Palette Theme`, `App Command Helpers`, `Side By Side Diff`, `Approval Modals`, `Context Windows Status`, `Tool Inspector Panel`, `Activity Live Tail`, `Markdown Stream Renderer`, `Diff View Highlight`, `Error Cards`?**
  _High betweenness centrality (0.091) - this node is a cross-community bridge._
- **Why does `keywords` connect `Package Keywords` to `Package Manifest`?**
  _High betweenness centrality (0.046) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `App()` (e.g. with `providerSecrets()` and `buildSystemPrompt()`) actually correct?**
  _`App()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Are the 4 inferred relationships involving `runLoopWithChat()` (e.g. with `.noteResult()` and `.shouldHoldFinal()`) actually correct?**
  _`runLoopWithChat()` has 4 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _365 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Config Loading` be split into smaller, more focused modules?**
  _Cohesion score 0.06013986013986014 - nodes in this community are weakly interconnected._