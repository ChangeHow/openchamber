import { z } from 'zod';

import { runtimeFetch } from './runtime-fetch';

const errorSchema = z.object({ error: z.string().min(1) }).catch({ error: '' });

/**
 * Sends private inputs directly to the waiting execution on the server.
 * All values are consumed in memory; no credential file or path is created.
 * A stale answer is refused with the server's message. `directory` is the
 * session's: an isolated space's call waits on that space's server, where
 * the agent's program also runs.
 */
export async function answerSecretRequest(
    input: { sessionId: string; callId: string } & ({ values: Record<string, string> } | { declined: true }),
    directory: string | undefined,
): Promise<void> {
    const response = await runtimeFetch('/api/openchamber/secret/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        directory,
    });
    if (response.ok) return;
    const payload = errorSchema.parse(await response.json().catch(() => null));
    throw new Error(payload.error || `Private inputs were not submitted (${response.status})`);
}
