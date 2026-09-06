import { z } from 'zod';
import {
  codebaseIssueStatusSchema,
  codebaseRepositorySchema,
  type CodebaseIssue,
  type CodebaseMergeRequest,
  type CodebaseRepository,
  type CodebaseUser,
} from '../contract.js';
import type { CodebaseUpstream } from '../server.js';

const apiUrl = 'https://codebase-api.byted.org/v2/';

const repositoryResponseSchema = z.object({
  Id: z.string().trim().min(1),
  Path: z.string().trim().min(1),
  URL: z.string().trim().min(1),
  CloneURL: z.string().trim().min(1),
  SSHURL: z.string().trim().min(1),
  IssueEnabled: z.boolean().optional(),
});

const authorResponseSchema = z.object({
  Username: z.string().trim().min(1),
  AvatarURL: z.string().trim().min(1).optional(),
});

const mergeRequestResponseSchema = z.object({
  Id: z.string().trim().min(1),
  Number: z.number().int().positive(),
  Title: z.string().trim().min(1),
  URL: z.string().trim().min(1),
  Description: z.string().optional(),
  SourceBranchName: z.string().optional(),
  TargetBranchName: z.string().trim().min(1),
  SourceRepoId: z.string().optional(),
  // The API may omit or corrupt this optional expansion. Treat it as unavailable.
  SourceRepository: repositoryResponseSchema.nullable().catch(null).optional(),
  CreatedBy: authorResponseSchema.optional(),
  Draft: z.boolean().optional(),
  UpdatedAt: z.string().trim().min(1),
});

const envelopeSchema = z.object({
  ResponseMetadata: z.object({
    Error: z.object({}).passthrough().optional(),
  }),
  Result: z.unknown(),
});

const userResultSchema = z.object({
  User: z.object({
    Id: z.string().trim().min(1),
    Username: z.string().trim().min(1),
    AvatarURL: z.string().trim().min(1).optional(),
  }),
});

const repositoryResultSchema = z.object({ Repository: repositoryResponseSchema });
const mergeRequestsResultSchema = z.object({
  MergeRequests: z.array(mergeRequestResponseSchema),
  PageNumber: z.number().int().positive(),
  PageSize: z.number().int().positive(),
  TotalCount: z.number().int().nonnegative(),
});

const issueResponseSchema = z.object({
  Id: z.string().trim().min(1),
  RepoId: z.string().trim().min(1),
  Number: z.number().int().positive(),
  Title: z.string().min(1),
  Description: z.string(),
  Status: codebaseIssueStatusSchema,
  CreatedBy: authorResponseSchema.optional(),
  CreatedAt: z.string().trim().min(1),
  UpdatedAt: z.string().trim().min(1),
});
const issuesResultSchema = z.object({
  Issues: z.array(issueResponseSchema),
  PageNumber: z.number().int().positive(),
  PageSize: z.number().int().positive(),
  TotalCount: z.number().int().nonnegative(),
});
const issueResultSchema = z.object({ Issue: issueResponseSchema });

interface ListMergeRequestsPayload {
  TargetRepoId: string;
  Status: 'open';
  PageNumber: number;
  PageSize: 50;
  SortBy: 'UpdatedAt';
  SortOrder: 'Desc';
  Selector: { Repository: true; URL: true };
  Title?: string;
}

export class CodebaseApiError extends Error {}

function repository(value: z.infer<typeof repositoryResponseSchema>): CodebaseRepository {
  const result = codebaseRepositorySchema.parse({
    id: value.Id,
    path: value.Path,
    url: value.URL,
    cloneUrl: value.CloneURL,
    sshUrl: value.SSHURL,
  });
  if (value.IssueEnabled !== undefined) result.issuesEnabled = value.IssueEnabled;
  return result;
}

function optionalText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text || undefined;
}

function optionalSourceRepository(
  value: z.infer<typeof repositoryResponseSchema> | null | undefined,
): CodebaseRepository | null {
  return value ? repository(value) : null;
}

function issue(value: z.infer<typeof issueResponseSchema>, repo: CodebaseRepository): CodebaseIssue {
  if (value.RepoId !== repo.id) throw new CodebaseApiError('Invalid Codebase issue repository');
  const result: CodebaseIssue = {
    id: value.Id,
    number: value.Number,
    title: value.Title,
    url: `https://code.byted.org/${repo.path.split('/').map(encodeURIComponent).join('/')}/issues/${value.Number}`,
    description: value.Description,
    status: value.Status,
    createdAt: value.CreatedAt,
    updatedAt: value.UpdatedAt,
  };
  if (value.CreatedBy) {
    result.author = { username: value.CreatedBy.Username };
    if (value.CreatedBy.AvatarURL) result.author.avatarUrl = value.CreatedBy.AvatarURL;
  }
  return result;
}

