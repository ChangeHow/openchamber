import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Icon } from '@/components/icon/Icon';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { CodebaseAuthStatus } from '@openchamber-plugin/codebase';
import { useI18n } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';
import { subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';

type ConnectionError = 'loadFailed' | 'connectFailed' | 'disconnectFailed';

export function CodebaseSettings() {
  const { codebase } = useRuntimeAPIs();
  const { t } = useI18n();
  const [status, setStatus] = React.useState<CodebaseAuthStatus | null>(null);
  const [pat, setPat] = React.useState('');
  const [busy, setBusy] = React.useState(true);
  const [error, setError] = React.useState<ConnectionError | null>(null);
  const [retry, setRetry] = React.useState(0);
  const [open, setOpen] = React.useState(false);
  const requestId = React.useRef(0);
  const patId = React.useId();

  React.useEffect(() => {
    if (!codebase) return;
    const invalidate = () => {
      requestId.current += 1;
      setPat('');
      setStatus(null);
      setError(null);
      setBusy(true);
    };
    const load = async () => {
      const id = ++requestId.current;
      setBusy(true);
      setError(null);
      try {
        const result = await codebase.authStatus();
        if (id === requestId.current) setStatus(result);
      } catch {
        if (id === requestId.current) setError('loadFailed');
      } finally {
        if (id === requestId.current) setBusy(false);
      }
    };
    invalidate();
    void load();
    const unsubscribeWillChange = subscribeRuntimeEndpointWillChange(invalidate);
    const unsubscribeChanged = subscribeRuntimeEndpointChanged(() => { void load(); });
    return () => {
      requestId.current += 1;
      unsubscribeWillChange();
      unsubscribeChanged();
    };
  }, [codebase, retry]);

  const updateConnection = async (action: 'connect' | 'disconnect') => {
    if (!codebase || busy) return;
    const id = ++requestId.current;
    const token = pat.trim();
    setPat('');
    setBusy(true);
    setError(null);
    reportSettingsSaveState('saving');
    try {
      const result = action === 'connect'
        ? await codebase.authConnect(token)
        : await codebase.authDisconnect();
      if (id !== requestId.current) return;
      setStatus(result);
      reportSettingsSaveState('saved');
    } catch {
      if (id !== requestId.current) return;
      setError(action === 'connect' ? 'connectFailed' : 'disconnectFailed');
      reportSettingsSaveState('error');
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  };

  if (!codebase) return null;

  const connected = status?.connected === true;
  const user = status?.user;
  const statusLabel = busy
    ? t('common.loading')
    : connected
      ? user?.username ?? t('settings.integrations.codebase.title')
      : status ? t('settings.integrations.codebase.notConnected') : t('common.unavailable');

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        data-settings-item="integrations.codebase"
        className="overflow-hidden rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)]"
      >
        <CollapsibleTrigger
          className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-[var(--interactive-hover)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
        >
          <div className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--surface-muted)]">
            <Icon name="gitlab" className="size-5 text-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">
              {t('settings.integrations.codebase.title')}
            </div>
            <p className="mt-0.5 line-clamp-1 text-xs leading-snug text-muted-foreground">
              {t('settings.integrations.codebase.description')}
            </p>
          </div>
          <span
            aria-live="polite"
            className={cn(
              'max-w-36 shrink-0 truncate rounded-full px-2 py-0.5 text-[10px] font-medium',
              connected
                ? 'bg-[var(--status-success)]/15 text-[var(--status-success)]'
                : 'bg-[var(--surface-muted)] text-muted-foreground',
            )}
          >
            {statusLabel}
          </span>
          <Icon
            name="arrow-down-s"
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none',
              open && 'rotate-180',
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-[var(--interactive-border)] px-4 py-4">
          <div className="space-y-3">
            {error ? (
              <p className="typography-meta text-[var(--status-error)]" role="alert">
                {t(`settings.integrations.codebase.${error}`)}
              </p>
            ) : null}
            {error === 'loadFailed' ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setRetry((value) => value + 1)}>
                {t('codebase.actions.retry')}
              </Button>
            ) : null}
            {connected ? (
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  {user?.avatarUrl ? (
                    <img
                      src={user.avatarUrl}
                      alt=""
                      className="size-10 shrink-0 rounded-full border border-[var(--interactive-border)] bg-[var(--surface-muted)] object-cover"
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-muted)]">
                      <Icon name="gitlab" className="size-5 text-muted-foreground" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate typography-ui-label text-foreground">{user?.username}</div>
                    <p className="typography-meta text-muted-foreground">{t('settings.integrations.codebase.pat')}</p>
                  </div>
                </div>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void updateConnection('disconnect')}>
                  {t('settings.integrations.codebase.disconnect')}
                </Button>
              </div>
            ) : (
              <form onSubmit={(event) => { event.preventDefault(); void updateConnection('connect'); }} className="space-y-3">
                <p className="typography-meta text-muted-foreground">{t('settings.integrations.codebase.restriction')}</p>
                <SettingsStackedField
                  label={<label htmlFor={patId}>{t('settings.integrations.codebase.pat')}</label>}
                  info={t('settings.integrations.codebase.tokenInfo')}
                >
                  <Input
                    id={patId}
                    type="password"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={pat}
                    onChange={(event) => setPat(event.target.value)}
                    placeholder="code_pat_..."
                    className="h-9"
                    disabled={busy}
                    required
                  />
                </SettingsStackedField>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" size="sm" disabled={busy || !pat.trim()}>
                    {t('settings.integrations.codebase.connect')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void openExternalUrl('https://code.byted.org/profile/personal_access_tokens')}>
                    {t('settings.integrations.codebase.createToken')}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
