'use client';

import Image from 'next/image';
import Link from 'next/link';
import { type CSSProperties, type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  accountOf,
  canSeal,
  cleanName,
  config as readConfig,
  DEFAULT_FUEL,
  type FactoryConfig,
  forgeAction,
  FUEL_CHOICES,
  getMask,
  LOOKS,
  lineOk,
  type MaskView,
  MINDS,
  nameFree,
  nameOk,
  nearText,
  outcome,
  readPending,
  reserved,
  seal,
  shareText,
  STYLES,
  tank,
  waitingChange,
  waitText,
  YOCTO,
} from '@maskwars/forge';
import { FORGE_NET as NET, FUEL_MAX } from '@/lib/forge';
import { connect, connected, type Signer } from './wallet';
import s from './forge.module.css';

/** What a person may put into a mask here: the forge's choices up to this network's limit (packages/network). */
const FUELS = FUEL_CHOICES.filter((n) => n <= FUEL_MAX);
const FIRST_FUEL = FUELS.includes(DEFAULT_FUEL) ? DEFAULT_FUEL : FUELS[FUELS.length - 1]!;

/** The factory's own numbers until its config arrives: the same constants the contract is built with. */
const MASK_FUND = (YOCTO * 3n) / 10n;
const RACE_LIMIT = YOCTO / 20n;
const PENDING = 'maskwars:forge';

type Step = 'face' | 'mind' | 'style' | 'plan' | 'fuel' | 'name';
const LABEL: Record<Step, string> = { face: 'Face', mind: 'Mind', style: 'Style', plan: 'Plan', fuel: 'Fuel', name: 'Name' };

type Check = 'empty' | 'bad' | 'arena' | 'checking' | 'free' | 'taken' | 'offline';
type Phase = 'choose' | 'connect' | 'sign' | 'forging' | 'done';

const usd = (n: number) => `$${n.toFixed(2)}`;

/** The page no longer waits for a forge. */
function forget() {
  try {
    sessionStorage.removeItem(PENDING);
  } catch {
    /* nothing to clean */
  }
}
const LEDE = 'Forge your own mask. It races for bounties and pays for its own mind.';


/** A change of the factory that waits in the open: what it is and when anyone may apply it. */
function Waiting({ cfg }: { cfg: FactoryConfig | null }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const w = cfg && now !== null ? waitingChange(cfg, now) : null;
  if (!w || now === null) return null;
  return (
    <details className={s.change}>
      <summary className={s.changeLine}>
        <span className={s.changeDot} aria-hidden />
        <span className={s.changeLong}>
          {w.at > now ? `A factory change applies in ${waitText(w.at - now)}` : 'A factory change can apply now'}
        </span>
        <span className={s.changeShort}>{w.at > now ? `Change in ${waitText(w.at - now)}` : 'Change can apply'}</span>
      </summary>
      <p className={s.changeMore}>
        {w.what}. Every change waits in the open, then anyone applies it. If you disagree, take your NEAR and your prize out
        before then.
      </p>
    </details>
  );
}

