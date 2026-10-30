import { z } from 'zod';

/**
 * A private problem report about one song, from its owner
 * (docs/ISSUE_REPORTS_SPEC.md). Only the owner and staff ever see one.
 */
export const ISSUE_KINDS = ['missing_vocals', 'lyrics_out_of_sync', 'audio_quality', 'download_failed', 'other'] as const;
export const IssueKind = z.enum(ISSUE_KINDS);
export type IssueKind = z.infer<typeof IssueKind>;

export const ISSUE_NOTE_MAX = 500;

export const createIssueReportRequest = z.object({
  kind: IssueKind,
  atSeconds: z.number().int().min(0).max(600).optional(),
  note: z
    .string()
    .max(ISSUE_NOTE_MAX * 4)
    .transform((v) => v.trim())
    .refine((v) => [...v].length <= ISSUE_NOTE_MAX, { message: `at most ${ISSUE_NOTE_MAX} characters` })
    .optional(),
  audioConsent: z.boolean().default(false),
  /** The server's request id of a failure the report is about, when the page had one. */
  requestId: z.string().max(64).regex(/^[\w.:-]+$/).optional(),
});
export type CreateIssueReportRequest = z.infer<typeof createIssueReportRequest>;

/** What the owner sees of their own reports. */
export interface IssueReportView {
  reportNumber: string;
  kind: IssueKind;
  atSeconds: number | null;
  note: string | null;
  audioConsent: boolean;
  status: 'open' | 'resolved';
  resolution: string | null;
  createdAt: string;
  resolvedAt: string | null;
  /** Credits given back when it was resolved (docs/FAILURE_COMPENSATION_SPEC.md), or null. */
  compensatedUnits: number | null;
}
