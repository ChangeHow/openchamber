import { z } from 'zod';

import { runtimeFetch } from './runtime-fetch';

const errorSchema = z.object({ error: z.string().min(1) }).catch({ error: '' });

/**
 * Sends private inputs directly to the waiting secret card's server. File mode
 * returns a private file path; execution mode consumes all values in memory.
 * A stale answer is refused with the server's message. `directory` is the
 * session's: an isolated space's call waits on that space's server, where
 * the agent's program also runs.
 */
export async function answerSecretRequest(
    input: { sessionId: string; callId: string } & ({ value: string } | { values: Record<string, string> } | { declined: true }),
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
    throw new Error(payload.error || `The secret was not saved (${response.status})`);
}
