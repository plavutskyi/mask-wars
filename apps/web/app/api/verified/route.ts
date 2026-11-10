import { ACCEPTED_TCB } from '@maskwars/mind/attestation';
import { MODELS, overall, verified, verifiedAll } from '@/lib/verified';

// GET /api/verified[?model=<id>]: the live attestation of every model the masks think with. Each check made its own
// fresh nonce; results are reused for up to five minutes (thirty seconds when something did not pass).
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const HEADERS = { 'cache-control': 'no-store', 'access-control-allow-origin': '*' };

const ABOUT = {
  docs: 'https://docs.near.ai/cloud/verification',
  checks: [
    'Intel TDX quote verified up to Intel root CA with Intel collateral (dcap-qvl)',
    'not a debug TD',
    'fresh nonce echoed and in quote report_data[32..64]',
    'report_data[0..32] binds the TEE signing address',
    'MRCONFIGID = 01 || sha256(app_compose) || 15 zero bytes',
    'event log replays to RTMR3',
    'model nodes: NVIDIA NRAS passes every GPU for the nonce (secure boot on, debug off, measurements matched)',
  ],
  acceptedTcb: ACCEPTED_TCB,
  notCovered: [
    'image provenance of the measured containers',
    'NVIDIA token signature (verdict read over TLS from NVIDIA)',
    'which instance answered a given completion (instances of one model share a signing key)',
  ],
};

export async function GET(req: Request) {
  const model = new URL(req.url).searchParams.get('model');
  if (model !== null && !MODELS.includes(model)) {
    return Response.json({ error: `unknown model; one of: ${MODELS.join(', ')}` }, { status: 404, headers: HEADERS });
  }
  const models = model ? [await verified(model)] : await verifiedAll();
  return Response.json({ outcome: overall(models), models, about: ABOUT }, { headers: HEADERS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...HEADERS, 'access-control-allow-methods': 'GET, OPTIONS' } });
}
