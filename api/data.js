// pages/api/data.js
let cache = null;
let lastFetch = 0;
const CACHE_TIME = 60 * 1000;
const METABASE_URL =
  "https://metabase.spyne.ai/public/question/21760ff0-3e2b-43c2-a6f4-51c4dac4077f.csv";

// ── CSV parser ─────────────────────────────────────────────────
function parseCSVRow(row) {
  const out = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = parseCSVRow(lines[0]).map(h => h.trim());
  return lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const vals = parseCSVRow(line);
      const obj = {};
      headers.forEach((h, i) => (obj[h] = (vals[i] ?? '').trim()));
      return obj;
    });
}

// ── Date parsing ───────────────────────────────────────────────
function safeDate(str) {
  if (!str || str.trim() === '') return null;
  const s = str.trim().replace(' ', 'T');
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  return null;
}

function isoMonth(d) { return d ? d.toISOString().slice(0, 7) : null; }

// ── Status helpers ─────────────────────────────────────────────
function isDelivered(r) { return r._crm === 'qc_done' && r._verified === 'verified'; }
function isRejected(r)  { return r._crm === 'qc_done' && r._verified === 'rejected'; }
function isPending(r)   { return r._crm !== 'qc_done'; }

// ── Load and normalise cache ───────────────────────────────────
async function loadCache() {
  if (cache && Date.now() - lastFetch < CACHE_TIME) return cache;

  const resp = await fetch(METABASE_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) throw new Error(`Metabase responded ${resp.status}`);
  const text = await resp.text();
  const rows = parseCSV(text);

  if (rows.length > 0) {
    console.log('[data.js] columns:', Object.keys(rows[0]));
    console.log('[data.js] total rows:', rows.length);
    console.log('[data.js] sample Created_ON:', rows[0].Created_ON);
  }

  cache = rows.map(r => {
    r._crm = (r['CRM_Status'] || r['crm_status'] || r['crm status'] || '').toLowerCase().trim();
    r._verified = (r['verified_status'] || r['verified status'] || r['verified'] || '').toLowerCase().trim();
    r._team = (
      r['Team_Name'] || r['team_name'] || r['Team'] || r['team'] ||
      r['qc_team']   || r['QC_Team']  || r['department'] || r['Department'] ||
      r['group']     || r['Group']    || ''
    ).trim();
    r._created = safeDate(r.Created_ON);
    r._updated = safeDate(r.Updated_ON);
    return r;
  });

  lastFetch = Date.now();
  return cache;
}

// ── Aggregate a filtered row array into stats ──────────────────
function aggregate(rows) {
  let totalReceived = 0, totalDelivered = 0, totalRejected = 0, totalPending = 0;
  const entMap = {}, teamMap = {}, qcMap = {}, statusMap = {}, verifiedMap = {}, monthMap = {};

  for (const r of rows) {
    totalReceived++;

    if (isDelivered(r))     totalDelivered++;
    else if (isRejected(r)) totalRejected++;
    else if (isPending(r))  totalPending++;

    if (r.Ent_Name)    entMap[r.Ent_Name]   = (entMap[r.Ent_Name]   || 0) + 1;
    if (r._team)       teamMap[r._team]      = (teamMap[r._team]     || 0) + 1;
    if (r.qc_email_id) qcMap[r.qc_email_id] = (qcMap[r.qc_email_id] || 0) + 1;
    if (r.status)      statusMap[r.status]   = (statusMap[r.status]  || 0) + 1;

    const vs = r._verified || 'none';
    verifiedMap[vs] = (verifiedMap[vs] || 0) + 1;

    const m = isoMonth(r._created);
    if (m) {
      if (!monthMap[m]) monthMap[m] = { received: 0, delivered: 0, rejected: 0 };
      monthMap[m].received++;
      if (isDelivered(r))     monthMap[m].delivered++;
      else if (isRejected(r)) monthMap[m].rejected++;
    }
  }

  const sortedMonths = Object.keys(monthMap).sort();
  const monthly = {
    received:  Object.fromEntries(sortedMonths.map(k => [k, monthMap[k].received])),
    delivered: Object.fromEntries(sortedMonths.map(k => [k, monthMap[k].delivered])),
    rejected:  Object.fromEntries(sortedMonths.map(k => [k, monthMap[k].rejected])),
  };

  return {
    kpis: {
      totalReceived, totalDelivered, totalRejected, totalPending,
      totalEnterpriseCount: Object.keys(entMap).length,
      totalTeamCount:       Object.keys(teamMap).length,
    },
    charts: {
      monthly,
      enterprise: Object.fromEntries(Object.entries(entMap).sort((a,b)=>b[1]-a[1]).slice(0,12)),
      team:       Object.fromEntries(Object.entries(teamMap).sort((a,b)=>b[1]-a[1]).slice(0,12)),
      qc:         Object.fromEntries(Object.entries(qcMap).sort((a,b)=>b[1]-a[1]).slice(0,15)),
      status:     statusMap,
      verified:   verifiedMap,
    },
  };
}

