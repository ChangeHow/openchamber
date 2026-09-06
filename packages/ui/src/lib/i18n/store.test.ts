import { beforeEach, describe, expect, test } from 'bun:test';
import { dict as enDict } from './messages/en';
import { DEFAULT_LOCALE, LOCALES, type Locale } from './runtime';
import { formatMessage, resetI18nDictionaryCacheForTests, useI18nStore } from './store';

const defaultDictionary = useI18nStore.getState().dictionary;

const resetStore = () => {
  resetI18nDictionaryCacheForTests();
  useI18nStore.setState({
    locale: DEFAULT_LOCALE,
    dictionary: defaultDictionary,
    loadingLocale: null,
  });
};

const waitForLocaleLoadToSettle = async (locale: Locale) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (useI18nStore.getState().loadingLocale !== locale) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${locale} dictionary load`);
};

describe('i18n store', () => {
  beforeEach(resetStore);

  test('retries loading the active locale when it is not cached', async () => {
    useI18nStore.setState({
      locale: 'es',
      dictionary: defaultDictionary,
      loadingLocale: null,
    });

    try {
      useI18nStore.getState().setLocale('es');

      expect(useI18nStore.getState().loadingLocale).toBe('es');
      await waitForLocaleLoadToSettle('es');
    } finally {
      resetStore();
    }
  });

  test('loads the french dictionary', async () => {
    try {
      useI18nStore.getState().setLocale('fr');

      expect(useI18nStore.getState().loadingLocale).toBe('fr');
      await waitForLocaleLoadToSettle('fr');
      expect(useI18nStore.getState().dictionary['common.language.french']).toBe('Français');
    } finally {
      resetStore();
    }
  });

  test('falls back to the composed english dictionary for a core-only dictionary', () => {
    expect(formatMessage(enDict, 'codebase.title')).toBe('Codebase merge requests');
  });

  test('keeps composed messages and placeholders while switching zh-CN and en', async () => {
    try {
      useI18nStore.getState().setLocale('zh-CN');
      await waitForLocaleLoadToSettle('zh-CN');
      expect(formatMessage(useI18nStore.getState().dictionary, 'codebase.usingMergeRequestBranch', { branch: 'main' }))
        .toBe('正在使用合并请求分支 main');

      useI18nStore.getState().setLocale('en');
      expect(formatMessage(useI18nStore.getState().dictionary, 'codebase.usingMergeRequestBranch', { branch: 'main' }))
        .toBe('Using merge request branch main');
    } finally {
      resetStore();
    }
  });

  test('keeps the Codebase title localized across every locale switch', async () => {
    try {
      for (const locale of LOCALES) {
        useI18nStore.getState().setLocale(locale);
        await waitForLocaleLoadToSettle(locale);
        const title = useI18nStore.getState().dictionary['codebase.title'];
        expect(title).toBeTruthy();
        if (locale !== 'en') {
          expect(title).not.toBe('Codebase merge requests');
        }
      }
    } finally {
      resetStore();
    }
  });
});
