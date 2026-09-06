import { codebaseIntegration } from '@openchamber-plugin/codebase';

export const getWorktreeMergeRequestProvider = (remoteUrl: string | null): 'github' | 'codebase' | null => {
  if (!remoteUrl) return null;
  if (codebaseIntegration.parseRemoteUrl(remoteUrl)) return 'codebase';
  const value = remoteUrl.trim();
  if (/^(?:[^@\s]+@)?github\.com:[^\s?#]+\/[^\s?#]+$/i.test(value)) return 'github';
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'ssh:') || url.port || url.search || url.hash) return null;
    return url.hostname === 'github.com' && url.pathname.split('/').filter(Boolean).length >= 2 ? 'github' : null;
  } catch {
    return null;
  }
};
