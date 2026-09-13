// Status-bar host: keeps the terminal-width subscription out of App.
//
// App used to call useStdout() in its own body to measure columns for the
// bar's fit-or-drop logic, coupling the whole App render to stdout changes.
// This memoized host owns that read instead: resizes re-render the bar
// alone. StatusBar itself is untouched (same props API); `columns` becomes
// an optional override (tests keep passing explicit widths, production
// measures). The 100 fallback matches StatusBar's own default.
// Throttled: resize drags coalesce to one bar render per frame, not N.
import React from "react";
import { StatusBar, type StatusBarProps } from "./status-bar.js";
import { useThrottledTerminalSize } from "./layout.js";

export type StatusBarHostProps = Omit<StatusBarProps, "columns"> & {
  columns?: number;
};

export const StatusBarHost = React.memo(function StatusBarHost(props: StatusBarHostProps) {
  let measured: number | undefined;
  try {
    measured = useThrottledTerminalSize(32).columns;
  } catch {
    measured = undefined;
  }
  return <StatusBar {...props} columns={props.columns ?? measured ?? 100} />;
});
