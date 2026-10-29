// AppShell: the root TUI layout as a UI concept.
//
// Contract (slots, all React nodes — AppShell owns geometry only):
//   conversation — committed scrollback (Conversation).
//   liveZone — streaming/held/empty zone (LiveTailHost).
//   overlayZone — error + modals + todo + widgets (above the footer).
//   footerZone — input/pickers/slash-menu + status bar (bottom-anchored,
//                never splits: flexShrink=0 per ticket-05 footer cluster).
// No state, no keyboard, no agent logic. Geometry: transcript scrolls,
// footer pins.
import React, { useEffect, useRef } from "react";
import { Box, useBoxMetrics, type DOMElement } from "ink";

export type AppShellProps = {
    conversation: React.ReactNode;
    liveZone: React.ReactNode;
    overlayZone: React.ReactNode;
    footerZone: React.ReactNode;
    // Frame containment cap (plan D2/D3). When present the root box can never
    // exceed this row count and the middle (conversation + live + overlay)
    // shrinks and clips inside it, while the footer keeps its flexShrink=0
    // size outside the clip — the middle is clipped, never the footer.
    // Absent (or a frame under the cap): the tree and its height are
    // unchanged, so frames that already fit render byte-identically.
    maxHeight?: number;
    // Measured frame height (plan Phase 3 overflow guard): reported whenever
    // the root box's computed height changes, one report per value. App uses
    // it to detect the documented cap-lifting residuals (provider picker,
    // /diff) reaching the viewport — the only states that can still arm
    // Ink's win32 clear branch — and fire the controlled repaint safety net.
    // Null = no measurement wanted (no churn, byte-identical tree).
    onFrameHeight?: (height: number) => void;
};

export const AppShell = React.memo(function AppShell({
    conversation,
    liveZone,
    overlayZone,
    footerZone,
    maxHeight,
    onFrameHeight,
}: AppShellProps) {
    const frameRef = useRef<DOMElement | null>(null);
    const metrics = useBoxMetrics(frameRef);
    const reportedHeightRef = useRef<number | null>(null);
    useEffect(() => {
        if (!onFrameHeight) return;
        if (!metrics.hasMeasured) return;
        if (reportedHeightRef.current === metrics.height) return;
        reportedHeightRef.current = metrics.height;
        onFrameHeight(metrics.height);
    }, [metrics.height, metrics.hasMeasured, onFrameHeight]);

    if (maxHeight === undefined) {
        // No cap: today's tree, byte-identical (no wrapper, no clip styles).
        return (
            <Box ref={frameRef} flexDirection="column">
                {conversation}
                {liveZone}
                {overlayZone}
                <Box flexDirection="column" flexShrink={0}>
                    {footerZone}
                </Box>
            </Box>
        );
    }
    return (
        // Capped root (plan D2): the frame never exceeds `maxHeight`. The
        // middle shrinks first (D3) and clips its overflow; the footer keeps
        // its flexShrink=0 size OUTSIDE the clipped middle.
        //
        // liveZone/overlayZone get unsquishable wrappers (Phase 1 spike): a
        // height-capped ancestor squeezes direct flex children fractionally
        // and overprints rows; flexShrink=0 keeps each zone at its natural
        // height so the middle's overflow="hidden" clips the TAIL cleanly
        // (D3: clip the middle, never squeeze it). The conversation slot
        // stays unwrapped: its <Static> is position:absolute and skipped in
        // the dynamic pass, so it neither grows the frame nor squeezes.
        <Box ref={frameRef} flexDirection="column" maxHeight={maxHeight}>
            <Box
                flexDirection="column"
                flexGrow={1}
                flexShrink={1}
                overflow="hidden"
            >
                {conversation}
                <Box flexDirection="column" flexShrink={0}>
                    {liveZone}
                </Box>
                <Box flexDirection="column" flexShrink={0}>
                    {overlayZone}
                </Box>
            </Box>
            <Box flexDirection="column" flexShrink={0}>
                {footerZone}
            </Box>
        </Box>
    );
});
