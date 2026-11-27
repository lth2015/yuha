import { useState } from 'react';
import {
  BGM_GENRES, BGM_MOODS, BGM_SCENARIOS, OFFICIAL_BGM_COVER_BYTES, OFFICIAL_BGM_DOCUMENT_BYTES, OFFICIAL_BGM_MASTER_BYTES,
  officialBgmCoverFor, officialBgmInventoryFor, officialBgmInventoryReport, officialBgmMissingProvenance, parseOfficialBgmManifest,
  type OfficialBgmBatchTrack, type OfficialBgmInventoryReport, type OfficialBgmManifestIssue, type OfficialBgmUploadResult,
} from '@yuha/contracts';
import { ApiError, apiFetch } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { OFFICIAL_BGM_ADMIN } from '../../lib/official-bgm-catalog';

type Entry = ReturnType<typeof parseOfficialBgmManifest>[number];
type Tags = Pick<Entry, 'genre' | 'mood' | 'scenario'>;
type Batch = { entries: Entry[]; rejected: OfficialBgmManifestIssue[]; files: Map<string, File>; name: string };
type Prepared = { id: string; entry: Entry; master?: File; cover?: File; track?: OfficialBgmBatchTrack;
  needsTags: boolean; issue?: string; notes?: string[] };
type Outcome = { status: 'checking' | 'sending' | 'imported' | 'existing' | 'failed'; problem?: string };
const TAGS = { genre: BGM_GENRES, scenario: BGM_SCENARIOS, mood: BGM_MOODS } as const;
const LABELS = ['genre', 'scenario', 'mood'] as const;
const MANIFEST_FIELDS: Record<string, string> = {
  trackId: 'market.import.fieldId', title: 'market.copy.trackTitle', masterFilename: 'market.source.master',
  series: 'market.source.series', style: 'bgm.genre', originalMood: 'bgm.mood', originalScenario: 'bgm.scenario',
  model: 'market.import.fieldModel', modelVersion: 'market.import.fieldVersion', seed: 'market.source.seed',
  prompt: 'market.source.prompt', generatedAt: 'market.source.time', note: 'market.source.note',
  coverFilename: 'market.import.fieldCover', licenseStatus: 'market.source.license',
};

function TagFields({ tags, disabled, onChange }: {
  tags: Tags; disabled: boolean; onChange: (tags: Tags) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="market-import__tags">
      {LABELS.map((key) => (
        <label className="field" key={key}>
          <span>{t(`bgm.${key}`)}</span>
          <select disabled={disabled} value={tags[key] ?? ''} onChange={(event) => {
            const value = TAGS[key].find((tag) => tag === event.target.value);
            onChange({ [key]: value });
          }}>
            <option value="">{t('market.import.chooseTag')}</option>
            {TAGS[key].map((value) => <option value={value} key={value}>{t(`bgm.${key}.${value}`)}</option>)}
          </select>
        </label>
      ))}
    </div>
  );
}

function ReportNotes({ notes }: { notes?: string[] }) {
  const { t } = useI18n();
  if (!notes?.length) return null;
  return (
    <details className="market-source small">
      <summary>{t('market.import.reportNotes')}</summary>
      <p className="muted">{notes.join(' · ')}</p>
    </details>
  );
}

async function readReport(file: File): Promise<OfficialBgmInventoryReport> {
  if (file.size > OFFICIAL_BGM_DOCUMENT_BYTES) throw new Error('inventory.json is too large');
  return officialBgmInventoryReport.parse(JSON.parse(await file.text()));
}

