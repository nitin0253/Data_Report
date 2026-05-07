export default async function handler(req, res) {
  const response = await fetch("https://metabase.spyne.ai/public/question/21760ff0-3e2b-43c2-a6f4-51c4dac4077f.csv");
  const data = await response.text();

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).send(data);
}
