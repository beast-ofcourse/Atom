# now

> God node · 138 connections · [C:\Users\Bhavin\Videos\WEB dev\Opensource porjects\Atom\tests\tools.test.ts](file:///C:/Users/Bhavin/Videos/WEB%20dev/Opensource%20porjects/Atom/tests/tools.test.ts#L153)

## Call Trace Diagram

```mermaid
sequenceDiagram
    participant P0 as now
    participant P1 as submit()
    participant P2 as runSlashCommand()
    participant P3 as doResume()
    participant P4 as getSession()
    participant P5 as pushInfo()
    participant P6 as selectSession()
    participant P7 as runReloadCommand()
    participant P8 as createSession()
    participant P9 as json
    participant P10 as runGoalCommand()
    participant P11 as runRevertCommand()
    participant P12 as updateSession()
    participant P13 as persistSession()
    participant P14 as openSkillPicker()
    participant P15 as withEnvBlock()
    participant P16 as addInfoRow()
    participant P17 as showError()
    participant P18 as clearTodos()
    participant P19 as setGoalBoth()
    participant P20 as buildContextText()
    participant P21 as openSessionPicker()
    participant P22 as openMcpPicker()
    participant P23 as .recordEvent()
    participant P24 as openModelPicker()
    participant P25 as getJSON()
    participant P26 as setActiveSession()
    participant P27 as setInputBoth()
    participant P28 as replaceTranscriptTurns()
    participant P29 as setScrollEndBoth()
    participant P30 as runThemeCommand()
    participant P31 as runForkCommand()
    participant P32 as runRenameCommand()
    participant P33 as refreshSessions()
    participant P34 as trackHistory()
    participant P35 as clearThinking()
    participant P36 as applyToolCall()
    participant P37 as storeCwd()
    participant P38 as setKeyPromptBoth()
    participant P39 as setBaseURLPromptBoth()
    participant P40 as runRulesCommand()
    participant P41 as telemetrySummaryText()
    participant P42 as applySlashSetting()
    participant P43 as setDraft()
    participant P44 as withSessionTodos()
    participant P45 as buildSystemPrompt()
    participant P46 as persistTelemetry()
    participant P47 as bindTodoSession()
    participant P48 as runQueueCommand()
    participant P49 as runAutoScrollCommand()
    participant P50 as runExtensionCommandFromApp()
    participant P51 as invokeSkill()
    participant P52 as writeTelemetryDashboard()
    participant P53 as setContextLoadBoth()
    participant P54 as setLoadEstimatedBoth()
    participant P55 as setSessionTitleBoth()
    participant P56 as setUsageBoth()
    participant P57 as setAutoDisabledBoth()
    participant P58 as replaceExtensionContext()
    participant P59 as runCompactCommand()
    participant P60 as openProviderPicker()
    participant P61 as runThinkingCommand()
    participant P62 as openUsageLedger()
    participant P63 as trySlashSubmit()
    participant P64 as clearSnapshots()
    participant P65 as listCheckpoints()
    participant P66 as setPhaseBoth()
    participant P67 as refreshSkillMenu()
    participant P68 as acceptSlash()
    participant P69 as refreshModels()
    participant P70 as resetStreamSequencing()
    participant P71 as toolsListText()
    participant P72 as setTrustAllBoth()
    participant P73 as parseExtensionCommandInput()
    participant P74 as getExtensionCommand()
    participant P75 as setEffortIndexBoth()
    participant P76 as helpListText()
    participant P77 as setRewindIndexBoth()
    participant P78 as has
    participant P79 as doCompact()
    participant P80 as drainTurnBoundary()
    participant P81 as .refresh()
    participant P82 as ensureStoreSession()
    participant P83 as runModelsCommand()
    participant P84 as .startTurn()
    participant P85 as .endTurn()
    participant P86 as appendTurns()
    participant P87 as chatBaseURL()
    participant P88 as estimateTokensForChars()
    participant P89 as paintScheduler()
    participant P90 as activateSkill()
    participant P91 as setBusy()
    participant P92 as resolveSkills()
    participant P93 as cwd
    participant P94 as commitThinking()
    participant P95 as invokeSkillByName()
    participant P96 as keyForProvider()
    participant P97 as providerNeedsKey()
    participant P98 as historyChars()
    participant P99 as localUnreachableNotice()
    participant P100 as startTurnTimer()
    participant P101 as refreshGitInfo()
    participant P102 as refreshSystemEnv()
    participant P103 as expandMentionsForSubmit()
    participant P104 as matchSkills()
    participant P105 as runAgenticLoopForProvider()
    participant P106 as setQueueBoth()
    participant P107 as flushDraft()
    participant P108 as pruneMentions()
    participant P109 as shouldPreCompactForPending()
    participant P110 as setHasHadOutputBoth()
    participant P111 as takeUncommittedStream()
    participant P112 as prunePastedChunks()
    participant P113 as .reset()
    participant P114 as .setSessionMeta()
    participant P115 as cancelledTurnLine()
    participant P116 as shouldCompactOnSizeError()
    participant P117 as isSizeError()
    participant P118 as buildGoalHook()
    participant P119 as expandPastedSummaries()
    participant P120 as stripShellBang()
    participant P121 as send
    participant P122 as classifyTurnOutcome()
    participant P123 as runLoopWithChat()
    participant P124 as .safeNow()
    participant P125 as collectSSEText()
    participant P126 as readSSEMessage()
    participant P127 as saveAuthFile()
    participant P128 as fetchKiloModelsWithStatus()
    participant P129 as .watchSseStream()
    participant P130 as listFilesUnshared()
    participant P131 as setCachedRead()
    participant P132 as readPrior()
    participant P133 as bashOutputTool()
    participant P134 as reduceAgentEvent()
    participant P135 as runScenario()
    participant P136 as getEnvBlock()
    participant P137 as getRetryDelay()
    participant P138 as getCachedRead()
    participant P139 as openTurn()
    participant P140 as closeTurn()
    participant P141 as timeCase()
    participant P142 as timePlan()
    participant P143 as pruneStaleSnapshotOverflow()
    participant P144 as snapshotFromText()
    participant P145 as resolveClient()
    participant P146 as toTokens()
    participant P147 as rememberNonGit()
    participant P148 as storeListing()
    participant P149 as spillOverflow()
    participant P150 as resultCacheSet()
    participant P151 as pushCheckpoint()
    participant P152 as pruneTelemetrySessions()
    participant P153 as isTokenExpired()
    participant P154 as pruneOverflowFiles()
    participant P155 as resultCacheGet()
    participant P156 as newBgId()
    participant P157 as waitFor()
    participant P158 as waitFor()
    participant P159 as waitFor()
    participant P160 as waitFor()
    participant P161 as waitFor()
    participant P162 as timeIt()
    participant P163 as clockNow()
    participant P164 as mediaId()
    participant P165 as pruneMedia()
    participant P166 as newCheckpointId()
    participant P167 as newSessionId()
    participant P168 as nextTurnId()
    participant P169 as isKnownNonGit()
    participant P170 as relTime()
    participant P171 as turnElapsed()
    participant P172 as waitForPostCount()
    participant P173 as waitFor()
    participant P174 as waitForPosts()
    participant P175 as waitForFrame()
    participant P176 as waitForFrame()
    participant P177 as waitForFrame()
    participant P178 as waitFor()
    participant P179 as waitForFrame()
    participant P180 as waitForFrame()
    participant P181 as waitForFrameAbsent()
    participant P182 as waitForFrame()
    participant P183 as waitForFrame()
    participant P184 as waitForFrame()
    participant P185 as waitForPosts()
    participant P186 as waitForFrame()
    participant P187 as waitForFrame()
    participant P188 as waitForFrame()
    participant P189 as waitForFrame()
    participant P190 as waitForFrame()
    participant P191 as waitForFrame()
    participant P192 as waitForFrame()
    participant P193 as waitForFrameAbsent()
    participant P194 as waitForFrame()
    participant P195 as waitForFrame()
    participant P196 as waitForFrame()
    participant P197 as waitForFrame()
    participant P198 as waitForFrame()
    participant P199 as waitForFrame()
    participant P200 as waitForFrame()
    participant P201 as waitForFrameAbsent()
    participant P202 as waitForFrame()
    participant P203 as waitForAppFrame()
    participant P204 as waitFor()
    participant P205 as waitForFrame()
    participant P206 as waitForFrame()
    participant P207 as waitForFrameAbsent()
    participant P208 as waitForFrame()
    participant P209 as waitForFrame()
    participant P210 as waitForFrame()
    participant P211 as waitForFrame()
    participant P212 as waitForFrameAbsent()
    participant P213 as waitForFrame()
    participant P214 as waitForPosts()
    participant P215 as waitForFrame()
    participant P216 as waitForFrame()
    participant P217 as waitForFrame()
    participant P218 as waitForFrame()
    participant P219 as waitForFrame()
    participant P220 as waitForFrame()
    participant P221 as waitForFrame()
    participant P222 as waitForFrame()
    participant P223 as waitForFrame()
    participant P224 as waitForFrame()
    participant P225 as waitForAbsence()
    participant P226 as waitForFrame()
    participant P227 as waitForFrame()
    participant P228 as waitForFrameAbsent()
    participant P229 as waitForFrame()
    participant P230 as waitForFrame()
    participant P231 as waitForFrame()
    participant P232 as waitForFrame()
    participant P233 as waitForFrame()
    participant P234 as waitForFrame()
    participant P235 as waitForFrame()
    participant P236 as waitForFrame()
    participant P237 as waitForFrameAbsent()
    participant P238 as waitForFrame()
    participant P239 as waitForFrame()
    participant P240 as waitForFrame()
    participant P241 as waitForFrame()
    participant P242 as waitForFrame()
    participant P243 as waitForFrame()
    participant P244 as waitForFrame()
    participant P245 as waitForFrameAbsent()
    participant P246 as waitForPosts()
    participant P247 as waitForFrame()
    participant P248 as waitForFrame()
    participant P249 as waitForPosts()
    participant P250 as waitForFrame()
    participant P251 as waitForFrame()
    participant P252 as waitForFrame()
    participant P253 as waitForFrame()
    participant P254 as waitForFrame()
    participant P255 as waitForFrame()
    participant P256 as waitFor()
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
    P1->>+ P78: calls
    P78-->>- P1: return
    P1->>+ P79: calls
    P79-->>- P1: return
    P1->>+ P5: calls
    P5-->>- P1: return
    P1->>+ P80: calls
    P80-->>- P1: return
    P1->>+ P10: calls
    P10-->>- P1: return
    P1->>+ P11: calls
    P11-->>- P1: return
    P1->>+ P81: calls
    P81-->>- P1: return
    P1->>+ P82: calls
    P82-->>- P1: return
    P1->>+ P13: calls
    P13-->>- P1: return
    P1->>+ P83: calls
    P83-->>- P1: return
    P1->>+ P84: calls
    P84-->>- P1: return
    P1->>+ P85: calls
    P85-->>- P1: return
    P1->>+ P21: calls
    P21-->>- P1: return
    P1->>+ P22: calls
    P22-->>- P1: return
    P1->>+ P24: calls
    P24-->>- P1: return
    P1->>+ P86: calls
    P86-->>- P1: return
    P1->>+ P87: calls
    P87-->>- P1: return
    P1->>+ P88: calls
    P88-->>- P1: return
    P1->>+ P27: calls
    P27-->>- P1: return
    P1->>+ P32: calls
    P32-->>- P1: return
    P1->>+ P30: calls
    P30-->>- P1: return
    P1->>+ P31: calls
    P31-->>- P1: return
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
    P1->>+ P40: calls
    P40-->>- P1: return
    P1->>+ P35: calls
    P35-->>- P1: return
    P1->>+ P36: calls
    P36-->>- P1: return
    P1->>+ P94: calls
    P94-->>- P1: return
    P1->>+ P43: calls
    P43-->>- P1: return
    P1->>+ P48: calls
    P48-->>- P1: return
    P1->>+ P49: calls
    P49-->>- P1: return
    P1->>+ P95: calls
    P95-->>- P1: return
    P1->>+ P50: calls
    P50-->>- P1: return
    P1->>+ P96: calls
    P96-->>- P1: return
    P1->>+ P46: calls
    P46-->>- P1: return
    P1->>+ P97: calls
    P97-->>- P1: return
    P1->>+ P98: calls
    P98-->>- P1: return
    P1->>+ P59: calls
    P59-->>- P1: return
    P1->>+ P61: calls
    P61-->>- P1: return
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
    P1->>+ P66: calls
    P66-->>- P1: return
    P1->>+ P107: calls
    P107-->>- P1: return
    P1->>+ P108: calls
    P108-->>- P1: return
    P1->>+ P109: calls
    P109-->>- P1: return
    P1->>+ P110: calls
    P110-->>- P1: return
    P1->>+ P70: calls
    P70-->>- P1: return
    P1->>+ P111: calls
    P111-->>- P1: return
    P1->>+ P112: calls
    P112-->>- P1: return
    P1->>+ P73: calls
    P73-->>- P1: return
    P1->>+ P74: calls
    P74-->>- P1: return
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
    P0->>+ P123: calls
    P123-->>- P0: return
    P0->>+ P80: calls
    P80-->>- P0: return
    P0->>+ P124: calls
    P124-->>- P0: return
    P0->>+ P125: calls
    P125-->>- P0: return
    P0->>+ P126: calls
    P126-->>- P0: return
    P0->>+ P127: calls
    P127-->>- P0: return
    P0->>+ P128: calls
    P128-->>- P0: return
    P0->>+ P129: calls
    P129-->>- P0: return
    P0->>+ P130: calls
    P130-->>- P0: return
    P0->>+ P131: calls
    P131-->>- P0: return
    P0->>+ P132: calls
    P132-->>- P0: return
    P0->>+ P133: calls
    P133-->>- P0: return
    P0->>+ P134: calls
    P134-->>- P0: return
    P0->>+ P135: calls
    P135-->>- P0: return
    P0->>+ P136: calls
    P136-->>- P0: return
    P0->>+ P137: calls
    P137-->>- P0: return
    P0->>+ P138: calls
    P138-->>- P0: return
    P0->>+ P139: calls
    P139-->>- P0: return
    P0->>+ P140: calls
    P140-->>- P0: return
    P0->>+ P141: calls
    P141-->>- P0: return
    P0->>+ P142: calls
    P142-->>- P0: return
    P0->>+ P100: calls
    P100-->>- P0: return
    P0->>+ P143: calls
    P143-->>- P0: return
    P0->>+ P144: calls
    P144-->>- P0: return
    P0->>+ P145: calls
    P145-->>- P0: return
    P0->>+ P146: calls
    P146-->>- P0: return
    P0->>+ P147: calls
    P147-->>- P0: return
    P0->>+ P148: calls
    P148-->>- P0: return
    P0->>+ P149: calls
    P149-->>- P0: return
    P0->>+ P150: calls
    P150-->>- P0: return
    P0->>+ P151: calls
    P151-->>- P0: return
    P0->>+ P152: calls
    P152-->>- P0: return
    P0->>+ P153: calls
    P153-->>- P0: return
    P0->>+ P154: calls
    P154-->>- P0: return
    P0->>+ P155: calls
    P155-->>- P0: return
    P0->>+ P156: calls
    P156-->>- P0: return
    P0->>+ P157: calls
    P157-->>- P0: return
    P0->>+ P158: calls
    P158-->>- P0: return
    P0->>+ P159: calls
    P159-->>- P0: return
    P0->>+ P160: calls
    P160-->>- P0: return
    P0->>+ P161: calls
    P161-->>- P0: return
    P0->>+ P162: calls
    P162-->>- P0: return
    P0->>+ P163: calls
    P163-->>- P0: return
    P0->>+ P164: calls
    P164-->>- P0: return
    P0->>+ P165: calls
    P165-->>- P0: return
    P0->>+ P166: calls
    P166-->>- P0: return
    P0->>+ P167: calls
    P167-->>- P0: return
    P0->>+ P168: calls
    P168-->>- P0: return
    P0->>+ P169: calls
    P169-->>- P0: return
    P0->>+ P170: calls
    P170-->>- P0: return
    P0->>+ P171: calls
    P171-->>- P0: return
    P0->>+ P172: calls
    P172-->>- P0: return
    P0->>+ P173: calls
    P173-->>- P0: return
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
```

## Connections by Relation

### calls
- [[submit()]] `INFERRED`
- [[runLoopWithChat()]] `INFERRED`
- [[drainTurnBoundary()]] `INFERRED`
- [[.safeNow()]] `INFERRED`
- [[collectSSEText()]] `INFERRED`
- [[readSSEMessage()]] `INFERRED`
- [[saveAuthFile()]] `INFERRED`
- [[fetchKiloModelsWithStatus()]] `INFERRED`
- [[.watchSseStream()]] `INFERRED`
- [[listFilesUnshared()]] `INFERRED`
- [[setCachedRead()]] `INFERRED`
- [[readPrior()]] `INFERRED`
- [[bashOutputTool()]] `INFERRED`
- [[reduceAgentEvent()]] `INFERRED`
- [[runScenario()]] `INFERRED`
- [[getEnvBlock()]] `INFERRED`
- [[getRetryDelay()]] `INFERRED`
- [[getCachedRead()]] `INFERRED`
- [[openTurn()]] `INFERRED`
- [[closeTurn()]] `INFERRED`

### contains
- [[tools.test.ts]] `EXTRACTED`

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*