export function Forge() {
  const id = useId();
  const [cfg, setCfg] = useState<FactoryConfig | null>(null);
  const [offline, setOffline] = useState(false);
  const [sealing, setSealing] = useState<boolean | null>(null);
  const [step, setStep] = useState(0);
  const [look, setLook] = useState(LOOKS[0]!.id);
  const [model, setModel] = useState(MINDS[0]!.id);
  const [style, setStyle] = useState(STYLES[0]!.id);
  const [plan, setPlan] = useState('');
  const [fuel, setFuel] = useState<number>(FIRST_FUEL);
  const [name, setName] = useState('');
  const [check, setCheck] = useState<Check>('empty');
  const [info, setInfo] = useState(false);
  const [tried, setTried] = useState(false);
  const [phase, setPhase] = useState<Phase>('choose');
  const [problem, setProblem] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const [done, setDone] = useState<MaskView | null>(null);
  /** Forged on this page just now, not found forged on the way back from a wallet: only then the reveal plays. */
  const [revealed, setRevealed] = useState(false);
  // Confidential copying: `?copy=<name>` forges a copy that plays an author's sealed strategy in a TEE. The copy
  // carries no strategy of its own, so the plan step drops away; the author and the share are read from the factory.
  const [copyOf, setCopyOf] = useState<string | null>(null);
  const [author, setAuthor] = useState<MaskView | null>(null);
  const moved = useRef(false);
  /** One forge at a time, whatever the clicks: React state lags a fast double tap. */
  const forging = useRef(false);

  // The factory's catalog, its numbers and the mind's key; a wallet that is already connected; a forge that a wallet
  // redirect interrupted.
  useEffect(() => {
    let live = true;
    readConfig(NET)
      .then((c) => live && setCfg(c))
      .catch(() => live && setOffline(true));
    canSeal().then((ok) => live && setSealing(ok));
    connected(NET.rpcs).then((w) => live && w && setAccount(w.accountId));
    // `?copy=<name>`: forge a copy of that mask, if it is open to copying.
    const wanted = (() => {
      try {
        return new URLSearchParams(window.location.search).get('copy');
      } catch {
        return null;
      }
    })();
    if (wanted) {
      void getMask(NET, wanted)
        .then((m) => {
          if (live && m && m.copyable && !m.copy_of) {
            setCopyOf(m.name);
            setAuthor(m);
          }
        })
        .catch(() => {});
    }
    const pending = readPending(
      (() => {
        try {
          return sessionStorage.getItem(PENDING);
        } catch {
          return null;
        }
      })(),
    );
    // Back from a wallet: the mask is shown as forged only if it is this signer's. Someone else's mask under the same
    // name, or no mask at all, means this forge did not go through.
    // A forge still landing is read again each second, so the mask shows up the moment its account exists.
    if (pending) {
      void (async () => {
        for (let i = 0; i < 30 && live; i++) {
          const m = await getMask(NET, pending.name).catch(() => null);
          if (!live) return;
          const o = outcome(m, pending.account);
          if (o === 'mine' && m) {
            setName(m.name);
            setLook(m.look);
            setDone(m);
            setPhase('done');
          }
          if (o === 'mine' || o === 'theirs' || (o === 'none' && i > 2)) {
            forget();
            return;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      })();
    }
    return () => {
      live = false;
    };
  }, []);

  const looks = useMemo(() => LOOKS.filter((l) => !cfg || cfg.catalog.looks.includes(l.id)), [cfg]);
  const minds = useMemo(() => MINDS.filter((m) => !cfg || cfg.catalog.models.includes(m.id)), [cfg]);
  const styles = useMemo(() => STYLES.filter((x) => !cfg || cfg.catalog.styles.includes(x.id)), [cfg]);
  // A plan needs the mind's key and a browser that can seal for it; without both the step is not there at all.
  const steps = useMemo<Step[]>(
    () => ['face', 'mind', 'style', ...(!copyOf && (cfg ? cfg.strategy_key : true) && sealing !== false ? (['plan'] as const) : []), 'fuel', 'name'],
    [cfg, sealing, copyOf],
  );
  const now = steps[Math.min(step, steps.length - 1)]!;
  const last = now === 'name';

  const fuelYocto = BigInt(fuel) * YOCTO;
  const limit = cfg ? BigInt(cfg.race_limit.default) : RACE_LIMIT;
  const fund = cfg ? BigInt(cfg.mask_fund) : MASK_FUND;
  const races = tank(fuelYocto, fund, limit).races;

  const theLook = LOOKS.find((l) => l.id === look)!;
  const theMind = MINDS.find((m) => m.id === model)!;
  const theStyle = STYLES.find((x) => x.id === style)!;
  const planOk = plan.trim() === '' || lineOk(plan.trim());

  // The name, checked as it is typed: the rule here, then the factory itself.
  useEffect(() => {
    if (!name) return setCheck('empty');
    if (!nameOk(name)) return setCheck('bad');
    if (reserved(name)) return setCheck('arena');
    setCheck('checking');
    let live = true;
    const t = setTimeout(() => {
      nameFree(NET, name)
        .then((free) => live && setCheck(free ? 'free' : 'taken'))
        .catch(() => live && setCheck('offline'));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [name]);

  // Focus follows the steps once the person has moved; the first screen waits for a tap.
  useEffect(() => {
    if (moved.current) document.getElementById(`${id}-${now}`)?.focus();
  }, [id, now]);

  const go = (to: number) => {
    moved.current = true;
    setInfo(false);
    setTried(false);
    setProblem(null);
    setStep(Math.max(0, Math.min(to, steps.length - 1)));
  };

  const forge = useCallback(async () => {
    if (!cfg) return setProblem('Cannot reach NEAR right now. Try again in a minute.');
    if (forging.current) return;
    forging.current = true;
    try {
      await forgeOnce(cfg);
    } finally {
      forging.current = false;
    }
  }, [cfg, plan, name, look, model, style, fuelYocto, copyOf, author]);

  async function forgeOnce(cfg: FactoryConfig) {
    setProblem(null);
    let signer: Signer;
    try {
      setPhase('connect');
      signer = await connect(NET.rpcs);
      setAccount(signer.accountId);
    } catch {
      setPhase('choose');
      return setProblem('No wallet connected. Nothing was sent.');
    }
    let strategy: string | null = null;
    // A copy plays its author's strategy, so it seals none of its own.
    if (!copyOf && plan.trim()) {
      if (!cfg.strategy_key) return setPhase('choose');
      strategy = await seal(cfg.strategy_key, accountOf(name, NET.factory), plan.trim());
    }
    setPhase('sign');
    try {
      sessionStorage.setItem(PENDING, JSON.stringify({ name, account: signer.accountId }));
    } catch {
      /* private mode: the page simply cannot resume after a redirect */
    }
    let signed = true;
    try {
      // A copy carries the share the person read on this page: the factory forges it only at that share.
      const copyBps = copyOf && author ? author.author_bps : null;
      setTx(await signer.call(NET.factory, forgeAction({ look, model, style, strategy, name, fuel: fuelYocto, copyOf, copyBps })));
    } catch {
      // A wallet can fail after it has sent: the chain says whether the forge went through.
      signed = false;
    }
    setPhase('forging');
    // The factory answers when the mask's account exists, or gives the deposit back. Read what it says, and count the
    // mask as forged only if it is this signer's.
    let last = outcome(null, signer.accountId);
    for (let i = 0; i < 30; i++) {
      const m = await getMask(NET, name).catch(() => null);
      last = outcome(m, signer.accountId);
      if (last === 'mine' && m) {
        forget();
        setDone(m);
        setRevealed(true);
        setPhase('done');
        return;
      }
      // No mask yet is final only after a few reads: a wallet that failed after sending lands a second or two later.
      if (last === 'theirs' || (last === 'none' && i > (signed ? 2 : 4))) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    setPhase('choose');
    if (last === 'forging') return setProblem('Still forging on NEAR. Your mask shows up here in a minute.');
    forget();
    if (last === 'theirs') {
      setCheck('taken');
      return setProblem(`${name.toUpperCase()} was just taken. Your NEAR came back.`);
    }
    // A copy the factory refused: the author may have changed the share, or closed the mask to copying, since this page
    // read it. Say which, with the terms as they are now.
    if (copyOf && author) {
      const now = await getMask(NET, copyOf).catch(() => null);
      const NAME = copyOf.toUpperCase();
      if (now && !now.copyable) {
        setCopyOf(null);
        setAuthor(null);
        return setProblem(`${NAME} just closed to new copies. Nothing was forged; your NEAR came back.`);
      }
      if (now && now.author_bps !== author.author_bps) {
        setAuthor(now);
        return setProblem(
          `${NAME}’s owner changed the share to ${shareText(now.author_bps)}. Nothing was forged; your NEAR came back. Forge again if ${shareText(now.author_bps)} suits you.`,
        );
      }
    }
    setProblem(signed ? 'The forge did not go through. Your NEAR came back.' : 'Not forged. Your NEAR stays with you.');
  }

  const ok: Record<Step, boolean> = {
    face: true,
    mind: true,
    style: true,
    plan: planOk,
    fuel: fuelYocto >= (cfg ? BigInt(cfg.min_fuel) : YOCTO) && races > 0,
    name: check === 'free',
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (phase !== 'choose') return;
    if (!ok[now]) {
      setTried(true);
      document.getElementById(`${id}-${now}`)?.focus();
      return;
    }
    if (!last) return go(step + 1);
    void forge();
  };

  const busy = phase === 'connect' || phase === 'sign' || phase === 'forging';
  const shown = name && nameOk(name) ? name.toUpperCase() : null;
  const share = done
    ? `https://x.com/intent/post?text=${encodeURIComponent(`I forged ${done.name.toUpperCase()}. It races AI masks for bounties on NEAR.`)}&url=${encodeURIComponent(`https://maskwars.xyz/mask/${done.name}`)}`
    : '';

  const note = (() => {
    if (phase === 'connect') return 'Pick your wallet.';
    if (phase === 'sign') return 'Sign the forge in your wallet.';
    if (phase === 'forging') return 'Forging on NEAR.';
    if (problem) return problem;
    switch (now) {
      case 'face':
        return `${theLook.name}. ${theLook.eyes}.`;
      case 'mind':
        return 'Thinks inside a TEE on NEAR AI Cloud. Nobody reads its thoughts, not even NEAR.';
      case 'style':
        return theStyle.manner;
      case 'plan':
        return tried && !planOk ? 'One line, up to 160 characters.' : 'Sealed in your browser. Only its mind can read it.';
      case 'fuel':
        return `Pays for its mind only. At least ${races} races.`;
      case 'name':
        return {
          empty: '3 to 16 letters and digits.',
          bad: 'Starts with a letter. Letters and digits only.',
          arena: 'That name belongs to the arena.',
          checking: 'Checking the name.',
          free: `${name.toUpperCase()} is free.`,
          taken: 'Taken. Try another.',
          offline: 'Cannot reach NEAR right now. Try again in a minute.',
        }[check];
    }
  })();
  const bad = Boolean(problem) || (tried && !ok[now]) || (now === 'name' && ['taken', 'arena'].includes(check));

  const details = (() => {
    switch (now) {
      case 'mind':
        return `${theMind.maker}. ${usd(theMind.input)} in, ${usd(theMind.output)} out per million tokens. A Confidential TEE model: it runs on NEAR AI's own GPUs, sealed from everyone.`;
      case 'plan':
        return 'Sealed with X25519 and AES-256-GCM for a key born inside the mind’s TEE on OutLayer. Only the sealed box goes on chain, and it opens there and nowhere else.';
      case 'fuel':
        return `A race holds up to ${nearText(limit)} NEAR from the tank, and what the mind does not spend comes back. ${nearText(fund)} NEAR goes to the mask’s own account for gas. What is left in the tank is yours to take back. Prizes come from the teams and sponsors who open races.`;
      case 'name':
        return `Its own NEAR account, ${accountOf(name || 'name', NET.factory)}, with no key at all. It races with keys the arena gives it for one race, and what it wins lands there for you alone.`;
      default:
        return null;
    }
  })();

  return (
    <div className={s.body} data-phase={phase} data-reveal={revealed && phase === 'done' ? '' : undefined}>
      <Waiting cfg={cfg} />
      <section className={s.stage}>
        <h1 className={s.title}>
          <span className={`${s.word} ${s.titleA}`}>{phase === 'done' ? 'Forged' : 'Forge'}</span>{' '}
          <span
            className={`${s.word} ${s.titleB}`}
            data-name={shown && (last || phase === 'done') ? '' : undefined}
            style={{ '--chars': (phase === 'done' && done ? done.name : last && shown ? shown : 'your mask').length } as CSSProperties}
          >
            {phase === 'done' && done ? done.name.toUpperCase() : last && shown ? shown : 'your mask'}
          </span>
        </h1>
        {copyOf && author && phase !== 'done' ? (
          <p className={s.copyLede}>
            Copying {author.name.toUpperCase()}’s mind — your mask plays its sealed strategy in a TEE. {author.name.toUpperCase()}’s owner
            earns {shareText(author.author_bps)} of what you win.
          </p>
        ) : step === 0 && phase === 'choose' ? (
          <p className={s.stageLede}>{LEDE}</p>
        ) : null}
        <div className={s.mask} aria-hidden data-forging={busy ? '' : undefined}>
          {LOOKS.map((l, i) => (
            <div key={l.id} className={s.face} data-on={l.id === look ? '' : undefined}>
              <Image src={l.art} alt="" fill priority={i === 0} sizes="(max-width: 1000px) 70vw, 34vw" quality={85} className={s.clay} />
              <Image src={l.art} alt="" fill priority={i === 0} sizes="(max-width: 1000px) 70vw, 34vw" quality={85} className={s.metal} />
            </div>
          ))}
          <i className={s.seamBox}>
            <i className={s.seam} />
          </i>
        </div>
      </section>

      <section className={s.band}>
        {phase === 'done' && done ? (
          <div className={s.done} role="status">
            <p className={s.doneNext}>Ready to race</p>
            <p className={s.doneLine}>{done.name.toUpperCase()} races when a round with the people’s masks opens.</p>
            <div className={s.doneNums}>
              <span>
                <b>{nearText(done.brain)}</b> NEAR in the tank
              </span>
              <span>
                up to <b>{nearText(done.race_limit)}</b> NEAR a race
              </span>
            </div>
            <div className={s.doneActions}>
              <Link href={`/mask/${done.name}`} className={s.btn}>
                <span className={s.word}>See {done.name}</span>
              </Link>
              <a href={share} target="_blank" rel="noreferrer" className={`${s.btn} ${s.quiet}`}>
                <span className={s.word}>Share</span>
              </a>
            </div>
            {tx ? (
              <a className={s.tx} href={`${NET.explorer}/txns/${tx}`} target="_blank" rel="noreferrer">
                The forge on NEAR
              </a>
            ) : null}
          </div>
        ) : (
          <form className={s.form} onSubmit={submit} noValidate>
            {step === 0 ? <p className={s.lede}>{LEDE}</p> : null}

            <div className={s.top}>
              <span className={`${s.word} ${s.label}`} id={`${id}-label`}>
                {LABEL[now]}
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
              {step > 0 && !busy ? (
                <button type="button" className={s.back} onClick={() => go(step - 1)}>
                  Back
                </button>
              ) : null}
              <span className={s.count} aria-label={`Step ${step + 1} of ${steps.length}`}>
                {Math.min(step, steps.length - 1) + 1}/{steps.length}
              </span>
            </div>

            <div className={s.row} key={now}>
              {now === 'face' ? (
                <div className={s.tiles} data-n={looks.length} role="radiogroup" aria-labelledby={`${id}-label`}>
                  {looks.map((l, i) => (
                    <button
                      key={l.id}
                      id={i === 0 ? `${id}-face` : undefined}
                      type="button"
                      role="radio"
                      aria-checked={l.id === look}
                      className={`${s.tile} ${s.lookTile}`}
                      onClick={() => setLook(l.id)}
                    >
                      <span className={s.thumb}>
                        <Image src={l.art} alt="" fill sizes="120px" quality={75} />
                      </span>
                      <span className={s.word}>{l.name}</span>
                    </button>
                  ))}
                </div>
              ) : null}

              {now === 'mind' ? (
                <div className={s.tiles} data-n={minds.length} role="radiogroup" aria-labelledby={`${id}-label`}>
                  {minds.map((m, i) => (
                    <button
                      key={m.id}
                      id={i === 0 ? `${id}-mind` : undefined}
                      type="button"
                      role="radio"
                      aria-checked={m.id === model}
                      className={s.tile}
                      data-long={m.name.length > 14 ? '' : undefined}
                      onClick={() => setModel(m.id)}
                    >
                      <span className={s.word}>{m.name}</span>
                    </button>
                  ))}
                </div>
              ) : null}

              {now === 'style' ? (
                <div className={s.tiles} data-n={styles.length} role="radiogroup" aria-labelledby={`${id}-label`}>
                  {styles.map((x, i) => (
                    <button
                      key={x.id}
                      id={i === 0 ? `${id}-style` : undefined}
                      type="button"
                      role="radio"
                      aria-checked={x.id === style}
                      className={s.tile}
                      onClick={() => setStyle(x.id)}
                    >
                      <span className={s.word}>{x.name}</span>
                    </button>
                  ))}
                </div>
              ) : null}

              {now === 'plan' ? (
                <input
                  id={`${id}-plan`}
                  className={s.input}
                  data-bad={tried && !planOk ? '' : undefined}
                  aria-labelledby={`${id}-label`}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={200}
                  placeholder="Wait for the window. Then take it all."
                  value={plan}
                  onChange={(e) => setPlan(e.target.value.replace(/[\r\n]+/g, ' '))}
                  aria-invalid={tried && !planOk}
                />
              ) : null}

              {now === 'fuel' ? (
                <div className={s.fuel}>
                  <div className={s.amount}>
                    <span className={s.num}>{fuel}</span>
                    <span className={s.unit}>NEAR</span>
                    <span className={s.net}>{NET.id}</span>
                  </div>
                  <div className={s.chips} data-n={FUELS.length} role="radiogroup" aria-labelledby={`${id}-label`}>
                    {FUELS.map((n, i) => (
                      <button
                        key={n}
                        id={i === 0 ? `${id}-fuel` : undefined}
                        type="button"
                        role="radio"
                        aria-checked={fuel === n}
                        className={s.chip}
                        onClick={() => setFuel(n)}
                      >
                        {n} NEAR
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {now === 'name' ? (
                <input
                  id={`${id}-name`}
                  className={`${s.input} ${s.nameInput}`}
                  data-bad={bad ? '' : undefined}
                  aria-labelledby={`${id}-label`}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  inputMode="text"
                  placeholder="kira"
                  value={name}
                  disabled={busy}
                  onChange={(e) => {
                    setProblem(null);
                    setName(cleanName(e.target.value));
                  }}
                  aria-invalid={bad}
                />
              ) : null}

              <button type="submit" className={s.btn} disabled={busy || (last && offline)} aria-busy={busy}>
                <span className={s.word}>
                  {busy ? 'Forging' : last ? 'Forge' : now === 'plan' && !plan.trim() ? 'Skip' : 'Next'}
                </span>
              </button>
            </div>

            {info && details && !problem ? (
              <p className={s.details} id={`${id}-details`}>
                {details}
              </p>
            ) : (
              <p className={s.note} data-bad={bad ? '' : undefined} role={bad ? 'alert' : 'status'}>
                {last && offline && !problem ? 'Cannot reach NEAR right now. Try again in a minute.' : note}
              </p>
            )}
            {last && account && !busy ? <p className={s.who}>Signs as {account} on {NET.id}.</p> : null}
          </form>
        )}
      </section>
    </div>
  );
}
