import type { PoolConnection } from 'mysql2/promise';
import { execute, newId, query, queryOne, toJson } from './pool.js';

// ------------------------------------------------------------ license snapshots

export interface LicenseSnapshotRow {
  id: string;
  track_id: string;
  user_id: string;
  provider_id: string;
  provider_model: string;
  contract_version: string;
  license_version: string;
  territory: string;
  allowed_uses: string[];
  prohibited_uses: string[];
  source_sha256: string;
  generated_at: Date;
  commercial_delivery: boolean;
  status: 'active' | 'suspended' | 'revoked';
  status_reason: string | null;
  created_at: Date;
}

const LICENSE_COLUMNS = `
  id, track_id, user_id, provider_id, provider_model, contract_version, license_version,
  territory, allowed_uses, prohibited_uses, source_sha256, generated_at,
  commercial_delivery, status, status_reason, created_at
`;

export async function insertLicenseSnapshot(
  params: {
    trackId: string;
    userId: string;
    providerId: string;
    providerModel: string;
    contractVersion: string;
    licenseVersion: string;
    territory: string;
    allowedUses: string[];
    prohibitedUses: string[];
    sourceSha256: string;
    generatedAt: Date;
    commercialDelivery: boolean;
  },
  tx: PoolConnection,
): Promise<LicenseSnapshotRow> {
  // INSERT IGNORE rather than an upsert: the immutability trigger would reject
  // any attempt to rewrite the terms anyway (SEC-08).
  await execute(
    `INSERT IGNORE INTO license_snapshots
       (id, track_id, user_id, provider_id, provider_model, contract_version, license_version,
        territory, allowed_uses, prohibited_uses, source_sha256, generated_at, commercial_delivery)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      newId(),
      params.trackId,
      params.userId,
      params.providerId,
      params.providerModel,
      params.contractVersion,
      params.licenseVersion,
      params.territory,
      toJson(params.allowedUses),
      toJson(params.prohibitedUses),
      params.sourceSha256,
      params.generatedAt,
      params.commercialDelivery ? 1 : 0,
    ],
    tx,
  );
  return (await getLicenseSnapshot(params.trackId, tx))!;
}

export async function getLicenseSnapshot(
  trackId: string,
  tx?: PoolConnection,
): Promise<LicenseSnapshotRow | undefined> {
  return queryOne<LicenseSnapshotRow>(
    `SELECT ${LICENSE_COLUMNS} FROM license_snapshots WHERE track_id = ?`,
    [trackId],
    tx,
  );
}

/** Only the status may change after creation; the trigger rejects anything else. */
export async function setLicenseStatus(
  params: { trackId: string; status: 'active' | 'suspended' | 'revoked'; reason: string },
  tx?: PoolConnection,
): Promise<void> {
  await execute(
    `UPDATE license_snapshots SET status = ?, status_reason = ? WHERE track_id = ?`,
    [params.status, params.reason, params.trackId],
    tx,
  );
}

// ---------------------------------------------------------------- rights cases

export interface RightsCaseRow {
  id: string;
  case_number: string;
  track_id: string | null;
  audio_sha256: string | null;
  reporter_name: string;
  reporter_email: string;
  claim_type: string;
  description: string;
  evidence: unknown[];
  status: string;
  assigned_to: string | null;
  resolution: string | null;
  created_at: Date;
  updated_at: Date;
}

const CASE_COLUMNS = `
  id, case_number, track_id, audio_sha256, reporter_name, reporter_email, claim_type,
  description, evidence, status, assigned_to, resolution, created_at, updated_at
`;

export async function insertRightsCase(
  params: {
    caseNumber: string;
    trackId?: string | null;
    audioSha256?: string | null;
    reporterName: string;
    reporterEmail: string;
    claimType: string;
    description: string;
    evidence: unknown[];
  },
  tx?: PoolConnection,
): Promise<RightsCaseRow> {
  const id = newId();
  await execute(
    `INSERT INTO rights_cases
       (id, case_number, track_id, audio_sha256, reporter_name, reporter_email, claim_type, description, evidence)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      id,
      params.caseNumber,
      params.trackId ?? null,
      params.audioSha256 ?? null,
      params.reporterName,
      params.reporterEmail,
      params.claimType,
      params.description,
      toJson(params.evidence),
    ],
    tx,
  );
  return (await queryOne<RightsCaseRow>(
    `SELECT ${CASE_COLUMNS} FROM rights_cases WHERE id = ?`,
    [id],
    tx,
  ))!;
}

