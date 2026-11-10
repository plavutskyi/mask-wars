'use client';

import Image from 'next/image';
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { coinText, dollars } from '@maskwars/pay';
import { autofillSupported, createVault, openVault, PasskeyError, passkeysSupported, type PasskeyVault } from '@maskwars/pay/passkey';
import { type CatalogState, type CatalogView, pay, type VaultView } from './api';
import { CashOut } from './CashOut';
import { catalogDelay } from './settle';
import { nearConnected, nearSignIn } from './near';
import { loadKnown, loadPending, loadPendingOut, loadWho, rememberKnown, saveWho, type Who } from './store';
import { TopUp } from './TopUp';
import { Note, shortAddress, Top, useCopy } from './ui';
import s from './wallet.module.css';

type Screen = 'home' | 'add' | 'out';

const LEDE = 'Money for the arena. In from any wallet, out to yours.';

/** The number on screen rises to a new value instead of jumping, unless the person asked for less motion. */
function useRising(target: number | null): number | null {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (target === null) return setShown(null);
    const start = from.current;
    from.current = target;
    if (start === null || start >= target || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return setShown(target);
    let frame = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / 1100);
      setShown(start + (target - start) * (1 - (1 - k) ** 3));
      if (k < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}

export function Wallet({ rpId }: { rpId: string }) {
  const [who, setWho] = useState<Who | null>(null);
  const [ready, setReady] = useState(false);
  const [catalog, setCatalog] = useState<CatalogView | null>(null);
  const [catalogDown, setCatalogDown] = useState(false);
  const [catalogRound, setCatalogRound] = useState(0);
  const [vault, setVault] = useState<VaultView | null>(null);
  const [vaultDown, setVaultDown] = useState(false);
  const [screen, setScreen] = useState<Screen>('home');
  const [ringing, setRinging] = useState(false);
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    const w = loadWho();
    setWho(w);
    if (w && loadPendingOut(w.account)) setScreen('out');
    else if (w && loadPending(w.account)) setScreen('add');
    setReady(true);
  }, []);

  // The coins on offer, asked again after 1.5, 3, 6 and 12 seconds; after that the page says so and offers a retry.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    setCatalogDown(false);
    const get = (n: number) =>
      pay.catalog().then(
        (c) => live && setCatalog(c),
        () => {
          if (!live) return;
          const later = catalogDelay(n);
          if (later === null) return setCatalogDown(true);
          timer = setTimeout(() => get(n + 1), later);
        },
      );
    void get(0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [catalogRound]);
  const coins: CatalogState = { catalog, down: catalogDown && !catalog, retry: () => setCatalogRound((n) => n + 1) };

  const refresh = useCallback(async (account: string): Promise<VaultView | null> => {
    try {
      const v = await pay.vault(account);
      setVault((old) => (old && old.account === account && old.usd === v.usd && old.near === v.near && old.holdings.length === v.holdings.length ? old : v));
      setVaultDown(false);
      return v;
    } catch {
      setVaultDown(true);
      return null;
    }
  }, []);

  // The vault, read again every 20 seconds while its page is open: money can land from elsewhere at any time.
  useEffect(() => {
    if (!who) return setVault(null);
    void refresh(who.account);
    const t = setInterval(() => document.visibilityState === 'visible' && void refresh(who.account), 20_000);
    return () => clearInterval(t);
  }, [who, refresh]);

  const signIn = (w: Who) => {
    saveWho(w);
    setVault(null);
    setWho(w);
    setScreen(loadPendingOut(w.account) ? 'out' : loadPending(w.account) ? 'add' : 'home');
  };

  const signOut = async () => {
    if (who?.kind === 'near') await (await nearConnected())?.signOut();
    saveWho(null);
    setWho(null);
    setVault(null);
    setScreen('home');
  };

  // Money landed: the vault is read again and, if the swap went through, the vault rings once (§9).
  const ringTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (ringTimer.current && clearTimeout(ringTimer.current)), []);
  const landed = (swapped: boolean) => {
    if (who) void refresh(who.account);
    if (!swapped) return;
    setRinging(true);
    if (ringTimer.current) clearTimeout(ringTimer.current);
    ringTimer.current = setTimeout(() => setRinging(false), 900);
  };

  const usd = useRising(vault ? vault.usd : null);
  const extra = vault?.holdings.filter((h) => h.chain !== 'near') ?? [];

  return (
    <div className={s.body} data-in={who ? '' : undefined}>
      <section className={s.stage}>
        <h1 className={s.hidden}>Your vault</h1>
        {who ? (
          <p className={s.title} data-money="" aria-live="polite">
            <span className={`${s.side} ${s.sideA}`}>
              <span className={s.money} data-ring={ringing ? '' : undefined}>
                {usd === null ? '$–' : dollars(usd)}
              </span>
            </span>
            <span className={`${s.side} ${s.sideB}`}>
              <span className={s.near}>
                <b>{vault ? coinText(vault.near, catalog?.near.decimals ?? 24) : '–'}</b> NEAR
              </span>
              {extra.length ? (
                <span className={s.plus}>{extra.map((h) => `+ ${coinText(h.units, h.decimals)} ${h.symbol}`).join('  ')}</span>
              ) : null}
            </span>
          </p>
        ) : (
          <p className={s.title} aria-hidden>
            <span className={`${s.side} ${s.sideA} ${s.word} ${s.titleWord}`}>Your</span>
            <span className={`${s.side} ${s.sideB} ${s.word} ${s.titleWord}`}>Vault</span>
          </p>
        )}
        {!who && ready ? <p className={s.stageLede}>{LEDE}</p> : null}
        <div className={s.vault} aria-hidden data-wait={waiting ? '' : undefined} data-ring={ringing ? '' : undefined}>
          <Image src="/art/vault.webp" alt="" fill priority sizes="(max-width: 1000px) 72vw, 36vw" quality={85} className={s.vaultImg} />
          <i className={s.seam} />
        </div>
      </section>

      <section className={s.band}>
        {!ready ? null : !who ? (
          <SignIn rpId={rpId} onIn={signIn} />
        ) : screen === 'add' ? (
          <TopUp who={who} coins={coins} onWaiting={setWaiting} onLanded={landed} onClose={() => setScreen('home')} />
        ) : screen === 'out' ? (
          <CashOut who={who} rpId={rpId} coins={coins} vault={vault} onRefresh={() => refresh(who.account)} onClose={() => setScreen('home')} />
        ) : (
          <Home
            who={who}
            vault={vault}
            down={vaultDown}
            coins={coins}
            settling={loadPendingOut(who.account) !== null}
            onAdd={() => setScreen('add')}
            onOut={() => setScreen('out')}
            onSignOut={signOut}
          />
        )}
      </section>
    </div>
  );
}

