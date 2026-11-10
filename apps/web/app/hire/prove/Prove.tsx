'use client';

import Image from 'next/image';
import { useEffect, useId, useRef, useState } from 'react';
import { accountOf, base64, base64url, fromBase64url, keyBytes, type Assertion } from '@maskwars/pay';
import { passkeysSupported } from '@maskwars/pay/passkey';
import {
  accountOk,
  cleanAccount,
  jobText,
  keyFromTwo,
  keyOfAssertion,
  originOk,
  proofEnvelope,
  proofHash,
  proofMessage,
  proofTime,
  relayOk,
  teamOk,
  type ProofAsk,
  type VaultProof,
} from '@maskwars/hire';
import { Mark } from '@/components/Mark';
import { nearSignIn } from '@/app/wallet/near';
import { loadWho, rememberKnown } from '@/app/wallet/store';
import { pageName } from '../embed/host';
import { shortAccount, vaultName } from '../ui';
import s from '../embed/checkout.module.css';
import p from './prove.module.css';

/** What the checkout handed this window in its address's fragment (never sent to a server): the job, and its relay. */
interface Ask {
  readonly relay: string;
  readonly text: string;
  readonly target: string;
  /** The vault the page named, if it named one: only its holder can prove it. */
  readonly team: string | null;
  readonly page: string | null;
}

function readAsk(hash: string): Ask | null {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const relay = q.get('r');
  const text = jobText(q.get('t') ?? '');
  const target = cleanAccount(q.get('g') ?? '');
  const team = q.get('m') ? cleanAccount(q.get('m')!) : null;
  const page = q.get('p') ? originOk(q.get('p')!) : null;
  if (!relayOk(relay) || !text || !accountOk(target) || (team !== null && !teamOk(team)) || (q.get('p') && !page)) return null;
  return { relay, text, target, team, page };
}

const SWARM = ['onyx', 'nova', 'oracle'] as const;
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const buffer = (b: Uint8Array) => b.slice().buffer as ArrayBuffer;

class Stop extends Error {}

/** One touch of a passkey on this site, over `challenge`. */
async function assertion(rpId: string, challenge: Uint8Array, allow: readonly string[] = []): Promise<{ id: string; a: Assertion }> {
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        challenge: buffer(challenge),
        rpId,
        allowCredentials: allow.map((id) => ({ type: 'public-key' as const, id: buffer(fromBase64url(id) ?? new Uint8Array()) })),
        userVerification: 'required',
        timeout: 180_000,
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    if (name === 'NotAllowedError' || name === 'AbortError') throw new Stop('Nothing changed. Try again when you are ready.');
    if (name === 'SecurityError') throw new Stop('Passkeys for your vault work on maskwars.xyz only.');
    throw new Stop('That passkey did not answer. Try again.');
  }
  if (!cred) throw new Stop('Nothing changed. Try again when you are ready.');
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: base64url(new Uint8Array(cred.rawId)),
    a: { authenticatorData: new Uint8Array(r.authenticatorData), clientDataJSON: new Uint8Array(r.clientDataJSON), signature: new Uint8Array(r.signature) },
  };
}

