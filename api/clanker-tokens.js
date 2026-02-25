// Vercel serverless function — proxies Clanker API to avoid CORS issues
module.exports = async function handler(req, res) {
  const chainId = req.query.chainId ?? '130';
  try {
    const r = await fetch(
      `https://www.clanker.world/api/tokens?chainId=${chainId}&sort=desc&limit=50`,
    );
    const data = await r.json();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.json(data);
  } catch {
    res.status(500).json({ data: [] });
  }
}
