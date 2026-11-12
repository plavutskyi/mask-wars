'use client';

import {
  checkNearQuote,
  feeBps,
  fromUnits,
  nearFinal,
  parseDollars,
  pollDelay,
  readNearAccount,
  usdOf,
  type NearChain,
  type NearCoin,
  type NearProgress,
  type NearQuoteView,
} from '@maskwars/pay';
import Link from 'next/link';
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  accountBad,
  accountReady,
  accountText,
  type AccountView,
  clockText,
  dollarsText,
  etaText,
  feeSplit,
  loadLast,
  loadPending,
  mmss,
  NearError,
  type NearCatalogView,
  nearApi,
  nearText,
  type PendingNear,
  percentText,
  PROBLEM,
  problemText,
  saveLast,
  savePending,
  shortRest,
  shortText,
  START,
  startReceiver,
} from './flow';
import { familyOf, payable, payFrom, PayFailed, type Step as PayStep, tellDeposit, txLink, type Wallet, walletsFor, watchWallets } from './pay';
import { CopyGlyph, Qr, Tick, useCopy, useNow } from './parts';
import { CoinMark, ContractLink, sendOnlyText, TokenFacts } from './CoinMark';
import { Picker } from './Picker';
import { Tabs } from './Tabs';
import { Info } from '@/components/arena/Info';
import { nearSignIn } from '../wallet/near';
import s from './near.module.css';

const AMOUNTS = [10, 25, 50, 100] as const;
/** What arrives: native NEAR on NEAR, for the mark beside the big number. */
const NEAR_COIN = { symbol: 'NEAR', logo: 'near.svg', native: true } as const;
const NEAR_CHAIN = { id: 'near', name: 'NEAR' } as const;
const EXPLORER = 'https://nearblocks.io';

