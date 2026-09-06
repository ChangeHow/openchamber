import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import type { WorktreeAvailability } from '@/lib/worktrees/worktreeAvailability';
import { WorktreeAvailabilityLabel } from './WorktreeAvailabilityLabel';

const renderLabel = (availability: WorktreeAvailability) => renderToStaticMarkup(
  <I18nProvider><WorktreeAvailabilityLabel availability={availability} /></I18nProvider>,
);

describe('shared worktree availability label', () => {
  test('shows an existing path and distinguishes loading, failure, and unavailable source', () => {
    const existing = renderLabel({ status: 'exists', path: '/repo/existing' });
    expect(existing).toContain('Worktree exists');
    expect(existing).toContain('/repo/existing');
    expect(renderLabel({ status: 'checking' })).toContain('Checking worktrees');
    expect(renderLabel({ status: 'error' })).toContain('Could not check existing worktrees');
    expect(renderLabel({ status: 'unavailable' })).toContain('Source branch or repository is unavailable');
    expect(renderLabel({ status: 'available' })).toBe('');
  });
});
