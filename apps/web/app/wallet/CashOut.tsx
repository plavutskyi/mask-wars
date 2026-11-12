'use client';

import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  addressOk,
  checkIntent,
  checkQuote,
  coinText,
  dollars,
  intentDeadline,
  nonceBytes,
  parseDollars,
  pollDelay,
  signedNep413,
  unitsForUsd,
  withDeadline,
  type ChainId,
  type Progress,
  type SignedIntent,
} from '@maskwars/pay';
import { PasskeyError, signWithPasskey } from '@maskwars/pay/passkey';
import { type CatalogState, type Held, passing, pay, PayError, type QuoteView, surelyRefused, type VaultView } from './api';
import { nearConnected, nearSignIn } from './near';
import { type CashOutDraft, loadPendingOut, type PendingCashOut, savePendingOut, type Who } from './store';
import { type EndKind, settleOf } from './settle';
import { mmss, NoCoins, Note, quietFocus, shortAddress, Top, useNow } from './ui';
import s from './wallet.module.css';

type Step = 'from' | 'chain' | 'coin' | 'address' | 'amount' | 'go';
type Phase = 'quote' | 'sign' | 'key' | 'send' | 'track';
interface End {
  readonly kind: EndKind;
  readonly job: CashOutDraft & { readonly deal: QuoteView };
  readonly progress: Progress | null;
}

const LABEL: Record<Step, string> = { from: 'From', chain: 'To', coin: 'Coin', address: 'Address', amount: 'Amount', go: 'Cash out' };
const SHARES = [
  ['25%', 25n],
  ['50%', 50n],
  ['All', 100n],
] as const;

/** Past its intent's deadline nothing signed can move; this much more lets the chain and 1Click's status catch up. */
const SETTLE_MS = 3 * 60_000;

const PROBLEM: Record<string, string> = {
  small: 'Too small to send there. Try a bigger amount.',
  route: 'No route for this right now. Try another coin.',
  closed: 'Cash-outs open soon.',
  busy: 'Too busy right now. Try again in a minute.',
  offline: 'Cannot reach the network right now. Try again in a minute.',
  signature: 'That signature did not hold. Nothing moved.',
  bad: 'That did not work. Nothing moved.',
  wrong: 'That cash-out did not read right. Nothing was signed.',
};

const problemOf = (e: unknown) => (e instanceof PayError ? (PROBLEM[e.code] ?? PROBLEM.bad!) : PROBLEM.bad!);