function Home(p: {
  who: Who;
  vault: VaultView | null;
  down: boolean;
  coins: CatalogState;
  /** A cash-out is still settling: its screen stays one tap away, even when it emptied the vault. */
  settling: boolean;
  onAdd: () => void;
  onOut: () => void;
  onSignOut: () => void;
}) {
  const id = useId();
  const [info, setInfo] = useState(false);
  const [copied, copy] = useCopy();
  const { catalog } = p.coins;
  const has = (p.vault?.usd ?? 0) >= 0.01 || p.settling;
  const names = catalog?.chains.map((c) => c.name) ?? [];
  const where = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : 'any wallet';
  const details =
    p.who.kind === 'passkey'
      ? `Your vault is ${p.who.account}, an account in NEAR Intents that only your passkey opens. Nobody else holds a key to it, this site included.`
      : `Your vault is ${p.who.account} in NEAR Intents. Your NEAR wallet signs every move out of it.`;
  const note = p.coins.down
    ? 'The coins did not load. Your vault is safe.'
    : p.down
      ? 'Cannot read your vault right now. It is safe; try again in a minute.'
      : !catalog
        ? 'Loading the coins on offer.'
        : `In from ${where}. Out to any of them.`;
  return (
    <div className={s.form}>
      <Top
        id={id}
        label="Vault"
        details={details}
        info={info}
        onInfo={() => setInfo((v) => !v)}
        extra={
          <button type="button" className={s.acct} onClick={() => copy('acct', p.who.account)} aria-label={`Copy ${p.who.account}`}>
            {copied === 'acct' ? 'Copied' : shortAddress(p.who.account)}
          </button>
        }
        back={p.onSignOut}
        backLabel="Sign out"
      />
      <div className={s.row} data-two={has && !p.coins.down ? '' : undefined}>
        {has && !p.coins.down ? (
          <button type="button" className={`${s.btn} ${s.quiet}`} onClick={p.onOut} disabled={!catalog} aria-busy={!catalog}>
            <span className={s.word}>Cash out</span>
          </button>
        ) : null}
        {p.coins.down ? (
          <button type="button" className={s.btn} onClick={p.coins.retry}>
            <span className={s.word}>Try again</span>
          </button>
        ) : (
          <button type="button" className={s.btn} onClick={p.onAdd} disabled={!catalog} aria-busy={!catalog}>
            <span className={s.word}>Add money</span>
          </button>
        )}
      </div>
      <Note id={id} info={info} details={details} bad={p.down || p.coins.down}>
        {note}
      </Note>
    </div>
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * `ask`: «Continue» opens the vault of a passkey the person already has. `fresh`: that opened nothing, and «New vault»
 * makes one under the email. `local`: the passkey just made would live on this device only, so no vault was made from it;
 * another device or a NEAR wallet is the way on.
 */
type Mode = 'ask' | 'fresh' | 'local';

function SignIn({ rpId, onIn }: { rpId: string; onIn: (w: Who) => void }) {
  const id = useId();
  const [email, setEmail] = useState('');
  const [info, setInfo] = useState(false);
  const [tried, setTried] = useState(false);
  const [mode, setMode] = useState<Mode>('ask');
  const [phase, setPhase] = useState<'idle' | 'create' | 'open' | 'second' | 'near'>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const [passkeys, setPasskeys] = useState<boolean | null>(null);
  const [round, setRound] = useState(0);
  const autofill = useRef<AbortController | null>(null);

  const known = useCallback(async (cred: string) => pay.passkey(cred), []);

  const opened = useCallback(
    (v: PasskeyVault & { recovered?: boolean }) => {
      if (v.recovered) void pay.savePasskey(v.id, v.key);
      rememberKnown(v.id);
      onIn({ kind: 'passkey', id: v.id, key: v.key, account: v.account });
    },
    [onIn],
  );

  const failed = (e: unknown) => {
    const problem = e instanceof PasskeyError ? e.problem : 'unknown';
    setPhase('idle');
    setRound((n) => n + 1);
    if (problem === 'local') {
      setMode('local');
      return setProblem(null);
    }
    if (problem === 'exists') setMode('ask');
    setProblem(
      {
        cancelled: 'Nothing changed. Try again when you are ready.',
        unsupported: 'This browser cannot use passkeys. Try Safari or Chrome, or a NEAR wallet.',
        domain: 'Passkeys for your vault work on maskwars.xyz only.',
        exists: 'This device already has a vault passkey. Continue opens it.',
        unknown: 'That passkey did not open a vault. Try again.',
      }[problem],
    );
  };

  // Passkeys need this site's own domain, exactly (they are bound to it for good), and a browser that has them. A
  // returning person's passkey shows up in the email field's autofill: picking it opens the vault.
  useEffect(() => {
    const ok = passkeysSupported() && location.hostname === rpId;
    setPasskeys(ok);
    if (!ok) return;
    const ctrl = new AbortController();
    autofill.current = ctrl;
    void autofillSupported().then((yes) => {
      if (!yes || ctrl.signal.aborted) return;
      openVault({ rpId, known, mediation: 'conditional', signal: ctrl.signal }).then(
        (v) => !ctrl.signal.aborted && opened(v),
        () => {},
      );
    });
    return () => ctrl.abort();
  }, [rpId, known, opened, round]);

  const stopAutofill = () => {
    autofill.current?.abort();
    autofill.current = null;
  };

  const emailOk = () => {
    if (EMAIL.test(email.trim())) return email.trim().toLowerCase();
    setTried(true);
    setProblem(null);
    document.getElementById(`${id}-email`)?.focus();
    return null;
  };

  // «Continue»: the passkey picker first. Only an explicit «New vault» makes a passkey, so an email that already has a
  // vault never gets a second, empty one.
  const open = async () => {
    if (phase !== 'idle') return;
    stopAutofill();
    setProblem(null);
    setPhase('open');
    try {
      opened(
        await openVault({
          rpId,
          known: async (cred) => {
            const k = await known(cred);
            if (!k) setPhase('second');
            return k;
          },
        }),
      );
    } catch (err) {
      if (err instanceof PasskeyError && err.problem === 'cancelled') {
        setPhase('idle');
        setRound((n) => n + 1);
        setMode('fresh');
        return;
      }
      failed(err);
    }
  };

  const create = async (elsewhere = false) => {
    if (phase !== 'idle') return;
    const name = emailOk();
    if (!name) return;
    stopAutofill();
    setProblem(null);
    setPhase('create');
    try {
      const v = await createVault({ rpId, name, exclude: loadKnown(), elsewhere });
      void pay.savePasskey(v.id, v.key);
      opened(v);
    } catch (err) {
      failed(err);
    }
  };

  const wallet = async () => {
    if (phase !== 'idle') return;
    stopAutofill();
    setProblem(null);
    setPhase('near');
    try {
      const w = await nearSignIn();
      onIn({ kind: 'near', account: w.accountId });
    } catch {
      setPhase('idle');
      setRound((n) => n + 1);
      setProblem('No wallet connected. Nothing changed.');
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (phase !== 'idle') return;
    if (!passkeys) return void wallet();
    if (mode === 'local') return void create(true);
    if (mode === 'fresh') return void create();
    if (emailOk()) void open();
  };

  const busy = phase !== 'idle';
  const badEmail = tried && !EMAIL.test(email.trim());
  const bad = Boolean(problem) || badEmail || mode === 'local';
  const details =
    mode === 'local'
      ? 'A vault needs a passkey that syncs to your other devices, so a lost phone never locks your money. This one would live on this device alone. Make it on another device (your phone, through its QR code), or use a NEAR wallet.'
      : 'Your vault is your own account in NEAR Intents, opened by a passkey: Face ID, a fingerprint or your screen lock. Only a passkey that syncs to your other devices makes one. Nobody else holds a key, this site included, and your email stays with your passkey.';
  const note = (() => {
    if (phase === 'create') return mode === 'local' ? 'Make it on your other device: scan the code with your phone.' : 'Save the passkey when your device asks.';
    if (phase === 'open') return 'Pick your passkey.';
    if (phase === 'second') return 'Once more to open it on this device.';
    if (phase === 'near') return 'Pick your NEAR wallet.';
    if (mode === 'local') return 'This passkey stays on this device only.';
    if (problem) return problem;
    if (passkeys === false) return 'Passkeys for your vault work on maskwars.xyz. Here, sign in with your NEAR wallet.';
    if (badEmail) return email.trim() ? 'That email does not look right.' : 'Type your email first.';
    if (mode === 'fresh') return 'No vault opened. New here? Tap New vault.';
    return 'A passkey opens it: Face ID or a fingerprint. No seed phrase, no app.';
  })();
  const primary = passkeys === false ? 'Connect' : busy ? 'Opening' : mode === 'local' ? 'Another device' : mode === 'fresh' ? 'New vault' : 'Continue';

  return (
    <form className={s.form} onSubmit={submit} noValidate>
      <p className={s.lede}>{LEDE}</p>
      <Top
        id={id}
        label={passkeys === false ? 'NEAR wallet' : mode === 'local' ? 'One device only' : 'Email'}
        details={details}
        info={info}
        onInfo={() => setInfo((v) => !v)}
        right={
          passkeys ? (
            <>
              {mode === 'ask' ? (
                <button type="button" className={s.back} onClick={() => void create()} disabled={busy}>
                  New vault
                </button>
              ) : mode === 'fresh' ? (
                <button type="button" className={s.back} onClick={() => void open()} disabled={busy}>
                  Sign in
                </button>
              ) : (
                <button type="button" className={s.back} onClick={() => setMode('ask')} disabled={busy}>
                  Back
                </button>
              )}
              {mode === 'local' ? null : (
                <button type="button" className={s.back} onClick={wallet} disabled={busy}>
                  NEAR wallet
                </button>
              )}
            </>
          ) : null
        }
      />
      <div className={s.row} key={passkeys === false ? 'near' : mode === 'local' ? 'local' : 'email'}>
        {passkeys === false ? null : mode === 'local' ? (
          <button type="button" className={`${s.btn} ${s.quiet}`} onClick={wallet} disabled={busy}>
            <span className={s.word}>NEAR wallet</span>
          </button>
        ) : (
          <input
            id={`${id}-email`}
            className={s.input}
            type="email"
            inputMode="email"
            autoComplete="username webauthn"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="you@mail.com"
            aria-labelledby={`${id}-label`}
            aria-invalid={badEmail}
            data-bad={badEmail ? '' : undefined}
            value={email}
            disabled={busy}
            onChange={(e) => setEmail(e.target.value)}
          />
        )}
        <button type="submit" className={s.btn} disabled={busy || passkeys === null} aria-busy={busy}>
          <span className={s.word}>{primary}</span>
        </button>
      </div>
      <Note id={id} info={info} details={details} bad={bad}>
        {note}
      </Note>
    </form>
  );
}