/** The key the site keeps for a passkey (it shows its key only once, when made); only used if its signature holds. */
async function knownKey(id: string): Promise<string | null> {
  const who = loadWho();
  if (who?.kind === 'passkey' && who.id === id) return who.key;
  try {
    const r = await fetch(`/api/pay/passkey?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    return r.ok ? (((await r.json()) as { key?: string | null }).key ?? null) : null;
  } catch {
    return null;
  }
}

type Phase = 'idle' | 'passkey' | 'second' | 'near' | 'checking' | 'done';

export function Prove({ rpId }: { rpId: string }) {
  const id = useId();
  const [ask, setAsk] = useState<Ask | null | undefined>(undefined);
  const [passkeys, setPasskeys] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const [info, setInfo] = useState(false);
  const [vault, setVault] = useState<string | null>(null);
  const [opener, setOpener] = useState(true);

  // Read once: the fragment is cleared right after, and an effect may run twice.
  const read = useRef<{ ask: Ask | null } | null>(null);
  useEffect(() => {
    read.current ??= { ask: readAsk(window.location.hash) };
    const a = read.current.ask;
    setAsk(a);
    // The relay id stays out of this tab's history.
    if (a) window.history.replaceState(null, '', window.location.pathname);
    setPasskeys(passkeysSupported() && window.location.hostname === rpId);
    setOpener(Boolean(window.opener));
  }, [rpId]);

  /** Sends the proof to the server to be read, then to the checkout that opened this window. */
  const finish = async (proof: VaultProof) => {
    if (!ask) return;
    setPhase('checking');
    const toOpener = Boolean(window.opener);
    const res = await fetch('/api/hire/proof', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(ask.page ? { 'x-hire-page': ask.page } : {}) },
      // Left with the server too, under the checkout's relay id: a page's policy can cut this window off from it.
      body: JSON.stringify({ proof, job: { text: ask.text, target: ask.target, team: ask.team }, relay: ask.relay }),
      cache: 'no-store',
    }).catch(() => null);
    const json = (await res?.json().catch(() => null)) as { vault?: string; error?: string } | null;
    if (!res?.ok || !json?.vault) {
      const code = json?.error;
      throw new Stop(
        code === 'vault'
          ? `That is not ${ask.team ? `${shortAccount(ask.team)}’s` : 'this job’s'} vault.`
          : code === 'busy' || res?.status === 429
            ? 'Too busy right now. Try again in a minute.'
            : res
              ? 'That did not prove the vault. Try again.'
              : 'Cannot reach the network right now. Try again in a minute.',
      );
    }
    setVault(json.vault);
    setPhase('done');
    if (toOpener) {
      try {
        window.opener.postMessage(proofEnvelope(ask.relay, proof, json.vault), window.location.origin);
      } catch {
        /* the checkout went away or is cut off: it finds the proof with the server */
      }
    }
    setTimeout(() => window.close(), toOpener ? 1400 : 2600);
  };

  const fail = (e: unknown) => {
    setPhase('idle');
    setProblem(e instanceof Stop ? e.message : 'That did not work. Try again.');
  };

  const withPasskey = async () => {
    if (!ask || phase !== 'idle') return;
    setProblem(null);
    setPhase('passkey');
    try {
      const nonce = random(32);
      const a: ProofAsk = { text: ask.text, target: ask.target, page: ask.page, at: proofTime() };
      const first = await assertion(rpId, proofHash(proofMessage(a), nonce, rpId));
      let key = keyOfAssertion(first.a, { known: await knownKey(first.id), want: ask.team });
      if (!key) {
        // A device that never saw this vault: one more touch pins its key down.
        setPhase('second');
        const second = await assertion(rpId, random(32), [first.id]);
        key = keyFromTwo(first.a, second.a);
        if (!key) throw new Stop('That passkey did not open a vault. Try again.');
        void fetch('/api/pay/passkey', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: first.id, key }) }).catch(
          () => {},
        );
      }
      rememberKnown(first.id);
      const opens = accountOf(keyBytes(key)!);
      if (ask.team && opens !== ask.team) throw new Stop(`That passkey opens ${shortAccount(opens)}’s vault. This job pays into ${shortAccount(ask.team)}’s.`);
      await finish({
        kind: 'passkey',
        ask: a,
        nonce: base64(nonce),
        recipient: rpId,
        key,
        authenticatorData: base64url(first.a.authenticatorData),
        clientDataJSON: base64url(first.a.clientDataJSON),
        signature: base64url(first.a.signature),
      });
    } catch (e) {
      fail(e);
    }
  };

  const withWallet = async () => {
    if (!ask || phase !== 'idle') return;
    setProblem(null);
    setPhase('near');
    try {
      let w;
      try {
        w = await nearSignIn();
      } catch {
        throw new Stop('No wallet connected. Nothing changed.');
      }
      if (ask.team && w.accountId !== ask.team)
        throw new Stop(`That wallet is ${shortAccount(w.accountId)}. This job pays into ${shortAccount(ask.team)}’s vault.`);
      const nonce = random(32);
      const a: ProofAsk = { text: ask.text, target: ask.target, page: ask.page, at: proofTime() };
      let sig;
      try {
        sig = await w.signMessage({ message: proofMessage(a), recipient: rpId, nonce });
      } catch {
        throw new Stop('The wallet did not sign. Nothing changed.');
      }
      await finish({ kind: 'near', ask: a, nonce: base64(nonce), recipient: rpId, account: sig.accountId, publicKey: sig.publicKey, signature: sig.signature });
    } catch (e) {
      fail(e);
    }
  };

  if (ask === undefined)
    return (
      <div className={p.page}>
        <main className={s.sheet} aria-busy />
      </div>
    );

  const busy = phase !== 'idle' && phase !== 'done';
  const note = (() => {
    if (problem) return problem;
    if (phase === 'passkey') return 'Pick your passkey.';
    if (phase === 'second') return 'Once more: this device has not seen your vault yet.';
    if (phase === 'near') return 'Finish in your wallet.';
    if (phase === 'checking') return 'Checking it.';
    return 'Sign one line about this job. Nothing moves.';
  })();

  return (
    <div className={p.page}>
      <main className={s.sheet}>
        <div className={s.bar}>
          <Mark className={s.mark} />
          <span className={`${s.word} ${s.brand}`}>Open your vault</span>
        </div>

        <div className={s.hero}>
          <div className={s.swarm} aria-hidden>
            {SWARM.map((m, i) => (
              <div key={m} className={s.maskBox} data-i={i}>
                <Image src={`/art/${m}.webp`} alt="" fill sizes="(max-width: 560px) 34vw, 180px" quality={75} priority className={s.maskImg} />
              </div>
            ))}
          </div>
          {ask ? (
            <div className={s.card}>
              <p className={s.job}>{ask.text}</p>
              <p className={s.meta} data-by="">
                <span className={s.metaLabel}>By</span>
                <span className={s.metaValue}>
                  <span>{ask.page ? pageName(ask.page) : 'a page that does not say'}</span>
                </span>
              </p>
              <p className={s.meta}>
                <span className={s.metaLabel}>Target</span>
                <span className={s.metaValue}>
                  <span>{ask.target}</span>
                </span>
              </p>
              <p className={s.meta} data-to="">
                <span className={s.metaLabel}>Paid to</span>
                <span className={s.metaValue}>
                  <span>
                    {(vault ?? ask.team) ? `${vaultName((vault ?? ask.team)!)}’s vault, not\u00a0MASK\u00a0WARS` : 'Your own vault, not\u00a0MASK\u00a0WARS'}
                  </span>
                </span>
              </p>
            </div>
          ) : (
            <div className={s.card}>
              <p className={s.job} data-lede>
                This window opens from a Hire the swarm checkout.
              </p>
            </div>
          )}
        </div>

        {!ask ? null : phase === 'done' && vault ? (
          <div className={s.band} role="status">
            <p className={`${s.word} ${p.proven}`}>Proven</p>
            <p className={s.endLine}>{`${shortAccount(vault)}’s vault is yours.`}</p>
            <p className={s.note}>{opener ? 'Back to the checkout.' : 'Go back to the checkout: it picks this up.'}</p>
          </div>
        ) : (
          <div className={s.band}>
            <div className={s.top}>
              <span className={`${s.word} ${s.label}`} id={`${id}-label`}>
                Your vault
              </span>
              <button
                type="button"
                className={s.info}
                aria-expanded={info}
                aria-controls={`${id}-details`}
                aria-label="Details"
                onClick={() => setInfo((v) => !v)}
              >
                i
              </button>
            </div>
            <div className={`${s.row} ${p.ways}`} data-n={passkeys ? 2 : 1} role="group" aria-labelledby={`${id}-label`}>
              {passkeys ? (
                <button type="button" className={s.btn} onClick={withPasskey} disabled={busy} aria-busy={phase === 'passkey' || phase === 'second'}>
                  <span className={s.word}>Passkey</span>
                </button>
              ) : null}
              <button type="button" className={passkeys ? p.alt : s.btn} onClick={withWallet} disabled={busy} aria-busy={phase === 'near'}>
                <span className={s.word}>NEAR wallet</span>
              </button>
            </div>
            {info ? (
              <p className={s.details} id={`${id}-details`}>
                Your vault is your own account in NEAR Intents. Its passkey or the NEAR wallet that owns it signs one line naming this job, this contract and
                the page that asked. The checkout then gives an address that pays into that vault and nowhere else. Nothing moves and nothing is spent here.
              </p>
            ) : (
              <p className={s.note} data-bad={problem ? '' : undefined} role={problem ? 'alert' : 'status'} aria-live="polite">
                {note}
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
