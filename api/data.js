let cache = null;
let lastFetch = 0;

const CACHE_TIME = 60 * 1000;

function safeDate(str) {
  if (!str) return null;
  return new Date(str.replace(/,/g, ""));
}

export default async function handler(req, res) {
  try {
    if (cache && Date.now() - lastFetch < CACHE_TIME) {
      return res.status(200).json(cache);
    }

    const response = await fetch(
      "https://metabase.spyne.ai/public/question/21760ff0-3e2b-43c2-a6f4-51c4dac4077f.csv",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );

    const text = await response.text();

    const [header, ...rows] = text.trim().split("\n");
    const cols = header.split(",");

    const data = rows.map(r => {
      const vals = r.split(",");
      let obj = {};
      cols.forEach((c, i) => (obj[c.trim()] = vals[i]));

      obj.created = safeDate(obj.Created_ON);
      obj.updated = safeDate(obj.Updated_ON);

      return obj;
    });

    const today = new Date().toISOString().slice(0, 10);

    let receivedToday = 0;
    let deliveredToday = 0;
    let totalDelivered = 0;

    const entMap = {};
    const qcMap = {};
    const statusMap = {};
    const monthMap = {};
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

      const month = d.created?.toISOString().slice(0, 7);
      if (month) monthMap[month] = (monthMap[month] || 0) + 1;

      if (d.created && d.updated) {
        tatArr.push((d.updated - d.created) / 60000);
      }
    });

    const avgTat = tatArr.length
      ? tatArr.reduce((a, b) => a + b, 0) / tatArr.length
      : 0;

    const result = {
      kpis: {
        receivedToday,
        deliveredToday,
        totalDelivered,
        avgTat: avgTat.toFixed(1)
      },
      enterpriseList: Object.keys(entMap),
      charts: {
        enterprise: entMap,
        qc: qcMap,
        status: statusMap,
        monthly: monthMap
      }
    };

    cache = result;
    lastFetch = Date.now();

    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
