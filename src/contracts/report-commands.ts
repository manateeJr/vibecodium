export const REPORT_INTAKE_PATH = '/report-intake';
export const REPORT_MAX_INTAKE_BYTES = 10 * 1024 * 1024;
/** Reports auto-expire after 30 days unless pinned. */
export const REPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const REPORT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const REPORT_METADATA_FILENAME = '.vibecodium-report.json';
export const REPORT_BODY_FILENAME = 'report.json';
export const REPORT_STREAM_ID = 'reports';

export interface ReportAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: number;
}
export interface ReportRecord {
  readonly id: string;
  readonly app: string;
  readonly kind: string;
  readonly schemaVersion: number;
  readonly capturedAt: string; // ISO 8601
  readonly title: string;
  readonly summary?: string;
  readonly device?: string;
  readonly note?: string;
  readonly pinned: boolean;
  readonly createdAt: string; // ISO 8601
  readonly expiresAt: string; // ISO 8601 = createdAt + REPORT_RETENTION_MS
  readonly attachments: readonly ReportAttachment[];
}
export interface ReportListArgs {
  readonly limit?: number;
}
export interface ReportListResult {
  readonly reports: readonly ReportRecord[];
} // newest createdAt first
export interface ReportGetArgs {
  readonly id: string;
}
export interface ReportGetResult {
  readonly report: ReportRecord;
  readonly body: unknown;
  readonly body_path: string;
}
export interface ReportPinArgs {
  readonly id: string;
  readonly pinned: boolean;
}
export interface ReportPinResult {
  readonly pinned: boolean;
}
export interface ReportDismissArgs {
  readonly id: string;
}
export interface ReportDismissResult {
  readonly dismissed: boolean;
}
export interface ReportPromoteArgs {
  readonly id: string;
  readonly target: 'new' | 'existing';
  readonly session_id?: string; // required when target==='existing'
  readonly provider?: string; // default 'omp', used when target==='new'
  readonly cwd?: string;
  readonly project?: string;
}
export interface ReportPromoteResult {
  readonly stream_id: string;
  readonly session_id: string;
}
