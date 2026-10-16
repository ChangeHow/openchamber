import { describe, expect, test } from 'bun:test';
import { createLiveTextRateSampler } from './liveTextRate';

describe('estimated live text arrival rate', () => {
  test('waits for observed text and a completed second', () => {
    const sampler = createLiveTextRateSampler();
    expect(sampler.read(10000)).toBeNull();
    sampler.observe('', 0);
    expect(sampler.read(10000)).toBeNull();
    sampler.observe('a'.repeat(400), 100);
    expect(sampler.read(1099)).toBeNull();
    expect(sampler.read(1100)).toBe(100);
    expect(sampler.read(2100)).toBe(50);
  });

  test('keeps token fractions instead of rounding each delta', () => {
    const whole = createLiveTextRateSampler();
    const chunks = createLiveTextRateSampler();
    whole.observe('a 你好😀한。', 0);
    for (let i = 0; i < 'a 你好😀한。'.length; i += 1) chunks.observe('a 你好😀한。'[i], 0);
    expect(chunks.read(1000)).toBe(whole.read(1000));
    const letters = createLiveTextRateSampler();
    for (let i = 0; i < 4; i += 1) letters.observe('a', i * 100);
    expect(letters.read(1000)).toBe(1);
  });

  test('applies the documented CJK and UTF-16 estimate, including whitespace', () => {
    const sampler = createLiveTextRateSampler();
    sampler.observe('你好あ한Ａabcd😀  ', 0);
    // Five CJK/full-width units, four letters, one surrogate pair and two spaces.
    expect(sampler.read(1000)).toBe(7);
  });

  test('uses the last five completed seconds and decays to zero during a pause', () => {
    const sampler = createLiveTextRateSampler();
    for (let second = 0; second < 8; second += 1) sampler.observe('a'.repeat((second + 1) * 40), second * 1000);
    // The unfinished eighth bucket is excluded. Completed buckets 2..6 hold 30..70 tokens.
    expect(sampler.read(7500)).toBe(50);
    expect(sampler.read(8000)).toBe(60);
    expect(sampler.read(13000)).toBe(0);
  });

  test('counts large batches as observed arrivals without spreading them at an assumed model speed', () => {
    const sampler = createLiveTextRateSampler();
    sampler.observe('a'.repeat(4000), 0);
    expect(sampler.read(1000)).toBe(1000);
    expect(sampler.read(5000)).toBe(200);
    expect(sampler.read(6000)).toBe(0);
  });

  test('a long stream does not retain past buckets', () => {
    const sampler = createLiveTextRateSampler();
    for (let second = 0; second < 10000; second += 1) sampler.observe('abcd', second * 1000);
    expect(sampler.read(10000000)).toBe(1);
    expect(sampler.read(10006000)).toBe(0);
  });
});