function mergeRequest(
  value: z.infer<typeof mergeRequestResponseSchema>,
  targetRepo: CodebaseRepository,
): CodebaseMergeRequest {
  const sourceRepoId = optionalText(value.SourceRepoId);
  const result: CodebaseMergeRequest = {
    id: value.Id,
    number: value.Number,
    title: value.Title,
    url: value.URL,
    sourceBranch: optionalText(value.SourceBranchName) ?? '',
    targetBranch: value.TargetBranchName,
    sourceRepo: sourceRepoId === targetRepo.id
      ? targetRepo
      : optionalSourceRepository(value.SourceRepository),
    draft: value.Draft ?? false,
    updatedAt: value.UpdatedAt,
  };
  const description = optionalText(value.Description);
  if (description) result.description = description;
  if (value.CreatedBy) {
    result.author = { username: value.CreatedBy.Username };
    if (value.CreatedBy.AvatarURL) result.author.avatarUrl = value.CreatedBy.AvatarURL;
  }
  return result;
}

export function createCodebaseUpstream(fetchImpl: typeof globalThis.fetch): CodebaseUpstream {
  const request = async <T>(
    action: string,
    pat: string,
    body: string,
    schema: z.ZodType<T>,
  ): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImpl(`${apiUrl}?Action=${encodeURIComponent(action)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pat}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new CodebaseApiError('Codebase request failed');
    }
    const envelope = envelopeSchema.safeParse(await response.json().catch(() => null));
    if (!response.ok || !envelope.success || envelope.data.ResponseMetadata.Error) {
      throw new CodebaseApiError('Codebase request failed');
    }
    const result = schema.safeParse(envelope.data.Result);
    if (!result.success) throw new CodebaseApiError('Invalid Codebase response');
    return result.data;
  };

  return {
    async getUser(pat) {
      const result = await request('GetUser', pat, '{}', userResultSchema);
      const user: CodebaseUser = {
        id: result.User.Id,
        username: result.User.Username,
      };
      if (result.User.AvatarURL) user.avatarUrl = result.User.AvatarURL;
      return user;
    },
    async getRepository(pat, repositoryPath) {
      const result = await request(
        'GetRepository',
        pat,
        JSON.stringify({ Path: repositoryPath }),
        repositoryResultSchema,
      );
      return repository(result.Repository);
    },
    async listMergeRequests(pat, repo, page, query) {
      const payload: ListMergeRequestsPayload = {
        TargetRepoId: repo.id,
        Status: 'open',
        PageNumber: page,
        PageSize: 50,
        SortBy: 'UpdatedAt',
        SortOrder: 'Desc',
        Selector: { Repository: true, URL: true },
      };
      if (query) payload.Title = query;
      const result = await request(
        'ListRepoMergeRequests',
        pat,
        JSON.stringify(payload),
        mergeRequestsResultSchema,
      );
      return {
        mergeRequests: result.MergeRequests.map((item) => mergeRequest(item, repo)),
        page: result.PageNumber,
        hasMore: result.PageNumber * result.PageSize < result.TotalCount,
      };
    },
    async listIssues(pat, repo, page, query, status) {
      const result = await request('SearchRepoIssues', pat, JSON.stringify({
        RepoId: repo.id,
        Filter: { Query: query || undefined, Status: status },
        PageNumber: page,
        PageSize: 50,
        SortBy: 'UpdatedAt',
        SortOrder: 'Desc',
        Selector: { CreatedBy: true },
      }), issuesResultSchema);
      return {
        issues: result.Issues.map((item) => issue(item, repo)),
        page: result.PageNumber,
        hasMore: result.PageNumber * result.PageSize < result.TotalCount,
      };
    },
    async getIssue(pat, repo, number) {
      const result = await request('GetIssue', pat, JSON.stringify({
        RepoId: repo.id, Number: number, Selector: { CreatedBy: true },
      }), issueResultSchema);
      if (result.Issue.Number !== number) throw new CodebaseApiError('Invalid Codebase issue number');
      return issue(result.Issue, repo);
    },
  };
}
