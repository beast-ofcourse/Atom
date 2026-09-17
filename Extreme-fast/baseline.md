# Extreme-fast baseline (Phase 0.1)

Captured 2026-09-17 on the Phase 0 starting tree (post widget/lanes track,
pre perf work). Comparison point for every Extreme-fast phase. Do not edit —
add new dated sections per phase instead.

- Machine: ASUSTeK Vivobook Go E1504FA, 64-bit Windows, Node v24.18.0
- Terminal: bench default 100×30 fake TTY (`scripts/bench-render.mjs`)
- Command: `npm run bench` (all scenarios × all configs)
- Configs: A = current (incremental, 30 fps, concurrent); B = 15 fps;
  C = full-frame 30 fps; D = incremental 30 fps sync

| config | scenario | wallMs | frames | bytes | writes | clears | avgRenderMs | maxRenderMs |
|---|---|---|---|---|---|---|---|---|
| A | idle | 2001 | 3 | 2532 | 10 | 0 | 3.00 | 5.91 |
| A | burst | 3175 | 17 | 14682 | 45 | 4 | 2.73 | 7.99 |
| A | long | 3108 | 16 | 41606 | 42 | 4 | 4.25 | 23.90 |
| A | paced | 8335 | 92 | 60816 | 270 | 14 | 2.96 | 7.05 |
| A | tools | 2254 | 24 | 14484 | 63 | 0 | 0.97 | 3.35 |
| B | idle | 2009 | 3 | 1704 | 7 | 0 | 1.76 | 2.45 |
| B | burst | 3202 | 16 | 14608 | 42 | 4 | 1.79 | 5.83 |
| B | long | 3160 | 16 | 41606 | 42 | 4 | 3.59 | 22.32 |
| B | paced | 8637 | 65 | 46193 | 186 | 8 | 2.78 | 7.88 |
| B | tools | 2468 | 23 | 12751 | 60 | 0 | 1.17 | 3.96 |
| C | idle | 2009 | 3 | 1704 | 7 | 0 | 1.44 | 2.01 |
| C | burst | 3308 | 17 | 22266 | 45 | 4 | 1.54 | 4.22 |
| C | long | 2969 | 16 | 48166 | 42 | 4 | 2.93 | 21.55 |
| C | paced | 8668 | 93 | 184402 | 273 | 14 | 3.49 | 8.53 |
| C | tools | 2419 | 24 | 20936 | 63 | 0 | 1.20 | 3.96 |
| D | idle | 2012 | 1 | 0 | 7 | 0 | 8.16 | 5.59 |
| D | burst | 3083 | 16 | 13228 | 48 | 4 | 2.02 | 7.58 |
| D | long | 3093 | 15 | 40064 | 45 | 4 | 5.34 | 26.07 |
| D | paced | 8703 | 93 | 60075 | 279 | 14 | 3.07 | 10.33 |
| D | tools | 2391 | 23 | 12831 | 66 | 0 | 1.20 | 3.35 |

Notes: `maxRenderMs` single-frame outliers on <30 ms absolutes are machine
noise (same cells show avg down on re-runs). `tools` bytes carry the landed
border-widget chrome — budget deltas from THIS table, never v1.5.5 raw.
