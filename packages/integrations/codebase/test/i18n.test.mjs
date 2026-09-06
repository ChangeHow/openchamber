import assert from 'node:assert/strict';
import test from 'node:test';
import { codebaseMessages } from '@openchamber-plugin/codebase/i18n';

function placeholders(value) {
  return [...value.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
}

test('translations have matching keys and placeholders', () => {
  const [firstLocale, ...locales] = Object.keys(codebaseMessages.messages);
  const reference = codebaseMessages.messages[firstLocale];
  const keys = Object.keys(reference).sort();

  for (const locale of locales) {
    const messages = codebaseMessages.messages[locale];
    assert.deepEqual(Object.keys(messages).sort(), keys, `${locale} keys`);
    for (const key of keys) {
      assert.deepEqual(placeholders(messages[key]), placeholders(reference[key]), `${locale}:${key}`);
    }
  }

  assert.equal(codebaseMessages.messages['zh-CN']['codebase.title'], 'Codebase 合并请求');
  assert.equal(codebaseMessages.messages['zh-CN']['settings.integrations.codebase.connect'], '连接');
});
