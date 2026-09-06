import type { GitWorktreeInfo } from '@/lib/api/types';

/** Providers adapt their source data to the local branch the host will check out. */
export interface WorktreeProviderAdapter<T> {
  getLocalBranch(item: T): string | null;
}

type WorktreeSnapshot =
  | { directory: string | null; status: 'checking' }
  | { directory: string; status: 'error' }
  | { directory: string; status: 'ready'; pathsByBranch: ReadonlyMap<string, string> };

export type WorktreeAvailability =
  | { status: 'checking' | 'available' | 'error' | 'unavailable' }
  | { status: 'exists'; path: string };

export function getWorktreeAvailability(snapshot: WorktreeSnapshot, directory: string | null, branch: string | null): WorktreeAvailability {
  if (!branch) return { status: 'unavailable' };
  if (snapshot.directory !== directory || snapshot.status === 'checking') return { status: 'checking' };
  if (snapshot.status === 'error') return { status: 'error' };
  const path = snapshot.pathsByBranch.get(branch.replace(/^refs\/heads\//, ''));
  return path ? { status: 'exists', path } : { status: 'available' };
}

export function createWorktreeAvailabilityStore(list: (directory: string) => Promise<GitWorktreeInfo[]>) {
  let snapshot: WorktreeSnapshot = { directory: null, status: 'checking' };
  let generation = 0;
  const listeners = new Set<() => void>();
  const publish = (next: WorktreeSnapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reset() {
      generation += 1;
      publish({ directory: null, status: 'checking' });
    },
    async refresh(directory: string) {
      const request = ++generation;
      publish({ directory, status: 'checking' });
      try {
        const worktrees = await list(directory);
        if (request !== generation) return;
        const pathsByBranch = new Map<string, string>();
        for (const worktree of worktrees) {
          if (worktree.branch) pathsByBranch.set(worktree.branch.replace(/^refs\/heads\//, ''), worktree.path);
        }
        publish({ directory, status: 'ready', pathsByBranch });
      } catch {
        if (request === generation) publish({ directory, status: 'error' });
      }
    },
  };
}
