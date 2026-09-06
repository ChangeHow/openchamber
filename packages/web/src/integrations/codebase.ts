import { codebaseIntegration } from '@openchamber-plugin/codebase';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';

export function createCodebaseRuntimeAPI(transport = runtimeFetch) {
  return codebaseIntegration.createClient({ fetch: transport, basePath: '/api/codebase' });
}
