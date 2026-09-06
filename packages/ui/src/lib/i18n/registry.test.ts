import { describe, expect, test } from 'bun:test';

import { createI18nRegistry } from './registry';
import type { Locale } from './runtime';

const messages = (key: string, value: string) => ({
  en: { [key]: value },
  de: { [key]: value },
  fr: { [key]: value },
  'zh-CN': { [key]: value },
  'zh-TW': { [key]: value },
  uk: { [key]: value },
  es: { [key]: value },
  'pt-BR': { [key]: value },
  ko: { [key]: value },
  pl: { [key]: value },
  ja: { [key]: value },
  tr: { [key]: value },
}) satisfies { readonly [locale in Locale]: Readonly<Record<string, string>> };

const core = { 'core.message': 'Core message' } as const;

describe('i18n registry', () => {
  test('composes a second bundle without special handling', () => {
    const registry = createI18nRegistry(core)
      .registerI18nBundle({ id: 'first', messages: messages('first.message', 'First message') })
      .registerI18nBundle({ id: 'second', messages: messages('second.message', 'Second message') });

    expect(registry.compose('zh-CN', core)).toEqual({
      'core.message': 'Core message',
      'first.message': 'First message',
      'second.message': 'Second message',
    });
  });

  test('rejects collisions without registering the failed bundle', () => {
    const registry = createI18nRegistry(core)
      .registerI18nBundle({ id: 'first', messages: messages('first.message', 'First message') });

    expect(() => registry.registerI18nBundle({ id: 'collision', messages: messages('first.message', 'Collision') }))
      .toThrow('duplicate message key');
    expect(() => registry.registerI18nBundle({ id: 'core-collision', messages: messages('core.message', 'Collision') }))
      .toThrow('duplicate message key');
    expect(registry.compose('en', core)).toEqual({
      'core.message': 'Core message',
      'first.message': 'First message',
    });
  });

  test('rejects a lazy core dictionary that would overwrite a bundle message', () => {
    const registry = createI18nRegistry(core)
      .registerI18nBundle({ id: 'first', messages: messages('first.message', 'First message') });

    expect(() => registry.compose('zh-CN', { ...core, 'first.message': 'Overwritten message' }))
      .toThrow('outside the registered core message set');
  });

  test('fills missing core messages from english without replacing localized messages', () => {
    const registry = createI18nRegistry({
      'core.message': 'English core message',
      'core.missing': 'English fallback message',
    } as const).registerI18nBundle({
      id: 'first',
      messages: {
        ...messages('first.message', 'English bundle message'),
        'zh-CN': { 'first.message': '本地化 bundle 消息' },
      },
    });

    expect(registry.compose('zh-CN', { 'core.message': '本地化核心消息' })).toEqual({
      'core.message': '本地化核心消息',
      'core.missing': 'English fallback message',
      'first.message': '本地化 bundle 消息',
    });
  });

  test('rejects duplicate ids and incomplete locale messages', () => {
    const registry = createI18nRegistry(core)
      .registerI18nBundle({ id: 'first', messages: messages('first.message', 'First message') });
    const incompleteMessages = {
      ...messages('incomplete.message', 'Incomplete message'),
      fr: {},
    } satisfies { readonly [locale in Locale]: Readonly<Record<string, string>> };

    expect(() => registry.registerI18nBundle({ id: 'first', messages: messages('second.message', 'Second message') }))
      .toThrow('already registered');
    expect(() => registry.registerI18nBundle({ id: 'incomplete', messages: incompleteMessages }))
      .toThrow('incomplete fr messages');
  });
});