function prepare(entry: Entry, files: Map<string, File>, report: OfficialBgmInventoryReport | undefined, covers: string[]) {
  const original = entry.provenance;
  const master = files.get(`masters/${original.masterFilename}`);
  if (!master || !master.size || master.size > OFFICIAL_BGM_MASTER_BYTES) return { issue: 'market.import.masterMissing' };
  let coverName: string | undefined;
  try { coverName = officialBgmCoverFor(original, covers); }
  catch { return { issue: 'market.import.multipleCovers' }; }
  const cover = coverName ? files.get(`covers/${coverName}`) : undefined;
  if (coverName && (!cover || !cover.size || cover.size > OFFICIAL_BGM_COVER_BYTES)) return { issue: 'market.import.coverMissing' };
  let record: ReturnType<typeof officialBgmInventoryFor>;
  try { record = officialBgmInventoryFor(report, original); }
  catch { return { issue: 'market.import.inventoryMismatch' }; }
  if (record?.evidence.bytes !== undefined && record.evidence.bytes !== master.size) return { issue: 'market.import.inventorySize' };
  if (!entry.genre || !entry.scenario || !entry.mood) return { issue: 'market.import.chooseTags', notes: record?.notes };
  const track: OfficialBgmBatchTrack = {
    title: entry.title, genre: entry.genre, scenario: entry.scenario, mood: entry.mood,
    provenance: { ...original, ...(coverName ? { coverFilename: coverName } : {}) },
    inventory: record?.evidence,
  };
  return { track, master, cover, notes: record?.notes };
}

