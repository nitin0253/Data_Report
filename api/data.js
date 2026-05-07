let cache = null;
let lastFetch = 0;

const CACHE_TIME = 60 * 1000;

function safeDate(str) {
  if (!str) return null;
  return new Date(str.replace(/,/g, ""));
}

export default async function handler(req, res) {
  try {
    if (!cache || Date.now() - lastFetch > CACHE_TIME) {
      const response = await fetch(
        "https://metabase.spyne.ai/public/question/21760ff0-3e2b-43c2-a6f4-51c4dac4077f.csv",
        { headers: { "User-Agent": "Mozilla/5.0" } }
      );

      const text = await response.text();

      const [header, ...rows] = text.trim().split("\n");
      const cols = header.split(",");

      cache = rows.map(r => {
        const vals = r.split(",");
        let obj = {};
        cols.forEach((c, i) => (obj[c.trim()] = vals[i]));

        obj.created = safeDate(obj.Created_ON);
        obj.updated = safeDate(obj.Updated_ON);

        return obj;
      });

      lastFetch = Date.now();
    }

    let data = cache;

    // 🔥 FILTERS
    const { start, end, enterprise } = req.query;

    if (enterprise && enterprise !== "all") {
      data = data.filter(d => d.Ent_Name === enterprise);
    }

    if (start) {
      data = data.filter(d => d.created && d.created >= new Date(start));
    }

    if (end) {
      data = data.filter(d => d.created && d.created <= new Date(end));
    }

    const today = new Date().toISOString().slice(0, 10);

    let receivedToday = 0, deliveredToday = 0, totalDelivered = 0;
    const entMap = {}, qcMap = {}, statusMap = {}, monthMap = {};
    let tatArr = [];

    data.forEach(d => {
      const c = d.created?.toISOString().slice(0, 10);
      const u = d.updated?.toISOString().slice(0, 10);

      if (c === today) receivedToday++;

      if (d.status === "done") {
        totalDelivered++;
        if (u === today) deliveredToday++;
      }

      entMap[d.Ent_Name] = (entMap[d.Ent_Name] || 0) + 1;
      qcMap[d.qc_email_id] = (qcMap[d.qc_email_id] || 0) + 1;
      statusMap[d.status] = (statusMap[d.status] || 0) + 1;

      const m = d.created?.toISOString().slice(0, 7);
      if (m) monthMap[m] = (monthMap[m] || 0) + 1;

      if (d.created && d.updated) {
        tatArr.push((d.updated - d.created) / 60000);
      }
    });

    const avgTat = tatArr.length
      ? tatArr.reduce((a, b) => a + b, 0) / tatArr.length
      : 0;

    return res.status(200).json({
      kpis: {
        receivedToday,
        deliveredToday,
        totalDelivered,
        avgTat: avgTat.toFixed(1)
      },
      enterpriseList: Object.keys(entMap).sort(),
      charts: {
        enterprise: entMap,
        qc: qcMap,
        status: statusMap,
        monthly: monthMap
      },
      raw: data.slice(0, 200) // for drilldown
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
