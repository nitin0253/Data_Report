let cache = null;
let lastFetch = 0;

const CACHE_TIME = 60 * 1000; // 1 min

function safeDate(str) {
  if (!str) return null;
  return new Date(str.replace(/,/g, ""));
}

export default async function handler(req, res) {
  try {
    // ✅ Use cache if recent
    if (cache && Date.now() - lastFetch < CACHE_TIME) {
      return res.status(200).json(cache);
    }

    const response = await fetch(
      "https://metabase.spyne.ai/public/question/21760ff0-3e2b-43c2-a6f4-51c4dac4077f.csv",
      {
        headers: { "User-Agent": "Mozilla/5.0" }
      }
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

    cache = data;
    lastFetch = Date.now();

    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
