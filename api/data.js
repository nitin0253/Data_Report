// pages/api/data.js
// Thin layer over Metabase — caches the CSV, parses rows, returns raw rows.
// All filtering and aggregation now happens client-side for sub-second filter UX.

let cache = null;
let cachedMeta = null;   // { rawHeaders: string[], rawSample: object[] }
let lastFetch = 0;
const CACHE_TIME = 5 * 60 * 1000; // 5 min server-side cache

const METABASE_URL =
  "https://metabase.spyne.ai/public/question/21760ff0-3e2b-43c2-a6f4-51c4dac4077f.csv";

// ── CSV parser (handles quoted fields, embedded commas, escaped quotes) ──
function parseCSVRow(row) {
  const out = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = parseCSVRow(lines[0]).map(h => h.trim());
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = parseCSVRow(line);
    const obj = {};
    headers.forEach((h, i) => (obj[h] = (vals[i] ?? '').trim()));
    return obj;
  });
}

// ── TAT parser — returns HOURS (matches TAT_Hrs from SQL) ──
function parseTatHrs(s) {
  if (s == null) return null;
  s = String(s).trim();
  if (!s || s.toLowerCase() === 'null' || s === 'NaN') return null;
  if (s.includes(':')) {
    const parts = s.split(':').map(Number);
    if (parts.some(isNaN)) return null;
    if (parts.length === 3) return parts[0] + parts[1] / 60 + parts[2] / 3600;
    if (parts.length === 2) return parts[0] / 60 + parts[1] / 3600;
    return null;
  }
  const n = parseFloat(s);
  return (isNaN(n) || n < 0) ? null : n;
}

function parseSla(s) {
  if (s == null) return null;
  s = String(s).trim().toLowerCase();
  if (!s || s === 'null') return null;
  if (['1','true','yes','y','within','within_sla'].includes(s)) return 1;
  if (['0','false','no','n','out','out_of_sla','breached'].includes(s)) return 0;
  return null;
}
function pickField(r, names) {
  for (const n of names) if (r[n] != null && String(r[n]).trim() !== '') return r[n];
  return '';
}

