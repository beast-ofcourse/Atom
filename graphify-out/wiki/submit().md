# submit()

> God node · 73 connections · [C:\Users\Bhavin\Videos\WEB dev\Opensource porjects\Atom\src\App.tsx](file:///C:/Users/Bhavin/Videos/WEB%20dev/Opensource%20porjects/Atom/src/App.tsx#L6867)

## Call Trace Diagram

```mermaid
sequenceDiagram
    participant P0 as submit()
    participant P1 as now
    participant P2 as runLoopWithChat()
    participant P3 as decideTurnEndAfterGates()
    participant P4 as isCancelError()
    participant P5 as planBatches()
    participant P6 as planToolCall()
    participant P7 as throwIfCancelled()
    participant P8 as getTodos()
    participant P9 as historyChars()
    participant P10 as runScripted()
    participant P11 as timeCase()
    participant P12 as runAgenticLoopForProvider()
    participant P13 as captureSchedulerSnapshot()
    participant P14 as .note()
    participant P15 as normalizeChatResult()
    participant P16 as evaluateTurnEnd()
    participant P17 as toolSignature()
    participant P18 as runSerialToolPipeline()
    participant P19 as toolStepBudget()
    participant P20 as emptyGoalProgress()
    participant P21 as chatFn()
    participant P22 as emitTurnEvent()
    participant P23 as .noteKind()
    participant P24 as runScript()
    participant P25 as resolveMaxTotalToolCalls()
    participant P26 as isEmptyReplyError()
    participant P27 as emptyResponseFollowUp()
    participant P28 as runAgenticLoop()
    participant P29 as getReadCacheStats()
    participant P30 as recentTurnsForJudge()
    participant P31 as parseToolArguments()
    participant P32 as invalidJsonArgsResult()
    participant P33 as .consumeNudge()
    participant P34 as repetitionFollowUp()
    participant P35 as repetitionStopNotice()
    participant P36 as drainTurnBoundary()
    participant P37 as .safeNow()
    participant P38 as collectSSEText()
    participant P39 as readSSEMessage()
    participant P40 as saveAuthFile()
    participant P41 as fetchKiloModelsWithStatus()
    participant P42 as .watchSseStream()
    participant P43 as listFilesUnshared()
    participant P44 as setCachedRead()
    participant P45 as readPrior()
    participant P46 as bashOutputTool()
    participant P47 as reduceAgentEvent()
    participant P48 as runScenario()
    participant P49 as getEnvBlock()
    participant P50 as getRetryDelay()
    participant P51 as getCachedRead()
    participant P52 as openTurn()
    participant P53 as closeTurn()
    participant P54 as timePlan()
    participant P55 as startTurnTimer()
    participant P56 as pruneStaleSnapshotOverflow()
    participant P57 as snapshotFromText()
    participant P58 as resolveClient()
    participant P59 as toTokens()
    participant P60 as rememberNonGit()
    participant P61 as storeListing()
    participant P62 as spillOverflow()
    participant P63 as resultCacheSet()
    participant P64 as pushCheckpoint()
    participant P65 as pruneTelemetrySessions()
    participant P66 as isTokenExpired()
    participant P67 as pruneOverflowFiles()
    participant P68 as resultCacheGet()
    participant P69 as newBgId()
    participant P70 as waitFor()
    participant P71 as waitFor()
    participant P72 as waitFor()
    participant P73 as waitFor()
    participant P74 as waitFor()
    participant P75 as timeIt()
    participant P76 as clockNow()
    participant P77 as mediaId()
    participant P78 as pruneMedia()
    participant P79 as newCheckpointId()
    participant P80 as newSessionId()
    participant P81 as nextTurnId()
    participant P82 as isKnownNonGit()
    participant P83 as relTime()
    participant P84 as turnElapsed()
    participant P85 as waitForPostCount()
    participant P86 as waitFor()
    participant P87 as waitForPosts()
    participant P88 as waitForFrame()
    participant P89 as waitForFrame()
    participant P90 as waitForFrame()
    participant P91 as waitFor()
    participant P92 as waitForFrame()
    participant P93 as waitForFrame()
    participant P94 as waitForFrameAbsent()
    participant P95 as waitForFrame()
    participant P96 as waitForFrame()
    participant P97 as waitForFrame()
    participant P98 as waitForPosts()
    participant P99 as waitForFrame()
    participant P100 as waitForFrame()
    participant P101 as waitForFrame()
    participant P102 as waitForFrame()
    participant P103 as waitForFrame()
    participant P104 as waitForFrame()
    participant P105 as waitForFrame()
    participant P106 as waitForFrameAbsent()
    participant P107 as waitForFrame()
    participant P108 as waitForFrame()
    participant P109 as waitForFrame()
    participant P110 as waitForFrame()
    participant P111 as waitForFrame()
    participant P112 as waitForFrame()
    participant P113 as waitForFrame()
    participant P114 as waitForFrameAbsent()
    participant P115 as waitForFrame()
    participant P116 as waitForAppFrame()
    participant P117 as waitFor()
    participant P118 as waitForFrame()
    participant P119 as waitForFrame()
    participant P120 as waitForFrameAbsent()
    participant P121 as waitForFrame()
    participant P122 as waitForFrame()
    participant P123 as waitForFrame()
    participant P124 as waitForFrame()
    participant P125 as waitForFrameAbsent()
    participant P126 as waitForFrame()
    participant P127 as waitForPosts()
    participant P128 as waitForFrame()
    participant P129 as waitForFrame()
    participant P130 as waitForFrame()
    participant P131 as waitForFrame()
    participant P132 as waitForFrame()
    participant P133 as waitForFrame()
    participant P134 as waitForFrame()
    participant P135 as waitForFrame()
    participant P136 as waitForFrame()
    participant P137 as waitForFrame()
    participant P138 as waitForAbsence()
    participant P139 as waitForFrame()
    participant P140 as waitForFrame()
    participant P141 as waitForFrameAbsent()
    participant P142 as waitForFrame()
    participant P143 as waitForFrame()
    participant P144 as waitForFrame()
    participant P145 as waitForFrame()
    participant P146 as waitForFrame()
    participant P147 as waitForFrame()
    participant P148 as waitForFrame()
    participant P149 as waitForFrame()
    participant P150 as waitForFrameAbsent()
    participant P151 as waitForFrame()
    participant P152 as waitForFrame()
    participant P153 as waitForFrame()
    participant P154 as waitForFrame()
    participant P155 as waitForFrame()
    participant P156 as waitForFrame()
    participant P157 as waitForFrame()
    participant P158 as waitForFrameAbsent()
    participant P159 as waitForPosts()
    participant P160 as waitForFrame()
    participant P161 as waitForFrame()
    participant P162 as waitForPosts()
    participant P163 as waitForFrame()
    participant P164 as waitForFrame()
    participant P165 as waitForFrame()
    participant P166 as waitForFrame()
    participant P167 as waitForFrame()
    participant P168 as waitForFrame()
    participant P169 as waitFor()
    participant P170 as runSlashCommand()
    participant P171 as has
    participant P172 as doCompact()
    participant P173 as pushInfo()
    participant P174 as runGoalCommand()
    participant P175 as runRevertCommand()
    participant P176 as .refresh()
    participant P177 as ensureStoreSession()
    participant P178 as persistSession()
    participant P179 as runModelsCommand()
    participant P180 as .startTurn()
    participant P181 as .endTurn()
    participant P182 as openSessionPicker()
    participant P183 as openMcpPicker()
    participant P184 as openModelPicker()
    participant P185 as appendTurns()
    participant P186 as chatBaseURL()
    participant P187 as estimateTokensForChars()
    participant P188 as setInputBoth()
    participant P189 as runRenameCommand()
    participant P190 as runThemeCommand()
    participant P191 as runForkCommand()
    participant P192 as paintScheduler()
    participant P193 as activateSkill()
    participant P194 as setBusy()
    participant P195 as resolveSkills()
    participant P196 as cwd
    participant P197 as runRulesCommand()
    participant P198 as clearThinking()
    participant P199 as applyToolCall()
    participant P200 as commitThinking()
    participant P201 as setDraft()
    participant P202 as runQueueCommand()
    participant P203 as runAutoScrollCommand()
    participant P204 as invokeSkillByName()
    participant P205 as runExtensionCommandFromApp()
    participant P206 as keyForProvider()
    participant P207 as persistTelemetry()
    participant P208 as providerNeedsKey()
    participant P209 as runCompactCommand()
    participant P210 as runThinkingCommand()
    participant P211 as localUnreachableNotice()
    participant P212 as refreshGitInfo()
    participant P213 as refreshSystemEnv()
    participant P214 as expandMentionsForSubmit()
    participant P215 as matchSkills()
    participant P216 as setQueueBoth()
    participant P217 as setPhaseBoth()
    participant P218 as flushDraft()
    participant P219 as pruneMentions()
    participant P220 as shouldPreCompactForPending()
    participant P221 as setHasHadOutputBoth()
    participant P222 as resetStreamSequencing()
    participant P223 as takeUncommittedStream()
    participant P224 as prunePastedChunks()
    participant P225 as parseExtensionCommandInput()
    participant P226 as getExtensionCommand()
    participant P227 as .reset()
    participant P228 as .setSessionMeta()
    participant P229 as cancelledTurnLine()
    participant P230 as shouldCompactOnSizeError()
    participant P231 as isSizeError()
    participant P232 as buildGoalHook()
    participant P233 as expandPastedSummaries()
    participant P234 as stripShellBang()
    participant P235 as send
    participant P236 as classifyTurnOutcome()
    P0->>+ P1: calls
    P1-->>- P0: return
    P1->>+ P0: calls
    P0-->>- P1: return
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
    P1->>+ P36: calls
    P36-->>- P1: return
    P1->>+ P37: calls
    P37-->>- P1: return
    P1->>+ P38: calls
    P38-->>- P1: return
    P1->>+ P39: calls
    P39-->>- P1: return
    P1->>+ P40: calls
    P40-->>- P1: return
    P1->>+ P41: calls
    P41-->>- P1: return
    P1->>+ P42: calls
    P42-->>- P1: return
    P1->>+ P43: calls
    P43-->>- P1: return
    P1->>+ P44: calls
    P44-->>- P1: return
    P1->>+ P45: calls
    P45-->>- P1: return
    P1->>+ P46: calls
    P46-->>- P1: return
    P1->>+ P47: calls
    P47-->>- P1: return
    P1->>+ P48: calls
    P48-->>- P1: return
    P1->>+ P49: calls
    P49-->>- P1: return
    P1->>+ P50: calls
    P50-->>- P1: return
    P1->>+ P51: calls
    P51-->>- P1: return
    P1->>+ P52: calls
    P52-->>- P1: return
    P1->>+ P53: calls
    P53-->>- P1: return
    P1->>+ P11: calls
    P11-->>- P1: return
    P1->>+ P54: calls
    P54-->>- P1: return
    P1->>+ P55: calls
    P55-->>- P1: return
    P1->>+ P56: calls
    P56-->>- P1: return
    P1->>+ P57: calls
    P57-->>- P1: return
    P1->>+ P58: calls
    P58-->>- P1: return
    P1->>+ P59: calls
    P59-->>- P1: return
    P1->>+ P60: calls
    P60-->>- P1: return
    P1->>+ P61: calls
    P61-->>- P1: return
    P1->>+ P62: calls
    P62-->>- P1: return
    P1->>+ P63: calls
    P63-->>- P1: return
    P1->>+ P64: calls
    P64-->>- P1: return
    P1->>+ P65: calls
    P65-->>- P1: return
    P1->>+ P66: calls
    P66-->>- P1: return
    P1->>+ P67: calls
    P67-->>- P1: return
    P1->>+ P68: calls
    P68-->>- P1: return
    P1->>+ P69: calls
    P69-->>- P1: return
    P1->>+ P70: calls
    P70-->>- P1: return
    P1->>+ P71: calls
    P71-->>- P1: return
    P1->>+ P72: calls
    P72-->>- P1: return
    P1->>+ P73: calls
    P73-->>- P1: return
    P1->>+ P74: calls
    P74-->>- P1: return
    P1->>+ P75: calls
    P75-->>- P1: return
    P1->>+ P76: calls
    P76-->>- P1: return
    P1->>+ P77: calls
    P77-->>- P1: return
    P1->>+ P78: calls
    P78-->>- P1: return
    P1->>+ P79: calls
    P79-->>- P1: return
    P1->>+ P80: calls
    P80-->>- P1: return
    P1->>+ P81: calls
    P81-->>- P1: return
    P1->>+ P82: calls
    P82-->>- P1: return
    P1->>+ P83: calls
    P83-->>- P1: return
    P1->>+ P84: calls
    P84-->>- P1: return
    P1->>+ P85: calls
    P85-->>- P1: return
    P1->>+ P86: calls
    P86-->>- P1: return
    P1->>+ P87: calls
    P87-->>- P1: return
    P1->>+ P88: calls
    P88-->>- P1: return
    P1->>+ P89: calls
    P89-->>- P1: return
    P1->>+ P90: calls
    P90-->>- P1: return
    P1->>+ P91: calls
    P91-->>- P1: return
    P1->>+ P92: calls
    P92-->>- P1: return
    P1->>+ P93: calls
    P93-->>- P1: return
    P1->>+ P94: calls
    P94-->>- P1: return
    P1->>+ P95: calls
    P95-->>- P1: return
    P1->>+ P96: calls
    P96-->>- P1: return
    P1->>+ P97: calls
    P97-->>- P1: return
    P1->>+ P98: calls
    P98-->>- P1: return
    P1->>+ P99: calls
    P99-->>- P1: return
    P1->>+ P100: calls
    P100-->>- P1: return
    P1->>+ P101: calls
    P101-->>- P1: return
    P1->>+ P102: calls
    P102-->>- P1: return
    P1->>+ P103: calls
    P103-->>- P1: return
    P1->>+ P104: calls
    P104-->>- P1: return
    P1->>+ P105: calls
    P105-->>- P1: return
    P1->>+ P106: calls
    P106-->>- P1: return
    P1->>+ P107: calls
    P107-->>- P1: return
    P1->>+ P108: calls
    P108-->>- P1: return
    P1->>+ P109: calls
    P109-->>- P1: return
    P1->>+ P110: calls
    P110-->>- P1: return
    P1->>+ P111: calls
    P111-->>- P1: return
    P1->>+ P112: calls
    P112-->>- P1: return
    P1->>+ P113: calls
    P113-->>- P1: return
    P1->>+ P114: calls
    P114-->>- P1: return
    P1->>+ P115: calls
    P115-->>- P1: return
    P1->>+ P116: calls
    P116-->>- P1: return
    P1->>+ P117: calls
    P117-->>- P1: return
    P1->>+ P118: calls
    P118-->>- P1: return
    P1->>+ P119: calls
    P119-->>- P1: return
    P1->>+ P120: calls
    P120-->>- P1: return
    P1->>+ P121: calls
    P121-->>- P1: return
    P1->>+ P122: calls
    P122-->>- P1: return
    P1->>+ P123: calls
    P123-->>- P1: return
    P1->>+ P124: calls
    P124-->>- P1: return
    P1->>+ P125: calls
    P125-->>- P1: return
    P1->>+ P126: calls
    P126-->>- P1: return
    P1->>+ P127: calls
    P127-->>- P1: return
    P1->>+ P128: calls
    P128-->>- P1: return
    P1->>+ P129: calls
    P129-->>- P1: return
    P1->>+ P130: calls
    P130-->>- P1: return
    P1->>+ P131: calls
    P131-->>- P1: return
    P1->>+ P132: calls
    P132-->>- P1: return
    P1->>+ P133: calls
    P133-->>- P1: return
    P1->>+ P134: calls
    P134-->>- P1: return
    P1->>+ P135: calls
    P135-->>- P1: return
    P1->>+ P136: calls
    P136-->>- P1: return
    P1->>+ P137: calls
    P137-->>- P1: return
    P1->>+ P138: calls
    P138-->>- P1: return
    P1->>+ P139: calls
    P139-->>- P1: return
    P1->>+ P140: calls
    P140-->>- P1: return
    P1->>+ P141: calls
    P141-->>- P1: return
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
    P0->>+ P170: calls
    P170-->>- P0: return
    P0->>+ P171: calls
    P171-->>- P0: return
    P0->>+ P172: calls
    P172-->>- P0: return
    P0->>+ P173: calls
    P173-->>- P0: return
    P0->>+ P36: calls
    P36-->>- P0: return
    P0->>+ P174: calls
    P174-->>- P0: return
    P0->>+ P175: calls
    P175-->>- P0: return
    P0->>+ P176: calls
    P176-->>- P0: return
    P0->>+ P177: calls
    P177-->>- P0: return
    P0->>+ P178: calls
    P178-->>- P0: return
    P0->>+ P179: calls
    P179-->>- P0: return
    P0->>+ P180: calls
    P180-->>- P0: return
    P0->>+ P181: calls
    P181-->>- P0: return
    P0->>+ P182: calls
    P182-->>- P0: return
    P0->>+ P183: calls
    P183-->>- P0: return
    P0->>+ P184: calls
    P184-->>- P0: return
    P0->>+ P185: calls
    P185-->>- P0: return
    P0->>+ P186: calls
    P186-->>- P0: return
    P0->>+ P187: calls
    P187-->>- P0: return
    P0->>+ P188: calls
    P188-->>- P0: return
    P0->>+ P189: calls
    P189-->>- P0: return
    P0->>+ P190: calls
    P190-->>- P0: return
    P0->>+ P191: calls
    P191-->>- P0: return
    P0->>+ P192: calls
    P192-->>- P0: return
    P0->>+ P193: calls
    P193-->>- P0: return
    P0->>+ P194: calls
    P194-->>- P0: return
    P0->>+ P195: calls
    P195-->>- P0: return
    P0->>+ P196: calls
    P196-->>- P0: return
    P0->>+ P197: calls
    P197-->>- P0: return
    P0->>+ P198: calls
    P198-->>- P0: return
    P0->>+ P199: calls
    P199-->>- P0: return
    P0->>+ P200: calls
    P200-->>- P0: return
    P0->>+ P201: calls
    P201-->>- P0: return
    P0->>+ P202: calls
    P202-->>- P0: return
    P0->>+ P203: calls
    P203-->>- P0: return
    P0->>+ P204: calls
    P204-->>- P0: return
    P0->>+ P205: calls
    P205-->>- P0: return
    P0->>+ P206: calls
    P206-->>- P0: return
    P0->>+ P207: calls
    P207-->>- P0: return
    P0->>+ P208: calls
    P208-->>- P0: return
    P0->>+ P9: calls
    P9-->>- P0: return
    P0->>+ P209: calls
    P209-->>- P0: return
    P0->>+ P210: calls
    P210-->>- P0: return
    P0->>+ P211: calls
    P211-->>- P0: return
    P0->>+ P55: calls
    P55-->>- P0: return
    P0->>+ P212: calls
    P212-->>- P0: return
    P0->>+ P213: calls
    P213-->>- P0: return
    P0->>+ P214: calls
    P214-->>- P0: return
    P0->>+ P215: calls
    P215-->>- P0: return
    P0->>+ P12: calls
    P12-->>- P0: return
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
    P0->>+ P233: calls
    P233-->>- P0: return
    P0->>+ P234: calls
    P234-->>- P0: return
    P0->>+ P235: calls
    P235-->>- P0: return
    P0->>+ P236: calls
    P236-->>- P0: return
```

## Connections by Relation

### calls
- [[now]] `INFERRED`
- [[runSlashCommand()]] `EXTRACTED`
- [[has]] `EXTRACTED`
- [[doCompact()]] `EXTRACTED`
- [[pushInfo()]] `EXTRACTED`
- [[drainTurnBoundary()]] `EXTRACTED`
- [[runGoalCommand()]] `EXTRACTED`
- [[runRevertCommand()]] `EXTRACTED`
- [[.refresh()]] `INFERRED`
- [[ensureStoreSession()]] `EXTRACTED`
- [[persistSession()]] `EXTRACTED`
- [[runModelsCommand()]] `EXTRACTED`
- [[.startTurn()]] `INFERRED`
- [[.endTurn()]] `INFERRED`
- [[openSessionPicker()]] `EXTRACTED`
- [[openMcpPicker()]] `EXTRACTED`
- [[openModelPicker()]] `EXTRACTED`
- [[appendTurns()]] `EXTRACTED`
- [[chatBaseURL()]] `EXTRACTED`
- [[estimateTokensForChars()]] `INFERRED`

### contains
- [[App.tsx]] `EXTRACTED`

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*