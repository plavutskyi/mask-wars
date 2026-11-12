'use client';

import Image from 'next/image';
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { chainOf, coinText, final, fromUnits, hex, parseDollars, pollDelay, type Progress, type QuoteView } from '@maskwars/pay';
import {
  accountOk,
  checkHire,
  cleanAccount,
  dollarsOf,
  jobText,
  networkOf,
  parseNear,
  PROOF_MS,
  proofOf,
  type Amount,
  type Job,
  type VaultProof,
} from '@maskwars/hire';
import { Mark } from '@/components/Mark';
import { api, type CatalogView, HireError, passing, setPage } from './api';
import { clearPending, hostOf, loadPending, pageName, type Pending, savePending, seenPage, type Slot, tell } from './host';
import { mmss, Qr, shortAccount, useCopy, useNow, vaultName } from '../ui';
import s from './checkout.module.css';

/** What the host page's attributes said, each already read: `null` where the attribute was missing or did not read. */
export interface Given {
  readonly text: string | null;
  readonly target: string | null;
  readonly team: string | null;
  readonly amount: Amount | null;
  readonly chain: string | null;
}

type Step = 'job' | 'target' | 'team' | 'chain' | 'coin' | 'amount' | 'send';
const LABEL: Record<Step, string> = { job: 'The job', target: 'The contract', team: 'Your vault', chain: 'From', coin: 'Coin', amount: 'Amount', send: 'Send' };

const PROBLEM: Record<string, string> = {
  small: 'Too small for this route. Try a bigger amount.',
  route: 'No route for this right now. Try another coin.',
  closed: 'Hiring opens soon.',
  busy: 'Too busy right now. Try again in a minute.',
  offline: 'Cannot reach the network right now. Try again in a minute.',
  bad: 'That did not work. Try again.',
  proof: 'Your proof ran out. Open your vault again.',
  vault: 'That vault is not the one this job pays into.',
  wrong: 'That quote did not read right. Nothing to send.',
};
const problemOf = (e: unknown) => (e instanceof HireError ? (PROBLEM[e.code] ?? PROBLEM.bad!) : PROBLEM.bad!);

/** The masks that race today: the swarm a team hires. */
const SWARM = [
  { name: 'onyx', src: '/art/onyx.webp' },
  { name: 'nova', src: '/art/nova.webp' },
  { name: 'oracle', src: '/art/oracle.webp' },
] as const;

/** Catalog retries: 1.5, 3, 6 and 12 seconds, then a button. */
const RETRY = [1500, 3000, 6000, 12000];

