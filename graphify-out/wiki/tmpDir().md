# tmpDir()

> God node · 48 connections · [C:\Users\Bhavin\Videos\WEB dev\Opensource porjects\Atom\tests\turn-boundary-drain.test.tsx](file:///C:/Users/Bhavin/Videos/WEB%20dev/Opensource%20porjects/Atom/tests/turn-boundary-drain.test.tsx#L23)

## Call Trace Diagram

```mermaid
sequenceDiagram
    participant P0 as tmpDir()
    participant P1 as snapshotDir()
    participant P2 as readPrior()
    participant P3 as now
    participant P4 as stat
    participant P5 as capturePriorBytes()
    participant P6 as pruneStaleSnapshotOverflow()
    participant P7 as streamCopyWithHash()
    participant P8 as snapshotFromText()
    participant P9 as overflowDir()
    participant P10 as bgDir()
    participant P11 as tempHome()
    participant P12 as tempHome()
    participant P13 as tempHome()
    participant P14 as tempHome()
    participant P15 as isolateHome()
    participant P16 as isolateHome()
    participant P17 as isolateHome()
    participant P18 as cleanEnv()
    participant P19 as cleanEnv()
    participant P20 as makeTempRoot()
    participant P21 as makeTempRoot()
    participant P22 as makeTempRoot()
    participant P23 as makeTempRoot()
    participant P24 as makeTempRoot()
    participant P25 as makeTempRoot()
    participant P26 as makeTempRoot()
    participant P27 as makeTempRoot()
    participant P28 as makeTempRoot()
    participant P29 as makeTempRoot()
    participant P30 as makeTempRoot()
    participant P31 as tmpTree()
    participant P32 as tmpHome()
    participant P33 as tempHome()
    participant P34 as cleanEnv()
    participant P35 as cleanEnv()
    participant P36 as cleanEnv()
    participant P37 as isolateHome()
    participant P38 as makeTempDir()
    participant P39 as tempHome()
    participant P40 as cleanEnv()
    participant P41 as tempHome()
    participant P42 as tmpFile()
    participant P43 as tempHome()
    participant P44 as tmpTree()
    participant P45 as tmpHome()
    participant P46 as tempHome()
    participant P47 as tempHome()
    participant P48 as tmpHome()
    participant P49 as tempHome()
    participant P50 as tempHome()
    participant P51 as tempHome()
    participant P52 as tempHome()
    participant P53 as tempHome()
    participant P54 as tempHome()
    P0->>+ P1: calls
    P1-->>- P0: return
    P1->>+ P0: calls
    P0-->>- P1: return
    P1->>+ P2: calls
    P2-->>- P1: return
    P2->>+ P3: calls
    P3-->>- P2: return
    P2->>+ P4: calls
    P4-->>- P2: return
    P2->>+ P5: calls
    P5-->>- P2: return
    P2->>+ P6: calls
    P6-->>- P2: return
    P2->>+ P1: calls
    P1-->>- P2: return
    P2->>+ P7: calls
    P7-->>- P2: return
    P1->>+ P6: calls
    P6-->>- P1: return
    P6->>+ P3: calls
    P3-->>- P6: return
    P6->>+ P2: calls
    P2-->>- P6: return
    P6->>+ P1: calls
    P1-->>- P6: return
    P6->>+ P8: calls
    P8-->>- P6: return
    P1->>+ P8: calls
    P8-->>- P1: return
    P0->>+ P9: calls
    P9-->>- P0: return
    P0->>+ P10: calls
    P10-->>- P0: return
    P0->>+ P11: calls
    P11-->>- P0: return
    P0->>+ P12: calls
    P12-->>- P0: return
    P0->>+ P13: calls
    P13-->>- P0: return
    P0->>+ P14: calls
    P14-->>- P0: return
    P0->>+ P15: calls
    P15-->>- P0: return
    P0->>+ P16: calls
    P16-->>- P0: return
    P0->>+ P17: calls
    P17-->>- P0: return
    P0->>+ P18: calls
    P18-->>- P0: return
    P0->>+ P19: calls
    P19-->>- P0: return
    P0->>+ P20: calls
    P20-->>- P0: return
    P0->>+ P21: calls
    P21-->>- P0: return
    P0->>+ P22: calls
    P22-->>- P0: return
    P0->>+ P23: calls
    P23-->>- P0: return
    P0->>+ P24: calls
    P24-->>- P0: return
    P0->>+ P25: calls
    P25-->>- P0: return
    P0->>+ P26: calls
    P26-->>- P0: return
    P0->>+ P27: calls
    P27-->>- P0: return
    P0->>+ P28: calls
    P28-->>- P0: return
    P0->>+ P29: calls
    P29-->>- P0: return
    P0->>+ P30: calls
    P30-->>- P0: return
    P0->>+ P31: calls
    P31-->>- P0: return
    P0->>+ P32: calls
    P32-->>- P0: return
    P0->>+ P33: calls
    P33-->>- P0: return
    P0->>+ P34: calls
    P34-->>- P0: return
    P0->>+ P35: calls
    P35-->>- P0: return
    P0->>+ P36: calls
    P36-->>- P0: return
    P0->>+ P37: calls
    P37-->>- P0: return
    P0->>+ P38: calls
    P38-->>- P0: return
    P0->>+ P39: calls
    P39-->>- P0: return
    P0->>+ P40: calls
    P40-->>- P0: return
    P0->>+ P41: calls
    P41-->>- P0: return
    P0->>+ P42: calls
    P42-->>- P0: return
    P0->>+ P43: calls
    P43-->>- P0: return
    P0->>+ P44: calls
    P44-->>- P0: return
    P0->>+ P45: calls
    P45-->>- P0: return
    P0->>+ P46: calls
    P46-->>- P0: return
    P0->>+ P47: calls
    P47-->>- P0: return
    P0->>+ P48: calls
    P48-->>- P0: return
    P0->>+ P49: calls
    P49-->>- P0: return
    P0->>+ P50: calls
    P50-->>- P0: return
    P0->>+ P51: calls
    P51-->>- P0: return
    P0->>+ P52: calls
    P52-->>- P0: return
    P0->>+ P53: calls
    P53-->>- P0: return
    P0->>+ P54: calls
    P54-->>- P0: return
```

## Connections by Relation

### calls
- [[snapshotDir()]] `INFERRED`
- [[overflowDir()]] `INFERRED`
- [[bgDir()]] `INFERRED`
- [[tempHome()]] `INFERRED`
- [[tempHome()]] `INFERRED`
- [[tempHome()]] `INFERRED`
- [[tempHome()]] `INFERRED`
- [[isolateHome()]] `INFERRED`
- [[isolateHome()]] `INFERRED`
- [[isolateHome()]] `INFERRED`
- [[cleanEnv()]] `INFERRED`
- [[cleanEnv()]] `INFERRED`
- [[makeTempRoot()]] `INFERRED`
- [[makeTempRoot()]] `INFERRED`
- [[makeTempRoot()]] `INFERRED`
- [[makeTempRoot()]] `INFERRED`
- [[makeTempRoot()]] `INFERRED`
- [[makeTempRoot()]] `INFERRED`
- [[makeTempRoot()]] `INFERRED`
- [[makeTempRoot()]] `INFERRED`

### contains
- [[turn-boundary-drain.test.tsx]] `EXTRACTED`

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*