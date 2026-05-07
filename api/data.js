export default async function handler(req, res) {
  try {
    const response = await fetch(
      "https://metabase.spyne.ai/public/question/21760ff0-3e2b-43c2-a6f4-51c4dac4077f.csv",
      {
        headers: {
          "User-Agent": "Mozilla/5.0"
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

      obj.created = parseDateSafe(obj.Created_ON);
      obj.updated = parseDateSafe(obj.Updated_ON);

      return obj;
    });

    res.status(200).json(data);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
