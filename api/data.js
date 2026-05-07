export default async function handler(req, res) {
  try {
    const response = await fetch(
      "https://metabase.spyne.ai/public/question/21760ff0-3e2b-43c2-a6f4-51c4dac4077f.csv",
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "text/csv"
        }
      }
    );

    const text = await response.text();

    const [header, ...rows] = text.trim().split("\n");
    const cols = header.split(",");

    const data = rows.map(r => {
      const vals = r.split(",");
      let obj = {};
      cols.forEach((c,i)=> obj[c.trim()] = vals[i]);

      obj.createdDate = new Date(obj.Created_ON.replace(",", ""));
      obj.updatedDate = new Date(obj.Updated_ON.replace(",", ""));

      return obj;
    });

    const today = new Date().toISOString().slice(0,10);

    let receivedToday = 0;
    let deliveredToday = 0;
    let totalDelivered = 0;

    const entMap = {};
    const qcMap = {};
    const statusMap = {};
    let tatArr = [];

    data.forEach(d => {
      const created = d.createdDate.toISOString().slice(0,10);
      const updated = d.updatedDate.toISOString().slice(0,10);

      if (created === today) receivedToday++;

      if (d.status === "done") {
        totalDelivered++;
        if (updated === today) deliveredToday++;
      }

      entMap[d.Ent_Name] = (entMap[d.Ent_Name] || 0) + 1;
      qcMap[d.qc_email_id] = (qcMap[d.qc_email_id] || 0) + 1;
      statusMap[d.status] = (statusMap[d.status] || 0) + 1;

      if (d.createdDate && d.updatedDate) {
        tatArr.push((d.updatedDate - d.createdDate)/60000);
      }
    });

    const avgTat = tatArr.length
      ? tatArr.reduce((a,b)=>a+b,0)/tatArr.length
      : 0;

    res.setHeader("Access-Control-Allow-Origin", "*");

    return res.status(200).json({
      kpis: {
        receivedToday,
        deliveredToday,
        totalDelivered,
        avgTat: avgTat.toFixed(1)
      },
      enterprise: entMap,
      qc: qcMap,
      status: statusMap
    });

  } catch (err) {
    return res.status(500).send(err.message);
  }
}
