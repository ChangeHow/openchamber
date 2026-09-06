import React from 'react';
import { codebaseIntegration, type CodebaseMergeRequest } from '@openchamber-plugin/codebase';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { loadCodebaseBranchLinks } from '@/lib/integrations/codebase-status';
import { subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { codebaseBranchKey, CodebaseStatusContext, type CodebaseBranchStatus, type CodebaseBranchTarget } from './codebase-status-context';

export function CodebaseStatusProvider({ targets, children }: { targets: CodebaseBranchTarget[]; children: React.ReactNode }) {
  const { codebase, git } = useRuntimeAPIs();
  const [entries, setEntries] = React.useState(new Map<string, CodebaseBranchStatus>());
  const [epoch, setEpoch] = React.useState(0);
  const generation = React.useRef(0);
  const abortRef = React.useRef<AbortController | null>(null);
  const refresh = React.useCallback(() => setEpoch((value) => value + 1), []);
  const signature = JSON.stringify(targets);
  const targetsRef = React.useRef(targets);
  targetsRef.current = targets;

  React.useEffect(() => subscribeRuntimeEndpointWillChange(() => {
    generation.current += 1;
    abortRef.current?.abort();
    setEntries(new Map());
  }), []);
  React.useEffect(() => subscribeRuntimeEndpointChanged(refresh), [refresh]);

  React.useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    abortRef.current = controller;
    const getRemoteUrl = git?.getRemoteUrl;
    const projects = new Map<string, CodebaseBranchTarget[]>();
    for (const target of targetsRef.current) {
      const group = projects.get(target.project) ?? [];
      group.push(target);
      projects.set(target.project, group);
    }
    const activeKeys = new Set(targetsRef.current.map((target) => codebaseBranchKey(target.directory, target.branch)));
    setEntries((previous) => new Map([...previous].filter(([key]) => activeKeys.has(key))));
    if (!codebase || !getRemoteUrl || !projects.size) {
      setEntries(new Map());
      return () => controller.abort();
    }
    let pending = false;
    const load = async () => {
      if (!codebase || !getRemoteUrl || !projects.size || pending || document.hidden) return;
      pending = true;
      try {
        const auth = await runBackgroundNetworkTask(() => { controller.signal.throwIfAborted(); return codebase.authStatus(); });
        if (current !== generation.current) return;
        if (!auth.connected) { setEntries(new Map()); return; }
        for (const [project, group] of projects) {
          if (current !== generation.current) return;
          try {
            const remote = await runBackgroundNetworkTask(() => { controller.signal.throwIfAborted(); return getRemoteUrl(project); });
            if (current !== generation.current) return;
            const links = remote && codebaseIntegration.parseRemoteUrl(remote)
              ? await runBackgroundNetworkTask(() => loadCodebaseBranchLinks(codebase, project, controller.signal))
              : new Map<string, CodebaseMergeRequest>();
            if (current !== generation.current) return;
            setEntries((previous) => {
              const next = new Map(previous);
              for (const target of group) next.set(codebaseBranchKey(target.directory, target.branch), { mergeRequest: links.get(target.branch) ?? null, failed: false });
              return next;
            });
          } catch {
            if (current !== generation.current) return;
            setEntries((previous) => {
              const next = new Map(previous);
              for (const target of group) {
                const key = codebaseBranchKey(target.directory, target.branch);
                next.set(key, { mergeRequest: previous.get(key)?.mergeRequest ?? null, failed: true });
              }
              return next;
            });
          }
        }
      } catch {
        if (current !== generation.current) return;
        setEntries((previous) => new Map([...previous].map(([key, entry]) => [key, { ...entry, failed: true }])));
      } finally { pending = false; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    const resume = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', resume);
    return () => {
      generation.current += 1;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [codebase, git, signature, epoch]);

  return <CodebaseStatusContext.Provider value={{ entries, refresh }}>{children}</CodebaseStatusContext.Provider>;
}
