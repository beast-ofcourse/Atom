// Shared Ink frame polling helpers for TUI tests.
// Replace 77 copies of identical waitForFrame/waitForFrameAbsent definitions.

export async function waitForFrame(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 8000
): Promise<string> {
  const start = Date.now();
  for (;;) {
    const frame = app.lastFrame() ?? "";
    if (frame.includes(needle)) return frame;
    if (Date.now() - start > timeout) {
      throw new Error(
        `timed out waiting for ${JSON.stringify(needle)}:\n${frame}`
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function waitForFrameAbsent(
  app: { lastFrame: () => string | undefined },
  needle: string,
  timeout = 5000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (!app.lastFrame()?.includes(needle)) return;
    if (Date.now() - start > timeout) {
      throw new Error(
        `timed out waiting for absence of ${JSON.stringify(needle)}:\n${app.lastFrame()}`
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}
