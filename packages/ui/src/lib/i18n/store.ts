import { create } from 'zustand';

import { composeI18nDictionary, type I18nDictionary as ComposedI18nDictionary, type I18nKey } from './composition';
import { dict as enDict } from './messages/en';
import { DEFAULT_LOCALE, detectInitialLocale, type Locale, writeStoredLocale } from './runtime';

export type I18nParams = Record<string, string | number | boolean | null | undefined>;
export type I18nDictionary = ComposedI18nDictionary;

type I18nState = {
  locale: Locale;
  dictionary: I18nDictionary;
  loadingLocale: Locale | null;
  setLocale: (locale: Locale) => void;
};

const defaultDictionary = composeI18nDictionary(DEFAULT_LOCALE, enDict);
const dictionaries = new Map<Locale, I18nDictionary>([[DEFAULT_LOCALE, defaultDictionary]]);

export function resetI18nDictionaryCacheForTests(): void {
  dictionaries.clear();
  dictionaries.set(DEFAULT_LOCALE, defaultDictionary);
}

async function loadDictionary(locale: Locale): Promise<I18nDictionary> {
  const cached = dictionaries.get(locale);
  if (cached) {
    return cached;
  }

  const coreDictionary = locale === 'zh-CN'
    ? (await import('./messages/zh-CN')).dict
    : locale === 'fr'
      ? (await import('./messages/fr')).dict
      : locale === 'zh-TW'
        ? (await import('./messages/zh-TW')).dict
        : locale === 'es'
          ? (await import('./messages/es')).dict
          : locale === 'pt-BR'
            ? (await import('./messages/pt-BR')).dict
            : locale === 'uk'
              ? (await import('./messages/uk')).dict
              : locale === 'ko'
                ? (await import('./messages/ko')).dict
                : locale === 'pl'
                  ? (await import('./messages/pl')).dict
                  : locale === 'de'
                    ? (await import('./messages/de')).dict
                    : locale === 'ja'
                      ? (await import('./messages/ja')).dict
                      : locale === 'tr'
                        ? (await import('./messages/tr')).dict
                        : enDict;
  const dictionary = composeI18nDictionary(locale, coreDictionary);
  dictionaries.set(locale, dictionary);
  return dictionary;
}

export const useI18nStore = create<I18nState>()((set, get) => ({
  locale: DEFAULT_LOCALE,
  dictionary: defaultDictionary,
  loadingLocale: null,
  setLocale: (locale) => {
    const current = get();
    const cached = dictionaries.get(locale);
    if (current.locale === locale && current.loadingLocale !== locale && cached) {
      return;
    }

    writeStoredLocale(locale);

    set({
      locale,
      dictionary: cached ?? current.dictionary,
      loadingLocale: cached ? null : locale,
    });

    if (cached) {
      return;
    }

    void loadDictionary(locale).then((dictionary) => {
      if (get().locale !== locale) {
        return;
      }
      set({ dictionary, loadingLocale: null });
    }).catch((error) => {
      console.error(`[i18n] failed to load locale ${locale}`, error);
      if (get().locale === locale) {
        set({ dictionary: defaultDictionary, loadingLocale: null });
      }
    });
  },
}));

export function initializeLocale(): void {
  useI18nStore.getState().setLocale(detectInitialLocale());
}

export function formatMessage(
  dictionary: Partial<I18nDictionary>,
  key: I18nKey,
  params?: I18nParams,
): string {
  const template = dictionary[key] ?? defaultDictionary[key] ?? key;
  if (!params) {
    return template;
  }

  return template.replace(/\{([^{}]+)\}/g, (match, rawKey) => {
    const value = params[rawKey.trim()];
    return value === null || value === undefined ? match : String(value);
  });
}

export type { I18nKey, Locale };
