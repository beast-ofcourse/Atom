// Resize paint arbitration guard (plan Phase 2): exactly one paint per
// settled resize, and no paint carrying pre-resize geometry.
//
// Root cause mechanism 3: a trailing paint can land after the resize's
// clear/re-layout carrying the OLD width — one mis-wrapped frame, then
// another erase → flicker. The fix gates the paint scheduler: raw resize
// events suspend it (rising edge), the settled epoch resumes it (trailing
// edge). Without the gate, pushes mid-storm emit immediately at intermediate
// widths; with it, every push only updates the pending lane and the resume
// flush paints once, at the final width.
//
// This test uses the REAL Ink renderer on a fake TTY (same harness style as
// tests/terminal-resize.test.tsx) with the REAL scheduler, wiring the
// suspend/resume effects exactly the way App does.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test } from "vitest";
import { Text, render as inkRender } from "ink";
import { createPaintScheduler } from "../src/ui/paint-scheduler.js";
import { useResizeEpoch } from "../src/ui/layout.js";

class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 24;
  text = "";
  write(chunk: unknown): boolean {
    this.text += String(chunk);
    return true;
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): null {
    return null;
  }
}

class FakeStderr extends EventEmitter {
  write(): boolean {
    return true;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type FlushRecord = {
  text: string;
  /** Epoch settled-state AT FLUSH TIME (a mid-storm flush is unsettled). */
  settled: boolean;
  /** Terminal width AT FLUSH TIME (a stale paint carries the old width). */
  columns: number;
};

// Streams into a paint scheduler while resizes fire around it, wired exactly
// like App: suspend on the epoch bump, resume when settled. The flush record
// captures the geometry the paint renders at — that is what "carrying stale
// geometry" means concretely.
function StreamProbe({
  pushRef,
  suspendRef,
  flushLog,
  renderCount,
  settleMs,
}: {
  pushRef: { current: ((text: string) => void) | null };
  // Reads the epoch the suspend effect LAST processed (0 until then). The
  // storm loop awaits it per iteration so a push can never race a raw
  // resize event into the leading-edge path — the gap between the raw
  // event and the suspend effect is a real-timer race otherwise (CI
  // flakes; review report).
  suspendRef: { current: number };
  flushLog: FlushRecord[];
  renderCount: { count: number };
  settleMs: number;
}) {
  renderCount.count += 1;
  const epoch = useResizeEpoch(settleMs);
  const epochRef = useRef(epoch);
  epochRef.current = epoch;
  const [draft, setDraft] = useState("");
  const scheduler = useMemo(
    () =>
      createPaintScheduler({
        intervalMs: 20,
        onFlush: (lanes) => {
          flushLog.push({
            text: lanes.draft ?? "",
            settled: epochRef.current.settled,
            columns: epochRef.current.size.columns,
          });
          setDraft(lanes.draft ?? "");
        },
      }),
    // Mount-once: the gate must survive every epoch-driven re-render.
    [],
  );
  // Same effect wiring as App (order-independent, not render-time).
  useEffect(() => {
    if (epoch.epoch === 0) return;
    scheduler.suspend();
    suspendRef.current = epoch.epoch;
  }, [epoch.epoch, scheduler, suspendRef]);
  useEffect(() => {
    if (!epoch.settled) return;
    scheduler.resume();
  }, [epoch.settled, epoch.epoch, scheduler]);
  // Hand the stream to the test; render the painted draft beside the live
  // width so a stale-geometry paint is visible in the terminal bytes too.
  pushRef.current = (text: string) => scheduler.push("draft", text);
  return (
    <Text>
      {draft}:{epoch.size.columns}
    </Text>
  );
}

function mount(
  stdout: FakeStdout,
  flushLog: FlushRecord[],
  renderCount: { count: number },
) {
  const pushRef: { current: ((text: string) => void) | null } = { current: null };
  const suspendRef = { current: 0 };
  const inst = inkRender(
    <StreamProbe
      pushRef={pushRef}
      suspendRef={suspendRef}
      flushLog={flushLog}
      renderCount={renderCount}
      settleMs={50}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: false,
      incrementalRendering: true,
    },
  );
  return { inst, pushRef, suspendRef };
}

const instances: { unmount: () => void }[] = [];

afterEach(() => {
  for (const inst of instances.splice(0)) inst.unmount();
});

describe("resize settle: one paint per settled resize", () => {
  test("10 resizes mid-stream ⇒ exactly one flush, at the final width", async () => {
    const stdout = new FakeStdout();
    const flushLog: FlushRecord[] = [];
    const renderCount = { count: 0 };
    const { inst, pushRef, suspendRef } = mount(stdout, flushLog, renderCount);
    instances.push(inst);
    await inst.waitUntilRenderFlush();
    await sleep(60);

    // Sanity first: with NO resize around, streaming flushes normally.
    pushRef.current!("seg0");
    await sleep(40);
    expect(flushLog).toHaveLength(1);
    expect(flushLog[0]).toEqual({ text: "seg0", settled: true, columns: 100 });

    // Drop pre-storm evidence: only the storm is on trial.
    flushLog.length = 0;
    stdout.text = "";

    // The storm: 10 raw resize events in rapid succession, the stream
    // pushing after each one (exactly the drag-while-streaming shape).
    // Deterministic suspension barrier (review fix): each push waits until
    // the suspend effect for the i-th epoch bump has RUN — the old
    // `sleep(4)` guess raced the effect under CI load (push landed
    // pre-suspension and flushed at an intermediate width).
    for (let i = 1; i <= 10; i++) {
      stdout.columns = 100 - i; // intermediate widths 99…90
      stdout.emit("resize");
      const suspendStart = Date.now();
      while (suspendRef.current < i) {
        if (Date.now() - suspendStart > 10_000) {
          throw new Error(`suspend for epoch ${i} never landed`);
        }
        await sleep(2);
      }
      pushRef.current!(`p${String(i).padStart(2, "0")}~`);
    }
    // Past the last settle edge + the resume flush.
    await sleep(50 + 150);
    await inst.waitUntilRenderFlush();

    // Exactly ONE flush after the final size…
    expect(flushLog).toHaveLength(1);
    // …carrying the LAST pushed text…
    expect(flushLog[0].text).toBe("p10~");
    // …and NO flush carried an intermediate (pre-final) width.
    expect(flushLog[0].columns).toBe(90);
    expect(flushLog[0].settled).toBe(true);

    // The rendered frame agrees: final text at final width, and no
    // intermediate payload ever painted.
    expect(stdout.text).toContain("p10~:90");
    for (let i = 1; i <= 9; i++) {
      expect(stdout.text).not.toContain(`p${String(i).padStart(2, "0")}~`);
    }

    // The gate returns to normal cadence after settle: the next push
    // flushes immediately at the (now settled) width.
    pushRef.current!("post");
    await sleep(40);
    expect(flushLog).toHaveLength(2);
    expect(flushLog[1]).toEqual({ text: "post", settled: true, columns: 90 });
  }, 20000);

  test("a resize event with unchanged dimensions is inert (no epoch churn)", async () => {
    const stdout = new FakeStdout();
    const flushLog: FlushRecord[] = [];
    const renderCount = { count: 0 };
    const { inst, pushRef } = mount(stdout, flushLog, renderCount);
    instances.push(inst);
    await inst.waitUntilRenderFlush();
    await sleep(60);
    pushRef.current!("seg0");
    await sleep(40);
    expect(flushLog).toHaveLength(1);

    const rendersBefore = renderCount.count;
    stdout.text = "";
    // Same dimensions: useTerminalSize AND the epoch hook must bail out —
    // no suspend/resume cycle, no extra render, no repaint.
    stdout.emit("resize");
    await inst.waitUntilRenderFlush();
    await sleep(80);
    expect(renderCount.count).toBe(rendersBefore);
    expect(stdout.text).not.toContain("seg0");
    expect(flushLog).toHaveLength(1);
  }, 20000);
});
