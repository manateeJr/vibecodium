export const FILES_SHARED_STAGED_COMMAND = 'files.shared_staged' as const;

export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly is_dir: boolean;
  readonly size?: number;
  readonly mtime?: string;
}

export interface FilesListArgs {
  readonly dir?: string;
}

export interface FilesListResult {
  readonly entries: readonly FileEntry[];
  readonly scope_roots: readonly string[];
}

export interface FilesDownloadArgs {
  readonly path: string;
}

export interface FilesDownloadResult {
  readonly name: string;
  readonly mime: string;
  readonly content_base64: string;
  readonly size: number;
}

export interface FilesUploadArgs {
  readonly session_id: string;
  readonly name: string;
  readonly content_base64: string;
  readonly mime?: string;
}

export interface FilesUploadResult {
  readonly path: string;
  readonly size: number;
}

export type FilesSharedDirArgs = Record<string, never>;

export interface FilesSharedDirResult {
  readonly path: string;
}

export interface FilesSharedStagedArgs {
  readonly token: string;
}

export interface SharedStagedFile {
  readonly name: string;
  readonly path: string;
  readonly size: number;
}

export interface FilesSharedStagedResult {
  readonly files: readonly SharedStagedFile[];
  readonly note?: string;
  readonly project?: string;
}
