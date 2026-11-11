import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DEFAULT_WORKSPACE_THEME, WorkspaceThemeRoot, useWorkspaceTheme } from './workspace-theme';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

function tokens(theme: 'dark' | 'light') {
  const start = css.indexOf(`[data-ws-theme='${theme}'] {`);
  const block = css.slice(start, css.indexOf('\n}', start));
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]!] = m[2]!;
  return out;
}
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('workspace theme tokens', () => {
  it('defaults to the dark navy canvas from the approved identity', () => {
    expect(DEFAULT_WORKSPACE_THEME).toBe('dark');
    const dark = tokens('dark');
    expect(dark['ws-canvas']).toBe('#031824');
    expect(dark['ws-solid-bg']).toBe('#25e9b0');
    expect(dark['ws-focus']).toBe('#22d3ee');
  });
  it.each(['dark', 'light'] as const)(
    '%s theme keeps text and accents at WCAG AA contrast',
    (theme) => {
      const t = tokens(theme);
      const pairs: [string, string][] = [
        ['ws-text', 'ws-canvas'],
        ['ws-text', 'ws-surface'],
        ['ws-text', 'ws-surface-2'],
        ['ws-text-muted', 'ws-surface'],
        ['ws-text-muted', 'ws-surface-2'],
        ['ws-text-faint', 'ws-surface'],
        ['ws-text-faint', 'ws-surface-2'],
        ['ws-text-faint', 'ws-canvas'],
        ['ws-accent-text', 'ws-surface'],
        ['ws-accent-text', 'ws-canvas'],
        ['ws-solid-fg', 'ws-solid-bg'],
        ['ws-solid-fg', 'ws-solid-hover'],
      ];
      for (const [fg, bg] of pairs) {
        expect(t[fg], fg).toBeDefined();
        expect(t[bg], bg).toBeDefined();
        expect(contrast(t[fg]!, t[bg]!), `${theme}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    },
  );
  it('provides the same semantic token names in both themes so light mode can be enabled later', () => {
    expect(
      Object.keys(tokens('light'))
        .filter((k) => k.startsWith('ws-'))
        .sort(),
    ).toEqual(
      Object.keys(tokens('dark'))
        .filter((k) => k.startsWith('ws-'))
        .sort(),
    );
  });
});

describe('WorkspaceThemeRoot', () => {
  function Probe() {
    return <span data-testid="probe">{useWorkspaceTheme() ?? 'none'}</span>;
  }
  it('scopes the dark theme by attribute and context, and allows the light theme', () => {
    const { container, rerender } = render(
      <WorkspaceThemeRoot>
        <Probe />
      </WorkspaceThemeRoot>,
    );
    expect(container.firstElementChild).toHaveAttribute('data-ws-theme', 'dark');
    expect(screen.getByTestId('probe')).toHaveTextContent('dark');
    rerender(
      <WorkspaceThemeRoot theme="light">
        <Probe />
      </WorkspaceThemeRoot>,
    );
    expect(container.firstElementChild).toHaveAttribute('data-ws-theme', 'light');
  });
  it('reports no theme outside an authenticated workspace', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('none');
  });
});
