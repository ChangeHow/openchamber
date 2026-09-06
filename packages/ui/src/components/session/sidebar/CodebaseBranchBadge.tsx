import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { codebaseBranchKey, CodebaseStatusContext } from './codebase-status-context';

export function CodebaseBranchBadge({ directory, branch }: { directory: string; branch: string }) {
  const { t } = useI18n();
  const { entries, refresh } = React.useContext(CodebaseStatusContext);
  const status = entries.get(codebaseBranchKey(directory, branch));
  const mr = status?.mergeRequest;
  return <>
    {mr ? <a href={mr.url} target="_blank" rel="noopener noreferrer" title={mr.title}
      className="mx-2 shrink-0 typography-micro font-medium" style={{ color: `var(--pr-${mr.draft ? 'draft' : 'open'})` }}
      onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>!{mr.number}</a> : null}
    {status?.failed ? <Button variant="ghost" size="xs" title={t('codebase.error.lookup')} aria-label={t('codebase.error.lookup')}
      onClick={(event) => { event.stopPropagation(); refresh(); }} onKeyDown={(event) => event.stopPropagation()}>
      <Icon name="error-warning" className="size-3 text-status-warning" />
    </Button> : null}
  </>;
}
