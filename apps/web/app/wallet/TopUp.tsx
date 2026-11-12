'use client';

import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { checkQuote, coinText, dollars, fromUnits, parseDollars, pollDelay, type Progress, usdOf } from '@maskwars/pay';
import { type CatalogState, passing, pay, PayError, type QuoteView } from './api';
import { loadPending, type PendingTopUp, savePending, type Who } from './store';
import { mmss, NoCoins, Note, Qr, quietFocus, Top, useCopy, useNow } from './ui';
import s from './wallet.module.css';

type Step = 'chain' | 'coin' | 'amount' | 'send';
const LABEL: Record<Step, string> = { chain: 'From', coin: 'Coin', amount: 'Amount', send: 'Send' };
const AMOUNTS = [10, 25, 100] as const;

const PROBLEM: Record<string, string> = {
  small: 'Too small for this route. Try a bigger amount.',
  route: 'No route for this right now. Try another coin.',
  closed: 'Deposits open soon. Your MASK WARS wallet is ready.',
  busy: 'Too busy right now. Try again in a minute.',
  offline: 'Cannot reach the network right now. Try again in a minute.',
  bad: 'That did not work. Try again.',
  wrong: 'That address did not read right. Nothing to send.',
};

export function TopUp(p: {
  who: Who;
  coins: CatalogState;
  onWaiting: (on: boolean) => void;
  /** The swap ended; `true` if the money landed as NEAR. */
  onLanded: (swapped: boolean) => void;
  onClose: () => void;
}) {
  const id = useId();
  const resumed = useMemo(() => loadPending(p.who.account), [p.who.account]);
  const catalog = p.coins.catalog;
  const chains = catalog?.chains ?? [];
  const [chainId, setChainId] = useState<string>(resumed?.chain ?? 'sol');
  const chain = chains.find((c) => c.id === chainId) ?? chains[0];
  const [symbol, setSymbol] = useState<string>(resumed?.coin.symbol ?? chain?.coins[0]?.symbol ?? '');
  const coin = chain?.coins.find((c) => c.symbol === symbol) ?? chain?.coins[0];
  const [usdText, setUsdText] = useState(String(resumed?.usd ?? 25));
  // Up to the season's limit for one top-up; more reads as no amount yet, with the limit said under it.
  const maxUsd = catalog?.maxUsd ?? 9_999;
  const amounts = AMOUNTS.filter((n) => n <= maxUsd);
  const typed = parseDollars(usdText);
  const usd = typed !== null && typed <= maxUsd ? typed : null;
  const [step, setStep] = useState<Step>(resumed ? 'send' : 'chain');
  const [info, setInfo] = useState(false);
  const [preview, setPreview] = useState<QuoteView | null>(null);
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [priceRound, setPriceRound] = useState(0);
  const [slid, setSlid] = useState(false);
  const [pending, setPending] = useState<PendingTopUp | null>(resumed);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [getting, setGetting] = useState(false);
  const [copied, copy] = useCopy();
  const moved = useRef(false);

  const steps = useMemo<Step[]>(() => ['chain', ...((chain?.coins.length ?? 0) > 1 ? (['coin'] as const) : []), 'amount', 'send'], [chain]);
  const at = Math.max(0, steps.indexOf(step));

  // A live price for what the amount buys, while the person picks it. A busy moment is not a no: the button stays on
  // (the real quote prices it), and the preview is asked once more a few seconds later.
  useEffect(() => {
    if (step !== 'amount' || !coin || !usd) return setPreview(null);
    const ctrl = new AbortController();
    let again: ReturnType<typeof setTimeout> | undefined;
    setPreviewProblem(null);
    setPreviewBusy(false);
    const ask = (retry: boolean) =>
      pay.quoteIn({ account: p.who.account, from: coin.assetId, usd, dry: true }, ctrl.signal).then(
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
          setPreviewProblem(e instanceof PayError ? (PROBLEM[e.code] ?? PROBLEM.bad!) : PROBLEM.bad!);
        },
      );
    const t = setTimeout(() => void ask(true), 350);
    return () => {
      ctrl.abort();
      clearTimeout(t);
      clearTimeout(again);
    };
  }, [step, coin, usd, p.who.account, priceRound]);

  // Follows the deposit address until 1Click says how it ended.
  const address = pending?.quote.depositAddress ?? null;
  const memo = pending?.quote.depositMemo ?? null;
  useEffect(() => {
    if (!address) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    let attempt = 0;
    const tick = async () => {
      let next: Progress | null = null;
      try {
        next = await pay.status(address, memo);
      } catch {
        /* a missed answer: ask again */
      }
      if (!live) return;
      if (next) setProgress(next);
      const stage = next?.stage ?? 'waiting';
      if (next && ['done', 'refunded', 'short', 'failed'].includes(stage)) {
        savePending(null);
        p.onLanded(stage === 'done');
        return;
      }
      timer = setTimeout(tick, pollDelay(stage, attempt++));
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, memo]);

  const stage = progress?.stage ?? (address ? 'waiting' : null);
  const waiting = stage === 'waiting' || stage === 'seen' || stage === 'moving';
  const { onWaiting } = p;
  useEffect(() => {
    onWaiting(waiting);
    return () => onWaiting(false);
  }, [waiting, onWaiting]);

  const now = useNow(step === 'send' && stage === 'waiting');
  const left = pending ? Date.parse(pending.quote.deadline) - now : 0;
  const expired = stage === 'waiting' && pending !== null && left <= 0;

  useEffect(() => {
    if (moved.current) document.getElementById(`${id}-${step}`)?.focus();
  }, [id, step]);

  const go = (to: Step) => {
    moved.current = true;
    setInfo(false);
    setProblem(null);
    setSlid(false);
    setStep(to);
  };

  const getAddress = async () => {
    if (!coin || !usd || !chain || !catalog || getting) return;
    setGetting(true);
    setProblem(null);
    try {
      const quote = await pay.quoteIn({ account: p.who.account, from: coin.assetId, usd, dry: false });
      // Read back before the address is shown: this coin in, NEAR into this vault, refunds to this vault, the price seen.
      const c = checkQuote(quote, {
        account: p.who.account,
        from: coin.assetId,
        to: catalog.near.assetId,
        recipient: p.who.account,
        recipientType: 'INTENTS',
        seen: preview?.amountOut ?? null,
      });
      if (!quote.depositAddress || !c.ok) {
        setPreview(null);
        setPriceRound((n) => n + 1);
        if (!c.ok && c.moved) return setSlid(true);
        return setProblem(PROBLEM.wrong!);
      }
      const next: PendingTopUp = { account: p.who.account, coin, chain: chain.id, usd, quote };
      savePending(next);
      setProgress(null);
      setPending(next);
      go('send');
    } catch (e) {
      setProblem(e instanceof PayError ? (PROBLEM[e.code] ?? PROBLEM.bad!) : PROBLEM.bad!);
    } finally {
      setGetting(false);
    }
  };

  const restart = () => {
    savePending(null);
    setPending(null);
    setProgress(null);
    go('amount');
  };

  const finish = () => {
    savePending(null);
    p.onClose();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (step === 'chain') return go(steps[1]!);
    if (step === 'coin') return go('amount');
    if (step === 'amount') {
      if (!usd) return document.getElementById(`${id}-amount`)?.focus();
      return void getAddress();
    }
    if (address) copy('address', address);
  };

  if (!catalog || !chain || !coin) {
    return <NoCoins id={id} label="Add money" coins={p.coins} empty="No coins on offer right now. Try again in a minute." onClose={p.onClose} />;
  }

  const sending = pending?.coin ?? coin;
  const sendingChain = chains.find((c) => c.id === pending?.chain)?.name ?? chain.name;
  const nearOut = (q: QuoteView | null) => (q ? coinText(q.amountOut, catalog.near.decimals) : null);

  // How it ended: one sentence and one button back to the vault.
  if (step === 'send' && pending && stage && ['done', 'refunded', 'short', 'failed'].includes(stage)) {
    const ended = {
      done: `Added ${coinText(progress?.amountOut ?? pending.quote.amountOut, catalog.near.decimals)} NEAR to your MASK WARS wallet, ${dollars(usdOf(progress?.amountOut ?? pending.quote.amountOut, catalog.near.decimals, catalog.near.price))}.`,
      refunded: `The swap did not go through. Your ${sending.symbol} is back in your MASK WARS wallet.`,
      short: `Less ${sending.symbol} arrived than the swap needs. It goes back to your MASK WARS wallet.`,
      failed: `It did not go through. Keep this code for support: ${progress?.correlationId.slice(0, 8) ?? pending.quote.correlationId.slice(0, 8)}.`,
    }[stage as 'done' | 'refunded' | 'short' | 'failed'];
    return (
      <div className={`${s.form} ${s.ended}`} role="status">
        <p className={s.endLine} data-good={stage === 'done' ? '' : undefined}>
          {ended}
        </p>
        <button type="button" className={`${s.btn} ${s.endBtn}`} onClick={finish} ref={quietFocus}>
          <span className={s.word}>{stage === 'done' ? 'Done' : 'Back to wallet'}</span>
        </button>
      </div>
    );
  }

  const details = (() => {
    if (step === 'send' && pending) {
      return `Send by ${new Date(pending.quote.deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}; anything later comes back to your MASK WARS wallet. Up to 1% less still goes through. 1Click by NEAR Intents swaps it to NEAR as it lands, at most 1% off the price.`;
    }
    return 'You send from your own wallet on that chain or from an exchange. 1Click by NEAR Intents swaps it to NEAR as it lands in your MASK WARS wallet, at most 1% off the price; if it cannot, the coin comes back to your MASK WARS wallet as it came.';
  })();

  const note = (() => {
    if (problem) return problem;
    switch (step) {
      case 'chain':
        return 'Where your money is now.';
      case 'coin':
        return `${coin.symbol} on ${chain.name}.`;
      case 'amount':
        if (!usd) return `From $1 to $${maxUsd.toLocaleString('en-US')}.`;
        if (!catalog.live && !previewProblem) return preview ? `≈ ${nearOut(preview)} NEAR. Deposits open soon.` : 'Deposits open soon.';
        if (previewProblem) return previewProblem;
        if (preview) return `${slid ? 'The price moved: ' : ''}≈ ${nearOut(preview)} NEAR lands in your MASK WARS wallet.`;
        return previewBusy ? 'Prices are busy right now. Get address prices it.' : 'Pricing it.';
      case 'send':
        if (expired) return 'Time is up for this price. Anything sent now comes back to your MASK WARS wallet.';
        if (stage === 'seen' || stage === 'moving') return `Your ${sending.symbol} is here. Swapping it to NEAR.`;
        return `Only ${sending.symbol} on ${sendingChain}. Waiting for it · ${mmss(left)}`;
    }
  })();
  const bad = Boolean(problem) || (step === 'amount' && (!usd || Boolean(previewProblem)));

  return (
    <form className={s.form} onSubmit={submit} noValidate data-step={step}>
      <Top
        id={id}
        label={step === 'send' && waiting && stage !== 'waiting' ? 'Swapping' : LABEL[step]}
        details={details}
        info={info}
        onInfo={() => setInfo((v) => !v)}
        back={
          step === 'send'
            ? stage === 'waiting'
              ? restart
              : null
            : at === 0
              ? p.onClose
              : () => go(steps[at - 1]!)
        }
        backLabel={step === 'send' ? 'Change' : 'Back'}
        count={[at + 1, steps.length]}
      />

      <div className={s.row} key={step} data-wide={step === 'send' ? '' : undefined}>
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

        {step === 'amount' ? (
          <div className={s.fuel}>
            <label className={s.amount} data-bad={!usd ? '' : undefined}>
              <span className={s.cur}>$</span>
              <input
                id={`${id}-amount`}
                className={s.num}
                inputMode="decimal"
                autoComplete="off"
                aria-labelledby={`${id}-label`}
                aria-invalid={!usd}
                value={usdText}
                size={Math.max(2, usdText.length)}
                onChange={(e) => {
                  setSlid(false);
                  setUsdText(e.target.value.replace(/[^\d.]/g, '').slice(0, 7));
                }}
              />
            </label>
            <div className={s.chips} data-n={amounts.length} role="radiogroup" aria-label="Amount">
              {amounts.map((n) => (
                <button key={n} type="button" role="radio" aria-checked={usd === n} className={s.chip} onClick={() => {
                    setSlid(false);
                    setUsdText(String(n));
                  }}
                >
                  ${n}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {step === 'send' && pending && address ? (
          <div className={s.send} id={`${id}-send`} tabIndex={-1}>
            <Qr text={address} label={`QR code of the deposit address on ${sendingChain}`} />
            <div className={s.sendText}>
              <button type="button" className={s.sendAmount} onClick={() => copy('amount', fromUnits(pending.quote.amountIn, sending.decimals))}>
                <b>{fromUnits(pending.quote.amountIn, sending.decimals)}</b> {sending.symbol}
                <span className={s.sendOn}>{copied === 'amount' ? 'copied' : `on ${sendingChain}`}</span>
              </button>
              <span className={s.addr}>{address}</span>
              {memo ? (
                <button type="button" className={s.memo} onClick={() => copy('memo', memo)}>
                  Memo {memo} {copied === 'memo' ? '· copied' : '· required'}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {step === 'send' ? (
          expired ? (
            <button type="button" className={s.btn} onClick={restart}>
              <span className={s.word}>New address</span>
            </button>
          ) : (
            <button type="submit" className={s.btn} disabled={!address}>
              <span className={s.word}>{copied === 'address' ? 'Copied' : 'Copy address'}</span>
            </button>
          )
        ) : (
          <button
            type="submit"
            className={s.btn}
            disabled={getting || (step === 'amount' && (!catalog.live || !usd || Boolean(previewProblem)))}
            aria-busy={getting}
          >
            <span className={s.word}>{getting ? 'Opening' : step === 'amount' ? 'Get address' : 'Next'}</span>
          </button>
        )}
      </div>

      <Note id={id} info={info} details={details} bad={bad || expired}>
        {step === 'send' && waiting ? <span className={s.live} aria-hidden /> : null}
        {note}
      </Note>
    </form>
  );
}
