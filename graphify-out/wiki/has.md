# has

> God node · 61 connections · [C:\Users\Bhavin\Videos\WEB dev\Opensource porjects\Atom\src\App.tsx](file:///C:/Users/Bhavin/Videos/WEB%20dev/Opensource%20porjects/Atom/src/App.tsx#L9817)

## Call Trace Diagram

```mermaid
sequenceDiagram
    participant P0 as has
    participant P1 as submit()
    participant P2 as now
    participant P3 as runLoopWithChat()
    participant P4 as drainTurnBoundary()
    participant P5 as .safeNow()
    participant P6 as collectSSEText()
    participant P7 as readSSEMessage()
    participant P8 as saveAuthFile()
    participant P9 as fetchKiloModelsWithStatus()
    participant P10 as .watchSseStream()
    participant P11 as listFilesUnshared()
    participant P12 as setCachedRead()
    participant P13 as readPrior()
    participant P14 as bashOutputTool()
    participant P15 as reduceAgentEvent()
    participant P16 as runScenario()
    participant P17 as getEnvBlock()
    participant P18 as getRetryDelay()
    participant P19 as getCachedRead()
    participant P20 as openTurn()
    participant P21 as closeTurn()
    participant P22 as timeCase()
    participant P23 as timePlan()
    participant P24 as startTurnTimer()
    participant P25 as pruneStaleSnapshotOverflow()
    participant P26 as snapshotFromText()
    participant P27 as resolveClient()
    participant P28 as toTokens()
    participant P29 as rememberNonGit()
    participant P30 as storeListing()
    participant P31 as spillOverflow()
    participant P32 as resultCacheSet()
    participant P33 as pushCheckpoint()
    participant P34 as pruneTelemetrySessions()
    participant P35 as isTokenExpired()
    participant P36 as pruneOverflowFiles()
    participant P37 as resultCacheGet()
    participant P38 as newBgId()
    participant P39 as waitFor()
    participant P40 as waitFor()
    participant P41 as waitFor()
    participant P42 as waitFor()
    participant P43 as waitFor()
    participant P44 as timeIt()
    participant P45 as clockNow()
    participant P46 as mediaId()
    participant P47 as pruneMedia()
    participant P48 as newCheckpointId()
    participant P49 as newSessionId()
    participant P50 as nextTurnId()
    participant P51 as isKnownNonGit()
    participant P52 as relTime()
    participant P53 as turnElapsed()
    participant P54 as waitForPostCount()
    participant P55 as waitFor()
    participant P56 as waitForPosts()
    participant P57 as waitForFrame()
    participant P58 as waitForFrame()
    participant P59 as waitForFrame()
    participant P60 as waitFor()
    participant P61 as waitForFrame()
    participant P62 as waitForFrame()
    participant P63 as waitForFrameAbsent()
    participant P64 as waitForFrame()
    participant P65 as waitForFrame()
    participant P66 as waitForFrame()
    participant P67 as waitForPosts()
    participant P68 as waitForFrame()
    participant P69 as waitForFrame()
    participant P70 as waitForFrame()
    participant P71 as waitForFrame()
    participant P72 as waitForFrame()
    participant P73 as waitForFrame()
    participant P74 as waitForFrame()
    participant P75 as waitForFrameAbsent()
    participant P76 as waitForFrame()
    participant P77 as waitForFrame()
    participant P78 as waitForFrame()
    participant P79 as waitForFrame()
    participant P80 as waitForFrame()
    participant P81 as waitForFrame()
    participant P82 as waitForFrame()
    participant P83 as waitForFrameAbsent()
    participant P84 as waitForFrame()
    participant P85 as waitForAppFrame()
    participant P86 as waitFor()
    participant P87 as waitForFrame()
    participant P88 as waitForFrame()
    participant P89 as waitForFrameAbsent()
    participant P90 as waitForFrame()
    participant P91 as waitForFrame()
    participant P92 as waitForFrame()
    participant P93 as waitForFrame()
    participant P94 as waitForFrameAbsent()
    participant P95 as waitForFrame()
    participant P96 as waitForPosts()
    participant P97 as waitForFrame()
    participant P98 as waitForFrame()
    participant P99 as waitForFrame()
    participant P100 as waitForFrame()
    participant P101 as waitForFrame()
    participant P102 as waitForFrame()
    participant P103 as waitForFrame()
    participant P104 as waitForFrame()
    participant P105 as waitForFrame()
    participant P106 as waitForFrame()
    participant P107 as waitForAbsence()
    participant P108 as waitForFrame()
    participant P109 as waitForFrame()
    participant P110 as waitForFrameAbsent()
    participant P111 as waitForFrame()
    participant P112 as waitForFrame()
    participant P113 as waitForFrame()
    participant P114 as waitForFrame()
    participant P115 as waitForFrame()
    participant P116 as waitForFrame()
    participant P117 as waitForFrame()
    participant P118 as waitForFrame()
    participant P119 as waitForFrameAbsent()
    participant P120 as waitForFrame()
    participant P121 as waitForFrame()
    participant P122 as waitForFrame()
    participant P123 as waitForFrame()
    participant P124 as waitForFrame()
    participant P125 as waitForFrame()
    participant P126 as waitForFrame()
    participant P127 as waitForFrameAbsent()
    participant P128 as waitForPosts()
    participant P129 as waitForFrame()
    participant P130 as waitForFrame()
    participant P131 as waitForPosts()
    participant P132 as waitForFrame()
    participant P133 as waitForFrame()
    participant P134 as waitForFrame()
    participant P135 as waitForFrame()
    participant P136 as waitForFrame()
    participant P137 as waitForFrame()
    participant P138 as waitFor()
    participant P139 as runSlashCommand()
    participant P140 as doCompact()
    participant P141 as pushInfo()
    participant P142 as runGoalCommand()
    participant P143 as runRevertCommand()
    participant P144 as .refresh()
    participant P145 as ensureStoreSession()
    participant P146 as persistSession()
    participant P147 as runModelsCommand()
    participant P148 as .startTurn()
    participant P149 as .endTurn()
    participant P150 as openSessionPicker()
    participant P151 as openMcpPicker()
    participant P152 as openModelPicker()
    participant P153 as appendTurns()
    participant P154 as chatBaseURL()
    participant P155 as estimateTokensForChars()
    participant P156 as setInputBoth()
    participant P157 as runRenameCommand()
    participant P158 as runThemeCommand()
    participant P159 as runForkCommand()
    participant P160 as paintScheduler()
    participant P161 as activateSkill()
    participant P162 as setBusy()
    participant P163 as resolveSkills()
    participant P164 as cwd
    participant P165 as runRulesCommand()
    participant P166 as clearThinking()
    participant P167 as applyToolCall()
    participant P168 as commitThinking()
    participant P169 as setDraft()
    participant P170 as runQueueCommand()
    participant P171 as runAutoScrollCommand()
    participant P172 as invokeSkillByName()
    participant P173 as runExtensionCommandFromApp()
    participant P174 as keyForProvider()
    participant P175 as persistTelemetry()
    participant P176 as providerNeedsKey()
    participant P177 as historyChars()
    participant P178 as runCompactCommand()
    participant P179 as runThinkingCommand()
    participant P180 as localUnreachableNotice()
    participant P181 as refreshGitInfo()
    participant P182 as refreshSystemEnv()
    participant P183 as expandMentionsForSubmit()
    participant P184 as matchSkills()
    participant P185 as runAgenticLoopForProvider()
    participant P186 as setQueueBoth()
    participant P187 as setPhaseBoth()
    participant P188 as flushDraft()
    participant P189 as pruneMentions()
    participant P190 as shouldPreCompactForPending()
    participant P191 as setHasHadOutputBoth()
    participant P192 as resetStreamSequencing()
    participant P193 as takeUncommittedStream()
    participant P194 as prunePastedChunks()
    participant P195 as parseExtensionCommandInput()
    participant P196 as getExtensionCommand()
    participant P197 as .reset()
    participant P198 as .setSessionMeta()
    participant P199 as cancelledTurnLine()
    participant P200 as shouldCompactOnSizeError()
    participant P201 as isSizeError()
    participant P202 as buildGoalHook()
    participant P203 as expandPastedSummaries()
    participant P204 as stripShellBang()
    participant P205 as send
    participant P206 as classifyTurnOutcome()
    participant P207 as chatCompletion()
    participant P208 as chatCompletionGemini()
    participant P209 as chatCompletionAnthropic()
    participant P210 as chatCompletionResponses()
    participant P211 as grepTool()
    participant P212 as validateToolArgs()
    participant P213 as executeTool()
    participant P214 as webfetchTool()
    participant P215 as .doRefresh()
    participant P216 as gitListFiles()
    participant P217 as needsApproval()
    participant P218 as fetchModelsWithStatus()
    participant P219 as toolNames()
    participant P220 as rgContentHits()
    participant P221 as planBatches()
    participant P222 as todoUpdateTool()
    participant P223 as trackHistory()
    participant P224 as readFileDiffs()
    participant P225 as discoverSkills()
    participant P226 as .listPaginated()
    participant P227 as loadSkillBody()
    participant P228 as .refreshServerTools()
    participant P229 as rgFileCounts()
    participant P230 as chainPathsUp()
    participant P231 as renderAgent()
    participant P232 as decidePolicy()
    participant P233 as .listTools()
    participant P234 as registerCustomTool()
    participant P235 as isCustomTool()
    participant P236 as filterMentionCandidates()
    participant P237 as highlight()
    participant P238 as noteGoalProgress()
    participant P239 as contentWords()
    participant P240 as todoRecordDetail()
    participant P241 as setActiveTodoSession()
    participant P242 as normalizeChatResult()
    participant P243 as walkFiles()
    participant P244 as registerToolOverride()
    participant P245 as isMessages()
    participant P246 as highlightCode()
    participant P247 as stripGeminiSchemaKeys()
    participant P248 as registerExtensionCommand()
    participant P249 as isEntryFile()
    participant P250 as loadMedia()
    participant P251 as isCodePath()
    participant P252 as .isExcluded()
    participant P253 as .isMcpTool()
    participant P254 as isReadOnlyCommand()
    participant P255 as isImagePathLike()
    participant P256 as assertPairingIntact()
    participant P257 as assertPairingIntact()
    participant P258 as expectPairingValid()
    participant P259 as assertPairingIntact()
    participant P260 as isTodoStatus()
    participant P261 as isTodoPriority()
    participant P262 as isToolOverridden()
    participant P263 as visit()
    P0->>+ P1: calls
    P1-->>- P0: return
    P1->>+ P2: calls
    P2-->>- P1: return
    P2->>+ P1: calls
    P1-->>- P2: return
    P2->>+ P3: calls
    P3-->>- P2: return
    P2->>+ P4: calls
    P4-->>- P2: return
    P2->>+ P5: calls
    P5-->>- P2: return
    P2->>+ P6: calls
    P6-->>- P2: return
    P2->>+ P7: calls
    P7-->>- P2: return
    P2->>+ P8: calls
    P8-->>- P2: return
    P2->>+ P9: calls
    P9-->>- P2: return
    P2->>+ P10: calls
    P10-->>- P2: return
    P2->>+ P11: calls
    P11-->>- P2: return
    P2->>+ P12: calls
    P12-->>- P2: return
    P2->>+ P13: calls
    P13-->>- P2: return
    P2->>+ P14: calls
    P14-->>- P2: return
    P2->>+ P15: calls
    P15-->>- P2: return
    P2->>+ P16: calls
    P16-->>- P2: return
    P2->>+ P17: calls
    P17-->>- P2: return
    P2->>+ P18: calls
    P18-->>- P2: return
    P2->>+ P19: calls
    P19-->>- P2: return
    P2->>+ P20: calls
    P20-->>- P2: return
    P2->>+ P21: calls
    P21-->>- P2: return
    P2->>+ P22: calls
    P22-->>- P2: return
    P2->>+ P23: calls
    P23-->>- P2: return
    P2->>+ P24: calls
    P24-->>- P2: return
    P2->>+ P25: calls
    P25-->>- P2: return
    P2->>+ P26: calls
    P26-->>- P2: return
    P2->>+ P27: calls
    P27-->>- P2: return
    P2->>+ P28: calls
    P28-->>- P2: return
    P2->>+ P29: calls
    P29-->>- P2: return
    P2->>+ P30: calls
    P30-->>- P2: return
    P2->>+ P31: calls
    P31-->>- P2: return
    P2->>+ P32: calls
    P32-->>- P2: return
    P2->>+ P33: calls
    P33-->>- P2: return
    P2->>+ P34: calls
    P34-->>- P2: return
    P2->>+ P35: calls
    P35-->>- P2: return
    P2->>+ P36: calls
    P36-->>- P2: return
    P2->>+ P37: calls
    P37-->>- P2: return
    P2->>+ P38: calls
    P38-->>- P2: return
    P2->>+ P39: calls
    P39-->>- P2: return
    P2->>+ P40: calls
    P40-->>- P2: return
    P2->>+ P41: calls
    P41-->>- P2: return
    P2->>+ P42: calls
    P42-->>- P2: return
    P2->>+ P43: calls
    P43-->>- P2: return
    P2->>+ P44: calls
    P44-->>- P2: return
    P2->>+ P45: calls
    P45-->>- P2: return
    P2->>+ P46: calls
    P46-->>- P2: return
    P2->>+ P47: calls
    P47-->>- P2: return
    P2->>+ P48: calls
    P48-->>- P2: return
    P2->>+ P49: calls
    P49-->>- P2: return
    P2->>+ P50: calls
    P50-->>- P2: return
    P2->>+ P51: calls
    P51-->>- P2: return
    P2->>+ P52: calls
    P52-->>- P2: return
    P2->>+ P53: calls
    P53-->>- P2: return
    P2->>+ P54: calls
    P54-->>- P2: return
    P2->>+ P55: calls
    P55-->>- P2: return
    P2->>+ P56: calls
    P56-->>- P2: return
    P2->>+ P57: calls
    P57-->>- P2: return
    P2->>+ P58: calls
    P58-->>- P2: return
    P2->>+ P59: calls
    P59-->>- P2: return
    P2->>+ P60: calls
    P60-->>- P2: return
    P2->>+ P61: calls
    P61-->>- P2: return
    P2->>+ P62: calls
    P62-->>- P2: return
    P2->>+ P63: calls
    P63-->>- P2: return
    P2->>+ P64: calls
    P64-->>- P2: return
    P2->>+ P65: calls
    P65-->>- P2: return
    P2->>+ P66: calls
    P66-->>- P2: return
    P2->>+ P67: calls
    P67-->>- P2: return
    P2->>+ P68: calls
    P68-->>- P2: return
    P2->>+ P69: calls
    P69-->>- P2: return
    P2->>+ P70: calls
    P70-->>- P2: return
    P2->>+ P71: calls
    P71-->>- P2: return
    P2->>+ P72: calls
    P72-->>- P2: return
    P2->>+ P73: calls
    P73-->>- P2: return
    P2->>+ P74: calls
    P74-->>- P2: return
    P2->>+ P75: calls
    P75-->>- P2: return
    P2->>+ P76: calls
    P76-->>- P2: return
    P2->>+ P77: calls
    P77-->>- P2: return
    P2->>+ P78: calls
    P78-->>- P2: return
    P2->>+ P79: calls
    P79-->>- P2: return
    P2->>+ P80: calls
    P80-->>- P2: return
    P2->>+ P81: calls
    P81-->>- P2: return
    P2->>+ P82: calls
    P82-->>- P2: return
    P2->>+ P83: calls
    P83-->>- P2: return
    P2->>+ P84: calls
    P84-->>- P2: return
    P2->>+ P85: calls
    P85-->>- P2: return
    P2->>+ P86: calls
    P86-->>- P2: return
    P2->>+ P87: calls
    P87-->>- P2: return
    P2->>+ P88: calls
    P88-->>- P2: return
    P2->>+ P89: calls
    P89-->>- P2: return
    P2->>+ P90: calls
    P90-->>- P2: return
    P2->>+ P91: calls
    P91-->>- P2: return
    P2->>+ P92: calls
    P92-->>- P2: return
    P2->>+ P93: calls
    P93-->>- P2: return
    P2->>+ P94: calls
    P94-->>- P2: return
    P2->>+ P95: calls
    P95-->>- P2: return
    P2->>+ P96: calls
    P96-->>- P2: return
    P2->>+ P97: calls
    P97-->>- P2: return
    P2->>+ P98: calls
    P98-->>- P2: return
    P2->>+ P99: calls
    P99-->>- P2: return
    P2->>+ P100: calls
    P100-->>- P2: return
    P2->>+ P101: calls
    P101-->>- P2: return
    P2->>+ P102: calls
    P102-->>- P2: return
    P2->>+ P103: calls
    P103-->>- P2: return
    P2->>+ P104: calls
    P104-->>- P2: return
    P2->>+ P105: calls
    P105-->>- P2: return
    P2->>+ P106: calls
    P106-->>- P2: return
    P2->>+ P107: calls
    P107-->>- P2: return
    P2->>+ P108: calls
    P108-->>- P2: return
    P2->>+ P109: calls
    P109-->>- P2: return
    P2->>+ P110: calls
    P110-->>- P2: return
    P2->>+ P111: calls
    P111-->>- P2: return
    P2->>+ P112: calls
    P112-->>- P2: return
    P2->>+ P113: calls
    P113-->>- P2: return
    P2->>+ P114: calls
    P114-->>- P2: return
    P2->>+ P115: calls
    P115-->>- P2: return
    P2->>+ P116: calls
    P116-->>- P2: return
    P2->>+ P117: calls
    P117-->>- P2: return
    P2->>+ P118: calls
    P118-->>- P2: return
    P2->>+ P119: calls
    P119-->>- P2: return
    P2->>+ P120: calls
    P120-->>- P2: return
    P2->>+ P121: calls
    P121-->>- P2: return
    P2->>+ P122: calls
    P122-->>- P2: return
    P2->>+ P123: calls
    P123-->>- P2: return
    P2->>+ P124: calls
    P124-->>- P2: return
    P2->>+ P125: calls
    P125-->>- P2: return
    P2->>+ P126: calls
    P126-->>- P2: return
    P2->>+ P127: calls
    P127-->>- P2: return
    P2->>+ P128: calls
    P128-->>- P2: return
    P2->>+ P129: calls
    P129-->>- P2: return
    P2->>+ P130: calls
    P130-->>- P2: return
    P2->>+ P131: calls
    P131-->>- P2: return
    P2->>+ P132: calls
    P132-->>- P2: return
    P2->>+ P133: calls
    P133-->>- P2: return
    P2->>+ P134: calls
    P134-->>- P2: return
    P2->>+ P135: calls
    P135-->>- P2: return
    P2->>+ P136: calls
    P136-->>- P2: return
    P2->>+ P137: calls
    P137-->>- P2: return
    P2->>+ P138: calls
    P138-->>- P2: return
    P1->>+ P139: calls
    P139-->>- P1: return
    P1->>+ P0: calls
    P0-->>- P1: return
    P1->>+ P140: calls
    P140-->>- P1: return
    P1->>+ P141: calls
    P141-->>- P1: return
    P1->>+ P4: calls
    P4-->>- P1: return
    P1->>+ P142: calls
    P142-->>- P1: return
    P1->>+ P143: calls
    P143-->>- P1: return
    P1->>+ P144: calls
    P144-->>- P1: return
    P1->>+ P145: calls
    P145-->>- P1: return
    P1->>+ P146: calls
    P146-->>- P1: return
    P1->>+ P147: calls
    P147-->>- P1: return
    P1->>+ P148: calls
    P148-->>- P1: return
    P1->>+ P149: calls
    P149-->>- P1: return
    P1->>+ P150: calls
    P150-->>- P1: return
    P1->>+ P151: calls
    P151-->>- P1: return
    P1->>+ P152: calls
    P152-->>- P1: return
    P1->>+ P153: calls
    P153-->>- P1: return
    P1->>+ P154: calls
    P154-->>- P1: return
    P1->>+ P155: calls
    P155-->>- P1: return
    P1->>+ P156: calls
    P156-->>- P1: return
    P1->>+ P157: calls
    P157-->>- P1: return
    P1->>+ P158: calls
    P158-->>- P1: return
    P1->>+ P159: calls
    P159-->>- P1: return
    P1->>+ P160: calls
    P160-->>- P1: return
    P1->>+ P161: calls
    P161-->>- P1: return
    P1->>+ P162: calls
    P162-->>- P1: return
    P1->>+ P163: calls
    P163-->>- P1: return
    P1->>+ P164: calls
    P164-->>- P1: return
    P1->>+ P165: calls
    P165-->>- P1: return
    P1->>+ P166: calls
    P166-->>- P1: return
    P1->>+ P167: calls
    P167-->>- P1: return
    P1->>+ P168: calls
    P168-->>- P1: return
    P1->>+ P169: calls
    P169-->>- P1: return
    P1->>+ P170: calls
    P170-->>- P1: return
    P1->>+ P171: calls
    P171-->>- P1: return
    P1->>+ P172: calls
    P172-->>- P1: return
    P1->>+ P173: calls
    P173-->>- P1: return
    P1->>+ P174: calls
    P174-->>- P1: return
    P1->>+ P175: calls
    P175-->>- P1: return
    P1->>+ P176: calls
    P176-->>- P1: return
    P1->>+ P177: calls
    P177-->>- P1: return
    P1->>+ P178: calls
    P178-->>- P1: return
    P1->>+ P179: calls
    P179-->>- P1: return
    P1->>+ P180: calls
    P180-->>- P1: return
    P1->>+ P24: calls
    P24-->>- P1: return
    P1->>+ P181: calls
    P181-->>- P1: return
    P1->>+ P182: calls
    P182-->>- P1: return
    P1->>+ P183: calls
    P183-->>- P1: return
    P1->>+ P184: calls
    P184-->>- P1: return
    P1->>+ P185: calls
    P185-->>- P1: return
    P1->>+ P186: calls
    P186-->>- P1: return
    P1->>+ P187: calls
    P187-->>- P1: return
    P1->>+ P188: calls
    P188-->>- P1: return
    P1->>+ P189: calls
    P189-->>- P1: return
    P1->>+ P190: calls
    P190-->>- P1: return
    P1->>+ P191: calls
    P191-->>- P1: return
    P1->>+ P192: calls
    P192-->>- P1: return
    P1->>+ P193: calls
    P193-->>- P1: return
    P1->>+ P194: calls
    P194-->>- P1: return
    P1->>+ P195: calls
    P195-->>- P1: return
    P1->>+ P196: calls
    P196-->>- P1: return
    P1->>+ P197: calls
    P197-->>- P1: return
    P1->>+ P198: calls
    P198-->>- P1: return
    P1->>+ P199: calls
    P199-->>- P1: return
    P1->>+ P200: calls
    P200-->>- P1: return
    P1->>+ P201: calls
    P201-->>- P1: return
    P1->>+ P202: calls
    P202-->>- P1: return
    P1->>+ P203: calls
    P203-->>- P1: return
    P1->>+ P204: calls
    P204-->>- P1: return
    P1->>+ P205: calls
    P205-->>- P1: return
    P1->>+ P206: calls
    P206-->>- P1: return
    P0->>+ P207: calls
    P207-->>- P0: return
    P0->>+ P208: calls
    P208-->>- P0: return
    P0->>+ P209: calls
    P209-->>- P0: return
    P0->>+ P210: calls
    P210-->>- P0: return
    P0->>+ P211: calls
    P211-->>- P0: return
    P0->>+ P212: calls
    P212-->>- P0: return
    P0->>+ P213: calls
    P213-->>- P0: return
    P0->>+ P214: calls
    P214-->>- P0: return
    P0->>+ P215: calls
    P215-->>- P0: return
    P0->>+ P216: calls
    P216-->>- P0: return
    P0->>+ P217: calls
    P217-->>- P0: return
    P0->>+ P218: calls
    P218-->>- P0: return
    P0->>+ P219: calls
    P219-->>- P0: return
    P0->>+ P220: calls
    P220-->>- P0: return
    P0->>+ P221: calls
    P221-->>- P0: return
    P0->>+ P222: calls
    P222-->>- P0: return
    P0->>+ P223: calls
    P223-->>- P0: return
    P0->>+ P224: calls
    P224-->>- P0: return
    P0->>+ P225: calls
    P225-->>- P0: return
    P0->>+ P226: calls
    P226-->>- P0: return
    P0->>+ P227: calls
    P227-->>- P0: return
    P0->>+ P228: calls
    P228-->>- P0: return
    P0->>+ P229: calls
    P229-->>- P0: return
    P0->>+ P230: calls
    P230-->>- P0: return
    P0->>+ P231: calls
    P231-->>- P0: return
    P0->>+ P232: calls
    P232-->>- P0: return
    P0->>+ P184: calls
    P184-->>- P0: return
    P0->>+ P233: calls
    P233-->>- P0: return
    P0->>+ P234: calls
    P234-->>- P0: return
    P0->>+ P235: calls
    P235-->>- P0: return
    P0->>+ P236: calls
    P236-->>- P0: return
    P0->>+ P237: calls
    P237-->>- P0: return
    P0->>+ P238: calls
    P238-->>- P0: return
    P0->>+ P239: calls
    P239-->>- P0: return
    P0->>+ P240: calls
    P240-->>- P0: return
    P0->>+ P241: calls
    P241-->>- P0: return
    P0->>+ P242: calls
    P242-->>- P0: return
    P0->>+ P243: calls
    P243-->>- P0: return
    P0->>+ P244: calls
    P244-->>- P0: return
    P0->>+ P245: calls
    P245-->>- P0: return
    P0->>+ P38: calls
    P38-->>- P0: return
    P0->>+ P246: calls
    P246-->>- P0: return
    P0->>+ P247: calls
    P247-->>- P0: return
    P0->>+ P248: calls
    P248-->>- P0: return
    P0->>+ P249: calls
    P249-->>- P0: return
    P0->>+ P250: calls
    P250-->>- P0: return
    P0->>+ P251: calls
    P251-->>- P0: return
    P0->>+ P252: calls
    P252-->>- P0: return
    P0->>+ P253: calls
    P253-->>- P0: return
    P0->>+ P254: calls
    P254-->>- P0: return
    P0->>+ P255: calls
    P255-->>- P0: return
    P0->>+ P256: calls
    P256-->>- P0: return
    P0->>+ P257: calls
    P257-->>- P0: return
    P0->>+ P258: calls
    P258-->>- P0: return
    P0->>+ P259: calls
    P259-->>- P0: return
    P0->>+ P260: calls
    P260-->>- P0: return
    P0->>+ P261: calls
    P261-->>- P0: return
    P0->>+ P262: calls
    P262-->>- P0: return
    P0->>+ P263: calls
    P263-->>- P0: return
```

## Connections by Relation

### calls
- [[submit()]] `EXTRACTED`
- [[chatCompletion()]] `INFERRED`
- [[chatCompletionGemini()]] `INFERRED`
- [[chatCompletionAnthropic()]] `INFERRED`
- [[chatCompletionResponses()]] `INFERRED`
- [[grepTool()]] `INFERRED`
- [[validateToolArgs()]] `INFERRED`
- [[executeTool()]] `INFERRED`
- [[webfetchTool()]] `INFERRED`
- [[.doRefresh()]] `INFERRED`
- [[gitListFiles()]] `INFERRED`
- [[needsApproval()]] `INFERRED`
- [[fetchModelsWithStatus()]] `INFERRED`
- [[toolNames()]] `INFERRED`
- [[rgContentHits()]] `INFERRED`
- [[planBatches()]] `INFERRED`
- [[todoUpdateTool()]] `INFERRED`
- [[trackHistory()]] `INFERRED`
- [[readFileDiffs()]] `INFERRED`
- [[discoverSkills()]] `INFERRED`

### contains
- [[App.tsx]] `EXTRACTED`

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*