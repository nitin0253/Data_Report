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
  return isNaN(d.getTime()) ? null : d;
}
function isoMonth(d) { return d ? d.toISOString().slice(0, 7) : null; }

// ── TAT parsing → returns minutes (number) or null ─────────────
function parseTat(s) {
  if (s == null) return null;
  s = String(s).trim();
  if (!s || s.toLowerCase() === 'null' || s === 'NaN') return null;
  // HH:MM:SS or MM:SS
  if (s.includes(':')) {
    const parts = s.split(':').map(Number);
    if (parts.some(isNaN)) return null;
    if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / 60;
    if (parts.length === 2) return parts[0] + parts[1] / 60;
    return null;
  }
  const n = parseFloat(s);
  return (isNaN(n) || n < 0) ? null : n;
}

// ── SLA flag parsing → 1, 0, or null ───────────────────────────
function parseSla(s) {
  if (s == null) return null;
  s = String(s).trim().toLowerCase();
  if (!s || s === 'null') return null;
  if (s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'within' || s === 'within_sla') return 1;
  if (s === '0' || s === 'false' || s === 'no' || s === 'n' || s === 'out' || s === 'out_of_sla' || s === 'breached') return 0;
  return null;
}

function pickField(r, names) {
  for (const n of names) {
    if (r[n] != null && String(r[n]).trim() !== '') return r[n];
  }
  return '';
}

// ── Status helpers ─────────────────────────────────────────────
function isDelivered(r) { return r._crm === 'qc_done' && r._verified === 'verified'; }
function isRejected(r) {
  return r._crm === 'qc_done' && (
    r._verified === 'rejected' ||
    !r._verified ||
    r._verified === 'none'
  );
}
function isPending(r) { return r._crm !== 'qc_done'; }

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
  }

  cache = rows.map(r => {
    r._crm      = (pickField(r, ['CRM_Status','crm_status','crm status']) || '').toLowerCase().trim();
    r._verified = (pickField(r, ['verified_status','verified status','verified']) || '').toLowerCase().trim();
    r._team     = pickField(r, ['Team_Name','team_name','Team','team','qc_team','QC_Team','department','Department','group','Group']).trim();
    r._created  = safeDate(r.Created_ON);
    r._updated  = safeDate(r.Updated_ON);
    r._tat      = parseTat(pickField(r, [
      'TAT','tat','Tat','TAT_minutes','tat_minutes','TAT_seconds','tat_seconds',
      'turnaround_time','Turnaround_Time','TurnaroundTime','delivery_tat','Delivery_TAT'
    ]));
    r._sla = parseSla(pickField(r, [
      'SLA_Flag','sla_flag','SLA','sla','within_sla','Within_SLA','is_within_sla','SLA_Status','sla_status'
    ]));
    return r;
  });

  lastFetch = Date.now();
  return cache;
}

// ── Aggregate a filtered row array into stats ──────────────────
function aggregate(rows) {
  let totalReceived = 0, totalDelivered = 0, totalRejected = 0, totalPending = 0;
  let withinSla = 0, outOfSla = 0, slaUnknown = 0;
  let tatSum = 0, tatCount = 0;
  const entMap = {}, teamMap = {}, qcMap = {}, statusMap = {}, verifiedMap = {}, monthMap = {};
  // SLA breakdown per enterprise/team — useful for drill-down summaries
  const entBreak = {}, teamBreak = {};

  function bump(map, key, kind) {
    if (!map[key]) map[key] = { total: 0, delivered: 0, rejected: 0, pending: 0, withinSla: 0, outOfSla: 0 };
    map[key].total++;
    map[key][kind]++;
  }

  for (const r of rows) {
    totalReceived++;

    let kind = 'pending';
    if (isDelivered(r))     { totalDelivered++; kind = 'delivered'; }
    else if (isRejected(r)) { totalRejected++;  kind = 'rejected';  }
    else if (isPending(r))  { totalPending++;   kind = 'pending';   }

    if (r._sla === 1) withinSla++;
    else if (r._sla === 0) outOfSla++;
    else slaUnknown++;

    if (typeof r._tat === 'number' && isFinite(r._tat)) {
      tatSum += r._tat;
      tatCount++;
    }

    if (r.Ent_Name)    entMap[r.Ent_Name]   = (entMap[r.Ent_Name]   || 0) + 1;
    if (r._team)       teamMap[r._team]      = (teamMap[r._team]     || 0) + 1;
    if (r.qc_email_id) qcMap[r.qc_email_id] = (qcMap[r.qc_email_id] || 0) + 1;
    if (r.status)      statusMap[r.status]   = (statusMap[r.status]  || 0) + 1;

    const vs = r._verified || 'none';
    verifiedMap[vs] = (verifiedMap[vs] || 0) + 1;

    if (r.Ent_Name) {
      bump(entBreak, r.Ent_Name, kind);
      if (r._sla === 1) entBreak[r.Ent_Name].withinSla++;
      else if (r._sla === 0) entBreak[r.Ent_Name].outOfSla++;
    }
    if (r._team) {
      bump(teamBreak, r._team, kind);
      if (r._sla === 1) teamBreak[r._team].withinSla++;
      else if (r._sla === 0) teamBreak[r._team].outOfSla++;
    }

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
      withinSla, outOfSla, slaUnknown,
      avgTat: tatCount ? +(tatSum / tatCount).toFixed(2) : null,
      tatRecordCount: tatCount,
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
    breakdown: {
      enterprise: entBreak,
      team:       teamBreak,
    },
  };
}

