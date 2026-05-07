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

    if (!response.ok) {
      return res.status(500).send("Failed to fetch CSV: " + response.status);
    }

    const data = await response.text();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "text/plain");

    return res.status(200).send(data);

  } catch (err) {
    return res.status(500).send("Error: " + err.message);
  }
}
