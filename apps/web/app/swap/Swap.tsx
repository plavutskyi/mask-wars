'use client';

import {
  addressKindOf,
  checkSwapQuote,
  coinText,
  feeBps,
  fromUnits,
  NEAR_ASSET,
  nearFinal,
  pollDelay,
  readRefund,
  STABLE,
  readSwapAddress,
  usdOf,
  type AddressWhy,
  type NearCoin,
  type Refund,
  type SwapChain,
  type SwapProgress,
  type SwapQuoteView,
} from '@maskwars/pay';
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useState } from 'react';
import { clockText, dollarsText, etaText, feeSplit, mmss, nearApi, percentText, shortRest } from '../near/flow';
import { CopyGlyph, Qr, Tick, useCopy, useNow } from '../near/parts';
import { familyOf, payable, payFrom, PayFailed, type Step as PayStep, txLink, type Wallet, walletAddress, walletsFor, watchWallets } from '../near/pay';
import { CoinMark, ContractLink, sendOnlyText, TokenFacts } from '../near/CoinMark';
import { Picker } from '../near/Picker';
import { Tabs } from '../near/Tabs';
import { Info } from '@/components/arena/Info';
import { nearSignIn } from '../wallet/near';
import {
  addressHint,
  addressText,
  amountText,
  amountUnits,
  heroAmount,
  loadLastSwap,
  loadPendingSwap,
  type Payment,
  type PendingSwap,
  POPULAR_FROM,
  POPULAR_TO,
  rateText,
  refundText,
  saveLastSwap,
  savePendingSwap,
  clearPendingSwap,
  shortAddress,
  START_FROM,
  START_TO,
  SWAP_PROBLEM,
  type SwapCatalogView,
  SwapError,
  swapApi,
  swapProblemText,
  swapShortText,
  tellSwapDeposit,
  usdText,
} from './flow';
import { payFromNear } from './near-pay';
import n from '../near/near.module.css';
import s from './swap.module.css';

/** The NEAR wallet, as a way to pay: a coin on NEAR is paid from it and nothing else. */
const NEAR_WALLET = 'near';
/** The deposit address, as a way to pay: any wallet, any exchange. */
const ADDRESS = 'address';

type Picked = { chain: SwapChain; coin: NearCoin };