// ── API handler ────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    const all = await loadCache();

    // Debug: /api/data?debug=1
    if (req.query.debug === '1') {
      const s = all.slice(0, 3);
      return res.status(200).json({
        total_rows:      all.length,
        all_columns:     Object.keys(s[0] || {}),
        sample_crm:      s.map(r => r._crm),
        sample_verified: s.map(r => r._verified),
        sample_team:     s.map(r => r._team),
        sample_ent:      s.map(r => r.Ent_Name),
        sample_created:  s.map(r => `${r.Created_ON}  →  ${r._created ? r._created.toISOString() : 'NULL'}`),
      });
    }

    const { start, end, enterprise, team, user, status: statusF, verified: verifiedF } = req.query;

    // ── Dropdown lists ─────────────────────────────────────────
    const enterpriseList = [...new Set(all.map(d => d.Ent_Name).filter(Boolean))].sort();

    // Team list scoped to enterprise (for cascade dropdown)
    const teamScope = (enterprise && enterprise !== 'all')
      ? all.filter(d => d.Ent_Name === enterprise)
      : all;
    const teamList = [...new Set(teamScope.map(d => d._team).filter(Boolean))].sort();

    // Reverse lookup: which enterprise does this team belong to?
    let teamEnterprise = null;
    if (team && team !== 'all') {
      const match = all.find(d => d._team === team && d.Ent_Name);
      teamEnterprise = match?.Ent_Name || null;
    }

    const userList     = [...new Set(all.map(d => d.qc_email_id).filter(Boolean))].sort();
    const statusList   = [...new Set(all.map(d => d.status).filter(Boolean))].sort();
    const verifiedList = [...new Set(all.map(d => d._verified).filter(Boolean))].sort();

    // ── Filter on FULL dataset (no 500-row cap here) ───────────
    let filtered = all;

    if (enterprise && enterprise !== 'all')
      filtered = filtered.filter(d => d.Ent_Name === enterprise);
    if (team && team !== 'all')
      filtered = filtered.filter(d => d._team === team);
    if (user && user !== 'all')
      filtered = filtered.filter(d => d.qc_email_id === user);
    if (statusF && statusF !== 'all')
      filtered = filtered.filter(d => d.status === statusF);
    if (verifiedF && verifiedF !== 'all')
      filtered = filtered.filter(d => d._verified === verifiedF);

    if (start) {
      const s = new Date(start + 'T00:00:00');
      if (!isNaN(s.getTime())) filtered = filtered.filter(d => d._created && d._created >= s);
    }
    if (end) {
      const e = new Date(end + 'T23:59:59');
      if (!isNaN(e.getTime())) filtered = filtered.filter(d => d._created && d._created <= e);
    }

    // ── Aggregate on the entire filtered dataset ───────────────
    const stats = aggregate(filtered);

    // ── Raw table rows: sorted newest-first, display cap 500 ──
    const rawRows = filtered
      .slice()
      .sort((a, b) => (b._created?.getTime() || 0) - (a._created?.getTime() || 0))
      .slice(0, 500)
      .map(d => ({
        Ent_Name:        d.Ent_Name    || '',
        team:            d._team       || '',
        status:          d.status      || '',
        crm_status:      d._crm        || '',
        verified_status: d._verified   || '',
        qc_email_id:     d.qc_email_id || '',
        video_id:        d.Video_ID    || '',
        vin:             d.VIN         || '',
        sku_id:          d.Sku_ID      || '',
        Created_ON:      d.Created_ON  || '',
        Updated_ON:      d.Updated_ON  || '',
      }));

    return res.status(200).json({
      kpis:          stats.kpis,
      charts:        stats.charts,
      filters:       { enterpriseList, teamList, userList, statusList, verifiedList, teamEnterprise },
      raw:           rawRows,
      totalFiltered: filtered.length,
      lastSynced:    new Date(lastFetch).toISOString(),
    });

  } catch (err) {
    console.error('[data.js] handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
