/**
 * Context, as Claude Code actually assembles it.
 *
 * More than one file reaches a session, they live in different directories,
 * and a repo inherits every CLAUDE.md above it as well as its own. Showing
 * fewer files than the model is given is how a context manager quietly stops
 * matching reality.
 */

export type ContextKind =
  | 'user'      // yours, every project on this machine
  | 'memory'    // the index Claude keeps for this project
  | 'note'      // one of the notes behind that index
  | 'project'   // a CLAUDE.md, in the repo or a directory above it
  | 'local';    // your uncommitted notes for this repo

export interface ContextLayer {
  /** Stable and opaque. Saving addresses a layer by this, never by path. */
  id: string;
  kind: ContextKind;
  label: string;
  /** One line on where it comes from and who it applies to. */
  summary: string;
  path: string;
  exists: boolean;
  /** True when it comes from a directory above the project. */
  inherited: boolean;
  body: string;
  tokens: number;
  /**
   * False for files a session does not automatically receive. The notes
   * behind the memory index are recalled when they are relevant, so counting
   * them in the total would overstate what every session is given.
   */
  counted: boolean;
}

export interface ContextResponse {
  projectId: string;
  /** In the order a session receives them: outermost first. */
  layers: ContextLayer[];
  totalTokens: number;
}

export interface SaveContextRequest {
  /** The layer id from a previous read. */
  id: string;
  body: string;
}
