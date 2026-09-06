import { codebaseIntegration } from '@openchamber-plugin/codebase';

import { dict as enDict } from './messages/en';
import { createI18nRegistry, type I18nMessageDictionary, type I18nRegistryKey } from './registry';
import type { Locale } from './runtime';

const i18nRegistry = createI18nRegistry(enDict)
  .registerI18nBundle(codebaseIntegration.i18n);

export type I18nKey = I18nRegistryKey<typeof i18nRegistry>;
export type I18nDictionary = ReturnType<typeof i18nRegistry.compose>;

export const composeI18nDictionary = (locale: Locale, coreDictionary: I18nMessageDictionary): I18nDictionary =>
  i18nRegistry.compose(locale, coreDictionary);
