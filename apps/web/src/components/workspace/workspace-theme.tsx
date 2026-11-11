'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * Workspace theme scope (UI Phase 1). DARK is the default authenticated presentation; LIGHT is a complete,
 * preserved token set (see app/globals.css) that nothing selects yet. The theme is carried as a data attribute on
 * the workspace root AND exposed through context, because portalled UI (dialogs) renders outside the root element
 * and must re-apply the same scope to receive the same tokens. Presentation only: no data, auth or routing here.
 */
export type WorkspaceTheme = 'dark' | 'light';
export const DEFAULT_WORKSPACE_THEME: WorkspaceTheme = 'dark';

const ThemeContext = createContext<WorkspaceTheme | undefined>(undefined);

/** The active workspace theme, or undefined outside an authenticated workspace (public pages stay light). */
export function useWorkspaceTheme(): WorkspaceTheme | undefined {
  return useContext(ThemeContext);
}

export function WorkspaceThemeRoot({
  theme = DEFAULT_WORKSPACE_THEME,
  className,
  children,
}: {
  theme?: WorkspaceTheme;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <ThemeContext.Provider value={theme}>
      <div data-ws-root="" data-ws-theme={theme} className={className}>
        {children}
      </div>
    </ThemeContext.Provider>
  );
}
