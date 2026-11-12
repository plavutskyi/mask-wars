import { associatedTokenAccount, mintDecimals, nearCoinOf, solanaKey, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '@maskwars/pay';
import { guard, reply } from '@/lib/pay';
import { nearCatalog, nearProblem } from '@/lib/getnear';

// What a Solana wallet payment needs from the chain: a recent blockhash and, for a token, which program owns its mint and
// its decimals, read from the mint itself so the page never sends at the wrong scale; with `owner`, what the payer holds
// (SOL, and the token in its token account), so a payment that cannot go through is not offered for signing. Only for a
// coin on offer: this is not an open door to a Solana node.
export const dynamic = 'force-dynamic';

const RPCS = (process.env.SOLANA_RPC ?? 'https://solana-rpc.publicnode.com,https://api.mainnet-beta.solana.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let last: unknown = null;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(6_000),
      });
      const json = (await res.json()) as { result?: T; error?: unknown };
      if (res.ok && json.result !== undefined) return json.result;
      last = json.error ?? res.status;
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`no Solana node answered: ${String(last)}`);
}

export async function GET(req: Request) {
  const no = guard(req, 'near-solana', 40);
  if (no) return no;
  const url = new URL(req.url);
  const assetId = url.searchParams.get('asset') ?? '';
  const owner = url.searchParams.get('owner');
  if (owner !== null && !solanaKey(owner)) return nearProblem('bad', 400);
  try {
    const hit = nearCoinOf(await nearCatalog(), assetId);
    if (!hit || hit.chain.id !== 'sol') return nearProblem('bad', 400);
    // `confirmed`: newer than `finalized`, so the transaction has the most of its ~60 s before the blockhash expires.
    const { value } = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const lamports = owner ? await rpc<{ value: number }>('getBalance', [owner, { commitment: 'confirmed' }]).then((r) => String(r.value)).catch(() => null) : null;
    if (!hit.coin.contract) return reply({ blockhash: value.blockhash, mint: null, lamports, balance: lamports });
    const info = await rpc<{ value: { owner: string; data: [string, string] } | null }>('getAccountInfo', [hit.coin.contract, { encoding: 'base64' }]);
    const decimals = info.value ? mintDecimals(info.value.data[0]) : null;
    const program = info.value?.owner;
    if ((program !== TOKEN_PROGRAM && program !== TOKEN_2022_PROGRAM) || decimals === null) return nearProblem('route', 422);
    let balance: string | null = null;
    if (owner) {
      // No token account yet reads as an error from the node: the payer holds none of the token.
      const ata = associatedTokenAccount(owner, hit.coin.contract, program);
      balance = await rpc<{ value: { amount: string } }>('getTokenAccountBalance', [ata, { commitment: 'confirmed' }])
        .then((r) => r.value.amount)
        .catch(() => '0');
    }
    return reply({ blockhash: value.blockhash, mint: { address: hit.coin.contract, program, decimals }, lamports, balance });
  } catch {
    return nearProblem('busy', 503);
  }
}
