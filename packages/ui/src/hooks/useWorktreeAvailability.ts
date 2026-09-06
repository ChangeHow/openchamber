import React from 'react';
import { useRuntimeAPIs } from './useRuntimeAPIs';
import { createWorktreeAvailabilityStore, getWorktreeAvailability, type WorktreeProviderAdapter } from '@/lib/worktrees/worktreeAvailability';
import { subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

export function useWorktreeAvailability<T>(enabled: boolean, directory: string | null, adapter: WorktreeProviderAdapter<T>) {
  const { git } = useRuntimeAPIs();
  const store = React.useMemo(() => createWorktreeAvailabilityStore((path) => git.listGitWorktrees(path)), [git]);
  const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [epoch, setEpoch] = React.useState(0);
  const refresh = React.useCallback(() => {
    if (enabled && directory) void store.refresh(directory);
  }, [directory, enabled, store]);

  React.useEffect(() => {
    refresh();
    return () => store.reset();
  }, [refresh, store, epoch]);
  React.useEffect(() => subscribeRuntimeEndpointWillChange(() => store.reset()), [store]);
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => setEpoch((value) => value + 1)), []);

  return {
    getAvailability: (item: T) => getWorktreeAvailability(store.getSnapshot(), directory, adapter.getLocalBranch(item)),
    failed: snapshot.directory === directory && snapshot.status === 'error',
    refresh,
  };
}