export function Checkout({ given, host: hostParam }: { given: Given; host: string | null }) {
  const id = useId();
  const [host, setHost] = useState<string | null>(null);
  // A frame or nothing: until the checkout sees it is inside a page, it draws nothing (`null`); opened on its own it
  // leaves for /hire. The proxy sends a browser that says it is not loading a frame there before this even runs.
  const [framed, setFramed] = useState<boolean | null>(null);
  // The page around it, as the browser says: who wrote the job on the card, and whose budget each call spends.
  const [page, setPageSeen] = useState<string | null>(null);

  // The job: what the host page named stays as it is; the rest the payer types here.
  const [text, setText] = useState(given.text ?? '');
  const [target, setTarget] = useState(given.target ?? '');
  const askText = jobText(text);
  const askTarget = cleanAccount(target);

  // The vault the money lands in, once the payer has proved it is theirs in the MASK WARS window. A page may name it;
  // only its holder can prove it. Change the job's words or contract and the proof no longer stands.
  const [vault, setVault] = useState<{ account: string; proof: VaultProof } | null>(null);
  useEffect(() => {
    if (vault && (vault.proof.ask.text !== askText || vault.proof.ask.target !== askTarget)) setVault(null);
  }, [vault, askText, askTarget]);
  const team = vault?.account ?? given.team ?? '';
  const job = useMemo<Job | null>(
    () => (askText && accountOk(askTarget) && vault ? { text: askText, target: askTarget, team: vault.account } : null),
    [askText, askTarget, vault],
  );
  // Where this job's deposit is kept in this browser: the job as the page named it.
  const slot = useMemo<Slot | null>(
    () => (askText && accountOk(askTarget) ? { text: askText, target: askTarget, team: given.team } : null),
    [askText, askTarget, given.team],
  );

  // Nothing reaches 1Click or NEAR until someone touches the checkout: a page that opens it unseen, or opens it a
  // thousand times, spends nothing. A host page cannot fake a touch inside this frame.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (touched || !framed) return;
    const on = (e: Event) => e.isTrusted && setTouched(true);
    window.addEventListener('pointerdown', on, true);
    window.addEventListener('keydown', on, true);
    return () => {
      window.removeEventListener('pointerdown', on, true);
      window.removeEventListener('keydown', on, true);
    };
  }, [touched, framed]);

  // The coins on offer, once touched, with a few quiet retries before a button. One shared list, cached a minute.
  const [catalog, setCatalog] = useState<CatalogView | null>(null);
  const [down, setDown] = useState(false);
  const [round, setRound] = useState(0);
  const fetchedAt = useRef(0);
  useEffect(() => {
    if (!touched) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    let attempt = 0;
    setDown(false);
    const ask = () =>
      api.catalog().then(
        (c) => {
          if (!live) return;
          fetchedAt.current = Date.now();
          setCatalog(c);
        },
        () => {
          if (!live) return;
          if (attempt < RETRY.length) timer = setTimeout(ask, RETRY[attempt++]);
          else setDown(true);
        },
      );
    void ask();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [round, touched]);

  const chains = catalog?.chains ?? [];
  const [chainId, setChainId] = useState<string>(given.chain ?? 'sol');
  const chain = chains.find((c) => c.id === chainId) ?? chains[0];
  const [symbol, setSymbol] = useState<string>('');
  const coin = chain?.coins.find((c) => c.symbol === symbol) ?? chain?.coins[0];

  // The amount: in the unit the host page named it in, dollars unless it said NEAR.
  const unit: 'usd' | 'near' = given.amount && 'near' in given.amount ? 'near' : 'usd';
  const start = given.amount ? ('near' in given.amount ? given.amount.near : given.amount.usd) : 250;
  const [amountText, setAmountText] = useState(String(start));
  const amount: Amount | null = useMemo(() => {
    if (unit === 'near') {
      const n = parseNear(amountText);
      return n ? { near: n } : null;
    }
    const d = parseDollars(amountText);
    return d ? { usd: d } : null;
  }, [unit, amountText]);
  // Up to the season's limit for one hire; more reads as no amount yet, with the limit said under it.
  const maxUsd = catalog?.max ?? 9_999;
  const inDollars = amount && catalog ? dollarsOf(amount, catalog.near.price) : null;
  const usd = inDollars !== null && inDollars <= maxUsd ? inDollars : null;
  const range = `From $1 to $${maxUsd.toLocaleString('en-US')}`;
  const presets = useMemo(() => {
    const base = start >= 1 ? start : unit === 'near' ? 100 : 250;
    const all = [base, base * 2, base * 4].map((n) => Math.round(n * 100) / 100);
    // In dollars the chips stop at the limit; a host that asked for more starts from the limit itself.
    if (unit === 'near') return all;
    const within = all.filter((n) => n <= maxUsd);
    return within.length > 0 ? within : [maxUsd];
  }, [start, unit, maxUsd]);

  // Where the flow starts: the first thing the host page left out, else straight to the money.
  // The vault is always proved, whoever named it: that step is never skipped.
  const steps = useMemo<Step[]>(() => {
    const out: Step[] = [];
    if (!given.text) out.push('job');
    if (!given.target) out.push('target');
    out.push('team', 'chain');
    // Before the coin list is in, the network's own list says whether there is a coin to pick: the count never jumps.
    if ((chain?.coins.length ?? chainOf(chainId)?.coins.length ?? 2) > 1) out.push('coin');
    out.push('amount', 'send');
    return out;
  }, [given.text, given.target, chain, chainId]);
  const first: Step = !given.text ? 'job' : !given.target ? 'target' : 'team';
  const [step, setStep] = useState<Step>(first);
  const shown: Step = step === 'coin' && !steps.includes('coin') ? 'amount' : step;
  const at = Math.max(0, steps.indexOf(shown));

  const [info, setInfo] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [priced, setPriced] = useState<{ key: string; quote: QuoteView } | null>(null);
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [priceRound, setPriceRound] = useState(0);
  const [slid, setSlid] = useState(false);
  const [getting, setGetting] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);

  // A deposit this browser already has for this very job (the host page was reloaded mid-payment) opens again on its
  // address. Only after the first render: the server cannot see this browser's storage, and both must draw the same.
  const resumed = useRef<Pending | null>(null);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  // A second tap on Change means something only while the address still waits.
  const stageNow = progress?.stage ?? null;
  useEffect(() => setConfirmDrop(false), [stageNow]);
  const [copied, copy] = useCopy();
  const moved = useRef(false);
  const addressRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (window.top === window.self) {
      setFramed(false);
      window.location.replace('/hire');
      return;
    }
    const p = seenPage();
    setPage(p);
    setPageSeen(p);
    const h = hostOf(hostParam);
    setHost(h);
    const found = loadPending(slot);
    if (found) {
      resumed.current = found;
      setPending(found);
      setStep('send');
    }
    setFramed(true);
    tell(h, { type: 'ready' });
    // A deposit found again after the host page reloaded: the page hears of it again, as it did the first time.
    if (found && Date.parse(found.quote.deadline) > Date.now()) announce(h, found);
    resumed.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostParam]);

  const close = useCallback(() => tell(host, { type: 'close' }), [host]);
  useEffect(() => {
    if (!framed) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [framed, close]);

  // A live price for what the amount buys, while it is picked: asked again only when the coin or the dollars change, never
  // because the coin list was read again. A busy moment is not a no: the button stays on.
  const coinId = coin?.assetId ?? null;
  const vaultId = job?.team ?? null;
  // A price is shown only for the coin and dollars it was asked for: never an old number under a new amount.
  const priceKey = coinId && usd ? `${coinId}|${usd}` : null;
  const preview = priced && priced.key === priceKey ? priced.quote : null;
  useEffect(() => {
    if (shown !== 'amount' || !coinId || !usd || !vaultId) return setPriced(null);
    const key = `${coinId}|${usd}`;
    const ctrl = new AbortController();
    let again: ReturnType<typeof setTimeout> | undefined;
    setPreviewProblem(null);
    setPreviewBusy(false);
    const ask = (retry: boolean) =>
      api.preview({ team: vaultId, from: coinId, usd }, ctrl.signal).then(
        (q) => {
          if (ctrl.signal.aborted) return;
          setPriced({ key, quote: q });
          setPreviewBusy(false);
        },
        (e) => {
          if (ctrl.signal.aborted) return;
          setPriced(null);
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
  }, [shown, coinId, usd, vaultId, priceRound]);

  // Follows the deposit address until 1Click says how it ended, and tells the host page each step.
  const address = pending?.quote.depositAddress ?? null;
  const memo = pending?.quote.depositMemo ?? null;
  useEffect(() => {
    if (!address || !pending) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    let attempt = 0;
    let last: string | null = null;
    const tick = async () => {
      let next: Progress | null = null;
      try {
        next = await api.status(address, memo);
      } catch {
        /* a missed answer: ask again */
      }
      if (!live) return;
      if (next) {
        setProgress(next);
        if (next.stage !== last) {
          last = next.stage;
          tell(host, { type: 'progress', job: pending.job.id, stage: next.stage });
        }
      }
      const stage = next?.stage ?? 'waiting';
      // Nothing came by the deadline and ten minutes past it: the address is done; the screen offers a new one.
      if (stage === 'waiting' && Date.now() > Date.parse(pending.quote.deadline) + 600_000) return;
      if (next && final(stage)) {
        clearPending(slotOf(pending.job, given.team));
        if (stage === 'done') {
          tell(host, {
            type: 'funded',
            job: pending.job,
            near: fromUnits(next.amountOut ?? pending.quote.amountOut, catalogNear(catalog)),
            txs: next.txs.map((t) => t.hash),
          });
        } else if (stage === 'failed') {
          tell(host, { type: 'failed', job: pending.job, code: next.correlationId.slice(0, 8) });
        } else {
          tell(host, { type: 'refunded', job: pending.job, stage: stage as 'short' | 'refunded' });
        }
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
  }, [address, memo, host]);

  // ---- The vault window ----

  const popup = useRef<{ w: Window | null; relay: string; at: number } | null>(null);
  const [proving, setProving] = useState(false);

  const stage = progress?.stage ?? (address ? 'waiting' : null);
  const waiting = stage === 'waiting' || stage === 'seen' || stage === 'moving';
  const now = useNow(shown === 'send' && stage === 'waiting');
  const left = pending ? Date.parse(pending.quote.deadline) - now : 0;
  const expired = stage === 'waiting' && pending !== null && left <= 0;

  useEffect(() => {
    if (moved.current) document.getElementById(`${id}-${shown}`)?.focus({ preventScroll: true });
  }, [id, shown]);

  const go = (to: Step) => {
    moved.current = true;
    setConfirmDrop(false);
    setInfo(false);
    setProblem(null);
    setSlid(false);
    setStep(to);
  };
  const next = () => go(steps[at + 1]!);

  // The job as it stands this moment: a quote that comes back for a job the payer has since changed is dropped.
  const jobNow = useRef(job);
  jobNow.current = job;

  const getAddress = async () => {
    if (!coin || !usd || !amount || !chain || !catalog || !job || !vault || !slot || getting) return;
    // A proof opens addresses for half an hour: an older one is made again first.
    if (Date.now() - Date.parse(vault.proof.ask.at) > PROOF_MS - 60_000) return reprove();
    setGetting(true);
    setProblem(null);
    try {
      // Prices more than a minute old are read again first: the read-back below prices the quote with them.
      let cat = catalog;
      if (Date.now() - fetchedAt.current > 60_000) {
        try {
          cat = await api.catalog();
          fetchedAt.current = Date.now();
          setCatalog(cat);
        } catch {
          /* the prices we have */
        }
      }
      const from = cat.chains.flatMap((c) => c.coins).find((c) => c.assetId === coin.assetId) ?? coin;
      const dollars = dollarsOf(amount, cat.near.price);
      if (!dollars || dollars > (cat.max ?? 9_999)) return setProblem(`${range} a payment.`);
      const r = await api.hire({ job, from: from.assetId, usd: dollars, proof: vault.proof });
      // Read back before the address shows: this coin in, NEAR into this team's vault, refunds there, the dollars agreed.
      const seen = dollars === usd ? (preview?.amountOut ?? null) : null;
      const c = checkHire(r.quote, { job, from, near: cat.near, usd: dollars, seen });
      const now = jobNow.current;
      const same =
        r.job.text === job.text &&
        r.job.target === job.target &&
        r.job.team === job.team &&
        now !== null &&
        now.text === job.text &&
        now.target === job.target &&
        now.team === job.team;
      if (!c.ok || !same) {
        setPriced(null);
        setPriceRound((n) => n + 1);
        if (!c.ok && c.moved) return setSlid(true);
        return setProblem(PROBLEM.wrong!);
      }
      const p: Pending = { job: r.job, coin: from, chain: chain.name, usd: dollars, quote: r.quote };
      savePending(slot, p);
      setProgress(null);
      setPending(p);
      announce(host, p);
      go('send');
    } catch (e) {
      if (e instanceof HireError && (e.code === 'proof' || e.code === 'vault')) return reprove(problemOf(e));
      setProblem(problemOf(e));
    } finally {
      setGetting(false);
    }
  };

  /** Back to the vault step with the proof dropped: it ran out, or the server would not take it. */
  const reprove = (why = PROBLEM.proof!) => {
    setVault(null);
    go('team');
    setProblem(why);
  };

  /** A proof from the vault window: taken only for the vault the page named, if it named one. */
  const accept = (proof: VaultProof, account: string) => {
    popup.current = null;
    setProving(false);
    if (given.team && account !== given.team) return setProblem(`That is ${shortAccount(account)}’s vault. This job pays into ${shortAccount(given.team)}’s.`);
    if (proof.ask.text !== askText || proof.ask.target !== askTarget) return setProblem(PROBLEM.proof!);
    setVault({ account, proof });
    go(given.chain && chains.some((c) => c.id === given.chain) && steps.includes('coin') ? 'coin' : 'chain');
  };
  const acceptNow = useRef(accept);
  acceptNow.current = accept;

  /**
   * Opens the MASK WARS window where the payer proves the vault: a page of maskwars.xyz on its own, with its address
   * bar, never inside someone else's page. It hears only from this frame's job, through a relay id made here.
   */
  const prove = () => {
    if (!askText || !accountOk(askTarget)) return;
    const open = popup.current?.w;
    if (open && !open.closed) return open.focus();
    const relay = hex(crypto.getRandomValues(new Uint8Array(32)));
    const q = new URLSearchParams({ r: relay, t: askText, g: askTarget });
    if (given.team) q.set('m', given.team);
    if (page) q.set('p', page);
    const w = window.open(`/hire/prove#${q}`, 'maskwars-vault', 'popup=yes,width=480,height=760');
    if (!w) return setProblem('The MASK WARS window was blocked. Allow pop-ups for this page, then try again.');
    popup.current = { w, relay, at: Date.now() };
    setProblem(null);
    setProving(true);
  };

  // While the window is out: its answer by message, or, where the page cut the window off from this frame, from the
  // server under the relay id (the window leaves it there too). The server is asked only once this frame cannot see the
  // window any more, and when the payer comes back to it; after ten minutes the window's proof would be too old anyway.
  useEffect(() => {
    const p = popup.current;
    if (!proving || !p) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    let asking = false;
    const take = (proof: VaultProof, account: string, fromMessage: boolean) => {
      if (!live) return;
      live = false;
      // Taken by message: the copy the window left with the server is picked up too, so nothing of it stays there.
      if (fromMessage) void api.relay(p.relay).catch(() => {});
      acceptNow.current(proof, account);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== p.w) return;
      const got = proofOf(e.data, p.relay);
      if (got) take(got.proof, got.vault, true);
    };
    const ask = async () => {
      if (!live || asking) return;
      asking = true;
      try {
        const r = await api.relay(p.relay);
        if (r.proof && r.vault) take(r.proof, r.vault, false);
      } catch {
        /* asked again on the next look */
      } finally {
        asking = false;
      }
    };
    const look = () => {
      if (!live) return;
      if (Date.now() - p.at > 10 * 60_000) {
        popup.current = null;
        setProving(false);
        return setProblem('That took too long. Open your vault again.');
      }
      if (!p.w || p.w.closed) void ask();
      timer = setTimeout(look, 2000);
    };
    const back = () => document.visibilityState === 'visible' && void ask();
    window.addEventListener('message', onMessage);
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    timer = setTimeout(look, 2000);
    return () => {
      live = false;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, [proving]);

  const restart = () => {
    // An address handed out and not ended is dropped: the host hears it, so it stops waiting on it.
    if (pending && !(stage && final(stage))) tell(host, { type: 'dropped', job: pending.job.id });
    if (pending) clearPending(slotOf(pending.job, given.team));
    setPending(null);
    setProgress(null);
    setConfirmDrop(false);
    go('amount');
  };

  // A new address while the old one waits is two taps: money may already be on its way to the first.
  const change = () => (confirmDrop ? restart() : setConfirmDrop(true));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    switch (shown) {
      case 'job':
        return jobText(text) ? next() : setProblem('Say what the masks should do, in 8 to 280 characters.');
      case 'target':
        return accountOk(cleanAccount(target)) ? next() : setProblem('That is not a NEAR account. Like your-contract.near.');
      case 'team':
        return vault ? next() : prove();
      case 'chain':
      case 'coin':
        return next();
      case 'amount':
        if (!usd) return document.getElementById(`${id}-amount`)?.focus();
        return void getAddress();
      case 'send':
        if (address) copy('address', address, addressRef.current);
    }
  };

  // ---- What the sheet shows ----

  const near = catalog?.near;
  // NEAR has 24 decimals; a deposit found again after a reload shows its numbers before the coin list is back.
  const nearOut = (units: string | null | undefined) => (units ? coinText(units, near?.decimals ?? 24) : null);
  const sending = pending?.coin ?? coin;
  // Once an address is out, the card shows the job that address pays for, whatever the fields say now.
  const shownJob = pending ? pending.job : { text: askText ?? text, target: askTarget, team };
  // Words the page wrote are shown as the page's, under its own name: never as ours.
  const byPage = Boolean(given.text) && !(pending && pending.job.text !== given.text);
  const ended = shown === 'send' && pending && stage && final(stage) ? stage : null;

  // Before a quote, the NEAR price from 1Click's list says roughly what the dollars buy; a quote says it exactly.
  const rough = usd && near ? usd / near.price : null;
  const roughNear = rough ? rough.toLocaleString('en-US', { maximumFractionDigits: rough < 10 ? 2 : 1 }) : null;
  const sum = (() => {
    if (pending) {
      const d = pending.usd;
      return { main: `$${d.toLocaleString('en-US', { maximumFractionDigits: 2 })}`, sub: `≈ ${nearOut(pending.quote.amountOut)} NEAR` };
    }
    if (unit === 'near')
      return {
        main: amount ? `${amountText.replace(/^0+(?=\d)/, '')} NEAR` : '— NEAR',
        sub: usd ? `≈ $${usd.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : null,
      };
    const sub = preview ? `≈ ${nearOut(preview.amountOut)} NEAR` : roughNear ? `≈ ${roughNear} NEAR` : null;
    return { main: amount ? `$${(amount as { usd: number }).usd.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '$—', sub };
  })();

  const teamName = team ? `${shortAccount(team)}’s` : 'your';
  const cut = catalog && catalog.fee > 0 ? ` MASK WARS keeps ${(catalog.fee / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}% of it.` : '';
  const details = (() => {
    switch (shown) {
      case 'job':
        return 'One line that names the job. Its hash is kept beside the deposit, so the payment can always be matched to exactly this job.';
      case 'target':
        return 'The contract the job is about: an account on NEAR mainnet or testnet.';
      case 'team':
        return 'Your vault is your own account in NEAR Intents, opened by its passkey or by the NEAR wallet that owns it. A MASK WARS window asks it to sign one line about this job: nothing moves and nothing is spent. Only then does the checkout give an address, so the money can only land in a vault you hold. It stays yours: maskwars.xyz/wallet moves it any time.';
      case 'send':
        if (pending) {
          return `Send by ${new Date(pending.quote.deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}; anything later goes back to ${shortAccount(pending.job.team)}’s vault. Up to 1% less still goes through. Job ${pending.job.id}, mark ${pending.job.hash.slice(0, 12)}.`;
        }
        return null;
      default:
        return `You send from your own wallet or exchange. 1Click by NEAR Intents swaps it to NEAR as it lands in ${teamName} vault, at most 1% off the price; if it cannot, the coin goes back to that vault.${cut} The NEAR is the vault’s: nobody else can move it. The 1Click key stays on our server.`;
    }
  })();

  const note = (() => {
    if (problem) return problem;
    switch (shown) {
      case 'job':
        return 'What should the masks do?';
      case 'target':
        return 'Mainnet or testnet.';
      case 'team':
        if (vault) return `${shortAccount(vault.account)}’s vault is yours. The money lands there.`;
        if (proving) return 'Waiting for your vault in the MASK WARS window.';
        return given.team ? `This job pays into ${shortAccount(given.team)}’s vault. Show it is yours.` : 'The money lands in your own vault. Show which one.';
      case 'chain':
        return 'Where your money is now.';
      case 'coin':
        return coin && chain ? `${coin.symbol} on ${chain.name}.` : '';
      case 'amount': {
        if (!amount) return unit === 'near' ? 'In NEAR, up to four decimals.' : `${range}.`;
        if (!usd) return `${range} a payment.`;
        if (previewProblem) return previewProblem;
        // Until the quote for this amount is back, the price from the coin list says roughly what it buys.
        const out = nearOut(preview?.amountOut) ?? (previewBusy ? null : roughNear);
        if (!catalog?.live) return out ? `≈ ${out} NEAR. Hiring opens soon.` : 'Hiring opens soon.';
        if (out) return `${slid ? 'The price moved: ' : ''}≈ ${out} NEAR lands in ${teamName} vault.`;
        return previewBusy ? 'Prices are busy right now. Get address prices it.' : 'Pricing it.';
      }
      case 'send':
        if (confirmDrop && stage === 'waiting') return 'Sent it already? Stay here: it still lands. Tap New address to drop this one.';
        if (expired) return 'Time is up for this price. Anything sent now goes back to the vault.';
        if (stage === 'seen' || stage === 'moving') return `Your ${sending?.symbol} is here. Swapping it to NEAR.`;
        return `Only ${sending?.symbol} on ${pending?.chain ?? chain?.name}. Waiting for it · ${mmss(left)}`;
    }
  })();
  const bad = Boolean(problem) || (shown === 'amount' && (!amount || !usd || Boolean(previewProblem))) || expired;

  if (!framed) return <main className={s.sheet} aria-busy />;

  return (
    <main className={s.sheet} data-ended={ended ?? undefined}>
      <div className={s.bar}>
        <Mark className={s.mark} />
        <span className={`${s.word} ${s.brand}`}>Hire the swarm</span>
        <span className={s.grow} />
        <button type="button" className={s.close} onClick={close} aria-label="Close">
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className={s.hero}>
        <div className={s.swarm} aria-hidden data-wait={waiting ? '' : undefined}>
          {SWARM.map((m, i) => (
            <div key={m.name} className={s.maskBox} data-i={i}>
              <Image src={m.src} alt="" fill sizes="(max-width: 560px) 34vw, 180px" quality={75} priority className={s.maskImg} />
            </div>
          ))}
        </div>
        <div className={s.card}>
          {shownJob.text ? (
            <p className={s.job}>{shownJob.text}</p>
          ) : (
            <p className={s.job} data-lede>
              Name the job. Fund your own vault for it from any wallet, on any chain.
            </p>
          )}
          {shownJob.text && byPage ? (
            <p className={s.meta} data-by="">
              <span className={s.metaLabel}>By</span>
              <span className={s.metaValue}>
                <span>{page ? pageName(page) : 'a page that does not say'}</span>
              </span>
            </p>
          ) : null}
          {accountOk(shownJob.target) ? (
            <p className={s.meta}>
              <span className={s.metaLabel}>Target</span>
              <span className={s.metaValue}>
                <span>{shownJob.target}</span>
                <span className={s.net}>{networkOf(shownJob.target)}</span>
              </span>
            </p>
          ) : null}
          {/* Who the money is for, in plain sight before anyone pays: a vault, never MASK WARS. */}
          <p className={s.meta} data-to="">
            <span className={s.metaLabel}>Paid to</span>
            <span className={s.metaValue}>
              <span>{shownJob.team ? `${vaultName(shownJob.team)}’s vault, not\u00a0MASK\u00a0WARS` : 'Your own vault, not\u00a0MASK\u00a0WARS'}</span>
            </span>
          </p>
          <div className={s.sum}>
            {shown === 'amount' && !pending ? (
              // On the amount step the number itself is the field: one big green figure, typed or picked below.
              <label className={s.money} data-edit="" data-bad={!amount || !usd ? '' : undefined}>
                {unit === 'usd' ? <span aria-hidden>$</span> : null}
                <input
                  id={`${id}-amount`}
                  className={s.num}
                  inputMode="decimal"
                  autoComplete="off"
                  aria-labelledby={`${id}-label`}
                  aria-invalid={!amount || !usd}
                  value={amountText}
                  size={Math.max(1, amountText.length)}
                  onChange={(e) => {
                    setSlid(false);
                    setAmountText(e.target.value.replace(/[^0-9.]/g, '').slice(0, unit === 'near' ? 12 : 7));
                  }}
                />
                {unit === 'near' ? <span className={s.unit}>NEAR</span> : null}
              </label>
            ) : (
              <span className={s.money}>{ended === 'done' ? `${nearOut(progress?.amountOut ?? pending?.quote.amountOut)} NEAR` : sum.main}</span>
            )}
            {ended === 'done' ? <span className={`${s.sub} ${s.word}`}>Funded</span> : sum.sub ? <span className={s.sub}>{sum.sub}</span> : null}
          </div>
        </div>
      </div>

      {ended && pending ? (
        <div className={s.band} role="status">
          <p className={s.endLine} data-good={ended === 'done' ? '' : undefined}>
            {
              {
                done: `In ${shortAccount(pending.job.team)}’s vault now, noted for this job. It stays yours to move.`,
                refunded: `The swap did not go through. Your ${pending.coin.symbol} is back in ${shortAccount(pending.job.team)}’s vault.`,
                short: `Less ${pending.coin.symbol} arrived than the swap needs. It goes back to ${shortAccount(pending.job.team)}’s vault.`,
                failed: `It did not go through. Keep this code for support: ${(progress?.correlationId ?? pending.quote.correlationId).slice(0, 8)}.`,
                waiting: '',
                seen: '',
                moving: '',
              }[ended]
            }
          </p>
          <button
            type="button"
            className={s.btn}
            onClick={() => {
              if (ended !== 'done') return restart();
              close();
            }}
          >
            <span className={s.word}>{ended === 'done' ? 'Done' : 'Try again'}</span>
          </button>
        </div>
      ) : !catalog && !pending && shown !== 'job' && shown !== 'target' && shown !== 'team' && touched ? (
        <div className={s.band}>
          <div className={s.top}>
            <span className={`${s.word} ${s.label}`}>{LABEL[shown]}</span>
          </div>
          {down ? (
            <button type="button" className={s.btn} onClick={() => setRound((n) => n + 1)}>
              <span className={s.word}>Try again</span>
            </button>
          ) : null}
          <p className={s.note} data-bad={down ? '' : undefined} role="status">
            {down ? 'The coins did not load. Nothing has moved.' : 'Loading the coins on offer.'}
          </p>
        </div>
      ) : (
        <form className={s.band} onSubmit={submit} noValidate data-step={shown}>
          <div className={s.top}>
            <span className={`${s.word} ${s.label}`} id={`${id}-label`}>
              {shown === 'send' && waiting && stage !== 'waiting' ? 'Swapping' : LABEL[shown]}
            </span>
            {details ? (
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
            ) : null}
            <span className={s.grow} />
            {shown === 'send' ? (
              stage === 'waiting' ? (
                <button type="button" className={s.back} onClick={change}>
                  {confirmDrop ? 'New address' : 'Change'}
                </button>
              ) : null
            ) : at > 0 ? (
              <button type="button" className={s.back} disabled={getting} onClick={() => go(steps[at - 1]!)}>
                Back
              </button>
            ) : null}
            <span className={s.count} aria-label={`Step ${at + 1} of ${steps.length}`}>
              {at + 1}/{steps.length}
            </span>
          </div>

          <div className={s.row} key={shown}>
            {shown === 'job' ? (
              <textarea
                id={`${id}-job`}
                className={`${s.input} ${s.area}`}
                aria-labelledby={`${id}-label`}
                placeholder="Attack my contract before launch"
                rows={2}
                maxLength={280}
                value={text}
                data-bad={problem ? '' : undefined}
                onChange={(e) => {
                  setProblem(null);
                  setText(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
              />
            ) : null}

            {shown === 'target' ? (
              <input
                id={`${id}-${shown}`}
                className={s.input}
                aria-labelledby={`${id}-label`}
                placeholder="your-contract.near"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="url"
                maxLength={64}
                value={target}
                data-bad={problem ? '' : undefined}
                onChange={(e) => {
                  setProblem(null);
                  setTarget(e.target.value.replace(/\s/g, ''));
                }}
              />
            ) : null}

            {shown === 'chain' ? (
              <div className={s.tiles} role="radiogroup" aria-labelledby={`${id}-label`}>
                {chains.map((c, i) => (
                  <button
                    key={c.id}
                    id={i === 0 ? `${id}-chain` : undefined}
                    type="button"
                    role="radio"
                    aria-checked={c.id === chain?.id}
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

            {shown === 'coin' && chain && coin ? (
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

            {shown === 'amount' ? (
              <div className={s.chips} data-n={presets.length} role="radiogroup" aria-label="Amount">
                {presets.map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={Number(amountText) === n}
                    className={s.chip}
                    onClick={() => {
                      setSlid(false);
                      setAmountText(String(n));
                    }}
                  >
                    {unit === 'usd' ? `$${n.toLocaleString('en-US')}` : `${n.toLocaleString('en-US')} NEAR`}
                  </button>
                ))}
              </div>
            ) : null}

            {shown === 'send' && pending && address ? (
              <div className={s.send} id={`${id}-send`} tabIndex={-1}>
                <Qr text={address} label={`QR code of the deposit address on ${pending.chain}`} className={s.qr} paper={s.qrPaper} ink={s.qrInk} />
                <div className={s.sendText}>
                  <button type="button" className={s.sendAmount} onClick={() => copy('amount', fromUnits(pending.quote.amountIn, pending.coin.decimals))}>
                    <b>{fromUnits(pending.quote.amountIn, pending.coin.decimals)}</b> {pending.coin.symbol}
                    <span className={s.sendOn}>{copied === 'amount' ? 'copied' : `on ${pending.chain}`}</span>
                  </button>
                  <span className={s.addr} ref={addressRef}>
                    {address}
                  </span>
                  {memo ? (
                    <button type="button" className={s.memo} onClick={() => copy('memo', memo)}>
                      Memo {memo} {copied === 'memo' ? '· copied' : '· required'}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {shown === 'send' ? (
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
                disabled={getting || (shown === 'amount' && (!catalog?.live || !usd || Boolean(previewProblem)))}
                aria-busy={getting || (shown === 'team' && proving)}
              >
                <span className={s.word}>
                  {getting
                    ? 'Opening'
                    : shown === 'amount'
                      ? 'Get address'
                      : shown === 'team' && !vault
                        ? proving
                          ? 'Open the window again'
                          : 'Open your vault'
                        : 'Next'}
                </span>
              </button>
            )}
          </div>

          {info && details ? (
            <p className={s.details} id={`${id}-details`}>
              {details}
            </p>
          ) : (
            <p className={s.note} data-bad={bad ? '' : undefined} role={bad ? 'alert' : 'status'} aria-live="polite">
              {shown === 'send' && waiting ? <span className={s.live} aria-hidden /> : null}
              {note}
            </p>
          )}
        </form>
      )}
    </main>
  );
}

const catalogNear = (c: CatalogView | null) => c?.near.decimals ?? 24;

/** Where a deposit for this job is kept: the job as the page named it, the vault only if the page named one. */
const slotOf = (job: { text: string; target: string }, team: string | null): Slot => ({ text: job.text, target: job.target, team });

/** Tells the host page a deposit address is out: what to send, where, by when, and the least NEAR it lands as. */
function announce(host: string | null, p: Pending): void {
  tell(host, {
    type: 'deposit',
    job: p.job,
    chain: p.coin.chain,
    coin: p.coin.symbol,
    amount: fromUnits(p.quote.amountIn, p.coin.decimals),
    address: p.quote.depositAddress!,
    memo: p.quote.depositMemo,
    deadline: p.quote.deadline,
    near: fromUnits(p.quote.minAmountOut, 24),
  });
}
