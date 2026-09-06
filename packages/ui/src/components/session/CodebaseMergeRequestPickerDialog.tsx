import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Icon } from '@/components/icon/Icon';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useI18n } from '@/lib/i18n';
import type { CodebaseIssue, CodebaseMergeRequest } from '@openchamber-plugin/codebase';
import { codebaseWorktreeAdapter } from '@/lib/integrations/codebase';
import { useWorktreeAvailability } from '@/hooks/useWorktreeAvailability';
import { WorktreeAvailabilityLabel } from './WorktreeAvailabilityLabel';
import { subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

export function CodebaseMergeRequestPickerDialog({
  open,
  onOpenChange,
  onSelect,
  onSelectIssue,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (mergeRequest: CodebaseMergeRequest) => void;
  onSelectIssue: (issue: CodebaseIssue) => void;
}) {
  const { t } = useI18n();
  const { codebase } = useRuntimeAPIs();
  const isMobile = useUIStore((state) => state.isMobile);
  const activeProject = useProjectsStore((state) => state.getActiveProject());
  const directory = activeProject?.path ?? null;
  const [query, setQuery] = React.useState('');
  const debouncedQuery = useDebouncedValue(query, 350);
  const [mergeRequests, setMergeRequests] = React.useState<CodebaseMergeRequest[]>([]);
  const [tab, setTab] = React.useState<'issues' | 'mrs'>('issues');
  const worktreeAvailability = useWorktreeAvailability(open && tab === 'mrs', directory, codebaseWorktreeAdapter);
  const [issues, setIssues] = React.useState<CodebaseIssue[]>([]);
  const [selectedIssue, setSelectedIssue] = React.useState<CodebaseIssue | null>(null);
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);
  const [isConnected, setIsConnected] = React.useState<boolean | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [resultScopeKey, setResultScopeKey] = React.useState<string | null>(null);
  const [runtimeEpoch, setRuntimeEpoch] = React.useState(0);
  const requestIdRef = React.useRef(0);
  const scopeKey = `${directory ?? ''}\u0000${tab}\u0000${query}\u0000${runtimeEpoch}`;
  const scopeKeyRef = React.useRef(scopeKey);
  scopeKeyRef.current = scopeKey;

  const invalidate = React.useCallback(() => {
    requestIdRef.current += 1;
    setMergeRequests([]);
    setIssues([]);
    setSelectedIssue(null);
    setPage(1);
    setHasMore(false);
    setIsConnected(null);
    setError(null);
    setIsLoading(false);
    setIsLoadingMore(false);
    setResultScopeKey(null);
  }, []);

  const load = React.useCallback(async (nextPage: number, append: boolean) => {
    if (!directory || !codebase) return;
    const requestId = ++requestIdRef.current;
    const requestScopeKey = scopeKeyRef.current;
    const requestQuery = query.trim();
    if (append) setIsLoadingMore(true);
    else setIsLoading(true);
    setError(null);

    try {
      const auth = await codebase.authStatus();
      if (requestId !== requestIdRef.current || requestScopeKey !== scopeKeyRef.current) return;
      if (!auth.connected) {
        setIsConnected(false);
        setMergeRequests([]);
        setIssues([]);
        setHasMore(false);
        return;
      }
      setIsConnected(true);
      const options = requestQuery
        ? { page: nextPage, query: requestQuery }
        : { page: nextPage };
      const result = tab === 'issues'
        ? await codebase.issuesList(directory, options)
        : await codebase.mergeRequestsList(directory, options);
      if (requestId !== requestIdRef.current || requestScopeKey !== scopeKeyRef.current) return;
      if ('issues' in result) setIssues((current) => append ? [...current, ...result.issues] : result.issues);
      else setMergeRequests((current) => append ? [...current, ...result.mergeRequests] : result.mergeRequests);
      setResultScopeKey(requestScopeKey);
      setPage(result.page);
      setHasMore(result.hasMore);
    } catch (error) {
      if (requestId !== requestIdRef.current || requestScopeKey !== scopeKeyRef.current) return;
      setError(error instanceof Error && error.message === 'Issues are not enabled for this repository'
        ? t('codebase.issuesDisabled')
        : t(tab === 'issues' ? 'codebase.error.loadIssues' : 'codebase.error.loadMergeRequests'));
    } finally {
      if (requestId === requestIdRef.current && requestScopeKey === scopeKeyRef.current) {
        if (append) setIsLoadingMore(false);
        else setIsLoading(false);
      }
    }
  }, [codebase, directory, query, tab, t]);

  const selectIssue = async (number: number) => {
    if (!directory || !codebase) return;
    const requestId = ++requestIdRef.current;
    const requestScopeKey = scopeKeyRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await codebase.issueGet(directory, number);
      if (requestId !== requestIdRef.current || requestScopeKey !== scopeKeyRef.current) return;
      setSelectedIssue(result.issue);
    } catch {
      if (requestId !== requestIdRef.current || requestScopeKey !== scopeKeyRef.current) return;
      setError(t('codebase.error.loadIssues'));
    } finally {
      if (requestId === requestIdRef.current && requestScopeKey === scopeKeyRef.current) setIsLoading(false);
    }
  };

  React.useEffect(() => {
    if (!open) {
      invalidate();
      setQuery('');
      return;
    }
    if (!directory || !codebase || query !== debouncedQuery) return;
    invalidate();
    void load(1, false);
    return invalidate;
  }, [codebase, debouncedQuery, directory, invalidate, load, open, query, runtimeEpoch]);

  React.useEffect(() => {
    if (!open) return;
    return subscribeRuntimeEndpointWillChange(invalidate);
  }, [invalidate, open]);

  React.useEffect(() => {
    if (!open) return;
    return subscribeRuntimeEndpointChanged(() => setRuntimeEpoch((epoch) => epoch + 1));
  }, [open]);

  const visibleMergeRequests = resultScopeKey === scopeKey ? mergeRequests : [];
  const visibleIssues = resultScopeKey === scopeKey ? issues : [];
  const visibleHasMore = resultScopeKey === scopeKey && hasMore;

  const content = (
    <>
      <div className="flex gap-2">
        <Button variant="chip" size="sm" aria-pressed={tab === 'issues'} onClick={() => { if (tab !== 'issues') { invalidate(); setQuery(''); setTab('issues'); } }}>{t('codebase.issues')}</Button>
        <Button variant="chip" size="sm" aria-pressed={tab === 'mrs'} onClick={() => { if (tab !== 'mrs') { invalidate(); setQuery(''); setTab('mrs'); } }}>{t('codebase.mergeRequests')}</Button>
      </div>
      {selectedIssue && resultScopeKey === scopeKey ? (
        <div className="min-h-0 space-y-3 overflow-y-auto">
          <Button variant="ghost" size="sm" onClick={() => setSelectedIssue(null)}>{t('codebase.actions.back')}</Button>
          <h3 className="break-words font-medium">#{selectedIssue.number} {selectedIssue.title}</h3>
          <pre className="whitespace-pre-wrap break-words font-sans typography-small">{selectedIssue.description}</pre>
          <Button onClick={() => onSelectIssue(selectedIssue)}>{t('codebase.actions.useIssue')}</Button>
        </div>
      ) : <>
      <div className="relative mt-2">
        <Icon name="search" className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={t(tab === 'issues' ? 'codebase.searchIssues' : 'codebase.searchPlaceholder')}
          aria-label={t(tab === 'issues' ? 'codebase.searchIssues' : 'codebase.searchAria')}
          value={query}
          onChange={(event) => {
            invalidate();
            setQuery(event.target.value);
          }}
          className="w-full pl-9"
        />
      </div>
      <div className={isMobile ? 'min-h-0' : 'flex-1 overflow-y-auto'}>
        {!directory ? <div className="py-8 text-center text-muted-foreground">{t('codebase.empty.noActiveProject')}</div> : null}
        {!codebase ? <div className="py-8 text-center text-muted-foreground">{t('codebase.empty.runtimeUnavailable')}</div> : null}
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
            <Icon name="loader-4" className="size-4 animate-spin" />
            {t(tab === 'issues' ? 'codebase.loading.issues' : 'codebase.loading.mergeRequests')}
          </div>
        ) : null}
        {isConnected === false ? <div className="py-8 text-center text-muted-foreground">{t('codebase.empty.notConnected')}</div> : null}
        {error ? (
          <div className="space-y-3 py-8 text-center text-muted-foreground">
            <div className="break-words">{error}</div>
            <Button variant="outline" size="sm" onClick={() => void load(1, false)}>{t('codebase.actions.retry')}</Button>
          </div>
        ) : null}
        {!isLoading && !error && isConnected && (tab === 'issues' ? visibleIssues : visibleMergeRequests).length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">
            {tab === 'issues' ? t('codebase.empty.noIssues') : debouncedQuery.trim() ? t('codebase.empty.noMergeRequestsFound') : t('codebase.empty.noOpenMergeRequestsFound')}
          </div>
        ) : null}
        {tab === 'issues' ? visibleIssues.map((issue) => (
          <Button key={issue.id} variant="ghost" size="sm" className="h-auto w-full justify-start py-2 text-left" disabled={isLoading} onClick={() => void selectIssue(issue.number)}>
            <span className="min-w-0 truncate"><span className="mr-1 text-muted-foreground">#{issue.number}</span>{issue.title}</span>
          </Button>
        )) : null}
        {tab === 'mrs' && worktreeAvailability.failed ? (
          <Button variant="outline" size="sm" onClick={worktreeAvailability.refresh}>{t('session.worktreeAvailability.retry')}</Button>
        ) : null}
        {visibleMergeRequests.map((mergeRequest) => {
          const availability = worktreeAvailability.getAvailability(mergeRequest);
          const usable = availability.status === 'available';
          return (
            <div key={mergeRequest.id} className="py-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-auto w-full justify-start px-2 py-1.5 text-left"
                disabled={!usable}
                onClick={() => {
                  if (worktreeAvailability.getAvailability(mergeRequest).status === 'available') onSelect(mergeRequest);
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="typography-small block truncate text-foreground">
                    <span className="mr-1 text-muted-foreground">!{mergeRequest.number}</span>
                    {mergeRequest.title}
                  </span>
                  <span className="typography-meta block truncate text-muted-foreground">
                    {mergeRequest.sourceBranch} → {mergeRequest.targetBranch}
                  </span>
                </span>
              </Button>
              <div className="px-2"><WorktreeAvailabilityLabel availability={availability} /></div>
            </div>
          );
        })}
        {visibleHasMore && isConnected ? (
          <div className="flex justify-center py-2">
            <Button variant="ghost" size="sm" disabled={isLoadingMore} onClick={() => void load(page + 1, true)}>
              {isLoadingMore ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
              {isLoadingMore ? t('codebase.loading.more') : t('codebase.actions.loadMore')}
            </Button>
          </div>
        ) : null}
      </div>
      </>}
    </>
  );

  const title = t('codebase.actions.startFromIssueMr');
  const description = t(tab === 'issues' ? 'codebase.searchIssues' : 'codebase.description');
  if (isMobile) {
    return <MobileOverlayPanel open={open} title={title} onClose={() => onOpenChange(false)}>{content}</MobileOverlayPanel>;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[70vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Icon name="gitlab" className="size-5" />{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}