export function OfficialBgmBatchImport({ onImported, onReview }: { onImported: () => void; onReview: () => void }) {
  const { t } = useI18n();
  const [batch, setBatch] = useState<Batch>();
  const [report, setReport] = useState<OfficialBgmInventoryReport>();
  const [reportName, setReportName] = useState('');
  const [tags, setTags] = useState<Record<string, Tags>>({});
  const [defaults, setDefaults] = useState<Tags>({});
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [badReport, setBadReport] = useState(false);

  async function selectFolder(selected: FileList | null) {
    if (!selected?.length) return;
    setLoading(true);
    setProblem('');
    setBatch(undefined);
    setReport(undefined);
    setReportName('');
    setBadReport(false);
    setTags({});
    setDefaults({});
    setOutcomes({});
    try {
      const files = new Map<string, File>();
      const first = selected[0]!.webkitRelativePath.split('/');
      const name = first[0]!;
      for (const file of Array.from(selected)) {
        const [folder, ...relative] = file.webkitRelativePath.split('/');
        if (folder === name) files.set(relative.join('/'), file);
      }
      const manifest = files.get('manifest.csv');
      if (!manifest || manifest.size > OFFICIAL_BGM_DOCUMENT_BYTES) {
        setProblem('market.import.manifest');
        return;
      }
      const rejected: OfficialBgmManifestIssue[] = [];
      const entries = parseOfficialBgmManifest(await manifest.text(), name, (issue) => rejected.push(issue));
      setBatch({ entries, rejected, files, name });
      const inventory = files.get('inventory.json');
      if (inventory) {
        setReportName(inventory.name);
        try { setReport(await readReport(inventory)); }
        catch { setBadReport(true); }
      }
    } catch {
      setProblem('market.import.manifestFormat');
    } finally {
      setLoading(false);
    }
  }

  async function selectReport(file: File | undefined) {
    if (!file) return;
    setLoading(true);
    setProblem('');
    setReportName(file.name);
    try {
      setReport(await readReport(file));
      setBadReport(false);
    } catch {
      setReport(undefined);
      setBadReport(true);
    }
    finally { setLoading(false); }
  }

  const covers = batch ? [...batch.files.keys()].filter((key) => /^covers\/[^/]+$/.test(key)).map((key) => key.slice(7)) : [];
  const rows = batch?.entries.map<Prepared>((row) => {
    const id = row.provenance.trackId;
    const entry = {
      ...row,
      genre: tags[id]?.genre ?? row.genre ?? defaults.genre,
      scenario: tags[id]?.scenario ?? row.scenario ?? defaults.scenario,
      mood: tags[id]?.mood ?? row.mood ?? defaults.mood,
    };
    return { id, entry, needsTags: LABELS.some((key) => !row[key]), ...prepare(entry, batch.files, report, covers) };
  }) ?? [];
  const pending = rows.filter((row) => row.track && row.master &&
    outcomes[row.id]?.status !== 'imported' && outcomes[row.id]?.status !== 'existing');
  const imported = rows.filter((row) => outcomes[row.id]?.status === 'imported').length;
  const existing = rows.filter((row) => outcomes[row.id]?.status === 'existing').length;
  const issues = (batch?.rejected.length ?? 0) + rows.filter((row) => row.issue || outcomes[row.id]?.status === 'failed').length;
  const ready = pending.filter((row) => outcomes[row.id]?.status !== 'failed');
  const toUpload = ready.length ? ready : pending;
  const missingTags = rows.some((row) => row.needsTags);

  function fieldNames(fields: string[]) {
    return fields.map((field) => t(MANIFEST_FIELDS[field] ?? 'market.import.fieldUnknown')).join(t('market.import.fieldSeparator'));
  }

  async function upload(selected: Prepared[]) {
    setBusy(true);
    let changed = false;
    try {
      for (const row of selected) {
        if (!row.track || !row.master) continue;
        try {
          if (row.track.inventory && globalThis.crypto?.subtle) {
            setOutcomes((current) => ({ ...current, [row.id]: { status: 'checking' } }));
            const digest = await crypto.subtle.digest('SHA-256', await row.master.arrayBuffer());
            const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
            if (hex !== row.track.inventory.sha256) {
              setOutcomes((current) => ({ ...current, [row.id]: { status: 'failed', problem: 'market.import.inventoryHash' } }));
              continue;
            }
          }
          setOutcomes((current) => ({ ...current, [row.id]: { status: 'sending' } }));
          const form = new FormData();
          form.append('fields', JSON.stringify({ track: row.track }));
          form.append('master', row.master);
          if (row.cover) form.append('cover', row.cover);
          const result = await apiFetch<OfficialBgmUploadResult>(`${OFFICIAL_BGM_ADMIN}/import`, { method: 'POST', body: form });
          changed = true;
          setOutcomes((current) => ({ ...current, [row.id]: { status: result.status } }));
        } catch (error) {
          const detail = error instanceof ApiError ? error.details as { reason?: string } | undefined : undefined;
          const problem = detail?.reason === 'import_conflict' ? 'market.import.importConflict'
            : error instanceof ApiError && error.code === 'VALIDATION_FAILED'
              ? 'market.import.invalidMedia' : 'market.import.retryUpload';
          setOutcomes((current) => ({ ...current, [row.id]: {
            status: 'failed', problem,
          } }));
        }
      }
    } finally {
      if (changed) onImported();
      setBusy(false);
    }
  }

  return (
    <div className="market-import stack">
      <p className="small muted market-import__description">{t('market.import.description')}</p>
      <div className="market-file">
        <div><strong>{t('market.import.folder')}</strong><p>{batch?.name ?? t('market.import.folderHint')}</p></div>
        <label className="market-file__pick">
          <input className="sr-only" type="file" multiple {...{ webkitdirectory: '' }} disabled={busy || loading}
            onChange={(event) => { void selectFolder(event.target.files); event.target.value = ''; }} />
          <span className="btn">{t(batch ? 'market.import.changeFolder' : 'market.import.pickFolder')}</span>
        </label>
      </div>
      {loading && <p className="small" role="status">{t('market.import.reading')}</p>}
      {problem && <p className="small market-admin__problem" role="alert">{t(problem)}</p>}
      {batch && (
        <>
          <div className="market-file">
            <div><strong>{t('market.import.report')}</strong><p>{reportName || t('market.import.reportHint')}</p></div>
            <div className="market-admin__actions">
              <label className="market-file__pick">
                <input className="sr-only" type="file" accept=".json,application/json" disabled={busy || loading}
                  onChange={(event) => { void selectReport(event.target.files?.[0]); event.target.value = ''; }} />
                <span className="btn">{t(reportName ? 'market.import.changeReport' : 'market.import.pickReport')}</span>
              </label>
              {reportName && <button type="button" className="btn" disabled={busy || loading}
                onClick={() => { setReport(undefined); setReportName(''); setBadReport(false); }}>{t('market.import.clearReport')}</button>}
            </div>
          </div>
          {badReport && <p className="small market-admin__problem" role="alert">{t('market.import.badReport')}</p>}
          <ReportNotes notes={report?.batch_problems} />
          {missingTags && <fieldset className="market-import__defaults">
            <legend>{t('market.import.defaults')}</legend>
            <p className="small muted">{t('market.import.defaultsHelp')}</p>
            <TagFields tags={defaults} disabled={busy || loading} onChange={(change) => setDefaults((current) => ({ ...current, ...change }))} />
          </fieldset>}
          <div className="market-import__summary">
            <h3>{t('market.import.checkTitle')}</h3>
            <p className="small muted" role="status">{t('market.import.summary', { ready: badReport || busy ? 0 : ready.length, imported, existing, issues })}</p>
            {batch.rejected.length > 0 && <p className="small muted">{t('market.import.fixManifest')}</p>}
            <div className="market-admin__actions">
              {pending.length > 0 && <button className="btn btn--primary market-import__submit" type="button"
                disabled={busy || loading || badReport} onClick={() => void upload(toUpload)}>
                {busy ? t('market.import.sending') : t(ready.length ? 'market.import.submitCount' : 'market.import.retryCount', { count: toUpload.length })}
              </button>}
              {imported > 0 && <button type="button" className={pending.length ? 'btn' : 'btn btn--primary'} disabled={busy} onClick={onReview}>
                {t('market.import.reviewDrafts')}
              </button>}
            </div>
          </div>
          <ul className="market-import__rows" aria-label={batch.name}>
            {batch.rejected.map((issue) => (
              <li key={`issue-${issue.row}`}>
                <strong>{issue.title || issue.id}</strong>
                <p className="small market-admin__problem" role="alert">{t('market.import.rowError', {
                  row: issue.row,
                  message: t(`market.import.issue.${issue.code}`, {
                    fields: fieldNames(issue.fields ?? []),
                  }),
                })}</p>
              </li>
            ))}
            {rows.map((row) => {
              const outcome = outcomes[row.id];
              const done = outcome?.status === 'imported' || outcome?.status === 'existing';
              const missing = officialBgmMissingProvenance(row.entry.provenance);
              return (
                <li key={row.id}>
                  <strong>{row.entry.title}</strong>
                  <span className="small muted">{row.entry.provenance.masterFilename}</span>
                  {missing.length > 0 && <p className="small muted">{t('market.import.missing', { fields: fieldNames(missing) })}</p>}
                  {!done && row.needsTags && <details className="market-source">
                    <summary>{t('market.import.editTags')}</summary>
                    <TagFields tags={row.entry} disabled={busy || loading}
                      onChange={(change) => setTags((current) => ({ ...current, [row.id]: { ...current[row.id], ...change } }))} />
                  </details>}
                  <span className={`small ${row.issue || outcome?.status === 'failed' ? 'market-admin__problem' : 'muted'}`}>
                    {outcome ? t(`market.import.${outcome.status}`) : t(row.issue ?? 'market.import.ready')}
                  </span>
                  {outcome?.problem && <p className="small" role="alert">{t(outcome.problem)}</p>}
                  {outcome?.status === 'failed' && row.track && (
                    <button type="button" className="btn market-import__clear" disabled={busy || loading || badReport}
                      onClick={() => void upload([row])}>{t('market.retry')}</button>
                  )}
                  <ReportNotes notes={row.notes} />
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
