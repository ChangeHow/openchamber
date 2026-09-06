import { describe, expect, test } from 'bun:test';

import { composeI18nDictionary } from './composition';
import type { I18nKey } from './store';
import { dict as enDict } from './messages/en';
import { dict as esDict } from './messages/es';
import { dict as deDict } from './messages/de';
import { dict as frDict } from './messages/fr';
import { dict as jaDict } from './messages/ja';
import { dict as koDict } from './messages/ko';
import { dict as plDict } from './messages/pl';
import { dict as ptBrDict } from './messages/pt-BR';
import { dict as ukDict } from './messages/uk';
import { dict as zhCnDict } from './messages/zh-CN';
import { dict as zhTwDict } from './messages/zh-TW';
import { dict as trDict } from './messages/tr';

const localeDictionaries = {
  en: enDict,
  de: deDict,
  fr: frDict,
  es: esDict,
  ja: jaDict,
  'pt-BR': ptBrDict,
  uk: ukDict,
  ko: koDict,
  pl: plDict,
  'zh-CN': zhCnDict,
  'zh-TW': zhTwDict,
  tr: trDict,
} as const;

const acceptsI18nKey = (key: I18nKey): I18nKey => key;

describe('i18n dictionaries', () => {
  test('all locales stay in key parity with english', () => {
    const englishKeys = Object.keys(enDict).sort();

    for (const dictionary of Object.values(localeDictionaries)) {
      expect(Object.keys(dictionary).sort()).toEqual(englishKeys);
    }
  });

  test('all locales expose language label keys', () => {
    for (const [, dictionary] of Object.entries(localeDictionaries)) {
      expect(dictionary['common.language.german']).toBeTruthy();
      expect(dictionary['common.language.french']).toBeTruthy();
      expect(dictionary['common.language.japanese']).toBeTruthy();
    }
  });

  test('composes registered bundle messages into every locale', () => {
    expect(composeI18nDictionary('en', enDict)['codebase.usingMergeRequestBranch'])
      .toBe('Using merge request branch {branch}');
    expect(composeI18nDictionary('zh-CN', zhCnDict)['codebase.usingMergeRequestBranch'])
      .toBe('正在使用合并请求分支 {branch}');
  });

  test('types core and registered bundle keys without widening', () => {
    acceptsI18nKey('common.loading');
    acceptsI18nKey('codebase.title');
    acceptsI18nKey('settings.integrations.codebase.title');
    // @ts-expect-error Arbitrary message keys must not be accepted.
    acceptsI18nKey('codebase.typo');
  });
});