// ── API handler ────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    const all = await loadCache();

    if (req.query.debug === '1') {
      const s = all.slice(0, 3);
      return res.status(200).json({
        total_rows: all.length,
        all_columns: Object.keys(s[0] || {}),
        sample: s.map(r => ({
          crm: r._crm, verified: r._verified, team: r._team,
          tat: r._tat, sla: r._sla,
          created: r._created?.toISOString() || null,
        })),
      });
    }

    const {
      start, end, enterprise, team, user,
      status: statusF, verified: verifiedF,
      sla, view,
    } = req.query;

    // ── Dropdown lists (from full dataset) ─────────────────────
    const enterpriseList = [...new Set(all.map(d => d.Ent_Name).filter(Boolean))].sort();
    const teamScope = (enterprise && enterprise !== 'all')
      ? all.filter(d => d.Ent_Name === enterprise) : all;
    const teamList = [...new Set(teamScope.map(d => d._team).filter(Boolean))].sort();

    let teamEnterprise = null;
    if (team && team !== 'all') {
      const match = all.find(d => d._team === team && d.Ent_Name);
      teamEnterprise = match?.Ent_Name || null;
    }
    const userList     = [...new Set(all.map(d => d.qc_email_id).filter(Boolean))].sort();
    const statusList   = [...new Set(all.map(d => d.status).filter(Boolean))].sort();
    const verifiedList = [...new Set(all.map(d => d._verified).filter(Boolean))].sort();

    // ── Filter on full dataset ─────────────────────────────────
    let filtered = all;
    if (enterprise && enterprise !== 'all') filtered = filtered.filter(d => d.Ent_Name === enterprise);
    if (team && team !== 'all')             filtered = filtered.filter(d => d._team === team);
    if (user && user !== 'all')             filtered = filtered.filter(d => d.qc_email_id === user);
    if (statusF && statusF !== 'all')       filtered = filtered.filter(d => d.status === statusF);
    if (verifiedF && verifiedF !== 'all')   filtered = filtered.filter(d => d._verified === verifiedF);
    if (sla === '1') filtered = filtered.filter(d => d._sla === 1);
    if (sla === '0') filtered = filtered.filter(d => d._sla === 0);

    if (start) {
      const s = new Date(start + 'T00:00:00');
      if (!isNaN(s.getTime())) filtered = filtered.filter(d => d._created && d._created >= s);
    }
    if (end) {
      const e = new Date(end + 'T23:59:59');
      if (!isNaN(e.getTime())) filtered = filtered.filter(d => d._created && d._created <= e);
    }

    // ── Aggregate FULL filtered dataset (so KPIs reflect all matches) ──
    const stats = aggregate(filtered);

    // ── For drill-down views, narrow further AFTER aggregate so the KPI
    //    numbers in the side panel still reflect the user's main filters. ──
    let drillRows = filtered;
    let sortByTat = false;
    if (view) {
      switch (view) {
        case 'delivered':  drillRows = filtered.filter(isDelivered); break;
        case 'rejected':   drillRows = filtered.filter(isRejected);  break;
        case 'pending':    drillRows = filtered.filter(isPending);   break;
        case 'within_sla': drillRows = filtered.filter(d => d._sla === 1); break;
        case 'out_of_sla': drillRows = filtered.filter(d => d._sla === 0); break;
        case 'tat':        drillRows = filtered.filter(d => typeof d._tat === 'number'); sortByTat = true; break;
        default: break;
      }
    }

    // ── Raw rows: sort + cap at 500 for table display ──────────
    const sorted = drillRows.slice().sort((a, b) => sortByTat
      ? (b._tat ?? -Infinity) - (a._tat ?? -Infinity)
      : (b._created?.getTime() || 0) - (a._created?.getTime() || 0));

    const rawRows = sorted.slice(0, 500).map(d => ({
      Ent_Name:        d.Ent_Name    || '',
      team:            d._team       || '',
      status:          d.status      || '',
      crm_status:      d._crm        || '',
      verified_status: d._verified   || '',
      qc_email_id:     d.qc_email_id || '',
      video_id:        d.Video_ID    || d.video_id || '',
      vin:             d.VIN         || d.vin || '',
      sku_id:          d.Sku_ID      || d.sku_id || '',
      tat:             d._tat,
      sla:             d._sla,
      Created_ON:      d.Created_ON  || '',
      Updated_ON:      d.Updated_ON  || '',
    }));

    return res.status(200).json({
      kpis:          stats.kpis,
      charts:        stats.charts,
      breakdown:     stats.breakdown,
      filters:       { enterpriseList, teamList, userList, statusList, verifiedList, teamEnterprise },
      raw:           rawRows,
      drillCount:    drillRows.length,
      totalFiltered: filtered.length,
      view:          view || null,
      lastSynced:    new Date(lastFetch).toISOString(),
    });

  } catch (err) {
    console.error('[data.js] handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
