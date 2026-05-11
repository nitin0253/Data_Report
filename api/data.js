// pages/api/data.js
// Thin layer over Metabase — caches the CSV, parses rows, returns raw rows.
// All filtering and aggregation now happens client-side for sub-second filter UX.

let cache = null;
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

  // Keep field names short — payload is sent to client and we want it lean.
  cache = rows.map(r => ({
    ent:    r.Ent_Name || '',
    team:   pickField(r, ['Team_Name','team_name','Team','team']),
    qc:     r.qc_email_id || '',
    status: r.status || '',
    crm:    (pickField(r, ['CRM_Status','crm_status']) || '').toLowerCase().trim(),
    ver:    (pickField(r, ['verified_status']) || '').toLowerCase().trim(),
    vid:    pickField(r, ['Video_ID','video_id']),
    vin:    r.VIN || '',
    sku:    pickField(r, ['Sku_ID','sku_id']),
    tat:    parseTatHrs(pickField(r, [
              'TAT_Hrs','TAT_hrs','tat_hrs','tat_Hrs',
              'TAT_Hours','TAT_hours','tat_hours','TAT','tat'
            ])),
    sla:    parseSla(pickField(r, ['SLA_Flag','sla_flag','SLA','sla'])),
    c:      r.Created_ON || '',
    u:      r.Updated_ON || '',
  }));
  lastFetch = Date.now();
  return cache;
}

export default async function handler(req, res) {
  try {
    if (req.query.force === '1') { cache = null; lastFetch = 0; }
    const rows = await loadRows();

    if (req.query.debug === '1') {
      return res.status(200).json({
        count: rows.length,
        sample: rows.slice(0, 3),
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
