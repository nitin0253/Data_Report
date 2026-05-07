// pages/api/data.js
let cache = null;
let lastFetch = 0;
const CACHE_TIME = 60 * 1000;
const METABASE_URL =
  "https://metabase.spyne.ai/public/question/21760ff0-3e2b-43c2-a6f4-51c4dac4077f.csv";

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
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

const isoMonth = (d) => (d ? d.toISOString().slice(0, 7) : null);

// ── Status helpers ─────────────────────────────────────────────
// CSV column is literally "verified_status" (with a space)
// crm_status and verified_status are both lowercased on ingest (see loadCache)
function isDelivered(r) {
  return r._crm === "qc_done" && r._verified === "verified";
}
function isRejected(r) {
  return r._crm === "qc_done" && r._verified === "rejected";
}
function isPending(r) {
  return r._crm !== "qc_done";
}

async function loadCache() {
  if (cache && Date.now() - lastFetch < CACHE_TIME) return cache;
  const resp = await fetch(METABASE_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!resp.ok) throw new Error(`Metabase responded ${resp.status}`);
  const text = await resp.text();
  const rows = parseCSV(text);
  cache = rows.map(r => {
    // Normalize the two key fields — handle "crm_status", "verified_status", etc.
    r._crm      = (r["crm_status"]      || r["crm status"]      || "").toLowerCase().trim();
    r._verified = (r["verified_status"] || r["verified_status"] || r["verified"] || "").toLowerCase().trim();

    // Write back clean display values
    r.crm_status      = r._crm;
    r.verified_status = r._verified;

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

    // Debug helper — visit /api/data?debug=1 to confirm column values
    if (req.query.debug === "1") {
      const sample = all.slice(0, 5);
      return res.status(200).json({
        all_columns:      Object.keys(sample[0] || {}),
        crm_samples:      sample.map(r => r._crm),
        verified_samples: sample.map(r => r._verified),
      });
    }

    const { start, end, enterprise, user, status: statusFilter } = req.query;

    const enterpriseList = [...new Set(all.map(d => d.Ent_Name).filter(Boolean))].sort();
    const userList       = [...new Set(all.map(d => d.qc_email_id).filter(Boolean))].sort();
    const statusList     = [...new Set(all.map(d => d.status).filter(Boolean))].sort();

    let data = all;
    if (enterprise && enterprise !== "all")     data = data.filter(d => d.Ent_Name === enterprise);
    if (user && user !== "all")                 data = data.filter(d => d.qc_email_id === user);
    if (statusFilter && statusFilter !== "all") data = data.filter(d => d.status === statusFilter);
    if (start) {
      const s = new Date(start);
      data = data.filter(d => d.created && d.created >= s);
    }
    if (end) {
      const e = new Date(end);
      e.setHours(23, 59, 59, 999);
      data = data.filter(d => d.created && d.created <= e);
    }

    let totalReceived  = 0;
    let totalDelivered = 0;
    let totalRejected  = 0;
    let totalPending   = 0;

    const entMap    = {};
    const qcMap     = {};
    const statusMap = {};
    const monthMap  = {};

    for (const d of data) {
      totalReceived++;

      if (isDelivered(d))     totalDelivered++;
      else if (isRejected(d)) totalRejected++;
      else if (isPending(d))  totalPending++;

      if (d.Ent_Name)    entMap[d.Ent_Name]   = (entMap[d.Ent_Name]   || 0) + 1;
      if (d.qc_email_id) qcMap[d.qc_email_id] = (qcMap[d.qc_email_id] || 0) + 1;
      if (d.status)      statusMap[d.status]  = (statusMap[d.status]  || 0) + 1;

      const m = isoMonth(d.created);
      if (m) {
        if (!monthMap[m]) monthMap[m] = { received: 0, delivered: 0, rejected: 0 };
        monthMap[m].received++;
        if (isDelivered(d))     monthMap[m].delivered++;
        else if (isRejected(d)) monthMap[m].rejected++;
      }
    }

    const topEnt = Object.fromEntries(
      Object.entries(entMap).sort((a, b) => b[1] - a[1]).slice(0, 12)
    );
    const topQc = Object.fromEntries(
      Object.entries(qcMap).sort((a, b) => b[1] - a[1]).slice(0, 15)
    );
    const sortedMonthKeys = Object.keys(monthMap).sort();
    const monthlySorted = {
      received:  Object.fromEntries(sortedMonthKeys.map(k => [k, monthMap[k].received])),
      delivered: Object.fromEntries(sortedMonthKeys.map(k => [k, monthMap[k].delivered])),
      rejected:  Object.fromEntries(sortedMonthKeys.map(k => [k, monthMap[k].rejected])),
    };

    return res.status(200).json({
      kpis: { totalReceived, totalDelivered, totalRejected, totalPending, totalRecords: data.length },
      filters: { enterpriseList, userList, statusList },
      charts: { enterprise: topEnt, qc: topQc, status: statusMap, monthly: monthlySorted },
      raw: data
        .slice()
        .sort((a, b) => (b.created?.getTime() || 0) - (a.created?.getTime() || 0))
        .slice(0, 500)
        .map(d => ({
          Ent_Name:        d.Ent_Name,
          status:          d.status,
          crm_status:      d._crm,
          verified_status: d._verified,
          qc_email_id:     d.qc_email_id,
          video_id:        d.video_id,
          vin:             d.vin,
          sku_id:          d.sku_id,
          Created_ON:      d.Created_ON,
          Updated_ON:      d.Updated_ON,
        })),
      lastSynced: new Date(lastFetch).toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
