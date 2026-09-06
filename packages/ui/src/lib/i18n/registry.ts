import { LOCALES, type Locale } from './runtime';

export type I18nMessageDictionary = Readonly<Record<string, string>>;

export type I18nBundle = {
  readonly id: string;
  readonly messages: { readonly [locale in Locale]: I18nMessageDictionary };
};

type BundleKeys<Bundles extends readonly I18nBundle[]> = Bundles[number] extends infer Bundle
  ? Bundle extends I18nBundle
    ? keyof Bundle['messages']['en']
    : never
  : never;

type RegistryKeys<Core extends I18nMessageDictionary, Bundles extends readonly I18nBundle[]> =
  Extract<keyof Core | BundleKeys<Bundles>, string>;

export type I18nRegistryKey<Registry> = Registry extends I18nRegistry<infer Core, infer Bundles>
  ? RegistryKeys<Core, Bundles>
  : never;

export type I18nRegistry<Core extends I18nMessageDictionary, Bundles extends readonly I18nBundle[]> = {
  registerI18nBundle: <Bundle extends I18nBundle>(bundle: Bundle) => I18nRegistry<Core, [...Bundles, Bundle]>;
  compose: (locale: Locale, coreDictionary: I18nMessageDictionary) => Readonly<Record<RegistryKeys<Core, Bundles>, string>>;
};

function validateBundle(bundle: I18nBundle, coreKeys: ReadonlySet<string>, bundles: readonly I18nBundle[]): void {
  if (bundles.some((registeredBundle) => registeredBundle.id === bundle.id)) {
    throw new Error(`I18n bundle "${bundle.id}" is already registered`);
  }

  const expectedKeys = Object.keys(bundle.messages.en).sort();
  for (const locale of LOCALES) {
    const keys = Object.keys(bundle.messages[locale]).sort();
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
      throw new Error(`I18n bundle "${bundle.id}" has incomplete ${locale} messages`);
    }
  }

  const bundleKeys = new Set(expectedKeys);
  for (const key of bundleKeys) {
    if (coreKeys.has(key) || bundles.some((registeredBundle) => key in registeredBundle.messages.en)) {
      throw new Error(`I18n bundle "${bundle.id}" has a duplicate message key "${key}"`);
    }
  }
}

class Registry<Core extends I18nMessageDictionary, Bundles extends readonly I18nBundle[]> {
  private readonly coreKeys: ReadonlySet<string>;

  constructor(
    private readonly coreDictionary: Core,
    private readonly bundles: readonly I18nBundle[],
  ) {
    this.coreKeys = new Set(Object.keys(coreDictionary));
  }

  registerI18nBundle<Bundle extends I18nBundle>(bundle: Bundle): I18nRegistry<Core, [...Bundles, Bundle]> {
    validateBundle(bundle, this.coreKeys, this.bundles);
    return new Registry<Core, [...Bundles, Bundle]>(this.coreDictionary, [...this.bundles, bundle]);
  }

  compose(locale: Locale, dictionary: I18nMessageDictionary): Readonly<Record<RegistryKeys<Core, Bundles>, string>> {
    if (Object.keys(dictionary).some((key) => !this.coreKeys.has(key))) {
      throw new Error(`I18n core messages for ${locale} contain keys outside the registered core message set`);
    }

    const composed = Object.assign({}, this.coreDictionary, dictionary, ...this.bundles.map((bundle) => bundle.messages[locale]));
    // SAFETY: The English core fills missing core keys; core membership and bundle parity/collision checks establish this exact key set.
    return composed as Readonly<Record<RegistryKeys<Core, Bundles>, string>>;
  }
}

export function createI18nRegistry<Core extends I18nMessageDictionary>(coreDictionary: Core): I18nRegistry<Core, []> {
  return new Registry<Core, []>(coreDictionary, []);
}
