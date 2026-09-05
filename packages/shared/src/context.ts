/**
 * Context, as Claude Code actually assembles it.
 *
 * There is more than one file, they live in different places, and only some
 * of them are yours to edit — the memory Claude keeps is written by Claude.
 * Showing two boxes when four files are in play is how a context manager
 * quietly stops matching what the model is told.
 */

export type ContextScope = 'user' | 'memory' | 'project' | 'local';

export interface ContextLayer {
  id: ContextScope;
  /** What to call it in the interface. */
  label: string;
  /** One line on where it comes from and who it applies to. */
  summary: string;
  /** The real path, shown so it can be checked or opened elsewhere. */
  path: string;
  exists: boolean;
  /** False for files Claude maintains; JKJ shows those read-only. */
  editable: boolean;
  body: string;
  tokens: number;
}

/** A file in the memory folder, listed but not inlined. */
export interface MemoryFile {
  name: string;
  bytes: number;
}

export interface ContextResponse {
  projectId: string;
  layers: ContextLayer[];
  memoryFiles: MemoryFile[];
  totalTokens: number;
}

export interface SaveContextRequest {
  scope: ContextScope;
  body: string;
}