async function loadRows() {
  if (cache && Date.now() - lastFetch < CACHE_TIME) return cache;
  const resp = await fetch(METABASE_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) throw new Error(`Metabase responded ${resp.status}`);
  const text = await resp.text();
  const rows = parseCSV(text);

  if (rows.length > 0) {
    console.log('[data.js] cols:', Object.keys(rows[0]).join(','));
    console.log('[data.js] rows:', rows.length);
  }

  // Stash raw CSV column names + per-status-candidate-header non-empty counts.
  // When a parsed field is silently empty, this surfaces which raw column is
  // actually carrying the data (e.g. `status` vs `v.status`). Counted across
  // the FULL dataset, not a sample — definitive, not a guess.
  const rawHeaders = rows.length ? Object.keys(rows[0]) : [];
  const statusHeaderCandidates = rawHeaders.filter(h => /status/i.test(h));
  const statusHeaderCoverage = {};
  for (const h of statusHeaderCandidates){
    let nonEmpty = 0;
    const distinctVals = new Set();
    for (const r of rows){
      const v = r[h];
      if (v != null && String(v).trim() !== ''){
        nonEmpty++;
        if (distinctVals.size < 6) distinctVals.add(String(v).trim().toLowerCase());
      }
    }
    statusHeaderCoverage[h] = {
      nonEmpty,
      pctFilled: rows.length ? +(nonEmpty / rows.length * 100).toFixed(1) : 0,
      sampleValues: Array.from(distinctVals),
    };
  }
  cachedMeta = {
    rawHeaders,
    statusHeaderCoverage,
    rawSample: rows.slice(0, 2),   // first two raw rows for visual inspection
  };

  // Keep field names short — payload is sent to client and we want it lean.
  cache = rows.map(r => ({
    ent:    r.Ent_Name || '',
    team:   pickField(r, ['Team_Name','team_name','Team','team']),
    qc:     r.qc_email_id || '',
    poc_ob: pickField(r, ['POC_OB','poc_ob','ob_poc_email']),
    poc_cs: pickField(r, ['POC_CS','poc_cs','cs_poc_email']),
    status: pickField(r, [
      // Plain forms (when SELECT has no table prefix or uses AS alias)
      'status','Status','STATUS','video_status','Video_Status',
      // Table-qualified forms — Metabase preserves dots from SELECT v.status
      // exactly the way it preserves asku.mediaId. Without these fallbacks
      // the value silently parses as empty string.
      'v.status','v_status','video.status','video_video.status',
    ]),
    crm:    (pickField(r, ['CRM_Status','crm_status']) || '').toLowerCase().trim(),
    ver:    (pickField(r, ['verified_status']) || '').toLowerCase().trim(),
    rej:    pickField(r, ['rejected_reason','reject_reason']),
    vid:    pickField(r, ['Video_ID','video_id']),
    vurl:   pickField(r, ['video_url','Video_URL','video_URL']),
    vmode:  pickField(r, ['View_Mode','view_mode','ViewMode']),
    ttype:  pickField(r, ['Temp_Type','temp_type','TempType','Template_Type','template_type']),
    vin:    r.VIN || '',
    sku:    pickField(r, ['Sku_ID','sku_id']),
    tat:    parseTatHrs(pickField(r, [
              'TAT_Hrs','TAT_hrs','tat_hrs','tat_Hrs',
              'TAT_Hours','TAT_hours','tat_hours','TAT','tat'
            ])),
    // End-to-end TAT — from media_updated_at to updated_on (hours). Different
    // from `tat` which only measures the QC pipeline phase (created_on → updated_on).
    ete:    parseTatHrs(pickField(r, [
              'ETE_TAT_Hrs','ETE_TAT_hrs','ete_tat_hrs','ete_tat_Hrs',
              'ETE_TAT_Hours','ETE_TAT','ete_tat','ETE_Tat_Hrs'
            ])),
    sla:    parseSla(pickField(r, ['SLA_Flag','sla_flag','SLA','sla'])),
    // Per-team metadata (every row for the same team carries the same values)
    weblink: pickField(r, ['website_link','Website_Link','WebsiteLink','website','Website']),
    logo:    pickField(r, ['logo_url','Logo_URL','LogoUrl','logo','Logo']),
    // Media-level identifiers — separate from Video_ID; one media (image/video asset)
    mid:    pickField(r, ['asku.mediaId','asku_mediaId','mediaId','media_id','MediaId','Media_ID']),
    // NOTE: despite the internal field name `mc` (kept for backward-compat with
    // downstream code), this column actually holds media_updated_at, not
    // media_created_at — confirmed against the source SQL. Both name variants
    // are listed as fallback candidates in case the CSV header changes between
    // the two, so parsing doesn't silently break either way.
    mc:     pickField(r, [
              'media_updated_at','Media_Updated_At','MediaUpdatedAt','media_updated',
              'media_created_at','Media_Created_At','MediaCreatedAt','media_created',
            ]),
    c:      r.Created_ON || '',
    u:      r.Updated_ON || '',
  }));
  lastFetch = Date.now();
  return cache;
}

export default async function handler(req, res) {
  try {
    if (req.query.force === '1') { cache = null; cachedMeta = null; lastFetch = 0; }
    const rows = await loadRows();

    if (req.query.debug === '1') {
      // Tally parsed status values so the operator can verify what got through.
      const statusTally = {};
      for (const r of rows){
        const k = (r.status || '(empty)').toLowerCase();
        statusTally[k] = (statusTally[k] || 0) + 1;
      }
      return res.status(200).json({
        count: rows.length,
        rawHeaders: cachedMeta?.rawHeaders || [],
        // Per-header non-empty count for any raw column whose name contains
        // "status". If `v.status` shows 100% filled but parsed `status` shows
        // mostly (empty), the pickField fallback needs that key added.
        statusHeaderCoverageInRawCsv: cachedMeta?.statusHeaderCoverage || {},
        parsedStatusTally: statusTally,
        sample: rows.slice(0, 3),
        rawSample: cachedMeta?.rawSample || [],
        tatStats: {
          withTat: rows.filter(r => r.tat != null).length,
          avg:     (() => {
            const t = rows.filter(r => r.tat != null);
            return t.length ? +(t.reduce((a, b) => a + b.tat, 0) / t.length).toFixed(2) : null;
          })(),
        },
        slaStats: {
          flag1: rows.filter(r => r.sla === 1).length,
          flag0: rows.filter(r => r.sla === 0).length,
          deliveredAndFlag1: rows.filter(r => r.crm === 'qc_done' && r.ver === 'verified' && r.sla === 1).length,
          deliveredTotal:    rows.filter(r => r.crm === 'qc_done' && r.ver === 'verified').length,
        },
      });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      rows,
      count: rows.length,
      lastSynced: new Date(lastFetch).toISOString(),
    });
  } catch (err) {
    console.error('[data.js]', err);
    res.status(500).json({ error: err.message });
  }
}
