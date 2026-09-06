import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { codebaseUserSchema, type CodebaseAuthStatus } from '../contract.js';
import { z } from 'zod';

const credentialsSchema = z.object({ pat: z.string().min(1).startsWith('code_pat_'), user: codebaseUserSchema });
type Credentials = z.infer<typeof credentialsSchema>;

export class CodebaseAuthStoreError extends Error {}

export function createCodebaseAuthStore(dataDirectory: string, fileSystem: typeof fs = fs) {
  const file = path.join(dataDirectory, 'codebase-auth.json');
  const read = (): Credentials | null => {
    let content: string;
    try {
      content = fileSystem.readFileSync(file, 'utf8');
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw new CodebaseAuthStoreError('Failed to read Codebase credentials');
    }
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new CodebaseAuthStoreError('Codebase credentials are malformed');
    }
    const parsed = credentialsSchema.safeParse(value);
    if (!parsed.success) throw new CodebaseAuthStoreError('Codebase credentials are malformed');
    return parsed.data;
  };
  const write = (credentials: Credentials): void => {
    const parsed = credentialsSchema.safeParse(credentials);
    if (!parsed.success) throw new CodebaseAuthStoreError('Invalid Codebase credentials');
    fileSystem.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    let renamed = false;
    try {
      descriptor = fileSystem.openSync(temporary, 'wx', 0o600);
      fileSystem.writeFileSync(descriptor, JSON.stringify(parsed.data), 'utf8');
      fileSystem.closeSync(descriptor);
      descriptor = undefined;
      fileSystem.renameSync(temporary, file);
      renamed = true;
    } catch {
      if (descriptor !== undefined) {
        try { fileSystem.closeSync(descriptor); } catch { /* preserve write failure */ }
      }
      throw new CodebaseAuthStoreError('Failed to save Codebase credentials');
    } finally {
      if (!renamed) {
        try { fileSystem.unlinkSync(temporary); } catch { /* best effort cleanup */ }
      }
    }
  };
  const clear = (): void => {
    try {
      fileSystem.unlinkSync(file);
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new CodebaseAuthStoreError('Failed to remove Codebase credentials');
    }
  };
  const status = (): CodebaseAuthStatus => {
    const credentials = read();
    return credentials ? { connected: true, user: credentials.user } : { connected: false };
  };
  return { file, read, write, clear, status };
}
