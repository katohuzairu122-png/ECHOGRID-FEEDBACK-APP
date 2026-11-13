import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, 'workspace.module.css'), 'utf8');
const logo = readFileSync(resolve(__dirname, '../brand/logo.tsx'), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

function tile(theme: 'dark' | 'light'): string {
  const rule = block(`.workspace[data-ws-theme='${theme}']`);
  const match = /url\("data:image\/svg\+xml,([^"]+)"\)/.exec(rule);
  expect(match, `${theme} tile`).not.toBeNull();
  return decodeURIComponent(match![1]!);
}

describe('workspace brand watermark (CSS layer on the workspace root)', () => {
  it('sits behind all content inside an isolated stacking context', () => {
    expect(block('.workspace')).toMatch(/isolation:\s*isolate/);
    const layer = block('.workspace::before');
    expect(layer).toMatch(/position:\s*fixed/);
    expect(layer).toMatch(/z-index:\s*-1/);
    expect(layer).toMatch(/background-repeat:\s*repeat/);
  });

  it('never takes pointer events and stays faint enough not to affect text contrast', () => {
    const layer = block('.workspace::before');
    expect(layer).toMatch(/pointer-events:\s*none/);
    const opacity = Number(/opacity:\s*([0-9.]+)/.exec(layer)![1]);
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThanOrEqual(0.08);
  });

  it('is hidden in print and in forced-colors mode', () => {
    const start = css.indexOf('@media print, (forced-colors: active)');
    expect(start).toBeGreaterThanOrEqual(0);
    const rule = css.slice(start, css.indexOf('\n}\n', start));
    expect(rule).toContain('.workspace::before');
    expect(rule).toMatch(/display:\s*none/);
  });

  it('has one tile per theme, light marks on dark and dark marks on light', () => {
    expect(tile('dark')).toContain("stroke='#ffffff'");
    expect(tile('light')).toContain("stroke='#0f172a'");
  });

  it('is built from the logo path itself and needs no network request', () => {
    const logoPath = /<path\s+d="([^"]+)"/.exec(logo)![1]!;
    for (const theme of ['dark', 'light'] as const) {
      const svg = tile(theme);
      expect(svg).toContain(logoPath);
      expect(svg).not.toMatch(/<(image|script|foreignObject|style)\b/i);
      expect(svg).not.toMatch(/\b(href|src)=/i);
      expect(svg.replace("xmlns='http://www.w3.org/2000/svg'", '')).not.toMatch(/https?:/);
    }
    // the only url() in the layer rules are inline data URIs
    const urls = [...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]!);
    for (const u of urls.filter((value) => value.includes('svg+xml'))) {
      expect(u.startsWith('"data:image/svg+xml,')).toBe(true);
    }
  });
});