/** Whether a NEAR account is there, asked a moment after the typing stops. */
function useNearAccount(id: string | null): { checking: boolean; exists: boolean | null; down: boolean } {
  const [state, setState] = useState<{ id: string | null; checking: boolean; exists: boolean | null; down: boolean }>({ id: null, checking: false, exists: null, down: false });
  useEffect(() => {
    if (!id) return setState({ id: null, checking: false, exists: null, down: false });
    const ctrl = new AbortController();
    setState({ id, checking: true, exists: null, down: false });
    const t = setTimeout(() => {
      nearApi.account(id, ctrl.signal).then(
        (a) => !ctrl.signal.aborted && setState({ id, checking: false, exists: a.ok ? a.exists : false, down: false }),
        () => !ctrl.signal.aborted && setState({ id, checking: false, exists: null, down: true }),
      );
    }, 420);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [id]);
  return state.id === id ? state : { checking: Boolean(id), exists: null, down: false };
}

/** The page: any coin in, any coin out on its own network, then the deposit (or the wallet paying it) and the swap. */
export function Swap() {
  const id = useId();
  const [catalog, setCatalog] = useState<SwapCatalogView | null>(null);
  const [down, setDown] = useState(false);
  const [loadRound, setLoadRound] = useState(0);
  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);
  const [amountTyped, setAmountTyped] = useState('25');
  const [toText, setToText] = useState('');
  const [refundTyped, setRefundTyped] = useState('');
  const [refundOpen, setRefundOpen] = useState(false);
  const [payWith, setPayWith] = useState<string | null>(null);
  const [picking, setPicking] = useState<'from' | 'to' | null>(null);
  const [preview, setPreview] = useState<SwapQuoteView | null>(null);
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [priceRound, setPriceRound] = useState(0);
  const [slid, setSlid] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [getting, setGetting] = useState<PayStep | 'price' | null>(null);
  const [nudge, setNudge] = useState(false);
  const [pending, setPending] = useState<PendingSwap | null>(null);
  const [progress, setProgress] = useState<SwapProgress | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [toWallets, setToWallets] = useState<Wallet[]>([]);
  const [paying, setPaying] = useState<{ name: string; step: PayStep } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [payProblem, setPayProblem] = useState<string | null>(null);
  const [filling, setFilling] = useState(false);
  const [copied, copy] = useCopy();

  // What this browser remembers comes in after the first paint, so the server's page and the browser's agree.
  useEffect(() => {
    const last = loadLastSwap();
    if (last.from) setFromId(last.from);
    if (last.to) setToId(last.to);
    setPending(loadPendingSwap());
  }, []);

  // The coins on offer, asked again a few times before saying they did not come.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    setDown(false);
    const ask = (k: number) =>
      swapApi.catalog().then(
        (c) => alive && setCatalog(c),
        () => {
          if (!alive) return;
          if (k < 2) timer = setTimeout(() => void ask(k + 1), 1500 * (k + 1));
          else setDown(true);
        },
      );
    void ask(0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [loadRound]);

  const chains = useMemo(() => catalog?.chains ?? [], [catalog]);
  const toChains = useMemo(() => chains.filter((c) => c.to), [chains]);
  const from = useMemo(() => pick(chains, fromId, START_FROM), [chains, fromId]);
  const to = useMemo(() => {
    const p = pick(toChains, toId, START_TO);
    // Never the same coin on both sides: the one out moves aside.
    return p && from && p.coin.assetId === from.coin.assetId ? pick(toChains, null, START_TO[0] === from.chain.id ? ['near', 'NEAR'] : START_TO) : p;
  }, [toChains, toId, from]);
  const maxUsd = catalog?.maxUsd ?? 100;

  // The receiver this browser used last on the receiving network, once the network is known.
  const toChainId = to?.chain.id ?? null;
  useEffect(() => {
    if (!toChainId) return;
    setToText((t) => (t ? t : (loadLastSwap().receivers?.[toChainId] ?? '')));
  }, [toChainId]);

  // The amount, in units of the coin paid in, and what it is worth.
  const units = from ? amountUnits(amountTyped, from.coin) : null;
  const usd = from && units ? usdOf(units, from.coin.decimals, from.coin.price) : 0;
  const amountOk = units !== null && usd >= 1 && usd <= maxUsd * 1.01;
  // What the amount is worth when the coin changes: a stablecoin counts as its face value, so 25 USDT stays 25 USDC.
  const worth = from && units ? (STABLE.has(from.coin.symbol) ? Number(fromUnits(units, from.coin.decimals, 6)) : usd) : 0;

  // Who receives, read at once; a NEAR account is asked of NEAR a moment later.
  const readTo = useMemo(() => (to ? readSwapAddress(to.chain.id, toText) : null), [to, toText]);
  const nearTo = readTo?.ok && readTo.kind === 'near' ? readTo.id : null;
  const toAccount = useNearAccount(nearTo);
  const toNeedsAccount = Boolean(readTo?.ok && readTo.kind === 'near' && (!readTo.implicit || to?.coin.assetId !== NEAR_ASSET));
  const toMissing = toNeedsAccount && toAccount.exists === false;
  const toReady = Boolean(readTo?.ok && (!toNeedsAccount || (!toAccount.checking && toAccount.exists === true)));

  // How the coin is paid: from a wallet in this browser that pays on that network, or the deposit address.
  const fromChainId = from?.chain.id ?? null;
  const fromPayable = Boolean(from && payable(from.chain.id, from.coin));
  useEffect(() => {
    if (!fromChainId || !familyOf(fromChainId) || !fromPayable) return setWallets([]);
    const update = () => setWallets(walletsFor(fromChainId));
    const off = watchWallets(update);
    update();
    return off;
  }, [fromChainId, fromPayable]);
  useEffect(() => {
    if (!toChainId || !familyOf(toChainId)) return setToWallets([]);
    const update = () => setToWallets(walletsFor(toChainId));
    const off = watchWallets(update);
    update();
    return off;
  }, [toChainId]);
  const methods = useMemo(() => {
    if (!from) return [] as { id: string; name: string; icon: string | null }[];
    if (from.chain.id === 'near') return [{ id: NEAR_WALLET, name: 'NEAR wallet', icon: null }];
    return [...wallets.slice(0, 3).map((w) => ({ id: w.id, name: w.name, icon: w.icon })), { id: ADDRESS, name: 'Exchange', icon: null }];
  }, [from, wallets]);
  const method = methods.find((m) => m.id === payWith)?.id ?? methods[0]?.id ?? ADDRESS;
  const byAddress = method === ADDRESS;
  const methodName = methods.find((m) => m.id === method)?.name ?? '';

  // Where a refund goes when the coin comes from an exchange: the receiving NEAR account inside NEAR Intents (when the
  // person keeps it so), otherwise the refund address they give on the paying network.
  const intentsRefund = Boolean(to && to.chain.id === 'near' && !refundOpen);
  const readBack = useMemo(() => (from && byAddress && !intentsRefund ? readRefund(from.chain.id, refundTyped) : null), [from, byAddress, intentsRefund, refundTyped]);
  // A NEAR account a refund waits for must be there, an implicit one too: 64 hex digits typed for a network the page
  // reads no address of (a Sui or Aptos address without its 0x) would otherwise pass as an account nobody holds.
  const backNear = readBack?.ok && (readBack.refund.type === 'INTENTS' || from?.chain.id === 'near') ? readBack.refund.to : null;
  const backAccount = useNearAccount(backNear);
  const refundReady = !byAddress || intentsRefund || Boolean(readBack?.ok && (!backNear || backAccount.exists === true));
  const refund: Refund | null = intentsRefund ? (readTo?.ok ? { to: readTo.id, type: 'INTENTS' } : null) : readBack?.ok ? readBack.refund : null;

  // A live price while the person picks: the same for everyone, asked again once if the moment was busy.
  const priceKey = from && to && units && amountOk ? `${from.coin.assetId}|${to.coin.assetId}|${units}` : null;
  useEffect(() => {
    if (pending || !priceKey || !from || !to || !units) return;
    const ctrl = new AbortController();
    let again: ReturnType<typeof setTimeout> | undefined;
    setPreviewProblem(null);
    setPreviewBusy(false);
    const ask = (retry: boolean) =>
      swapApi.quote({ from: from.coin.assetId, to: to.coin.assetId, amount: units.toString(), dry: true }, ctrl.signal).then(
        (q) => {
          if (ctrl.signal.aborted) return;
          setPreview(q);
          setPreviewFor(priceKey);
          setPreviewBusy(false);
        },
        (e) => {
          if (ctrl.signal.aborted) return;
          if (e instanceof SwapError && (e.code === 'busy' || e.code === 'offline')) {
            if (retry) again = setTimeout(() => void ask(false), 3500);
            else setPreviewBusy(true);
            return;
          }
          setPreview(null);
          setPreviewFor(null);
          setPreviewProblem(swapProblemText(e, from.chain.name, maxUsd));
        },
      );
    const t = setTimeout(() => void ask(true), 300);
    return () => {
      ctrl.abort();
      clearTimeout(t);
      clearTimeout(again);
    };
    // The key holds the coins and the amount; the objects themselves change identity with every catalog read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, priceKey, maxUsd, priceRound]);

  // Follows the deposit address until 1Click says how it ended.
  const address = pending?.quote.depositAddress ?? null;
  const memo = pending?.quote.depositMemo ?? null;
  useEffect(() => {
    if (!address) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let attempt = 0;
    const tick = async () => {
      let next: SwapProgress | null = null;
      try {
        next = await swapApi.status(address, memo);
      } catch {
        /* a missed answer: ask again */
      }
      if (!alive) return;
      if (next) setProgress(next);
      if (next && nearFinal(next.stage)) return clearPendingSwap(address);
      timer = setTimeout(tick, pollDelay(next?.stage ?? 'waiting', attempt++));
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [address, memo]);

  // The wallets that can pay a pending swap's deposit, after a reload too.
  const pendingChain = pending && payable(pending.from.chain.id, pending.from.coin) ? pending.from.chain.id : null;
  const [pendingWallets, setPendingWallets] = useState<Wallet[]>([]);
  useEffect(() => {
    if (!pendingChain || !familyOf(pendingChain)) return setPendingWallets([]);
    const update = () => setPendingWallets(walletsFor(pendingChain));
    const off = watchWallets(update);
    update();
    return off;
  }, [pendingChain]);

  const stage = progress?.stage ?? (address ? 'waiting' : null);
  const open = stage === 'waiting' || stage === 'short';
  const now = useNow(open);
  const left = pending ? Date.parse(pending.quote.deadline) - now : 0;
  const expired = open && pending !== null && left <= 0;

  const ready = Boolean(catalog?.live && from && to && amountOk && toReady && refundReady && !previewProblem);

  /** Pays a pending swap from the wallet it was quoted for: the NEAR wallet, or one in this browser. */
  const payNow = async (p: PendingSwap, wallet: Wallet | null) => {
    if (!p.quote.depositAddress || paying) return;
    const name = p.payment.by === 'wallet' ? p.payment.wallet : (wallet?.name ?? 'wallet');
    setPayProblem(null);
    setPaying({ name, step: 'connect' });
    // After a short deposit only the rest, and nothing while 1Click has not said how much came.
    const rest = stage === 'short' ? shortRest(p, progress?.deposited ?? null) : null;
    if (stage === 'short' && rest === null) {
      setPaying(null);
      return;
    }
    const amount = rest ?? BigInt(p.quote.amountIn);
    const step = (st: PayStep) => setPaying({ name, step: st });
    try {
      let tx: string;
      let link: string | null;
      let nearSender: string | undefined;
      if (p.from.chain.id === 'near') {
        const signer = await nearSignIn();
        // The refund was quoted to this account: another one would pay a swap whose refund is not its own.
        if (p.payment.by === 'wallet' && signer.accountId !== p.payment.address) throw new PayFailed('wallet');
        tx = await payFromNear(signer, { coin: p.from.coin, depositAddress: p.quote.depositAddress, amount }, step);
        link = `https://nearblocks.io/txns/${tx}`;
        nearSender = signer.accountId;
      } else {
        const w = wallet ?? pendingWallets.find((x) => p.payment.by === 'wallet' && x.id === p.payment.walletId) ?? null;
        if (!w) throw new PayFailed('wallet');
        // The wallet pays from the account the refund was quoted to, or not at all.
        const payer = p.payment.by === 'wallet' ? p.payment.address : undefined;
        tx = await payFrom(w, { chainId: p.from.chain.id, coin: p.from.coin, depositAddress: p.quote.depositAddress, amount, ...(payer ? { payer } : {}) }, step);
        link = txLink(p.from.chain.id, tx);
      }
      tellSwapDeposit({ address: p.quote.depositAddress, txHash: tx, memo: p.quote.depositMemo, ...(nearSender ? { nearSender } : {}) });
      const next: PendingSwap = { ...p, paid: { by: name, tx, link } };
      savePendingSwap(next);
      setPending(next);
    } catch (e) {
      setPayProblem(payText(e, p, name));
    } finally {
      setPaying(null);
    }
  };

  const swap = async () => {
    if (!catalog || !from || !to || !units || getting) return;
    if (!toReady) {
      setNudge(true);
      return document.getElementById(`${id}-to`)?.focus();
    }
    if (!refundReady) {
      setNudge(true);
      return document.getElementById(`${id}-refund`)?.focus();
    }
    if (!ready || !readTo?.ok) return;
    setProblem(null);
    setPayProblem(null);
    let payment: Payment = { by: 'address' };
    let wallet: Wallet | null = null;
    try {
      // Who pays, first: a refund goes back to that wallet, so the quote names it.
      if (method === NEAR_WALLET) {
        setGetting('connect');
        const signer = await nearSignIn();
        const me = readSwapAddress('near', signer.accountId);
        if (!me.ok) throw new PayFailed('wallet');
        payment = { by: 'wallet', wallet: 'NEAR wallet', walletId: NEAR_WALLET, address: me.id };
      } else if (!byAddress) {
        wallet = wallets.find((w) => w.id === method) ?? null;
        if (!wallet) throw new PayFailed('wallet');
        setGetting('connect');
        const me = readSwapAddress(from.chain.id, await walletAddress(wallet));
        if (!me.ok) throw new PayFailed('wallet');
        payment = { by: 'wallet', wallet: wallet.name, walletId: wallet.id, address: me.id };
      }
      setGetting('price');
      const back: Refund | null = payment.by === 'wallet' ? { to: payment.address, type: 'ORIGIN_CHAIN' } : refund;
      if (!back) return;
      const quote = await swapApi.quote({
        from: from.coin.assetId,
        to: to.coin.assetId,
        amount: units.toString(),
        dry: false,
        recipient: readTo.id,
        ...(payment.by === 'wallet' ? { payer: payment.address } : intentsRefund ? {} : { refund: refundTyped }),
      });
      // Read back before anything is paid: these coins, this receiver, the refund where the page said, this amount.
      const seen = previewFor === priceKey ? (preview?.amountOut ?? null) : null;
      const c = checkSwapQuote(quote, { from: from.coin.assetId, to: to.coin.assetId, recipient: readTo.id, refund: back, amountIn: units.toString(), seen });
      if (!quote.depositAddress || !c.ok) {
        setPriceRound((k) => k + 1);
        if (!c.ok && c.moved) return setSlid(true);
        return setProblem(SWAP_PROBLEM.wrong);
      }
      const next: PendingSwap = {
        from: { chain: { id: from.chain.id, name: from.chain.name }, coin: from.coin },
        to: { chain: { id: to.chain.id, name: to.chain.name }, coin: to.coin },
        recipient: readTo.id,
        refund: back,
        payment,
        quote,
      };
      savePendingSwap(next);
      saveLastSwap({ from: from.coin.assetId, to: to.coin.assetId, usd: Math.round(usd * 100) / 100, receivers: { [to.chain.id]: readTo.id } });
      setProgress(null);
      setShowQr(false);
      setPending(next);
      setGetting(null);
      if (payment.by === 'wallet') await payNow(next, wallet);
      else requestAnimationFrame(() => document.getElementById(`${id}-send`)?.focus({ preventScroll: false }));
    } catch (e) {
      if (e instanceof PayFailed) setProblem(e.problem === 'cancelled' ? 'Cancelled in the wallet. Nothing was sent.' : `${methodName} did not connect. Try again, or pay from an exchange.`);
      else setProblem(swapProblemText(e, from.chain.name, maxUsd));
      if (e instanceof SwapError && (e.code === 'account' || e.code === 'refund')) setNudge(true);
    } finally {
      setGetting(null);
    }
  };

  /** Fills the receiver from the person's own wallet on the receiving network: no typing, and it is theirs. */
  const fillTo = async () => {
    if (!to || filling) return;
    setFilling(true);
    try {
      if (to.chain.id === 'near') setToText((await nearSignIn()).accountId);
      else if (toWallets[0]) setToText(await walletAddress(toWallets[0]));
    } catch {
      /* closed or declined: the field stays as it was */
    } finally {
      setFilling(false);
    }
  };

  const restart = () => {
    setLeaving(false);
    clearPendingSwap(pending?.quote.depositAddress ?? null);
    setPending(null);
    setProgress(null);
    setSlid(false);
    setPayProblem(null);
    setPriceRound((k) => k + 1);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!amountOk) return document.getElementById(`${id}-amount`)?.focus();
    void swap();
  };

  /** A coin picked for one side: the dollars stay, the other side moves aside when it is the same coin. */
  const choose = (side: 'from' | 'to', assetId: string) => {
    setSlid(false);
    setProblem(null);
    setNudge(false);
    const hit = chains.flatMap((c) => c.coins.map((coin) => ({ chain: c, coin }))).find((x) => x.coin.assetId === assetId);
    if (!hit || !from || !to) return;
    if (side === 'from') {
      if (assetId === to.coin.assetId && from.chain.to) setToId(from.coin.assetId);
      setFromId(assetId);
      if (worth > 0) setAmountTyped(amountText(Math.min(worth, maxUsd), hit.coin));
      if (hit.chain.id !== from.chain.id) {
        setRefundTyped('');
        setPayWith(null);
      }
      saveLastSwap({ from: assetId });
    } else {
      if (assetId === from.coin.assetId) setFromId(to.coin.assetId);
      setToId(assetId);
      if (hit.chain.id !== to.chain.id && addressKindOf(hit.chain.id) !== addressKindOf(to.chain.id)) setToText(loadLastSwap().receivers?.[hit.chain.id] ?? '');
      saveLastSwap({ to: assetId });
    }
  };

  /** Turns the swap around: what was received is paid, at the same dollars. */
  const canFlip = Boolean(from && to && from.chain.to);
  const flip = () => {
    if (!from || !to || !canFlip) return;
    setFromId(to.coin.assetId);
    setToId(from.coin.assetId);
    if (worth > 0) setAmountTyped(amountText(Math.min(worth, maxUsd), to.coin));
    if (addressKindOf(from.chain.id) !== addressKindOf(to.chain.id)) setToText(loadLastSwap().receivers?.[from.chain.id] ?? '');
    setRefundTyped('');
    setRefundOpen(false);
    setPayWith(null);
    setSlid(false);
    setProblem(null);
    saveLastSwap({ from: to.coin.assetId, to: from.coin.assetId });
  };

  const closePicker = useCallback(() => {
    const side = picking;
    setPicking(null);
    requestAnimationFrame(() => document.getElementById(`${id}-${side ?? 'from'}-coin`)?.focus());
  }, [id, picking]);

  // ---- The number ----

  const fresh = previewFor === priceKey ? preview : null;
  const shown = pending ? pending.quote : fresh;
  const outCoin = pending ? pending.to.coin : (to?.coin ?? null);
  const outChain = pending ? pending.to.chain : (to?.chain ?? null);
  const ended = pending && stage && nearFinal(stage) ? stage : null;
  const landedUnits = ended === 'done' ? (progress?.amountOut ?? pending?.quote.amountOut ?? null) : null;
  const heroUnits = landedUnits ?? shown?.amountOut ?? (units && amountOk ? (preview?.destinationAsset === to?.coin.assetId ? (preview?.amountOut ?? null) : null) : null);
  const heroUsd = heroUnits && outCoin ? usdOf(heroUnits, outCoin.decimals, outCoin.price) : null;
  const heroText = heroUnits && outCoin ? heroAmount(heroUnits, outCoin.decimals) : '0';
  const heroDim = !heroUnits || (ended !== null && ended !== 'done') || (!pending && !shown);

  const kicker = (() => {
    if (ended === 'done') return 'Landed';
    if (ended) return 'Did not go through';
    if (pending) return stage === 'moving' || stage === 'seen' ? 'Swapping' : stage === 'short' ? 'Waiting for the rest' : 'You get';
    return 'You get';
  })();

  const heroLine = (() => {
    if (pending) return <>{ended === 'done' ? 'in' : 'to'} <b>{shortAddress(pending.recipient)}</b> on {pending.to.chain.name}</>;
    if (!to) return '';
    if (!units || !amountOk) return `From $1 to ${dollarsText(maxUsd)} a swap.`;
    if (shown && heroUsd !== null) return `on ${to.chain.name} · ≈ ${dollarsText(Math.floor(heroUsd * 100) / 100)} · ${etaText(shown.timeEstimate)}`;
    return previewBusy ? 'Prices are busy. Swap prices it.' : 'Pricing it.';
  })();

  // ---- The card ----

  const details = (() => {
    if (!catalog || !from || !to) return null;
    if (pending) {
      const q = pending.quote;
      const split = feeSplit(q.fees, catalog.fee?.recipient ?? null);
      return [
        ['Send by', `${clockText(q.deadline)}. Later, it goes back as a refund.`],
        ['At least', `${fromUnits(q.minAmountIn, pending.from.coin.decimals)} ${pending.from.coin.symbol} must arrive.`],
        ['You get at least', `${coinText(q.minAmountOut, pending.to.coin.decimals)} ${pending.to.coin.symbol}, or it refunds.`],
        ['Fees', feeLine(feeBps(q), split)],
        ...(pending.from.chain.id === 'sol' && pending.from.coin.contract && pending.payment.by === 'wallet'
          ? ([['From a Solana wallet', "Also about 0.002 SOL, to open the deposit address's token account."]] as const)
          : []),
        ['Pay', <TokenFacts key="pay" coin={pending.from.coin} chain={pending.from.chain} withSymbol copyable={false} />],
        ['Receive', <TokenFacts key="receive" coin={pending.to.coin} chain={pending.to.chain} withSymbol copyable={false} />],
        ['Refund', `To ${refundText(pending.refund, pending.from.chain, pending.payment.by === 'wallet' ? pending.payment.address : null)}.`],
        ['Receiver', `${pending.recipient} on ${pending.to.chain.name}`],
        ['Support code', q.correlationId.slice(0, 8)],
      ] as const;
    }
    const v = shown;
    const split = v ? feeSplit(v.fees, catalog.fee?.recipient ?? null) : null;
    const backLine = !byAddress
      ? `Back to the wallet that pays, on ${from.chain.name}.`
      : intentsRefund
        ? `To ${readTo?.ok ? readTo.id : 'the receiving account'} inside NEAR Intents. Whoever holds it takes it out at near-intents.org.`
        : `To the refund address you give on ${from.chain.name}${readBack?.ok && readBack.refund.type === 'INTENTS' ? ', inside NEAR Intents' : ''}.`;
    return [
      ...(v ? ([['Rate', rateText(v, from.coin, to.coin)]] as const) : []),
      ...(v ? ([['At least', `${coinText(v.minAmountOut, to.coin.decimals)} ${to.coin.symbol} arrives, or the swap refunds.`]] as const) : []),
      ...(v && split ? ([['Fees', feeLine(feeBps(v), split)]] as const) : []),
      ...(v?.withdrawFee && v.withdrawFee !== '0' ? ([['Network fee', `${coinText(v.withdrawFee, to.coin.decimals)} ${to.coin.symbol} to send it on ${to.chain.name}, inside the price.`]] as const) : []),
      ['If it fails', backLine],
      ...(from.chain.id === 'sol' && from.coin.contract && !byAddress
        ? ([['From a Solana wallet', "Also about 0.002 SOL, to open the deposit address's token account."]] as const)
        : []),
      ['Pay', <TokenFacts key="pay" coin={from.coin} chain={from.chain} withSymbol />],
      ['Receive', <TokenFacts key="receive" coin={to.coin} chain={to.chain} withSymbol />],
      ['Limit', `Up to ${dollarsText(maxUsd)} a swap while Swap is new.`],
    ] as const;
  })();

  // The facts open over the card from the «i», as every «i» on the site does: nothing on the page moves, the amount
  // and the button stay where they are. A sheet from the bottom on a phone; Escape or a tap outside closes it.
  const infoButton = details ? (
    <Info rows={[]} label="Details" anchor="line" align="start" fill>
      <dl className={n.details}>
        {details.map(([k, v]) => (
          <div key={k} className={n.fact}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
        <div className={n.fact}>
          <dt>Swapped by</dt>
          <dd>NEAR Intents (1Click). The team never holds your coins.</dd>
        </div>
      </dl>
    </Info>
  ) : null;

  let card: ReactNode;
  if (!catalog || !from || !to) {
    card = (
      <div className={n.card} aria-busy={!down}>
        <div className={n.loading}>
          {down ? (
            <>
              <p className={n.note} data-bad="">
                The coins did not load.
              </p>
              <button type="button" className={n.btn} onClick={() => setLoadRound((k) => k + 1)}>
                <span className={n.word}>Try again</span>
              </button>
            </>
          ) : (
            <p className={n.note}>
              <span className={n.pulse} aria-hidden />
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
    const short = stage === 'short';
    // After a short deposit only the rest is on the card, so nobody sends the whole amount twice; while 1Click has not
    // said how much came there is no number and no wallet button at all.
    const rest = short ? shortRest(p, progress?.deposited ?? null) : null;
    const restUnknown = short && rest === null;
    const sendText = fromUnits(rest ?? BigInt(p.quote.amountIn), p.from.coin.decimals);
    // Nothing lit while nothing is sent; "Sent" done once a wallet sent it or the network saw it.
    const step = stage === 'waiting' ? (p.paid ? 1 : -1) : stage === 'seen' || short ? 1 : 2;
    const waiting = stage === 'waiting';
    const fromNear = p.from.chain.id === 'near';
    const payWallet = p.payment.by === 'wallet' ? (fromNear ? null : (pendingWallets.find((w) => p.payment.by === 'wallet' && w.id === p.payment.walletId) ?? null)) : null;
    // A wallet pays once, or once more for the rest after a short deposit: never the whole amount a second time.
    const canPay = open && !expired && !restUnknown && (!p.paid || short) && p.payment.by === 'wallet' && (fromNear || payWallet !== null);
    const showAddress = open && !fromNear && (!p.paid || short);
    const amountBlock = restUnknown ? (
      <span className={n.sendAmount}>Checking the amount</span>
    ) : null;
    card = (
      <div className={n.card} data-phase="send">
        <div className={n.top}>
          <span className={`${n.word} ${n.label}`}>{restUnknown ? 'Part arrived' : short ? 'Send the rest' : p.paid ? 'Your swap' : waiting || expired ? 'Send' : 'Your deposit'}</span>
          {infoButton}
          <span className={n.grow} />
          {open && !expired && (!p.paid || short) ? (
            <span className={n.clock} aria-label={`Time left ${mmss(left)}`}>
              {mmss(left)}
            </span>
          ) : null}
          {waiting && !p.paid && !paying ? (
            <button type="button" className={n.back} onClick={() => (leaving ? restart() : setLeaving(true))} onBlur={() => setLeaving(false)}>
              {leaving ? 'Start over' : 'Change'}
            </button>
          ) : null}
        </div>
        {showAddress ? (
          <div className={n.deposit} id={`${id}-send`} tabIndex={-1}>
            <Qr text={address} label={`QR code of the deposit address on ${p.from.chain.name}`} shown={showQr} />
            <div className={n.depositText}>
              {amountBlock ?? (
                <button type="button" className={n.sendAmount} onClick={() => copy('amount', sendText)} aria-label={`Copy the amount, ${sendText} ${p.from.coin.symbol}`}>
                  <b>{sendText}</b> {p.from.coin.symbol}
                  <CopyGlyph />
                </button>
              )}
              <span className={n.sendOn}>{copied === 'amount' ? 'Amount copied' : sendOnlyText(p.from.coin, p.from.chain, rest !== null)}</span>
              <ContractLink coin={p.from.coin} chain={p.from.chain} />
              <span className={n.addr} aria-label="Deposit address">
                {address}
              </span>
              <button type="button" className={n.qrToggle} aria-expanded={showQr} onClick={() => setShowQr((v) => !v)}>
                {showQr ? 'Hide QR' : 'Show QR'}
              </button>
            </div>
          </div>
        ) : (
          <div className={s.sending} id={`${id}-send`} tabIndex={-1}>
            {amountBlock ?? (
              <span className={s.sendingAmount}>
                <b>{sendText}</b> {p.from.coin.symbol}
              </span>
            )}
            <span className={s.sendingArrow} aria-hidden>
              →
            </span>
            <span className={s.sendingAmount}>
              <b>{coinText(p.quote.amountOut, p.to.coin.decimals)}</b> {p.to.coin.symbol}
            </span>
          </div>
        )}
        {memo && showAddress ? (
          <button type="button" className={n.memo} onClick={() => copy('memo', memo)}>
            Memo {memo} · {copied === 'memo' ? 'copied' : 'required, or the coins are lost'}
          </button>
        ) : null}
        {p.paid ? (
          <p className={n.paid}>
            <Tick />
            <span className={n.grow}>Sent from {p.paid.by}.</span>
            {p.paid.link ? (
              <a href={p.paid.link} target="_blank" rel="noreferrer" aria-label={`View the transaction from ${p.paid.by}`}>
                View
              </a>
            ) : null}
          </p>
        ) : null}
        {canPay ? (
          <button type="button" className={`${n.btn} ${n.walletBtn}`} disabled={paying !== null} aria-busy={paying !== null} onClick={() => void payNow(p, payWallet)}>
            {payWallet?.icon ? <img src={payWallet.icon} alt="" width={22} height={22} className={n.walletIcon} /> : null}
            <span className={n.word}>{paying ? STEP[paying.step] : `Pay with ${p.payment.by === 'wallet' ? p.payment.wallet : 'wallet'}`}</span>
          </button>
        ) : null}
        {expired && waiting && !p.paid ? (
          <button type="button" className={n.btn} onClick={restart}>
            <span className={n.word}>New quote</span>
          </button>
        ) : showAddress && !expired ? (
          <button type="button" className={`${n.btn} ${canPay || restUnknown ? n.quiet : ''}`} onClick={() => copy('address', address)}>
            <span className={n.word}>{copied === 'address' ? 'Copied' : 'Copy address'}</span>
          </button>
        ) : null}
        <ol className={n.track} aria-label="Progress">
          {(['Sent', 'Arrived', 'Swapped', 'Landed'] as const).map((w, i) => (
            <li key={w} className={n.trackStep} data-done={i < step ? '' : undefined} data-now={i === step ? '' : undefined} aria-current={i === step ? 'step' : undefined}>
              {w}
            </li>
          ))}
        </ol>
        <p className={n.note} role="status" aria-live="polite" data-bad={expired || short || (payProblem && (!p.paid || short)) ? '' : undefined}>
          {payProblem && open && !expired && (!p.paid || short)
            ? payProblem
            : short
              ? swapShortText({ pending: p, deposited: progress?.deposited ?? null, now })
              : expired
                ? `Time is up for this price. Anything sent now goes back to ${refundText(p.refund, p.from.chain)}.`
                : stage === 'waiting'
                  ? leaving && !p.paid
                    ? `Anything already sent still lands, or goes back to ${refundText(p.refund, p.from.chain)}. Start over?`
                    : p.paid
                    ? `Waiting for ${p.from.chain.name} to confirm it.`
                    : paying
                      ? `Confirm in ${paying.name}. At least ${coinText(p.quote.minAmountOut, p.to.coin.decimals)} ${p.to.coin.symbol} arrives, or it goes back to that wallet.`
                      : fromNear
                        ? 'Pay from your own NEAR wallet to start the swap.'
                        : `Send from your own wallet, or straight from an exchange: pick the ${p.from.chain.name} network. If it takes a fee, add it on top.`
                  : stage === 'seen'
                    ? `Your ${p.from.coin.symbol} is here. ${p.from.chain.name} is confirming it.`
                    : `Swapping it to ${p.to.coin.symbol} on ${p.to.chain.name} now.`}
        </p>
      </div>
    );
  } else {
    const toLine = (() => {
      if (!readTo) return { text: '', bad: false, good: false };
      if (readTo.ok && toNeedsAccount && toAccount.checking) return { text: 'Checking NEAR.', bad: false, good: false };
      if (readTo.ok && toNeedsAccount && toAccount.down) return { text: 'NEAR did not answer. Try again in a moment.', bad: true, good: false };
      if (toMissing) return { text: readTo.ok && readTo.implicit ? 'Not on NEAR yet. A token needs an account that is there.' : addressText('missing', to.chain), bad: true, good: false };
      if (readTo.ok && readTo.implicit && toAccount.exists === false) return { text: 'New account. The NEAR opens it.', bad: false, good: true };
      if (readTo.ok) return { text: readyLine(to.chain), bad: false, good: true };
      if (readTo.why === 'empty') return { text: addressHint(to.chain, 'to'), bad: nudge, good: false };
      return { text: addressText(readTo.why, to.chain, readTo.other), bad: true, good: false };
    })();
    const backLine = (() => {
      if (!readBack) return null;
      if (readBack.ok && backNear && backAccount.checking) return { text: 'Checking NEAR.', bad: false, good: false };
      if (readBack.ok && backNear && backAccount.exists === false)
        return { text: /^[0-9a-f]{64}$/.test(backNear) ? 'Not on NEAR. Use a NEAR account that is there.' : addressText('missing', from.chain, null, 'refund'), bad: true, good: false };
      if (readBack.ok)
        return { text: readBack.refund.type === 'INTENTS' ? `A refund waits for ${readBack.refund.to} inside NEAR Intents.` : `A refund comes back here, on ${from.chain.name}.`, bad: false, good: true };
      if (readBack.why === 'empty') return { text: addressHint(from.chain, 'refund'), bad: nudge, good: false };
      return { text: addressText(readBack.why as AddressWhy, from.chain, readBack.other, 'refund'), bad: true, good: false };
    })();
    const line = (() => {
      if (problem) return { text: problem, bad: true };
      if (!units || !amountOk) return { text: units && usd > maxUsd ? `Up to ${dollarsText(maxUsd)} a swap while Swap is new.` : `From $1 to ${dollarsText(maxUsd)} a swap.`, bad: true };
      if (previewProblem) return { text: previewProblem, bad: true };
      if (!catalog.live) return { text: SWAP_PROBLEM.closed, bad: false };
      if (slid) return { text: 'The price moved. Here is the new one.', bad: false };
      if (method === NEAR_WALLET) return { text: 'Pays from your own NEAR wallet. If it fails, it goes back to it.', bad: false };
      if (!byAddress) return { text: `Pays from ${methodName}. If it fails, it goes back to that wallet.`, bad: false };
      return { text: 'You get an address to send to from your own wallet or an exchange.', bad: false };
    })();
    const goText = getting === 'connect' ? `Open ${methodName}` : getting === 'price' ? 'Pricing' : byAddress ? 'Get deposit address' : 'Swap';
    const toKind = addressKindOf(to.chain.id);
    const canFill = to.chain.id === 'near' || toWallets.length > 0;
    card = (
      <form className={n.card} onSubmit={submit} noValidate>
        <div className={n.top}>
          <span className={`${n.word} ${n.label}`} id={`${id}-pay-label`}>
            You pay
          </span>
          {infoButton}
          <span className={n.grow} />
          <span className={s.worth} aria-live="polite">
            {units ? `≈ ${usdText(units, from.coin)}` : ''}
          </span>
        </div>
        <div className={s.pair}>
          <div className={`${n.sendRow} ${s.side}`}>
            <input
              id={`${id}-amount`}
              className={s.amount}
              inputMode="decimal"
              autoComplete="off"
              aria-labelledby={`${id}-pay-label`}
              aria-invalid={!amountOk}
              data-bad={!amountOk ? '' : undefined}
              value={amountTyped}
              onChange={(e) => {
                setSlid(false);
                setProblem(null);
                setAmountTyped(e.target.value.replace(/,/g, '.').replace(/[^\d.]/g, '').slice(0, 18));
              }}
            />
            <CoinButton side="from" id={`${id}-from-coin`} pick={from} onOpen={() => setPicking('from')} />
          </div>
          <div className={s.seam}>
            <button type="button" className={s.flip} onClick={flip} disabled={!canFlip} aria-label="Turn the swap around" title={canFlip ? 'Turn the swap around' : `Swap pays out on ${toChains.length} networks; ${from.chain.name} is not one yet`}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden>
                <path d="M8 4v16M8 20l-4-4M8 20l4-4M16 20V4M16 4l-4 4M16 4l4 4" />
              </svg>
            </button>
          </div>
          <div className={`${n.sendRow} ${s.side} ${s.receive}`}>
            <span className={s.receiveText}>
              <span className={`${n.word} ${n.label}`}>You receive</span>
              <span className={s.receiveWorth}>{fresh && heroUsd !== null ? `≈ ${dollarsText(Math.floor(heroUsd * 100) / 100)}` : '…'}</span>
            </span>
            <CoinButton side="to" id={`${id}-to-coin`} pick={to} onOpen={() => setPicking('to')} />
          </div>
        </div>

        <div className={n.top}>
          <label className={`${n.word} ${n.label}`} htmlFor={`${id}-to`}>
            To · {to.chain.name}
          </label>
          <span className={n.grow} />
          {canFill ? (
            <button type="button" className={n.useWallet} onClick={() => void fillTo()} disabled={filling} aria-busy={filling}>
              {filling ? 'Opening' : to.chain.id === 'near' ? 'Use my own NEAR wallet' : 'Use my own wallet'}
            </button>
          ) : null}
        </div>
        <input
          id={`${id}-to`}
          className={n.input}
          value={toText}
          placeholder={PLACEHOLDER[toKind ?? 'evm']}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={toLine.bad}
          aria-describedby={`${id}-to-line`}
          data-bad={toLine.bad ? '' : undefined}
          onChange={(e) => {
            setProblem(null);
            setToText(e.target.value.slice(0, 100));
          }}
        />
        <p className={n.toLine} id={`${id}-to-line`} data-bad={toLine.bad ? '' : undefined} data-good={toLine.good ? '' : undefined} aria-live="polite">
          {toLine.good ? <Tick /> : null}
          {toLine.text}
        </p>

        <div className={n.top}>
          <span className={`${n.word} ${n.label}`} id={`${id}-method-label`}>
            Pay from
          </span>
        </div>
        <div className={s.methods} role="radiogroup" aria-labelledby={`${id}-method-label`}>
          {methods.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={m.id === method}
              className={s.method}
              onClick={() => {
                setPayWith(m.id);
                setProblem(null);
              }}
            >
              {m.icon ? <img src={m.icon} alt="" width={20} height={20} className={n.walletIcon} /> : null}
              {m.name}
            </button>
          ))}
        </div>

        {byAddress ? (
          intentsRefund ? (
            <div className={s.refundRow}>
              <span className={s.refundText}>
                Refund: <b>{readTo?.ok ? readTo.id : 'the receiving account'}</b>, inside NEAR Intents
              </span>
              <button type="button" className={n.mine} onClick={() => setRefundOpen(true)}>
                Change
              </button>
            </div>
          ) : (
            <>
              <div className={n.top}>
                <label className={`${n.word} ${n.label}`} htmlFor={`${id}-refund`}>
                  Refund to · {addressKindOf(from.chain.id) ? from.chain.name : 'NEAR'}
                </label>
                <span className={n.grow} />
                {to.chain.id === 'near' ? (
                  <button type="button" className={n.useWallet} onClick={() => setRefundOpen(false)}>
                    The account above
                  </button>
                ) : null}
              </div>
              <input
                id={`${id}-refund`}
                className={n.input}
                value={refundTyped}
                placeholder={addressKindOf(from.chain.id) ? PLACEHOLDER[addressKindOf(from.chain.id)!] : PLACEHOLDER.near}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={backLine?.bad}
                aria-describedby={`${id}-refund-line`}
                data-bad={backLine?.bad ? '' : undefined}
                onChange={(e) => {
                  setProblem(null);
                  setRefundTyped(e.target.value.slice(0, 100));
                }}
              />
              <p className={n.toLine} id={`${id}-refund-line`} data-bad={backLine?.bad ? '' : undefined} data-good={backLine?.good ? '' : undefined} aria-live="polite">
                {backLine?.good ? <Tick /> : null}
                {backLine?.text}
              </p>
            </>
          )
        ) : null}

        <p className={s.route} aria-live="polite">
          <span>{fresh ? rateText(fresh, from.coin, to.coin) : 'Rate …'}</span>
          <span>
            {fresh ? `Fee ${percentText(feeBps(fresh))}` : 'Fee …'}
            <i aria-hidden> · </i>
            {fresh ? etaText(fresh.timeEstimate) : '…'}
          </span>
        </p>

        <button
          type="submit"
          className={`${n.btn} ${n.go}`}
          disabled={getting !== null || !catalog.live || !amountOk || Boolean(previewProblem) || (readTo?.ok === false && readTo.why !== 'empty') || toMissing}
          aria-busy={getting !== null}
        >
          <span className={n.word}>{goText}</span>
        </button>
        <p className={n.note} role={line.bad ? 'alert' : 'status'} data-bad={line.bad ? '' : undefined}>
          {line.text}
        </p>
      </form>
    );
  }

  return (
    <div className={n.layout} data-moving={pending ? '' : undefined}>
      <section className={n.hero} aria-labelledby={`${id}-title`}>
        <Tabs here="swap" />
        <h1 className={`${n.word} ${n.title}`} id={`${id}-title`}>
          Swap
        </h1>
        <p className={n.lede}>{catalog ? `Any coin on ${chains.length} networks, into any coin on ${toChains.length}. Straight to your own wallet.` : 'Any coin, any network. Straight to your own wallet.'}</p>
        <div className={n.result} aria-live="polite" data-dim={heroDim ? '' : undefined} data-ended={ended ?? undefined}>
          <span className={`${n.word} ${n.kicker}`}>{kicker}</span>
          <span className={n.big}>
            <span className={n.bigNum} data-size={heroText.length > 9 ? 'l' : heroText.length > 7 ? 'm' : undefined}>
              {heroText}
            </span>
            <span className={n.bigUnit}>
              {outCoin && outChain ? <CoinMark coin={outCoin} chain={outChain} /> : null}
              <span>{outCoin?.symbol ?? ''}</span>
            </span>
          </span>
          <span className={n.heroLine}>{heroLine}</span>
        </div>
      </section>
      {card}
      {picking && catalog ? (
        <Picker
          chains={picking === 'to' ? toChains : chains}
          current={(picking === 'to' ? to?.coin.assetId : from?.coin.assetId) ?? null}
          title={picking === 'to' ? 'You receive' : 'You pay'}
          popular={picking === 'to' ? POPULAR_TO : POPULAR_FROM}
          onClose={closePicker}
          onPick={(assetId) => {
            choose(picking, assetId);
            closePicker();
          }}
        />
      ) : null}
    </div>
  );
}

const PLACEHOLDER: Record<'near' | 'evm' | 'sol' | 'tron' | 'btc', string> = {
  near: 'your-name.near',
  evm: '0x…',
  sol: 'Solana address',
  tron: 'T…',
  btc: 'bc1…',
};

/** The line under a receiver that reads right. */
function readyLine(chain: Pick<SwapChain, 'id' | 'name'>): string {
  const kind = addressKindOf(chain.id);
  if (kind === 'near') return 'On NEAR. Your own wallet, not an exchange.';
  if (kind === 'sol') return 'A Solana wallet.';
  return `An address on ${chain.name}.`;
}

function CoinButton({ side, id, pick: p, onOpen }: { side: 'from' | 'to'; id: string; pick: Picked; onOpen: () => void }) {
  return (
    <button type="button" id={id} className={`${n.coinBtn} ${s.coinPick}`} aria-haspopup="dialog" aria-label={`${side === 'from' ? 'Pay' : 'Receive'} ${p.coin.symbol} on ${p.chain.name}`} onClick={onOpen}>
      <CoinMark coin={p.coin} chain={p.chain} size={32} />
      <span className={n.coinBtnText}>
        <b>{p.coin.symbol}</b>
        <span>{p.chain.name}</span>
      </span>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M7 10l5 5 5-5" />
      </svg>
    </button>
  );
}

/** How the swap ended: one sentence, the way on, and the payout's transaction when there is one. */
function Ended({ stage, pending, progress, onAgain }: { stage: string; pending: PendingSwap; progress: SwapProgress | null; onAgain: () => void }) {
  const code = (progress?.correlationId ?? pending.quote.correlationId).slice(0, 8);
  const sym = pending.from.coin.symbol;
  const refunded = progress?.refunded ? `${fromUnits(progress.refunded, pending.from.coin.decimals)} ${sym}` : `Your ${sym}`;
  const landed = progress?.landed ?? null;
  const intents = pending.refund.type === 'INTENTS';
  const line = {
    done: (
      <>
        Done. <span className={n.nowrap}>{landedText(progress?.amountOut ?? pending.quote.amountOut, pending.to.coin)}</span> landed in{' '}
        <span className={n.nowrap}>{shortAddress(pending.recipient)}</span> on {pending.to.chain.name}.
      </>
    ),
    refunded: (
      <>
        The swap did not go through. <span className={n.nowrap}>{refunded}</span> went to {refundText(pending.refund, pending.from.chain, pending.payment.by === 'wallet' ? pending.payment.address : null)}.
        {intents ? ' That account’s wallet takes it out at near-intents.org.' : ''}
      </>
    ),
    failed: <>It did not go through. Keep this code for support: {code}.</>,
  }[stage as 'done' | 'refunded' | 'failed'];
  return (
    <div className={`${n.card} ${n.ended}`} role="status" data-stage={stage}>
      <p className={n.endLine}>{line}</p>
      {stage === 'done' ? (
        <>
          {landed ? (
            <a className={`${n.btn} ${n.go}`} href={landed.link} target="_blank" rel="noreferrer">
              <span className={n.word}>View on {pending.to.chain.name}</span>
            </a>
          ) : null}
          <button type="button" className={`${n.btn} ${landed ? n.quiet : n.go}`} onClick={onAgain}>
            <span className={n.word}>Swap again</span>
          </button>
        </>
      ) : (
        <>
          <button type="button" className={`${n.btn} ${n.go}`} onClick={onAgain}>
            <span className={n.word}>Try again</span>
          </button>
          {stage !== 'failed' && intents ? (
            <a className={`${n.btn} ${n.quiet}`} href="https://near-intents.org" target="_blank" rel="noreferrer">
              <span className={n.word}>Open NEAR Intents</span>
            </a>
          ) : null}
        </>
      )}
    </div>
  );
}

/** `0.2934 SOL`: what landed, as a person reads it. */
const landedText = (units: string, coin: NearCoin) => `${coinText(units, coin.decimals)} ${coin.symbol}`;

/** What the pay button says while the wallet works. */
const STEP: Record<PayStep, string> = { connect: 'Open your wallet', network: 'Switching network', check: 'Checking balance', confirm: 'Confirm in wallet' };

/** Why a wallet payment did not go: what to do about it. */
function payText(e: unknown, p: PendingSwap, name: string): string {
  const sym = p.from.coin.symbol;
  const net = p.from.chain.name;
  const other = p.from.chain.id === 'near' ? 'Try again.' : 'Try again, or copy the address.';
  if (!(e instanceof PayFailed)) return `The wallet did not send it. ${other}`;
  switch (e.problem) {
    case 'cancelled':
      return 'Cancelled in the wallet. Nothing was sent.';
    case 'funds':
      return `Not enough ${sym} on ${net} in this wallet${e.have !== null ? ` (${coinText(e.have, p.from.coin.decimals)})` : ''}. Top it up and try again.`;
    case 'rent':
      return `${name} needs about 0.0021 SOL to open the deposit address's token account. Top it up and try again.`;
    case 'gas':
      return 'Not enough NEAR in this wallet for the network fee. Add 0.02 NEAR and try again.';
    case 'account':
      return p.payment.by === 'wallet' ? `${name} is on another account. Switch it to ${shortAddress(p.payment.address)}: the refund goes there.` : `${name} is on another account.`;
    case 'unclear':
      return `${name} did not say whether it sent. Check it before paying again: a payment that went out shows up here by itself.`;
    case 'network':
      return `${name} did not switch to ${net}. Switch it there, or copy the address.`;
    case 'coin':
      return `${name} cannot pay ${sym} on ${net} from this page. Copy the address instead.`;
    default:
      return p.from.chain.id === 'near' && p.payment.by === 'wallet' ? `Sign in with ${p.payment.address} and try again.` : `The wallet did not send it. ${other}`;
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

function pick(chains: readonly SwapChain[], assetId: string | null, start: readonly [string, string]): Picked | null {
  for (const chain of chains) {
    const coin = assetId ? chain.coins.find((c) => c.assetId === assetId) : null;
    if (coin) return { chain, coin };
  }
  const first = chains.find((c) => c.id === start[0]);
  const coin = first?.coins.find((c) => c.symbol === start[1]) ?? first?.coins[0];
  if (first && coin) return { chain: first, coin };
  const any = chains[0];
  return any?.coins[0] ? { chain: any, coin: any.coins[0] } : null;
}