export function CashOut(p: {
  who: Who;
  rpId: string;
  coins: CatalogState;
  vault: VaultView | null;
  /** Reads the vault again and gives what it holds now (`null` when it cannot be read). */
  onRefresh: () => Promise<VaultView | null>;
  onClose: () => void;
}) {
  const id = useId();
  const holdings = p.vault?.holdings ?? [];
  const catalog = p.coins.catalog;
  const chains = catalog?.chains ?? [];
  // A cash-out signed earlier that has not settled comes first: no new one starts while it may still go through.
  const [job, setJob] = useState<PendingCashOut | null>(() => loadPendingOut(p.who.account));
  const [draft, setDraft] = useState<CashOutDraft | null>(null);
  const [end, setEnd] = useState<End | null>(null);
  const [fromId, setFromId] = useState(holdings[0]?.assetId ?? '');
  const from: Held | undefined = holdings.find((h) => h.assetId === fromId) ?? holdings[0];
  const [chainId, setChainId] = useState<string>(from && from.chain !== 'near' ? from.chain : 'sol');
  const chain = chains.find((c) => c.id === chainId) ?? chains[0];
  const [symbol, setSymbol] = useState(chain?.coins[0]?.symbol ?? '');
  const coin = chain?.coins.find((c) => c.symbol === symbol) ?? chain?.coins[0];
  const [recipient, setRecipient] = useState('');
  const [usdText, setUsdText] = useState('');
  const [share, setShare] = useState<bigint | null>(100n);
  const [step, setStep] = useState<Step>(job ? 'go' : holdings.length > 1 ? 'from' : 'chain');
  const [info, setInfo] = useState(false);
  const [tried, setTried] = useState(false);
  const [preview, setPreview] = useState<QuoteView | null>(null);
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [slid, setSlid] = useState(false);
  const [phase, setPhase] = useState<Phase | null>(job ? 'track' : null);
  const [problem, setProblem] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [deal, setDeal] = useState<QuoteView | null>(null);
  const moved = useRef(false);

  const steps = useMemo<Step[]>(
    () => [...(holdings.length > 1 ? (['from'] as const) : []), 'chain', ...((chain?.coins.length ?? 0) > 1 ? (['coin'] as const) : []), 'address', 'amount'],
    [holdings.length, chain],
  );
  const at = Math.max(0, steps.indexOf(step));
  const addressGood = chain ? addressOk(chain.id as ChainId, recipient) : false;

  // The amount in the vault coin's units: a share of what it holds, or the dollars typed, never more than it holds.
  const units = useMemo(() => {
    if (!from) return 0n;
    const all = BigInt(from.units);
    if (share !== null) return (all * share) / 100n;
    const usd = parseDollars(usdText);
    if (!usd) return 0n;
    return unitsForUsd(usd, from.price, from.decimals);
  }, [from, share, usdText]);
  const over = from ? units > BigInt(from.units) : false;
  // A share is shown in whole cents down, as the vault's own number is: «All» never reads more than the vault holds.
  const usdShown = from ? (share !== null ? Math.floor(from.usd * Number(share) + 1e-6) / 100 : (parseDollars(usdText) ?? 0)) : 0;

  // A live price for what arrives. A busy moment is not a no: the button stays on (the real quote prices it), and the
  // preview is asked once more a few seconds later.
  useEffect(() => {
    if (step !== 'amount' || !from || !coin || units <= 0n || over || !addressGood) return setPreview(null);
    const ctrl = new AbortController();
    let again: ReturnType<typeof setTimeout> | undefined;
    setPreviewProblem(null);
    setPreviewBusy(false);
    const ask = (retry: boolean) =>
      pay
        .quoteOut({ account: p.who.account, from: from.assetId, to: coin.assetId, recipient: recipient.trim(), units: units.toString(), dry: true }, ctrl.signal)
        .then(
          (q) => {
            if (ctrl.signal.aborted) return;
            setPreview(q);
            setPreviewBusy(false);
          },
          (e) => {
            if (ctrl.signal.aborted) return;
            setPreview(null);
            if (passing(e)) {
              setPreviewBusy(true);
              if (retry) again = setTimeout(() => void ask(false), 4000);
              return;
            }
            setPreviewProblem(problemOf(e));
          },
        );
    const t = setTimeout(() => void ask(true), 350);
    return () => {
      ctrl.abort();
      clearTimeout(t);
      clearTimeout(again);
    };
  }, [step, from, coin, units, over, addressGood, recipient, p.who.account]);

  const settle = (kind: EndKind, job: PendingCashOut, progress: Progress | null) => {
    savePendingOut(null);
    setEnd({ kind, job, progress });
    setJob(null);
    setDraft(null);
    setPhase(null);
    void p.onRefresh();
  };

  // Follows a signed cash-out until 1Click says how it ended, or until its intent can no longer move anything: then the
  // vault is read again and the screen says what happened, with a way back.
  useEffect(() => {
    if (!job || phase !== 'track') return;
    const address = job.deal.depositAddress;
    if (!address) return settle('none', job, null);
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    let attempt = 0;
    const tick = async () => {
      const next = await pay.status(address).catch(() => null);
      if (!live) return;
      if (next) setProgress(next);
      const stage = next?.stage ?? null;
      let ended = settleOf({ stage, now: Date.now(), until: job.until, before: job.from.units, units: job.units });
      if (ended === 'unknown') {
        // Its intent can no longer move anything and 1Click did not say how it went: the vault, read again, does.
        const v = await p.onRefresh();
        if (!live) return;
        const held = v ? (v.holdings.find((h) => h.assetId === job.from.assetId)?.units ?? '0') : null;
        ended = settleOf({ stage, now: Date.now(), until: job.until, before: job.from.units, units: job.units, held: () => held });
      }
      if (ended) return settle(ended, job, next);
      const pace = stage === 'seen' || stage === 'moving' ? stage : job.sent === 'sent' ? 'moving' : 'waiting';
      timer = setTimeout(tick, Math.min(pollDelay(pace, attempt++), Math.max(1000, job.until - Date.now())));
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job, phase]);

  useEffect(() => {
    if (moved.current) document.getElementById(`${id}-${step}`)?.focus();
  }, [id, step]);

  const now = useNow(phase === 'track' && job?.sent === 'unsure');

  const go = (to: Step) => {
    moved.current = true;
    setInfo(false);
    setTried(false);
    setProblem(null);
    setSlid(false);
    setStep(to);
  };

  const fail = (text: string | null) => {
    setDraft(null);
    setDeal(null);
    setPhase(null);
    setStep('amount');
    setProblem(text);
  };

  const cashOut = async () => {
    if (!from || !coin || !chain || phase || job) return;
    const d: CashOutDraft = {
      from,
      chain: { id: chain.id, name: chain.name },
      coin,
      recipient: recipient.trim(),
      units: units.toString(),
      seen: preview?.amountOut ?? null,
    };
    setDraft(d);
    setDeal(null);
    setProblem(null);
    setSlid(false);
    setStep('go');
    setPhase('quote');
    let q: QuoteView;
    try {
      q = await pay.quoteOut({ account: p.who.account, from: d.from.assetId, to: d.coin.assetId, recipient: d.recipient, units: d.units, dry: false });
    } catch (e) {
      return fail(problemOf(e));
    }
    // Read the quote back: this coin out of this vault, exactly this amount, to the address typed, refunds to the vault.
    const terms = checkQuote(q, { account: p.who.account, from: d.from.assetId, to: d.coin.assetId, recipient: d.recipient, recipientType: 'DESTINATION_CHAIN', amountIn: d.units, seen: d.seen });
    if (!terms.ok && terms.moved) {
      setSlid(true);
      return fail(null);
    }
    if (!q.depositAddress || !terms.ok) return fail(PROBLEM.wrong!);
    setDeal(q);
    const standard = p.who.kind === 'passkey' ? 'webauthn' : 'nep413';
    let signed: SignedIntent;
    let until: number;
    try {
      const built = await pay.intent({ depositAddress: q.depositAddress, signer: p.who.account, standard });
      // Dated to the quote's fifteen minutes, not the address's three days; then read before signing: exactly this coin,
      // this amount, to this quote's address, from this vault.
      const intent = withDeadline(built, q.deadline);
      if (!intent || intent.standard !== standard) return fail(PROBLEM.wrong!);
      const c = checkIntent(intent, { signer: p.who.account, depositAddress: q.depositAddress, asset: d.from.assetId, amount: d.units, notAfter: q.deadline });
      if (!c.ok) return fail(PROBLEM.wrong!);
      until = (intentDeadline(intent) ?? Date.parse(q.deadline)) + SETTLE_MS;
      setPhase('sign');
      if (p.who.kind === 'passkey' && intent.standard === 'webauthn') {
        signed = await signWithPasskey({ id: p.who.id, key: p.who.key, account: p.who.account }, intent.payload, p.rpId);
      } else if (intent.standard === 'nep413') {
        const w = (await nearConnected()) ?? (await nearSignIn());
        if (w.accountId !== p.who.account) return fail(`Your own NEAR wallet is signed in as ${w.accountId}. Switch it to ${p.who.account}.`);
        const sig = await w.signMessage({ message: intent.payload.message, recipient: intent.payload.recipient, nonce: nonceBytes(intent.payload) });
        signed = signedNep413(intent.payload, sig);
        if (!(await pay.keyRegistered(p.who.account, sig.publicKey))) {
          setPhase('key');
          await w.addKey(sig.publicKey);
          let ok = false;
          for (let i = 0; i < 15 && !ok; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            ok = await pay.keyRegistered(p.who.account, sig.publicKey).catch(() => false);
          }
          if (!ok) return fail('Your own NEAR wallet did not add its key. Nothing moved.');
        }
      } else {
        return fail(PROBLEM.bad!);
      }
    } catch (e) {
      if (e instanceof PayError) return fail(problemOf(e));
      if (e instanceof PasskeyError && e.problem !== 'cancelled') return fail('Your passkey could not sign. Nothing moved.');
      return fail('Not signed. Nothing moved.');
    }
    // Kept before it is sent: if the answer is lost, the signed intent may still go through until it runs out, and no
    // second cash-out starts before this one settles, here or after a reload.
    const pending: PendingCashOut = { ...d, account: p.who.account, deal: q, sent: 'unsure', until };
    savePendingOut(pending);
    setPhase('send');
    try {
      await pay.submit(signed);
    } catch (e) {
      if (surelyRefused(e)) {
        savePendingOut(null);
        return fail(problemOf(e));
      }
      setProgress(null);
      setJob(pending);
      setPhase('track');
      return;
    }
    const sent: PendingCashOut = { ...pending, sent: 'sent' };
    savePendingOut(sent);
    setProgress(null);
    setJob(sent);
    setPhase('track');
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (step === 'go') return;
    if (step === 'address' && !addressGood) {
      setTried(true);
      return document.getElementById(`${id}-address`)?.focus();
    }
    if (step === 'amount') {
      if (units <= 0n || over || previewProblem) return setTried(true);
      return void cashOut();
    }
    go(steps[at + 1]!);
  };

  const details =
    'The money leaves your MASK WARS wallet in NEAR Intents and 1Click delivers it as the coin you pick, at most 1% off the price; fees are in the price. If it cannot be delivered, it comes back to your MASK WARS wallet. Check the address: a transfer to the wrong one cannot be undone.';

  // How it ended: one sentence, from what was sent, whatever the vault holds now.
  if (end) {
    const { job: j, progress: pr, kind } = end;
    const to = shortAddress(j.recipient);
    const fromName = j.from.chain === 'near' ? 'NEAR' : j.from.symbol;
    const tx = pr?.txs[0];
    const line =
      kind === 'done' ? (
        <>
          Sent {coinText(pr?.amountOut ?? j.deal.amountOut, j.coin.decimals)} {j.coin.symbol} to <span className={s.nowrap}>{to}</span> on {j.chain.name}.
        </>
      ) : kind === 'back' ? (
        `It did not go through. Your ${fromName} is back in your MASK WARS wallet.`
      ) : kind === 'failed' ? (
        `It did not go through. Keep this code for support: ${(pr?.correlationId ?? j.deal.correlationId).slice(0, 8)}.`
      ) : kind === 'none' ? (
        `It did not go out. Your ${fromName} is still in your MASK WARS wallet.`
      ) : kind === 'away' ? (
        <>
          It left your MASK WARS wallet and is on its way to <span className={s.nowrap}>{to}</span> on {j.chain.name}. If it cannot land, it comes back to your MASK WARS wallet.
        </>
      ) : (
        'Cannot tell yet how it ended. Whatever did not go out is still in your MASK WARS wallet.'
      );
    return (
      <div className={`${s.form} ${s.ended}`} role="status">
        <p className={s.endLine} data-good={kind === 'done' ? '' : undefined}>
          {line}
        </p>
        <div className={s.endActions}>
          {kind === 'done' && tx ? (
            <a className={`${s.btn} ${s.quiet}`} href={tx.explorerUrl} target="_blank" rel="noreferrer">
              <span className={s.word}>See it on {j.chain.name}</span>
            </a>
          ) : null}
          <button type="button" className={s.btn} onClick={p.onClose} ref={quietFocus}>
            <span className={s.word}>{kind === 'done' ? 'Done' : 'Back to wallet'}</span>
          </button>
        </div>
      </div>
    );
  }

  // On its way: what was set up when it started, not what the vault reads now.
  const g = job ?? draft;
  if (step === 'go' && g) {
    const to = shortAddress(g.recipient);
    const stage = progress?.stage ?? null;
    const unsure = job?.sent === 'unsure' && stage !== 'seen' && stage !== 'moving';
    const shownOut = job?.deal.amountOut ?? deal?.amountOut ?? g.seen;
    const ends = job ? new Date(job.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const unsureDetails = `Sending it got no answer, so it may still go through until ${ends}. This page follows 1Click and your MASK WARS wallet until then and starts no new cash-out before it settles. If it does not go through, nothing leaves your MASK WARS wallet.`;
    const note =
      phase === 'track'
        ? unsure
          ? `Checking it went out · ${mmss((job?.until ?? now) - now)}`
          : `On its way to ${g.chain.name}.`
        : {
            quote: 'Locking the price.',
            sign: p.who.kind === 'passkey' ? 'Confirm with your passkey.' : 'Sign in your own NEAR wallet.',
            key: 'Once only: let your own NEAR wallet sign for your MASK WARS wallet.',
            send: 'Sending.',
          }[phase ?? 'quote'];
    return (
      <form className={s.form} onSubmit={submit} noValidate data-step="go">
        <Top
          id={id}
          label={LABEL.go}
          details={unsure ? unsureDetails : details}
          info={info}
          onInfo={() => setInfo((v) => !v)}
          back={phase === 'track' ? p.onClose : null}
          backLabel="Wallet"
        />
        <div className={s.row} key="go">
          <div className={s.going}>
            <b>{shownOut ? coinText(shownOut, g.coin.decimals) : '…'}</b> {g.coin.symbol}
            <span className={s.sendOn}>
              to {to} on {g.chain.name}
            </span>
          </div>
          <button type="submit" className={s.btn} disabled aria-busy>
            <span className={s.word}>{phase === 'sign' || phase === 'key' ? 'Signing' : 'Sending'}</span>
          </button>
        </div>
        <Note id={id} info={info} details={unsure ? unsureDetails : details}>
          <span className={s.live} aria-hidden />
          {note}
        </Note>
      </form>
    );
  }

  if (!catalog || !from || !chain || !coin) {
    return <NoCoins id={id} label="Cash out" coins={p.coins} empty="Nothing to cash out yet." onClose={p.onClose} />;
  }

  const to = shortAddress(recipient.trim());
  const nameOf = (h: Held) => (h.chain === 'near' ? 'NEAR' : `${h.symbol} · ${chains.find((c) => c.id === h.chain)?.name ?? h.chain}`);

  const note = (() => {
    if (problem) return problem;
    switch (step) {
      case 'from':
        return 'Which coin in your MASK WARS wallet to send.';
      case 'chain':
        return 'Where your money goes.';
      case 'coin':
        return `${coin.symbol} on ${chain.name}.`;
      case 'address':
        if (!recipient.trim()) return `Your ${chain.name} address.`;
        return addressGood ? `Arrives at ${to}.` : `That is not a ${chain.name} address.`;
      default:
        if (over) return 'More than your MASK WARS wallet holds.';
        if (units <= 0n) return 'Pick an amount.';
        if (previewProblem) return previewProblem;
        if (preview) return `${slid ? 'The price moved: ' : ''}≈ ${coinText(preview.amountOut, coin.decimals)} ${coin.symbol} arrives at ${to}.`;
        return previewBusy ? 'Prices are busy right now. Cash out prices it.' : 'Pricing it.';
    }
  })();
  const bad =
    Boolean(problem) ||
    (step === 'address' && recipient.trim() !== '' && !addressGood && (tried || recipient.trim().length > 8)) ||
    (step === 'amount' && (over || Boolean(previewProblem)));

  return (
    <form className={s.form} onSubmit={submit} noValidate data-step={step}>
      <Top
        id={id}
        label={LABEL[step]}
        details={details}
        info={info}
        onInfo={() => setInfo((v) => !v)}
        back={at === 0 ? p.onClose : () => go(steps[at - 1]!)}
        count={[at + 1, steps.length]}
      />

      <div className={s.row} key={step}>
        {step === 'from' ? (
          <div className={s.chips} data-n={Math.min(3, holdings.length)} role="radiogroup" aria-labelledby={`${id}-label`}>
            {holdings.map((h, i) => (
              <button
                key={h.assetId}
                id={i === 0 ? `${id}-from` : undefined}
                type="button"
                role="radio"
                aria-checked={h.assetId === from.assetId}
                className={s.chip}
                onClick={() => {
                  setFromId(h.assetId);
                  setShare(100n);
                }}
              >
                {nameOf(h)} <span className={s.chipSub}>{dollars(h.usd)}</span>
              </button>
            ))}
          </div>
        ) : null}

        {step === 'chain' ? (
          <div className={s.tiles} data-n={chains.length > 4 ? 3 : chains.length} role="radiogroup" aria-labelledby={`${id}-label`}>
            {chains.map((c, i) => (
              <button
                key={c.id}
                id={i === 0 ? `${id}-chain` : undefined}
                type="button"
                role="radio"
                aria-checked={c.id === chain.id}
                className={s.tile}
                onClick={() => {
                  if (c.id !== chain.id) setRecipient('');
                  setChainId(c.id);
                  setSymbol(c.coins[0]!.symbol);
                }}
              >
                <span className={s.word}>{c.name}</span>
              </button>
            ))}
          </div>
        ) : null}

        {step === 'coin' ? (
          <div className={s.chips} data-n={chain.coins.length} role="radiogroup" aria-labelledby={`${id}-label`}>
            {chain.coins.map((c, i) => (
              <button
                key={c.assetId}
                id={i === 0 ? `${id}-coin` : undefined}
                type="button"
                role="radio"
                aria-checked={c.symbol === coin.symbol}
                className={s.chip}
                onClick={() => setSymbol(c.symbol)}
              >
                {c.symbol}
              </button>
            ))}
          </div>
        ) : null}

        {step === 'address' ? (
          <input
            id={`${id}-address`}
            className={`${s.input} ${s.addrInput}`}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder={`Your ${chain.name} address`}
            aria-labelledby={`${id}-label`}
            aria-invalid={bad}
            data-bad={bad ? '' : undefined}
            value={recipient}
            onChange={(e) => setRecipient(e.target.value.replace(/\s+/g, ''))}
          />
        ) : null}

        {step === 'amount' ? (
          <div className={s.fuel}>
            <label className={s.amount} data-bad={over ? '' : undefined}>
              <span className={s.cur}>$</span>
              <input
                id={`${id}-amount`}
                className={s.num}
                inputMode="decimal"
                autoComplete="off"
                aria-labelledby={`${id}-label`}
                aria-invalid={over}
                value={share !== null ? usdShown.toFixed(2) : usdText}
                size={Math.max(2, (share !== null ? usdShown.toFixed(2) : usdText).length)}
                onChange={(e) => {
                  setSlid(false);
                  setShare(null);
                  setUsdText(e.target.value.replace(/[^\d.]/g, '').slice(0, 7));
                }}
              />
            </label>
            <div className={s.chips} data-n={SHARES.length} role="radiogroup" aria-label="Share of your MASK WARS wallet">
              {SHARES.map(([label, pct]) => (
                <button
                  key={label}
                  type="button"
                  role="radio"
                  aria-checked={share === pct}
                  className={s.chip}
                  onClick={() => {
                    setSlid(false);
                    setShare(pct);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <button type="submit" className={s.btn} disabled={step === 'amount' && (units <= 0n || over || Boolean(previewProblem))}>
          <span className={s.word}>{step === 'amount' ? 'Cash out' : 'Next'}</span>
        </button>
      </div>

      <Note id={id} info={info} details={details} bad={bad}>
        {note}
      </Note>
    </form>
  );
}
