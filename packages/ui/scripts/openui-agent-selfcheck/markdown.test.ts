import { expect, test } from 'bun:test';
import { inspectFinal, validateCandidate } from './markdown';

const program = 'root = Stack([table])\ntable = Table(["Task"], [["Ready"]])';
const fragment = '```openui-lang\n' + program + '\n```';

test('validates the entire Markdown envelope and retains the exact fenced bytes', () => {
  const result = validateCandidate(fragment + '\n');
  expect(result.ok).toBe(true);
  expect(result.fragment).toBe(fragment);
  expect(result.fileSha256).not.toBe(result.fragmentSha256);
  for (const invalid of [program, '```\n' + program + '\n```', '```openui\n' + program + '\n```',
    '```openui-lang\n' + program, 'Prose.\n\n' + fragment, fragment + '\n\n' + fragment]) {
    expect(validateCandidate(invalid).ok).toBe(false);
  }
});

test('keeps the existing strict DSL checks', () => {
  for (const source of ['root = Stack([missing])', 'root = Stack([])\nunused = Text("lost")',
    'root = Stack([])\n$count = 1', 'root = Stack([x])\nx = Button(12)']) {
    expect(validateCandidate('```openui-lang\n' + source + '\n```').ok).toBe(false);
  }
});

test('rejects mismatched table widths without changing or truncating table data', () => {
  const candidate = '```openui-lang\nroot = Stack([table])\ntable = Table(["A", "B"], [["one", "two", "extra"]])\n```';
  const result = validateCandidate(candidate);
  expect(result.ok).toBe(false);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('Table 1 row 1 has 3 cells; expected 2 columns');
  expect(result.fragment).toBe(candidate.trimEnd());
  expect(inspectFinal(candidate).formatAndDslPass).toBe(false);
  const otherTable = '```openui-lang\nroot = Stack([good, bad])\ngood = Table(["A"], [["ok"]])\nbad = Table(["B", "C"], [["short"]])\n```';
  expect(validateCandidate(otherTable).errors[0]).toContain('Table 2 row 1 has 1 cells; expected 2 columns');
});

test('independently checks final output and reports successful validation followed by drift', () => {
  expect(inspectFinal('Before.\n\n' + fragment + '\n\nAfter.', fragment).matchesLastSuccessfulCandidate).toBe(true);
  const changed = fragment.replace('Ready', 'Different');
  expect(inspectFinal(changed, fragment).formatAndDslPass).toBe(true);
  expect(inspectFinal(changed, fragment).matchesLastSuccessfulCandidate).toBe(false);
  expect(inspectFinal(program, fragment).formatAndDslPass).toBe(false);
  expect(inspectFinal('```\n' + program + '\n```', fragment).formatAndDslPass).toBe(false);
  expect(inspectFinal('````markdown\n' + fragment + '\n````', fragment).formatAndDslPass).toBe(false);
  const extraXml = fragment + '\n\n<openui-lang>\nroot = Stack([])\n</openui-lang>';
  expect(inspectFinal(extraXml, fragment).formatAndDslPass).toBe(false);
  expect(inspectFinal(extraXml, fragment).matchesLastSuccessfulCandidate).toBe(false);
  const extraAlias = fragment + '\n\nroot = stack\nstack = Stack([])';
  expect(inspectFinal(extraAlias, fragment).formatAndDslPass).toBe(false);
  expect(inspectFinal(extraAlias, fragment).matchesLastSuccessfulCandidate).toBe(false);
  const extraAnonymousAlias = fragment + '\n\n```\nroot = stack\nstack = Stack([])\n```';
  expect(inspectFinal(extraAnonymousAlias, fragment).formatAndDslPass).toBe(false);
  expect(inspectFinal(extraAnonymousAlias, fragment).matchesLastSuccessfulCandidate).toBe(false);
});
