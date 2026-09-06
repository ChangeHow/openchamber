import { z } from 'zod';

export const codebaseUserSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  avatarUrl: z.string().min(1).optional(),
});

export const codebaseAuthStatusSchema = z.object({
  connected: z.boolean(),
  user: codebaseUserSchema.optional(),
}).superRefine((value, context) => {
  if (value.connected && !value.user) {
    context.addIssue({ code: 'custom', message: 'Connected status requires a user' });
  }
});

export const codebaseRepositorySchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  url: z.string().min(1),
  cloneUrl: z.string().min(1),
  sshUrl: z.string().min(1),
  issuesEnabled: z.boolean().optional(),
});

export const codebaseMergeRequestSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().min(1),
  url: z.string().min(1),
  description: z.string().min(1).optional(),
  sourceBranch: z.string(),
  targetBranch: z.string().min(1),
  sourceRepo: codebaseRepositorySchema.nullable(),
  author: z.object({
    username: z.string().min(1),
    avatarUrl: z.string().min(1).optional(),
  }).optional(),
  draft: z.boolean(),
  updatedAt: z.string().min(1),
});

export const codebaseMergeRequestsListResultSchema = z.object({
  repo: codebaseRepositorySchema,
  mergeRequests: z.array(codebaseMergeRequestSchema),
  page: z.number().int().positive(),
  hasMore: z.boolean(),
});

export const codebaseIssueStatusSchema = z.enum(['backlog', 'todo', 'in_progress', 'done', 'canceled']);

const codebaseIssueSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().min(1),
  url: z.string().min(1),
  description: z.string(),
  status: codebaseIssueStatusSchema,
  author: codebaseUserSchema.omit({ id: true }).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const codebaseIssuesListResultSchema = z.object({
  repo: codebaseRepositorySchema,
  issues: z.array(codebaseIssueSchema),
  page: z.number().int().positive(),
  hasMore: z.boolean(),
});

export const codebaseIssueGetResultSchema = z.object({
  repo: codebaseRepositorySchema,
  issue: codebaseIssueSchema,
});

export type CodebaseAuthStatus = z.infer<typeof codebaseAuthStatusSchema>;
export type CodebaseUser = z.infer<typeof codebaseUserSchema>;
export type CodebaseRepository = z.infer<typeof codebaseRepositorySchema>;
export type CodebaseMergeRequest = z.infer<typeof codebaseMergeRequestSchema>;
export type CodebaseMergeRequestsListResult = z.infer<typeof codebaseMergeRequestsListResultSchema>;
export type CodebaseIssueStatus = z.infer<typeof codebaseIssueStatusSchema>;
export type CodebaseIssue = z.infer<typeof codebaseIssueSchema>;
export type CodebaseIssuesListResult = z.infer<typeof codebaseIssuesListResultSchema>;
export type CodebaseIssueGetResult = z.infer<typeof codebaseIssueGetResultSchema>;

export interface CodebaseAPI {
  authStatus(): Promise<CodebaseAuthStatus>;
  authConnect(pat: string): Promise<CodebaseAuthStatus>;
  authDisconnect(): Promise<CodebaseAuthStatus>;
  mergeRequestsList(
    directory: string,
    options?: { page?: number; query?: string },
  ): Promise<CodebaseMergeRequestsListResult>;
  issuesList(
    directory: string,
    options?: { page?: number; query?: string; status?: CodebaseIssueStatus },
  ): Promise<CodebaseIssuesListResult>;
  issueGet(directory: string, number: number): Promise<CodebaseIssueGetResult>;
}
