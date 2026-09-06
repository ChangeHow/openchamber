import { createContext } from 'react';
import type { CodebaseMergeRequest } from '@openchamber-plugin/codebase';

export interface CodebaseBranchTarget {
  project: string;
  directory: string;
  branch: string;
}

export interface CodebaseBranchStatus {
  mergeRequest: CodebaseMergeRequest | null;
  failed: boolean;
}

export const codebaseBranchKey = (directory: string, branch: string): string => JSON.stringify([directory, branch]);

export const CodebaseStatusContext = createContext({
  entries: new Map<string, CodebaseBranchStatus>(),
  refresh: () => {},
});