export async function listRightsCases(status?: string, limit = 100): Promise<RightsCaseRow[]> {
  if (status) {
    return query<RightsCaseRow>(
      `SELECT ${CASE_COLUMNS} FROM rights_cases WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
      [status, limit],
    );
  }
  return query<RightsCaseRow>(
    `SELECT ${CASE_COLUMNS} FROM rights_cases ORDER BY created_at DESC LIMIT ?`,
    [limit],
  );
}

export async function getRightsCase(id: string): Promise<RightsCaseRow | undefined> {
  return queryOne<RightsCaseRow>(`SELECT ${CASE_COLUMNS} FROM rights_cases WHERE id = ?`, [id]);
}

export async function updateRightsCase(
  params: { id: string; status: string; resolution?: string | null; assignedTo?: string | null },
  tx?: PoolConnection,
): Promise<RightsCaseRow | undefined> {
  await execute(
    `UPDATE rights_cases SET status = ?,
                             resolution = COALESCE(?, resolution),
                             assigned_to = COALESCE(?, assigned_to),
                             updated_at = UTC_TIMESTAMP(3)
      WHERE id = ?`,
    [params.status, params.resolution ?? null, params.assignedTo ?? null, params.id],
    tx,
  );
  return queryOne<RightsCaseRow>(`SELECT ${CASE_COLUMNS} FROM rights_cases WHERE id = ?`, [params.id], tx);
}

// ------------------------------------------------------------------ audit logs

/**
 * Every privileged mutation writes one of these. `reason` is NOT NULL in the
 * schema, so an operator action with no stated reason cannot be recorded at all
 * (UI-15).
 */
export async function writeAuditLog(
  params: {
    actorId: string | null;
    actorRole: string;
    action: string;
    subjectType: string;
    subjectId: string;
    reason: string;
    before?: unknown;
    after?: unknown;
    ipHash?: string | null;
  },
  tx?: PoolConnection,
): Promise<void> {
  await execute(
    `INSERT INTO audit_logs
       (id, actor_id, actor_role, action, subject_type, subject_id, reason, before_state, after_state, ip_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      newId(),
      params.actorId,
      params.actorRole,
      params.action,
      params.subjectType,
      params.subjectId,
      params.reason,
      params.before === undefined ? null : toJson(params.before),
      params.after === undefined ? null : toJson(params.after),
      params.ipHash ?? null,
    ],
    tx,
  );
}

export async function listAuditLogs(params: {
  subjectType?: string;
  subjectId?: string;
  limit?: number;
}): Promise<Array<Record<string, unknown>>> {
  if (params.subjectType && params.subjectId) {
    return query(
      `SELECT * FROM audit_logs WHERE subject_type = ? AND subject_id = ?
        ORDER BY created_at DESC LIMIT ?`,
      [params.subjectType, params.subjectId, params.limit ?? 100],
    );
  }
  return query(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?`, [params.limit ?? 100]);
}

// ------------------------------------------------------------------ analytics

/**
 * §11.1: stable id, timestamp, pseudonymous user ref, price version, run mode.
 * Never the raw prompt, the email address or any card data.
 */
export async function trackEvent(
  params: {
    name: string;
    userRef?: string | null;
    props?: Record<string, unknown>;
    priceVersion?: number | null;
    runMode: string;
    isInternal: boolean;
    occurredAt?: Date;
  },
  tx?: PoolConnection,
): Promise<void> {
  await execute(
    `INSERT INTO analytics_events
       (id, name, user_ref, props, price_version, run_mode, is_internal, occurred_at)
     VALUES (?,?,?,?,?,?,?, COALESCE(?, UTC_TIMESTAMP(3)))`,
    [
      newId(),
      params.name,
      params.userRef ?? null,
      toJson(params.props ?? {}),
      params.priceVersion ?? null,
      params.runMode,
      params.isInternal ? 1 : 0,
      params.occurredAt ?? null,
    ],
    tx,
  );
}

/**
 * One page view (POST /v1/visits). A browser seen signed in as staff is
 * remembered by its visitor id, its earlier page views are marked internal,
 * and every later one is internal too, signed in or not
 * (migration 0030_staff_visitors).
 */
export async function recordPageView(params: {
  visitorRef: string;
  props: Record<string, unknown>;
  runMode: string;
  staff: boolean;
  demo: boolean;
}): Promise<void> {
  if (params.staff) {
    await execute(`INSERT IGNORE INTO staff_visitors (visitor_ref) VALUES (?)`, [params.visitorRef]);
    await execute(
      `UPDATE analytics_events SET is_internal = 1 WHERE name = 'page_view' AND user_ref = ? AND is_internal = 0`,
      [params.visitorRef],
    );
  }
  const known =
    params.staff ||
    Boolean(await queryOne(`SELECT 1 AS k FROM staff_visitors WHERE visitor_ref = ?`, [params.visitorRef]));
  await trackEvent({
    name: 'page_view',
    userRef: params.visitorRef,
    props: params.props,
    runMode: params.runMode,
    isInternal: params.demo || known,
  });
}

// ------------------------------------------------------------ runtime settings

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await queryOne<{ setting_value: T }>(
    `SELECT setting_value FROM runtime_settings WHERE setting_key = ?`,
    [key],
  );
  return row ? row.setting_value : fallback;
}

export async function setSetting(
  params: { key: string; value: unknown; updatedBy: string | null; reason: string },
  tx?: PoolConnection,
): Promise<void> {
  await execute(
    `INSERT INTO runtime_settings (setting_key, setting_value, updated_by, reason)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
                             updated_by = VALUES(updated_by),
                             reason = VALUES(reason),
                             updated_at = UTC_TIMESTAMP(3)`,
    [params.key, toJson(params.value), params.updatedBy, params.reason],
    tx,
  );
}

export async function listSettings(): Promise<
  Array<{ key: string; value: unknown; reason: string | null; updated_at: Date }>
> {
  return query(
    `SELECT setting_key AS \`key\`, setting_value AS value, reason, updated_at
       FROM runtime_settings ORDER BY setting_key`,
  );
}
