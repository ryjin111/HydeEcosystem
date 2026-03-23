// HydeTokenFactory event reader — replaces old Clanker proxy
// Returns the 50 most recent TokenLaunched events from the factory on Optimism.

const FACTORY      = '0x83f5945b257aA3adBa2F572e0BC23d42DA9f4273';
const TOPIC        = '0xe6909668d179e62e5187846d18f40674b9798fa796e6303f68f49f8a0fca8735';
const FROM_BLOCK   = '0x' + (149_100_000).toString(16); // before factory deploy
const RPC          = process.env.RPC_URL ?? 'https://mainnet.optimism.io';

function decodeAbiString(hex) {
  if (!hex || hex === '0x') return '';
  try {
    const data = hex.slice(2);
    const len  = parseInt(data.slice(64, 128), 16);
    const raw  = data.slice(128, 128 + len * 2);
    return Buffer.from(raw, 'hex').toString('utf8').replace(/\0/g, '');
  } catch { return ''; }
}

export default async function handler(req, res) {
  try {
    // 1. Fetch TokenLaunched logs
    const logsRes = await fetch(RPC, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
        params: [{ address: FACTORY, topics: [TOPIC], fromBlock: FROM_BLOCK, toBlock: 'latest' }],
      }),
    });
    const { result: logs = [] } = await logsRes.json();

    if (logs.length === 0) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
      return res.json({ data: [] });
    }

    // Sort newest first, cap at 50
    const sorted = [...logs]
      .sort((a, b) => parseInt(b.blockNumber, 16) - parseInt(a.blockNumber, 16))
      .slice(0, 50);

    // token address is in topics[1] (left-padded to 32 bytes)
    const addresses = sorted.map(log => '0x' + log.topics[1].slice(26));

    // 2. Batch: name() + symbol() per token + eth_getBlockByNumber per unique block
    const uniqueBlocks = [...new Set(sorted.map(l => l.blockNumber))];
    let id = 2;
    const calls = [];

    const nameIds   = addresses.map(addr => {
      calls.push({ jsonrpc: '2.0', id: id++, method: 'eth_call', params: [{ to: addr, data: '0x06fdde03' }, 'latest'] });
      return id - 1;
    });
    const symbolIds = addresses.map(addr => {
      calls.push({ jsonrpc: '2.0', id: id++, method: 'eth_call', params: [{ to: addr, data: '0x95d89b41' }, 'latest'] });
      return id - 1;
    });
    const blockIdMap = {};
    for (const blk of uniqueBlocks) {
      blockIdMap[blk] = id;
      calls.push({ jsonrpc: '2.0', id: id++, method: 'eth_getBlockByNumber', params: [blk, false] });
    }

    const batchRes  = await fetch(RPC, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(calls),
    });
    const batchData = await batchRes.json();
    if (!Array.isArray(batchData)) throw new Error('Batch RPC returned non-array');
    const byId = Object.fromEntries(batchData.map(r => [r.id, r.result]));

    // 3. Build response in the shape useClankerTokens() expects
    const data = sorted.map((log, i) => {
      const ts = byId[blockIdMap[log.blockNumber]]?.timestamp;
      return {
        contract_address: addresses[i],
        pool_address:      addresses[i],
        name:              decodeAbiString(byId[nameIds[i]])   || 'Unknown',
        symbol:            decodeAbiString(byId[symbolIds[i]]) || '???',
        deployed_at:       ts ? new Date(parseInt(ts, 16) * 1000).toISOString() : new Date().toISOString(),
      };
    });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.json({ data });
  } catch (err) {
    console.error('[clanker-tokens] error:', err?.message ?? err);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ data: [] });
  }
}
