// Phase 1 item 1.3 — theme injection via ThemeProvider + useTheme().
// No visual change: context default is the legacy singleton reference,
// so every consumer rendering without a provider sees byte-identical tokens.
// Existing `import { theme }` consumers stay untouched; they migrate later.
import React, { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { theme as legacyTheme } from "./theme.js";
import type { Theme } from "./theme.js";

const ThemeContext = createContext<Theme>(legacyTheme);

export function ThemeProvider({
  theme = legacyTheme,
  children,
}: {
  theme?: Theme;
  children: ReactNode;
}): React.JSX.Element {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