/** The page: a coin and an amount in, NEAR out to an account, then the deposit address and the swap as it happens. */
export function GetNear() {
  const id = useId();
  const [catalog, setCatalog] = useState<NearCatalogView | null>(null);
  const [down, setDown] = useState(false);
  const [loadRound, setLoadRound] = useState(0);
  const [from, setFrom] = useState<string | null>(null);
  const [usdText, setUsdText] = useState('25');
  const [toText, setToText] = useState('');
  const [picking, setPicking] = useState(false);
  const [account, setAccount] = useState<AccountView | null>(null);
  const [checking, setChecking] = useState(false);
  const [accountDown, setAccountDown] = useState(false);
  const [preview, setPreview] = useState<NearQuoteView | null>(null);
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [priceRound, setPriceRound] = useState(0);
  const [slid, setSlid] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [getting, setGetting] = useState(false);
  const [pending, setPending] = useState<PendingNear | null>(null);
  const [progress, setProgress] = useState<NearProgress | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [nudge, setNudge] = useState(false);
  const [fromLink, setFromLink] = useState(false);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [paying, setPaying] = useState<{ wallet: Wallet; step: PayStep } | null>(null);
  const [payProblem, setPayProblem] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [nearBusy, setNearBusy] = useState(false);
  const [copied, copy] = useCopy();

  // What this browser remembers comes in after the first paint, so the server's page and the browser's agree.
  useEffect(() => {
    const last = loadLast();
    const start = startReceiver({ saved: last.to, link: new URLSearchParams(window.location.search).get('to') });
    setToText(start.text);
    setFromLink(start.fromLink);
    if (last.from) setFrom(last.from);
    setPending(loadPending());
  }, []);

  // The coins on offer, asked again a few times before saying they did not come.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    setDown(false);
    const ask = (n: number) =>
      nearApi.catalog().then(
        (c) => alive && setCatalog(c),
        () => {
          if (!alive) return;
          if (n < 2) timer = setTimeout(() => void ask(n + 1), 1500 * (n + 1));
          else setDown(true);
        },
      );
    void ask(0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [loadRound]);

  const chains = catalog?.chains ?? [];
  const picked = useMemo(() => pick(chains, from), [chains, from]);
  const chain = picked?.chain ?? null;
  const coin = picked?.coin ?? null;
  const maxUsd = catalog?.maxUsd ?? 100;
  const typed = parseDollars(usdText);
  const usd = typed !== null && typed <= maxUsd ? typed : null;
  const amounts = AMOUNTS.filter((n) => n <= maxUsd);

  // Who receives: read here at once, asked of NEAR a moment after the typing stops.
  const read = useMemo(() => readNearAccount(toText), [toText]);
  useEffect(() => {
    setProblem(null);
    setNudge(false);
    setAccountDown(false);
    if (!read.ok) {
      setChecking(false);
      return setAccount(read.why === 'empty' ? null : read);
    }
    const ctrl = new AbortController();
    setChecking(true);
    setAccount(null);
    const t = setTimeout(() => {
      nearApi.account(read.id, ctrl.signal).then(
        (a) => {
          if (ctrl.signal.aborted) return;
          setAccount(a);
          setChecking(false);
        },
        () => {
          if (ctrl.signal.aborted) return;
          // A node that does not answer: an implicit address is fine either way, a name is asked again on Get NEAR.
          setAccount(read.kind === 'implicit' ? { ok: true, id: read.id, kind: 'implicit', exists: null } : null);
          setAccountDown(read.kind === 'named');
          setChecking(false);
        },
      );
    }, 420);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [read]);

  // A live price while the person picks: the same for everyone, asked again once if the moment was busy.
  const priceKey = coin && usd ? `${coin.assetId}|${usd}` : null;
  useEffect(() => {
    if (pending || !coin || !usd || !chain) return;
    const ctrl = new AbortController();
    let again: ReturnType<typeof setTimeout> | undefined;
    setPreviewProblem(null);
    setPreviewBusy(false);
    const ask = (retry: boolean) =>
      nearApi.quote({ from: coin.assetId, usd, dry: true }, ctrl.signal).then(
        (q) => {
          if (ctrl.signal.aborted) return;
          setPreview(q);
          setPreviewFor(`${coin.assetId}|${usd}`);
          setPreviewBusy(false);
        },
        (e) => {
          if (ctrl.signal.aborted) return;
          // A busy moment is not a no: asked once more, and if still busy the real quote on Get NEAR prices it.
          if (e instanceof NearError && (e.code === 'busy' || e.code === 'offline')) {
            if (retry) again = setTimeout(() => void ask(false), 3500);
            else setPreviewBusy(true);
            return;
          }
          setPreview(null);
          setPreviewFor(null);
          setPreviewProblem(problemText(e, chain.name, maxUsd));
        },
      );
    const t = setTimeout(() => void ask(true), 300);
    return () => {
      ctrl.abort();
      clearTimeout(t);
      clearTimeout(again);
    };
  }, [pending, coin, chain, usd, maxUsd, priceRound]);

  // Follows the deposit address until 1Click says how it ended.
  const address = pending?.quote.depositAddress ?? null;
  const memo = pending?.quote.depositMemo ?? null;
  useEffect(() => {
    if (!address) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let attempt = 0;
    const tick = async () => {
      let next: NearProgress | null = null;
      try {
        next = await nearApi.status(address, memo);
      } catch {
        /* a missed answer: ask again */
      }
      if (!alive) return;
      if (next) setProgress(next);
      if (next && nearFinal(next.stage)) return savePending(null);
      timer = setTimeout(tick, pollDelay(next?.stage ?? 'waiting', attempt++));
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [address, memo]);

  const stage = progress?.stage ?? (address ? 'waiting' : null);
  const open = stage === 'waiting' || stage === 'short';

  // The wallets in this browser that can pay on the deposit's network, as they announce themselves.
  const payChain = pending && familyOf(pending.chain.id) && payable(pending.chain.id, pending.coin) ? pending.chain.id : null;
  useEffect(() => {
    if (!payChain) return setWallets([]);
    const update = () => setWallets(walletsFor(payChain));
    const off = watchWallets(update);
    update();
    return off;
  }, [payChain]);
  const now = useNow(open);
  const left = pending ? Date.parse(pending.quote.deadline) - now : 0;
  const expired = open && pending !== null && left <= 0;

  // A receiver from a link counts only once the person says it is theirs.
  const ready = Boolean(catalog?.live && coin && usd && accountReady(account) && !fromLink && !previewProblem && !checking);

  const getNear = async () => {
    if (!catalog || !coin || !chain || !usd || getting) return;
    if (!read.ok) {
      setNudge(true);
      return document.getElementById(`${id}-to`)?.focus();
    }
    if (!ready || !account?.ok) return;
    setGetting(true);
    setProblem(null);
    try {
      const quote = await nearApi.quote({ from: coin.assetId, usd, recipient: account.id, dry: false });
      // Read back before the address is shown: this coin in, NEAR on NEAR to this account, refunds to it, the price seen.
      const c = checkNearQuote(quote, { recipient: account.id, from: coin.assetId, seen: previewFor === priceKey ? (preview?.amountOut ?? null) : null });
      if (!quote.depositAddress || !c.ok) {
        setPriceRound((n) => n + 1);
        if (!c.ok && c.moved) return setSlid(true);
        return setProblem(PROBLEM.wrong);
      }
      const next: PendingNear = { recipient: account.id, chain: { id: chain.id, name: chain.name }, coin, usd, quote };
      savePending(next);
      saveLast({ from: coin.assetId, to: account.id });
      setProgress(null);
      setShowQr(false);
      setPending(next);
      requestAnimationFrame(() => document.getElementById(`${id}-send`)?.focus({ preventScroll: false }));
    } catch (e) {
      setProblem(problemText(e, chain.name, maxUsd));
    } finally {
      setGetting(false);
    }
  };

  // Pays the deposit address from a wallet in this browser: the rest after a short deposit, otherwise the amount quoted.
  const payWith = async (wallet: Wallet) => {
    if (!pending?.quote.depositAddress || paying) return;
    setChoosing(false);
    setPayProblem(null);
    setPaying({ wallet, step: 'connect' });
    // After a short deposit only the rest, and nothing while 1Click has not said how much came.
    const rest = stage === 'short' ? shortRest(pending, progress?.deposited ?? null) : null;
    if (stage === 'short' && rest === null) {
      setPaying(null);
      return;
    }
    const amount = rest ?? BigInt(pending.quote.amountIn);
    try {
      const tx = await payFrom(wallet, { chainId: pending.chain.id, coin: pending.coin, depositAddress: pending.quote.depositAddress, amount }, (step) =>
        setPaying({ wallet, step }),
      );
      tellDeposit(pending.quote.depositAddress, tx, pending.quote.depositMemo);
      const next: PendingNear = { ...pending, paid: { by: wallet.name, tx, link: txLink(pending.chain.id, tx) } };
      savePending(next);
      setPending(next);
    } catch (e) {
      setPayProblem(payText(e, pending, wallet));
    } finally {
      setPaying(null);
    }
  };

  // Fills the receiver from the person's own NEAR wallet: no typing, and it is theirs by definition.
  const fillFromNearWallet = async () => {
    if (nearBusy) return;
    setNearBusy(true);
    try {
      const w = await nearSignIn();
      setFromLink(false);
      setToText(w.accountId);
    } catch {
      /* closed or declined: the field stays as it was */
    } finally {
      setNearBusy(false);
    }
  };

  const restart = () => {
    savePending(null);
    setPending(null);
    setProgress(null);
    setSlid(false);
    setPayProblem(null);
    setChoosing(false);
    setPriceRound((n) => n + 1);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!usd) return document.getElementById(`${id}-usd`)?.focus();
    void getNear();
  };

  const closePicker = useCallback(() => {
    setPicking(false);
    requestAnimationFrame(() => document.getElementById(`${id}-coin`)?.focus());
  }, [id]);

  // ---- The number ----

  const near = catalog?.near ?? { decimals: 24, price: 0 };
  const fresh = previewFor === priceKey ? preview : null;
  const shown = pending ? pending.quote : fresh;
  const ended = pending && stage && nearFinal(stage) ? stage : null;
  const landedUnits = ended === 'done' ? (progress?.amountOut ?? pending?.quote.amountOut ?? null) : null;
  // While a new price comes, the last one stays up, dimmed, instead of a jump to nothing.
  const heroUnits = landedUnits ?? shown?.amountOut ?? (usd ? (preview?.amountOut ?? null) : null);
  const heroUsd = heroUnits && near.price ? usdOf(heroUnits, near.decimals, near.price) : null;
  const heroDim = !heroUnits || (ended !== null && ended !== 'done') || (!pending && !shown);

  const kicker = (() => {
    if (ended === 'done') return 'Landed';
    if (ended) return 'Did not go through';
    if (pending) return stage === 'moving' || stage === 'seen' ? 'Swapping to NEAR' : stage === 'short' ? 'Waiting for the rest' : 'You get';
    return 'You get';
  })();

  const heroLine = (() => {
    if (ended === 'done') return <>in <b>{pending!.recipient}</b></>;
    if (pending) return <>to <b>{pending.recipient}</b></>;
    if (!usd) return `From $1 to ${dollarsText(maxUsd)}.`;
    if (shown && heroUsd !== null) return `≈ ${dollarsText(Math.floor(heroUsd * 100) / 100)} · lands in ${etaText(shown.timeEstimate)}`;
    return previewBusy ? 'Prices are busy. Get NEAR prices it.' : 'Pricing it.';
  })();

  // ---- The card ----

  const details = (() => {
    if (!catalog || !coin || !chain) return null;
    if (pending) {
      const q = pending.quote;
      const paid = feeSplit(q.fees, catalog.fee?.recipient ?? null);
      return [
        ['Send by', `${clockText(q.deadline)}. Anything later goes to ${pending.recipient} inside NEAR Intents.`],
        ['At least', `${fromUnits(q.minAmountIn, pending.coin.decimals)} ${pending.coin.symbol} must arrive.`],
        ['You get at least', `${nearText(q.minAmountOut)} NEAR, or it refunds.`],
        ['Fees', feeLine(feeBps(q), paid)],
        ...(pending.chain.id === 'sol' && pending.coin.contract
          ? ([['From a Solana wallet', "Also about 0.002 SOL, to open the deposit address's token account."]] as const)
          : []),
        ['Coin', <TokenFacts key="coin" coin={pending.coin} chain={pending.chain} withSymbol copyable={false} />],
        ['Support code', q.correlationId.slice(0, 8)],
      ] as const;
    }
    const v = shown;
    const split = v ? feeSplit(v.fees, catalog.fee?.recipient ?? null) : null;
    return [
      ...(v && usd ? ([['Rate', `1 NEAR ≈ ${dollarsText(Math.round((usd / Number(fromUnits(v.amountOut, near.decimals, 6))) * 100) / 100)}`]] as const) : []),
      ...(v ? ([['At least', `${nearText(v.minAmountOut)} NEAR arrives, or the swap refunds.`]] as const) : []),
      ...(v && split ? ([['Fees', feeLine(feeBps(v), split)]] as const) : []),
      ['Arrives as', 'Native NEAR on NEAR mainnet, straight to the account.'],
      ['If it fails', 'The coin goes to the same account inside NEAR Intents. Whoever holds the account takes it out at near-intents.org.'],
      ['Coin', <TokenFacts key="coin" coin={coin} chain={chain} withSymbol />],
      ['No account yet', 'Any NEAR wallet gives you a 64-character address for free. The NEAR opens it.'],
      ['Limit', `Prices up to ${dollarsText(maxUsd)} while season 0 is new.`],
    ] as const;
  })();

  // The facts open over the card from the «i», as every «i» on the site does: nothing on the page moves, the amount
  // and the button stay where they are. A sheet from the bottom on a phone; Escape or a tap outside closes it.
  const infoButton = details ? (
    <Info rows={[]} label="Details" anchor="line" align="start" fill>
      <dl className={s.details}>
        {details.map(([k, v]) => (
          <div key={k} className={s.fact}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
        <div className={s.fact}>
          <dt>Swapped by</dt>
          <dd>NEAR Intents (1Click). The team never holds your coins.</dd>
        </div>
      </dl>
    </Info>
  ) : null;

  let card: ReactNode;
  if (!catalog || !coin || !chain) {
    card = (
      <div className={s.card} aria-busy={!down}>
        <div className={s.loading}>
          {down ? (
            <>
              <p className={s.note} data-bad="">
                The coins did not load.
              </p>
              <button type="button" className={s.btn} onClick={() => setLoadRound((n) => n + 1)}>
                <span className={s.word}>Try again</span>
              </button>
            </>
          ) : (
            <p className={s.note}>
              <span className={s.pulse} aria-hidden />
              Loading every network.
            </p>
          )}
        </div>
      </div>
    );
  } else if (pending && ended) {
    card = <Ended stage={ended} pending={pending} progress={progress} onAgain={restart} />;
  } else if (pending && address) {
    const p = pending;
    // After a short deposit only the rest is on the card, so nobody sends the whole amount twice.
    const rest = stage === 'short' ? shortRest(p, progress?.deposited ?? null) : null;
    // A short deposit whose amount 1Click has not reported: no number on the card and no wallet button, so the whole
    // amount is never asked for a second time.
    const restUnknown = stage === 'short' && rest === null;
    const sendText = fromUnits(rest ?? BigInt(p.quote.amountIn), p.coin.decimals);
    const step = stage === 'waiting' ? 0 : stage === 'seen' || stage === 'short' ? 1 : 2;
    const waiting = stage === 'waiting';
    const short = stage === 'short';
    card = (
      <div className={s.card} data-phase="send">
        <div className={s.top}>
          <span className={`${s.word} ${s.label}`}>{restUnknown ? 'Part arrived' : short ? 'Send the rest' : waiting || expired ? 'Send' : 'Your deposit'}</span>
          {infoButton}
          <span className={s.grow} />
          {open && !expired ? (
            <span className={s.clock} aria-label={`Time left ${mmss(left)}`}>
              {mmss(left)}
            </span>
          ) : null}
          {stage === 'waiting' ? (
            <button type="button" className={s.back} onClick={restart}>
              Change
            </button>
          ) : null}
        </div>
        <div className={s.deposit} id={`${id}-send`} tabIndex={-1}>
          {open ? <Qr text={address} label={`QR code of the deposit address on ${p.chain.name}`} shown={showQr} /> : null}
          <div className={s.depositText}>
            {restUnknown ? (
              <span className={s.sendAmount}>Checking the amount</span>
            ) : (
              <button type="button" className={s.sendAmount} onClick={() => copy('amount', sendText)} aria-label={`Copy the amount, ${sendText} ${p.coin.symbol}`}>
                <b>{sendText}</b> {p.coin.symbol}
                <CopyGlyph />
              </button>
            )}
            <span className={s.sendOn}>{copied === 'amount' ? 'Amount copied' : sendOnlyText(p.coin, p.chain, rest !== null)}</span>
            <ContractLink coin={p.coin} chain={p.chain} />
            <span className={s.addr} aria-label="Deposit address">
              {address}
            </span>
            {open ? (
              <button type="button" className={s.qrToggle} aria-expanded={showQr} onClick={() => setShowQr((v) => !v)}>
                {showQr ? 'Hide QR' : 'Show QR'}
              </button>
            ) : null}
          </div>
        </div>
        {memo ? (
          <button type="button" className={s.memo} onClick={() => copy('memo', memo)}>
            Memo {memo} · {copied === 'memo' ? 'copied' : 'required, or the coins are lost'}
          </button>
        ) : null}
        {open && !expired && p.paid ? (
          <p className={s.paid}>
            <Tick />
            <span className={s.grow}>Sent from {p.paid.by}.</span>
            {p.paid.link ? (
              <a href={p.paid.link} target="_blank" rel="noreferrer" aria-label={`View the transaction from ${p.paid.by}`}>
                View
              </a>
            ) : null}
          </p>
        ) : null}
        {open && !expired && !p.paid && !restUnknown && wallets.length ? (
          choosing && wallets.length > 1 ? (
            <div className={s.walletList} role="group" aria-label="Pay from">
              {wallets.map((w) => (
                <button key={w.id} type="button" className={`${s.btn} ${s.quiet} ${s.walletBtn}`} onClick={() => void payWith(w)}>
                  {w.icon ? <img src={w.icon} alt="" width={22} height={22} className={s.walletIcon} /> : null}
                  <span className={s.word}>{w.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <button
              type="button"
              className={`${s.btn} ${s.walletBtn}`}
              disabled={paying !== null}
              aria-busy={paying !== null}
              onClick={() => (wallets.length > 1 ? setChoosing(true) : void payWith(wallets[0]!))}
            >
              {paying?.wallet.icon || (wallets.length === 1 && wallets[0]!.icon) ? (
                <img src={(paying?.wallet.icon ?? wallets[0]!.icon)!} alt="" width={22} height={22} className={s.walletIcon} />
              ) : null}
              <span className={s.word}>{paying ? STEP[paying.step] : wallets.length === 1 ? `Pay with ${wallets[0]!.name}` : 'Pay from my own wallet'}</span>
            </button>
          )
        ) : null}
        {expired && waiting ? (
          <button type="button" className={s.btn} onClick={restart}>
            <span className={s.word}>New address</span>
          </button>
        ) : open && !expired ? (
          <button type="button" className={`${s.btn} ${wallets.length || p.paid || restUnknown ? s.quiet : ''}`} onClick={() => copy('address', address)}>
            <span className={s.word}>{copied === 'address' ? 'Copied' : 'Copy address'}</span>
          </button>
        ) : null}
        <ol className={s.track} aria-label="Progress">
          {(['Sent', 'Arrived', 'Swapped', 'Landed'] as const).map((w, i) => (
            <li key={w} className={s.trackStep} data-done={i < step ? '' : undefined} data-now={i === step ? '' : undefined} aria-current={i === step ? 'step' : undefined}>
              {w}
            </li>
          ))}
        </ol>
        <p className={s.note} role="status" aria-live="polite" data-bad={expired || short || payProblem ? '' : undefined}>
          {payProblem && open && !expired
            ? payProblem
            : short
            ? shortText({ pending: p, deposited: progress?.deposited ?? null, now })
            : expired
            ? `Time is up for this price. Anything sent now goes to ${p.recipient} inside NEAR Intents.`
            : stage === 'waiting'
              ? p.paid
                ? `Waiting for ${p.chain.name} to confirm it.`
                : `Send from your own wallet, or straight from an exchange like Binance: pick the ${p.chain.name} network. If it takes a fee, add it on top.`
              : stage === 'seen'
                ? `Your ${p.coin.symbol} is here. ${p.chain.name} is confirming it.`
                : 'Swapping it to NEAR now.'}
        </p>
      </div>
    );
  } else {
    const coinProblem = previewProblem;
    const accountLine = checking
      ? 'Checking NEAR.'
      : fromLink && read.ok
        ? 'From a link. Check it is your own account.'
        : accountDown
        ? 'NEAR did not answer. Try again in a moment.'
        : nudge && !read.ok
          ? 'Paste your NEAR account first: a name or a 64-character address.'
          : accountText(account);
    const bad = accountBad(account) || accountDown;
    const line = (() => {
      if (problem) return { text: problem, bad: true };
      if (!usd) return { text: `From $1 to ${dollarsText(maxUsd)}.`, bad: true };
      if (coinProblem) return { text: coinProblem, bad: true };
      if (!catalog.live) return { text: PROBLEM.closed, bad: false };
      if (slid) return { text: 'The price moved. Here is the new one.', bad: false };
      return { text: 'Send from your own wallet, or straight from an exchange.', bad: false };
    })();
    card = (
      <form className={s.card} onSubmit={submit} noValidate>
        <div className={s.top}>
          <span className={`${s.word} ${s.label}`} id={`${id}-send-label`}>
            You send
          </span>
          {infoButton}
        </div>
        <div className={s.sendRow}>
          <label className={s.amount} data-bad={!usd ? '' : undefined}>
            <span className={s.cur}>$</span>
            <input
              id={`${id}-usd`}
              className={s.num}
              inputMode="decimal"
              autoComplete="off"
              aria-labelledby={`${id}-send-label`}
              aria-invalid={!usd}
              value={usdText}
              onChange={(e) => {
                setSlid(false);
                setProblem(null);
                setUsdText(e.target.value.replace(/[^\d.]/g, '').slice(0, 7));
              }}
            />
          </label>
          <button type="button" id={`${id}-coin`} className={s.coinBtn} aria-haspopup="dialog" onClick={() => setPicking(true)}>
            <CoinMark coin={coin} chain={chain} size={32} />
            <span className={s.coinBtnText}>
              <b>{coin.symbol}</b>
              <span>{chain.name}</span>
            </span>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M7 10l5 5 5-5" />
            </svg>
          </button>
        </div>
        <div className={s.chips} role="radiogroup" aria-label="Amount">
          {amounts.map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={usd === n}
              className={s.chip}
              onClick={() => {
                setSlid(false);
                setProblem(null);
                setUsdText(String(n));
              }}
            >
              ${n}
            </button>
          ))}
        </div>

        <div className={s.top}>
          <label className={`${s.word} ${s.label}`} htmlFor={`${id}-to`}>
            To
          </label>
          <span className={s.grow} />
          <button type="button" className={s.useWallet} onClick={() => void fillFromNearWallet()} disabled={nearBusy} aria-busy={nearBusy}>
            {nearBusy ? 'Opening' : 'Use my own NEAR wallet'}
          </button>
        </div>
        <input
          id={`${id}-to`}
          className={s.input}
          value={toText}
          placeholder="your-name.near"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={bad}
          aria-describedby={`${id}-to-line`}
          data-bad={bad ? '' : undefined}
          data-link={fromLink ? '' : undefined}
          onChange={(e) => {
            setFromLink(false);
            setToText(e.target.value.slice(0, 80));
          }}
        />
        <div className={s.toRow}>
          <p
            className={s.toLine}
            id={`${id}-to-line`}
            data-bad={bad ? '' : undefined}
            data-good={accountReady(account) && !checking && !fromLink ? '' : undefined}
            data-link={fromLink && read.ok ? '' : undefined}
            aria-live="polite"
          >
            {accountReady(account) && !checking && !fromLink ? <Tick /> : null}
            {accountLine}
          </p>
          {fromLink && read.ok ? (
            <button type="button" className={s.mine} onClick={() => setFromLink(false)}>
              It is mine
            </button>
          ) : null}
        </div>

        <p className={s.terms} aria-live="polite">
          <span>Fee</span>
          <span>{fresh ? `${percentText(feeBps(fresh))}, inside the price` : '…'}</span>
        </p>

        <button type="submit" className={`${s.btn} ${s.go}`} disabled={getting || (toText.trim() !== '' && !ready)} aria-busy={getting}>
          <span className={s.word}>{getting ? 'Opening' : 'Get NEAR'}</span>
        </button>
        <p className={s.note} role={line.bad ? 'alert' : 'status'} data-bad={line.bad ? '' : undefined}>
          {line.text}
        </p>
      </form>
    );
  }

  return (
    <div className={s.layout} data-moving={pending ? '' : undefined}>
      <section className={s.hero} aria-labelledby={`${id}-title`}>
        <Tabs here="near" />
        <h1 className={`${s.word} ${s.title}`} id={`${id}-title`}>
          Get NEAR
        </h1>
        <p className={s.lede}>
          {catalog ? `Any coin on ${chains.length} networks.` : 'Any coin on any network.'} NEAR straight to your account.
        </p>
        <div className={s.result} aria-live="polite" data-dim={heroDim ? '' : undefined} data-ended={ended ?? undefined}>
          <span className={`${s.word} ${s.kicker}`}>{kicker}</span>
          <span className={s.big}>
            <span className={s.bigNum}>{heroUnits ? nearText(heroUnits) : '0'}</span>
            <span className={s.bigUnit}>
              <CoinMark coin={NEAR_COIN} chain={NEAR_CHAIN} />
              <span>NEAR</span>
            </span>
          </span>
          <span className={s.heroLine}>{heroLine}</span>
        </div>
      </section>
      {card}
      {picking && catalog ? (
        <Picker
          chains={chains}
          current={coin?.assetId ?? null}
          onClose={closePicker}
          onPick={(assetId) => {
            setFrom(assetId);
            setSlid(false);
            setProblem(null);
            saveLast({ from: assetId });
            closePicker();
          }}
        />
      ) : null}
    </div>
  );
}

/** How the swap ended: one sentence, the way on, and the NEAR transaction when there is one. */
function Ended({ stage, pending, progress, onAgain }: { stage: string; pending: PendingNear; progress: NearProgress | null; onAgain: () => void }) {
  const tx = progress?.landedTx ?? null;
  const code = (progress?.correlationId ?? pending.quote.correlationId).slice(0, 8);
  const sym = pending.coin.symbol;
  const refunded = progress?.refunded ? `${fromUnits(progress.refunded, pending.coin.decimals)} ${sym}` : `Your ${sym}`;
  const line = {
    done: <>Done. The arena is waiting.</>,
    refunded: (
      <>
        The swap did not go through. <span className={s.nowrap}>{refunded}</span> went to {pending.recipient} inside NEAR Intents. That account's wallet takes it out at near-intents.org.
      </>
    ),
    failed: <>It did not go through. Keep this code for support: {code}.</>,
  }[stage as 'done' | 'refunded' | 'failed'];
  return (
    <div className={`${s.card} ${s.ended}`} role="status" data-stage={stage}>
      <p className={s.endLine}>{line}</p>
      {stage === 'done' ? (
        <>
          <Link href="/" className={`${s.btn} ${s.go}`}>
            <span className={s.word}>Go to the race</span>
          </Link>
          <div className={s.endRow}>
            {tx ? (
              <a className={`${s.btn} ${s.quiet}`} href={`${EXPLORER}/txns/${tx}`} target="_blank" rel="noreferrer">
                <span className={s.word}>View on NEAR</span>
              </a>
            ) : null}
            <button type="button" className={`${s.btn} ${s.quiet}`} onClick={onAgain}>
              <span className={s.word}>Get more</span>
            </button>
          </div>
        </>
      ) : (
        <>
          <button type="button" className={`${s.btn} ${s.go}`} onClick={onAgain}>
            <span className={s.word}>Try again</span>
          </button>
          {stage !== 'failed' ? (
            <a className={`${s.btn} ${s.quiet}`} href="https://near-intents.org" target="_blank" rel="noreferrer">
              <span className={s.word}>Open NEAR Intents</span>
            </a>
          ) : null}
        </>
      )}
    </div>
  );
}

/** What the pay button says while the wallet works. */
const STEP: Record<PayStep, string> = { connect: 'Open your wallet', network: 'Switching network', check: 'Checking balance', confirm: 'Confirm in wallet' };

/** Why a wallet payment did not go: what to do about it; copying the address always remains. */
function payText(e: unknown, p: PendingNear, w: Wallet): string {
  const sym = p.coin.symbol;
  const net = p.chain.name;
  if (!(e instanceof PayFailed)) return 'The wallet did not send it. Try again, or copy the address.';
  switch (e.problem) {
    case 'cancelled':
      return 'Cancelled in the wallet. Nothing was sent.';
    case 'funds':
      return `Not enough ${sym} on ${net} in this wallet${e.have !== null ? ` (${fromUnits(e.have, p.coin.decimals, 6)})` : ''}. Top it up, or copy the address.`;
    case 'rent':
      return `${w.name} needs about 0.0021 SOL to open the deposit address's token account. Top it up, or copy the address.`;
    case 'network':
      return `${w.name} did not switch to ${net}. Switch it there, or copy the address.`;
    case 'coin':
      return `${w.name} cannot pay ${sym} on ${net} from this page. Copy the address instead.`;
    case 'unclear':
      return `${w.name} did not say whether it sent. Check it before paying again: a payment that went out shows up here by itself.`;
    default:
      return 'The wallet did not send it. Try again, or copy the address.';
  }
}

/** `0.33% inside the price: MASK WARS 0.13%, NEAR Intents 0.2%.` */
function feeLine(total: number, split: { ours: number; intents: number }): string {
  const parts =
    split.ours && split.intents
      ? `: MASK WARS ${percentText(split.ours)}, NEAR Intents ${percentText(split.intents)}`
      : split.ours
        ? ', all of it to MASK WARS'
        : ', all of it to NEAR Intents';
  return `${percentText(total)} inside the price${parts}.`;
}

function pick(chains: readonly NearChain[], assetId: string | null): { chain: NearChain; coin: NearCoin } | null {
  for (const chain of chains) {
    const coin = assetId ? chain.coins.find((c) => c.assetId === assetId) : null;
    if (coin) return { chain, coin };
  }
  const start = chains.find((c) => c.id === START[0]);
  const coin = start?.coins.find((c) => c.symbol === START[1]) ?? start?.coins[0];
  if (start && coin) return { chain: start, coin };
  const first = chains[0];
  return first?.coins[0] ? { chain: first, coin: first.coins[0] } : null;
}
