// Brand dock Phase 2 item 2.1: the dock frame (presentation only).
//
// Contract (slots, all React nodes — Dock owns geometry only):
//   inputZone — composer/input leaf (rendered as-is, top row).
//   pills — status pills (label dim + value in tone, joined by `·`).
//   actions — action chips (amber `/` prefix + dim command).
//   state — `{ busy, columns }` (columns drives margin + divider math;
//            busy reserved for Phase 5 Ember deltas, no visual yet).
// No wiring into App here (2.1 frame only).
//
// Frame: Ink Box, round gray border, horizontal margin 2 each side
// (0 below 60 cols), maxWidth 100 centered, padX 1, transparent
// background (no backgroundColor — light/dark terminals both work).
// Geometry follows AppShell/status-bar conventions: footer-cluster
// pin via flexShrink=0, top gap via theme.spacing.statusMarginTop.
import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

export type PillTone =
    | "dim"
    | "amber"
    | "cyan"
    | "magenta"
    | "green"
    | "yellow"
    | "red"
    | "gray";

export type Pill = {
    key: string;
    label: string;
    value: string;
    tone: PillTone;
};

export type ActionChip = {
    key: string;
    command: string;
};

export type DockState = {
    busy: boolean;
    columns: number;
};

export type DockProps = {
    inputZone: React.ReactNode;
    pills: Pill[];
    actions: ActionChip[];
    state: DockState;
};

// Tone paint: Ink color names. `dim` uses dimColor (terminal-dimmed
// default fg, never literal gray — see theme header). Amber has no
// Ink hue; it reads as attention, so it shares the warning yellow.
const TONE_COLOR: Record<Exclude<PillTone, "dim">, string> = {
    amber: "yellow",
    cyan: "cyan",
    magenta: "magenta",
    green: "green",
    yellow: "yellow",
    red: "red",
    gray: "gray",
};

function PillText({ pill }: { pill: Pill }) {
    const value =
        pill.tone === "dim" ? (
            <Text dimColor>{pill.value}</Text>
        ) : (
            <Text color={TONE_COLOR[pill.tone]}>{pill.value}</Text>
        );
    return (
        <Text>
            <Text dimColor>{pill.label} </Text>
            {value}
        </Text>
    );
}

function ActionText({ action }: { action: ActionChip }) {
    return (
        <Text>
            <Text color={TONE_COLOR.amber}>/</Text>
            <Text dimColor>{action.command}</Text>
        </Text>
    );
}

export const Dock = React.memo(function Dock({
    inputZone,
    pills,
    actions,
    state,
}: DockProps) {
    const columns = state.columns;
    // Horizontal margin 2 each side, 0 below 60 cols (narrow yield).
    const margin = columns < 60 ? 0 : 2;
    // Divider fill: frame width capped at 100, minus borders (2) and
    // padX (2). Never negative; repeat of the rule unit (never a frame).
    const frameWidth = Math.max(0, Math.min(columns - margin * 2, 100));
    const innerWidth = Math.max(0, frameWidth - 4);
    const divider = theme.symbol.rule.repeat(innerWidth);
    const separator = ` ${theme.symbol.separator} `;
    return (
        // flexShrink=0: footer-cluster anchoring (AppShell convention) —
        // the dock never splits. No backgroundColor: transparent.
        <Box
            borderStyle="round"
            borderColor="gray"
            marginLeft={margin}
            marginRight={margin}
            marginTop={theme.spacing.statusMarginTop}
            paddingX={1}
            flexDirection="column"
            flexShrink={0}
            maxWidth={100}
            alignSelf="center"
        >
            {inputZone}
            <Text dimColor>{divider}</Text>
            {pills.length > 0 ? (
                <Box flexDirection="row" flexWrap="wrap">
                    {pills.map((pill, i) => (
                        <Text key={pill.key}>
                            {i > 0 ? <Text dimColor>{separator}</Text> : null}
                            <PillText pill={pill} />
                        </Text>
                    ))}
                </Box>
            ) : null}
            {actions.length > 0 ? (
                <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
                    {actions.map((action) => (
                        <ActionText key={action.key} action={action} />
                    ))}
                </Box>
            ) : null}
        </Box>
    );
});
