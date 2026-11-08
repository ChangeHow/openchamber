import React from 'react';

import { dispatchPageWaiting } from '@/components/chat/lib/scroll/timelineScrollIntent';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import type { ToolPart } from '@/lib/opencode/model';
import type { RequestedSecret } from '@/lib/opencode/tools';
import { answerSecretRequest } from '@/lib/secretRequestAnswer';
import { useSessionDirectory } from '@/sync/sync-context';

/** Private values stay in this card until one direct submission to the server. */
export function SecretRequestCard({ part, request }: { part: ToolPart; request: RequestedSecret }) {
    const { t } = useI18n();
    const directory = useSessionDirectory(part.sessionID);
    const [values, setValues] = React.useState(() => new Map<string, string>());
    const complete = request.inputs.every((input) => {
        const value = values.get(input.env);
        return !!value?.trim() && !value.includes('\0');
    });
    const [busy, setBusy] = React.useState(false);
    // Display only: turning it on never sends the value anywhere new.
    const [revealed, setRevealed] = React.useState(() => new Set<string>());
    // What this client sent, shown until the call completes with the status
    // OpenCode stores.
    const [sent, setSent] = React.useState<'submitted' | 'declined' | null>(null);

    const send = React.useCallback(async (answer: { values: Record<string, string> } | { declined: true }) => {
        setBusy(true);
        try {
            await answerSecretRequest({ sessionId: part.sessionID, callId: part.callID, ...answer }, directory);
            setValues(new Map());
            setRevealed(new Set());
            setSent('declined' in answer ? 'declined' : 'submitted');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            toast.error(t('chat.secretRequest.submitFailed'), { description: message });
        } finally {
            setBusy(false);
        }
    }, [directory, part.callID, part.sessionID, t]);

    // The chat brings a card that waits into view, like a page that waits.
    const waiting = sent === null;
    const blockRef = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        if (waiting) dispatchPageWaiting(blockRef.current);
    }, [waiting]);

    if (!waiting) {
        const line = sent === 'submitted'
            ? t('chat.secretRequest.submitted')
            : t('chat.secretRequest.declined', { label: request.inputs[0].label });
        return (
            <div className="my-2 flex items-center gap-1.5 typography-meta text-muted-foreground" data-secret-request-status={sent}>
                <Icon name="shield-check" className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate" title={line}>{line}</span>
            </div>
        );
    }

    return (
        <div ref={blockRef} className="oc-tile my-2 rounded-xl p-4" data-secret-request-status="waiting" data-waiting-page={part.id}>
            <div className="typography-ui-label font-semibold text-foreground">{t('chat.secretRequest.executionTitle')}</div>
            <form
                className="mt-3 flex flex-col gap-3"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (complete && !busy) void send({ values: Object.fromEntries(request.inputs.map(({ env }) => [env, values.get(env)!])) });
                }}
            >
                {request.inputs.map((input) => (
                    <div key={input.env} className="flex w-full flex-col gap-1 typography-ui-label">
                        <label htmlFor={`${part.id}-${input.env}`} dir="auto">{input.label}</label>
                        <div className="relative min-w-0">
                            <Input
                                id={`${part.id}-${input.env}`}
                                type={revealed.has(input.env) ? 'text' : 'password'}
                                value={values.get(input.env) ?? ''}
                                onChange={(event) => setValues((current) => new Map(current).set(input.env, event.target.value))}
                                // Keep password managers from offering to store or fill it.
                                autoComplete="off"
                                data-1p-ignore
                                data-lpignore="true"
                                data-bwignore
                                maxLength={16000}
                                disabled={busy}
                                className="w-full pe-9"
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="absolute inset-e-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                aria-label={t(revealed.has(input.env) ? 'chat.secretRequest.hideSecret' : 'chat.secretRequest.showSecret')}
                                aria-pressed={revealed.has(input.env)}
                                title={t(revealed.has(input.env) ? 'chat.secretRequest.hideSecret' : 'chat.secretRequest.showSecret')}
                                disabled={busy}
                                onClick={() => setRevealed((current) => {
                                    const next = new Set(current);
                                    if (next.has(input.env)) next.delete(input.env);
                                    else next.add(input.env);
                                    return next;
                                })}
                            >
                                <Icon name={revealed.has(input.env) ? 'eye-off' : 'eye'} className="size-4" />
                            </Button>
                        </div>
                    </div>
                ))}
                <Button type="submit" className="self-start" disabled={busy || !complete}>{t('chat.secretRequest.run')}</Button>
            </form>
            <div className="mt-2 flex items-center gap-1.5 typography-meta text-muted-foreground">
                <Icon name="shield-check" className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">{t('chat.secretRequest.executionPrivacy')}</span>
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void send({ declined: true })}>
                    {t('chat.secretRequest.decline')}
                </Button>
            </div>
        </div>
    );
}
