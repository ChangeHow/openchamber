import React from 'react';

import { dispatchPageWaiting } from '@/components/chat/lib/scroll/timelineScrollIntent';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import type { ToolPart } from '@/lib/opencode/model';
import type { RequestedSecret, SecretRequestState } from '@/lib/opencode/tools';
import { answerSecretRequest } from '@/lib/secretRequestAnswer';
import { useSessionDirectory } from '@/sync/sync-context';

/** Private values stay in this card until one direct submission to the server. */
export function SecretRequestCard({ part, request }: { part: ToolPart; request: RequestedSecret }) {
    const { t } = useI18n();
    const directory = useSessionDirectory(part.sessionID);
    const [value, setValue] = React.useState('');
    const [values, setValues] = React.useState(() => new Map<string, string>());
    const execution = request.inputs !== undefined;
    const complete = request.inputs ? request.inputs.every((input) => {
        const value = values.get(input.env);
        return !!value && !value.includes('\0');
    }) : !!value.trim();
    const [busy, setBusy] = React.useState(false);
    // Display only: turning it on never sends the value anywhere new.
    const [revealed, setRevealed] = React.useState(false);
    // What this client sent, shown until the call completes with the status
    // OpenCode stores.
    const inputKey = request.inputs?.map((input) => input.env).join('\0');
    const [sent, setSent] = React.useState<{ state: SecretRequestState; inputKey: string | undefined } | null>(null);
    const state = request.state === 'waiting' && sent && sent.inputKey === inputKey ? sent.state : request.state;

    const send = React.useCallback(async (answer: { value: string } | { values: Record<string, string> } | { declined: true }, outcome: SecretRequestState) => {
        setBusy(true);
        try {
            await answerSecretRequest({ sessionId: part.sessionID, callId: part.callID, ...answer }, directory);
            setValue('');
            setValues(new Map());
            setSent({ state: outcome, inputKey });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            toast.error(t(execution ? 'chat.secretRequest.submitFailed' : 'chat.secretRequest.saveFailed'), { description: message });
        } finally {
            setBusy(false);
        }
    }, [directory, execution, inputKey, part.callID, part.sessionID, t]);

    // The chat brings a card that waits into view, like a page that waits.
    const waiting = state === 'waiting';
    const blockRef = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        if (waiting) dispatchPageWaiting(blockRef.current);
        else { setValue(''); setValues(new Map()); }
    }, [waiting]);

    if (!waiting) {
        const line = state === 'submitted'
            ? t('chat.secretRequest.submitted')
            : state === 'saved'
            ? t('chat.secretRequest.saved', { label: request.label })
            : state === 'declined'
                ? t('chat.secretRequest.declined', { label: request.label })
                : t('chat.secretRequest.notGiven', { label: request.label });
        return (
            <div className="my-2 flex items-center gap-1.5 typography-meta text-muted-foreground" data-secret-request-status={state}>
                <Icon name={state === 'saved' ? 'shield-check' : 'shield'} className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate" title={line}>{line}</span>
            </div>
        );
    }

    return (
        <div ref={blockRef} className="oc-tile my-2 rounded-xl p-4" data-secret-request-status="waiting" data-waiting-page={part.id}>
            <div className="typography-ui-label font-semibold text-foreground">{execution ? t('chat.secretRequest.executionTitle') : request.label}</div>
            {request.reason && <p className="mt-1 whitespace-pre-wrap break-words typography-markdown text-muted-foreground">{request.reason}</p>}
            <form
                className={execution ? "mt-3 flex flex-col gap-3" : "mt-3 flex items-center gap-2"}
                onSubmit={(event) => {
                    event.preventDefault();
                    if (complete && !busy) void send(request.inputs ? { values: Object.fromEntries([...values].filter(([env]) => request.inputs?.some((input) => input.env === env))) } : { value }, execution ? 'submitted' : 'saved');
                }}
            >
                {request.inputs ? request.inputs.map((input) => (
                    <label key={input.env} className="flex w-full flex-col gap-1 typography-ui-label">
                        <span dir="auto">{input.label}</span>
                        <Input
                            type="password"
                            value={values.get(input.env) ?? ''}
                            onChange={(event) => setValues((current) => new Map(current).set(input.env, event.target.value))}
                            autoComplete="off"
                            data-1p-ignore
                            data-lpignore="true"
                            data-bwignore
                            maxLength={16000}
                            disabled={busy}
                        />
                    </label>
                )) : <div className="relative min-w-0 flex-1">
                    <Input
                        type={revealed ? 'text' : 'password'}
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                        placeholder={request.placeholder ?? t('chat.secretRequest.placeholder')}
                        aria-label={t('chat.secretRequest.inputLabel')}
                        // Keep password managers from offering to store or fill it.
                        autoComplete="off"
                        data-1p-ignore
                        data-lpignore="true"
                        data-bwignore
                        disabled={busy}
                        className="w-full pe-9"
                    />
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute inset-e-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        aria-label={t(revealed ? 'chat.secretRequest.hideSecret' : 'chat.secretRequest.showSecret')}
                        aria-pressed={revealed}
                        title={t(revealed ? 'chat.secretRequest.hideSecret' : 'chat.secretRequest.showSecret')}
                        disabled={busy}
                        onClick={() => setRevealed((current) => !current)}
                    >
                        <Icon name={revealed ? 'eye-off' : 'eye'} className="size-4" />
                    </Button>
                </div>}
                <Button type="submit" className={execution ? 'self-start' : undefined} disabled={busy || !complete}>{t(execution ? 'chat.secretRequest.run' : 'chat.secretRequest.save')}</Button>
            </form>
            <div className="mt-2 flex items-center gap-1.5 typography-meta text-muted-foreground">
                <Icon name="shield-check" className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">{t(execution ? 'chat.secretRequest.executionPrivacy' : 'chat.secretRequest.privacy')}</span>
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void send({ declined: true }, 'declined')}>
                    {t('chat.secretRequest.decline')}
                </Button>
            </div>
        </div>
    );
}
