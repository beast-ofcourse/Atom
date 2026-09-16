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
import React from "react";
import { Box } from "ink";

export type AppShellProps = {
    conversation: React.ReactNode;
    liveZone: React.ReactNode;
    overlayZone: React.ReactNode;
    footerZone: React.ReactNode;
};

export const AppShell = React.memo(function AppShell({
    conversation,
    liveZone,
    overlayZone,
    footerZone,
}: AppShellProps) {
    return (
        <Box flexDirection="column">
            {conversation}
            {liveZone}
            {overlayZone}
            <Box flexDirection="column" flexShrink={0}>
                {footerZone}
            </Box>
        </Box>
    );
});
