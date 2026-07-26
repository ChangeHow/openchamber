import { describe, expect, test } from 'bun:test';

import { findTextPosition } from './textPosition';

describe('findTextPosition', () => {
  test('maps a second-line match start to the visible line content', () => {
    const firstLine = { data: 'output:' };
    const hiddenLineBreak = { data: '\n' };
    const secondLine = { data: 'src/index.ts:12' };
    const nodes = [firstLine, hiddenLineBreak, secondLine];
    const startOffset = firstLine.data.length + hiddenLineBreak.data.length;

    expect(findTextPosition(nodes, startOffset, 'right')).toEqual({ node: secondLine, offset: 0 });
    expect(findTextPosition(nodes, startOffset + secondLine.data.length, 'left')).toEqual({
      node: secondLine,
      offset: secondLine.data.length,
    });
  });

  test('keeps an end boundary on the preceding text node', () => {
    const firstLine = { data: 'src/index.ts:12' };
    const hiddenLineBreak = { data: '\n' };

    expect(findTextPosition([firstLine, hiddenLineBreak], firstLine.data.length, 'left')).toEqual({
      node: firstLine,
      offset: firstLine.data.length,
    });
  });
});
