import { describe, expect, test } from 'bun:test';
import type { I18nKey } from '@/lib/i18n/store';
import { buildSettingsSearchResults } from './search';

const t = (key: I18nKey): string => key;

const runtimeCtx = {
  isVSCode: false,
  isWeb: true,
  isDesktop: false,
  isMobile: false,
  isDesktopLocalOrigin: false,
  isMac: false,
  isWindows: false,
  isLinux: false,
  isWindowsArm64: false,
};

describe('settings search', () => {
  test('finds Codebase PAT settings without hiding GitHub', () => {
    for (const [query, id] of [['PAT', 'integrations.codebase'], ['github', 'integrations.github']]) {
      const results = buildSettingsSearchResults({ query, runtimeCtx, t, getPageTitle: (page) => page });
      expect(results.some((result) => result.id === id)).toBe(true);
    }
  });

  test('hides Codebase settings in VS Code', () => {
    const results = buildSettingsSearchResults({
      query: 'codebase', runtimeCtx: { ...runtimeCtx, isVSCode: true }, t, getPageTitle: (page) => page,
    });
    expect(results.some((result) => result.id === 'integrations.codebase')).toBe(false);
  });

  test('finds the Codebase third-party package without matching the built-in section', () => {
    const results = buildSettingsSearchResults({
      query: '@openchamber-plugin/codebase', runtimeCtx, t, getPageTitle: (page) => page,
    });
    expect(results.some((result) => result.id === 'integrations.codebase')).toBe(true);
    expect(results.some((result) => result.id === 'integrations.first-party')).toBe(false);
  });

  test('finds the Claude Code third-party integration', () => {
    const results = buildSettingsSearchResults({
      query: 'claude',
      runtimeCtx,
      t,
      getPageTitle: (page) => page,
    });

    expect(results.some((result) => result.id === 'integrations.third-party.opencode-claude')).toBe(true);
  });

  test('finds third-party integrations by OpenChamber npm package names', () => {
    const results = buildSettingsSearchResults({
      query: '@openchamber/opencode-cursor',
      runtimeCtx,
      t,
      getPageTitle: (page) => page,
    });

    expect(results.some((result) => result.id === 'integrations.third-party.opencode-cursor-oauth')).toBe(true);
  });

  test('finds Linear connect on the integrations page', () => {
    const results = buildSettingsSearchResults({
      query: 'linear',
      runtimeCtx,
      t,
      getPageTitle: (page) => page,
    });

    expect(results.some((result) => result.id === 'integrations.linear')).toBe(true);
    expect(results.some((result) => result.id === 'integrations.linear.add-workspace')).toBe(true);
    expect(results.some((result) => result.id === 'integrations.linear.mapping')).toBe(true);
  });

  test('hides Linear connect in VS Code', () => {
    const results = buildSettingsSearchResults({
      query: 'linear',
      runtimeCtx: { ...runtimeCtx, isVSCode: true },
      t,
      getPageTitle: (page) => page,
    });

    expect(results.some((result) => result.id === 'integrations.linear')).toBe(false);
    expect(results.some((result) => result.id === 'integrations.linear.add-workspace')).toBe(false);
    expect(results.some((result) => result.id === 'integrations.linear.mapping')).toBe(false);
  });

  test('finds guest extension panels on the integrations page', () => {
    const results = buildSettingsSearchResults({
      query: 'gitlab',
      runtimeCtx,
      t,
      getPageTitle: (page) => page,
    });

    expect(results.some((result) => result.id === 'integrations.guests')).toBe(true);
  });

  test('hides guest extension panels in VS Code', () => {
    const results = buildSettingsSearchResults({
      query: 'clickup',
      runtimeCtx: { ...runtimeCtx, isVSCode: true },
      t,
      getPageTitle: (page) => page,
    });

    expect(results.some((result) => result.id === 'integrations.guests')).toBe(false);
  });
});
