// pages/api/data.js  (Next.js API route)

let cache = null;
let lastFetch = 0;
const CACHE_TIME = 60 * 1000; // 1 min

const METABASE_URL =
  "https://metabase.spyne.ai/public/question/21760ff0-3e2b-43c2-a6f4-51c4dac4077f.csv";

// ---- robust CSV parsing (handles quoted fields, commas in values, escaped quotes) ----
function parseCSVRow(row) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = parseCSVRow(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = parseCSVRow(line);
    const obj = {};
    headers.forEach((h, i) => (obj[h] = (vals[i] ?? "").trim()));
    return obj;
  });
}

function safeDate(str) {
  if (!str) return null;
  // Metabase CSVs typically emit ISO; new Date() handles that fine.
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

const isoDay = (d) => (d ? d.toISOString().slice(0, 10) : null);
const isoMonth = (d) => (d ? d.toISOString().slice(0, 7) : null);

const DONE_STATUSES = new Set(["done", "delivered", "completed", "complete"]);
const REJECTED_STATUSES = new Set(["rejected", "reject", "qc_rejected"]);

async function loadCache() {
  if (cache && Date.now() - lastFetch < CACHE_TIME) return cache;
  const resp = await fetch(METABASE_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!resp.ok) throw new Error(`Metabase responded ${resp.status}`);
  const text = await resp.text();
  const rows = parseCSV(text);
  cache = rows.map(r => {
    r.created = safeDate(r.Created_ON);
    r.updated = safeDate(r.Updated_ON);
    return r;
  });
  lastFetch = Date.now();
  return cache;
}

export default async function handler(req, res) {
  try {
    const all = await loadCache();
    const { start, end, enterprise, user, status: statusFilter } = req.query;

    // Build filter dropdowns from FULL dataset so they don't shrink as user filters.
    const enterpriseList = [...new Set(all.map(d => d.Ent_Name).filter(Boolean))].sort();
    const userList       = [...new Set(all.map(d => d.qc_email_id).filter(Boolean))].sort();
    const statusList     = [...new Set(all.map(d => d.status).filter(Boolean))].sort();

    // Apply filters
    let data = all;
    if (enterprise && enterprise !== "all")    data = data.filter(d => d.Ent_Name === enterprise);
    if (user && user !== "all")                 data = data.filter(d => d.qc_email_id === user);
    if (statusFilter && statusFilter !== "all") data = data.filter(d => d.status === statusFilter);
    if (start) {
      const s = new Date(start);
      data = data.filter(d => d.created && d.created >= s);
    }
    if (end) {
      const e = new Date(end);
      e.setHours(23, 59, 59, 999); // inclusive of full end day
      data = data.filter(d => d.created && d.created <= e);
    }

    const today = new Date().toISOString().slice(0, 10);

    let receivedToday = 0;
    let deliveredToday = 0;                  // closed today, regardless of when created
    let deliveredTodayFromTodayCreated = 0;  // created today AND closed today
    let totalDelivered = 0;
    let rejectedCount = 0;
    let rejectedToday = 0;
    let pendingCount = 0;

    const entMap = {}, qcMap = {}, statusMap = {}, monthMap = {}, dailyMap = {};
    const tatArr = [];

    for (const d of data) {
      const cDay = isoDay(d.created);
      const uDay = isoDay(d.updated);
      const s = (d.status || "").toLowerCase();

      if (cDay === today) receivedToday++;

      if (DONE_STATUSES.has(s)) {
        totalDelivered++;
        if (uDay === today) deliveredToday++;
        if (cDay === today && uDay === today) deliveredTodayFromTodayCreated++;
      } else if (REJECTED_STATUSES.has(s)) {
        rejectedCount++;
        if (uDay === today) rejectedToday++;
      } else {
        pendingCount++;
      }

      if (d.Ent_Name)     entMap[d.Ent_Name]     = (entMap[d.Ent_Name] || 0) + 1;
      if (d.qc_email_id)  qcMap[d.qc_email_id]   = (qcMap[d.qc_email_id] || 0) + 1;
      if (d.status)       statusMap[d.status]    = (statusMap[d.status] || 0) + 1;

      const m = isoMonth(d.created);
      if (m)              monthMap[m]            = (monthMap[m] || 0) + 1;
      if (cDay)           dailyMap[cDay]         = (dailyMap[cDay] || 0) + 1;

      if (d.created && d.updated && d.updated >= d.created) {
        tatArr.push((d.updated - d.created) / 60000); // minutes
      }
    }

    const avgTat = tatArr.length
      ? tatArr.reduce((a, b) => a + b, 0) / tatArr.length
      : 0;

    // Keep payload reasonable: top N for high-cardinality dimensions, sorted months.
    const topEnt = Object.fromEntries(
      Object.entries(entMap).sort((a, b) => b[1] - a[1]).slice(0, 12)
    );
    const topQc = Object.fromEntries(
      Object.entries(qcMap).sort((a, b) => b[1] - a[1]).slice(0, 15)
    );
    const monthlySorted = Object.fromEntries(
      Object.entries(monthMap).sort((a, b) => a[0].localeCompare(b[0]))
    );

    return res.status(200).json({
      kpis: {
        receivedToday,
        deliveredToday,
        deliveredTodayFromTodayCreated,
        totalDelivered,
        rejectedCount,
        rejectedToday,
        pendingCount,
        totalRecords: data.length,
        avgTat: avgTat.toFixed(1),
      },
      filters: { enterpriseList, userList, statusList },
      charts: {
        enterprise: topEnt,
        qc: topQc,
        status: statusMap,
        monthly: monthlySorted,
      },
      raw: data
        .slice()
        .sort((a, b) => (b.created?.getTime() || 0) - (a.created?.getTime() || 0))
        .slice(0, 500)
        .map(d => ({
          Ent_Name: d.Ent_Name,
          status: d.status,
          qc_email_id: d.qc_email_id,
          Created_ON: d.Created_ON,
          Updated_ON: d.Updated_ON,
        })),
      lastSynced: new Date(lastFetch).toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
