'use client';

import Image from 'next/image';
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { coinText, dollars, parseDollars, spendTransactions, spentOf, unitsForUsd, usdOf } from '@maskwars/pay';
import { LOOKS } from '@maskwars/forge';
import { NETWORKS } from '@maskwars/network';
import { type MaskTank, type MasksView, type VaultView } from './api';
import { nearConnected, nearSignIn } from './near';
import type { Who } from './store';
import { Note, quietFocus, Top } from './ui';
import s from './wallet.module.css';

// The person's money into a forged mask's mind: the vault's NEAR goes into the mask's tank on the factory (`refuel`),
// the tank that pays NEAR AI for every race the mind thinks through. Money from any network, in through /wallet, ends up
// racing. A NEAR wallet's vault only: it signs four transactions (`spendTransactions`), at once where it can.

type Step = 'mask' | 'amount';
type Phase = 'sign' | 'check';
type End =
  | { readonly kind: 'done'; readonly mask: MaskTank; readonly units: bigint; readonly hash: string | null }
  /** Nothing left the vault. */
  | { readonly kind: 'none' }
  /** It left the vault and stopped on the person's own account: as wNEAR (step 3) or NEAR (step 4). */
  | { readonly kind: 'wallet'; readonly wrapped: boolean }
  /** The wallet gave no answer and the chain did not say yet. */
  | { readonly kind: 'unknown' };

/** The mask factory on mainnet, from this build's own settings: the one account the fourth transaction may call. */
const FACTORY = NETWORKS.mainnet.factory;
const AMOUNTS = [5, 10, 25] as const;
const GAS_TGAS = 30;
const NEAR_DECIMALS = 24;

/** A mask's face: the art of its look, as the forge shows it. */
export function faceOf(look: string): string {
  return LOOKS.find((l) => l.id === look)?.art ?? '/art/onyx.webp';
}

export const maskName = (name: string) => name.toUpperCase();

/** The mask as `refuel` returned it, when it reads as one: its tank after the NEAR landed. */
function tankOf(v: unknown, name: string): MaskTank | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Partial<MaskTank>;
  if (m.name !== name || typeof m.brain !== 'string' || !/^\d+$/.test(m.brain) || typeof m.fuel !== 'string') return null;
  return { name: m.name, account: String(m.account ?? ''), look: String(m.look ?? ''), brain: m.brain, fuel: m.fuel, state: String(m.state ?? 'ready') };
}

export function Fuel(p: {
  who: Who & { kind: 'near' };
  masks: MasksView;
  vault: VaultView | null;
  /** The mask the person tapped, if any. */
  first: string | null;
  /** Reads the vault and the masks again; what they hold now (`null` when they cannot be read). */
  onRefresh: () => Promise<{ vault: VaultView | null; masks: MasksView | null }>;
  onAdd: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const list = p.masks.masks;
  const [name, setName] = useState(p.first && list.some((m) => m.name === p.first) ? p.first : (list[0]?.name ?? ''));
  const mask = list.find((m) => m.name === name) ?? list[0];
  const steps = useMemo<Step[]>(() => (list.length > 1 ? ['mask', 'amount'] : ['amount']), [list.length]);
  const [step, setStep] = useState<Step>(p.first || list.length === 1 ? 'amount' : 'mask');
  const at = Math.max(0, steps.indexOf(step));
  const [info, setInfo] = useState(false);
  const [usdText, setUsdText] = useState('5');
  const [phase, setPhase] = useState<Phase | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [end, setEnd] = useState<End | null>(null);
  const moved = useRef(false);

  const price = p.vault?.nearPrice ?? 0;
  const held = BigInt(p.vault?.near ?? '0');
  const heldUsd = usdOf(held, NEAR_DECIMALS, price);
  const least = BigInt(p.masks.minRefuel);
  const leastUsd = Math.ceil(usdOf(least, NEAR_DECIMALS, price) * 100) / 100;
  const [all, setAll] = useState(false);
  const allUsd = Math.floor(heldUsd * 100) / 100;
  const typed = all ? allUsd : parseDollars(usdText);
  // «All» is every unit of NEAR in the vault; otherwise the NEAR the dollars typed buy at the vault's price. The least
  // shown in dollars is rounded up to the cent: typing it gives exactly the factory's least.
  const bought = typed && price > 0 ? unitsForUsd(typed, price, NEAR_DECIMALS) : 0n;
  const units = all ? held : typed && typed >= leastUsd && bought < least ? least : bought;
  const over = units > held;
  const under = units > 0n && units < least;
  const reading = p.vault === null;
  const empty = !reading && held < least;
  const amounts = AMOUNTS.filter((n) => n < heldUsd);

  useEffect(() => {
    if (moved.current) (document.getElementById(`${id}-${step}`) ?? document.getElementById(`${id}-go`))?.focus();
  }, [id, step]);

  const go = (to: Step) => {
    moved.current = true;
    setInfo(false);
    setProblem(null);
    setStep(to);
  };

  /**
   * Fuels the mask. The wallet signs the four transactions; whatever it reports, the vault and the mask are read again,
   * so the screen says what really happened even when a wallet stops or its answer is lost. The mask is judged by
   * `fuel`, everything ever put into it, which only a refuel raises: its tank (`brain`) also moves with its races.
   */
  const fuel = async () => {
    if (!mask || phase || units <= 0n || over || under) return;
    setProblem(null);
    setPhase('sign');
    let w;
    try {
      w = (await nearConnected()) ?? (await nearSignIn());
    } catch {
      setPhase(null);
      return setProblem('No NEAR wallet connected. Nothing moved.');
    }
    if (w.accountId !== p.who.account) {
      setPhase(null);
      return setProblem(`Your own NEAR wallet is signed in as ${w.accountId}. Switch it to ${p.who.account}.`);
    }
    // What the mask and the vault hold right before signing, read fresh: everything after is measured against it, so
    // without it nothing is signed.
    const fresh = await p.onRefresh();
    const was = fresh.masks?.masks.find((m) => m.name === mask.name);
    if (!fresh.vault || !was) {
      setPhase(null);
      return setProblem('Cannot read your MASK WARS wallet right now. Nothing moved; try again in a minute.');
    }
    const before = { fuel: BigInt(was.fuel), vault: BigInt(fresh.vault.near) };
    if (units > before.vault) {
      setPhase(null);
      return setProblem('More than your MASK WARS wallet holds now. Nothing moved.');
    }
    // The receiver is the factory this build knows, never one named by an answer from the server.
    const txs = spendTransactions(p.who.account, { receiver: FACTORY, method: 'refuel', args: { name: mask.name }, amount: units, tgas: GAS_TGAS });
    let spent: ReturnType<typeof spentOf>;
    let declined = false;
    try {
      spent = spentOf(await w.send(txs), units);
    } catch (error) {
      // A throw is a lost answer: a closed panel or a timeout may come after sending, and a wallet that asks for each
      // transaction may be declined after the first ones landed. A decline is only known to have moved nothing once
      // the vault, read past finality, still holds everything.
      declined = /reject|denied|cancel/i.test(error instanceof Error ? error.message : String(error));
      spent = { ok: false, step: 1, hash: null, lost: true };
    }
    if (declined) {
      setPhase('check');
      let reads = 0;
      let left = false;
      for (let i = 0; i < 4 && !left; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const now = await p.onRefresh();
        if (!now.vault) continue;
        reads += 1;
        left = BigInt(now.vault.near) < before.vault;
      }
      if (!left && reads >= 3) {
        setPhase(null);
        return setProblem('Not signed. Nothing moved.');
      }
    }
    // The wallet's own word that a step failed stands: where it stopped says where the NEAR is.
    if (!spent.ok && !spent.lost) {
      void p.onRefresh();
      return finish(spent.step <= 2 ? { kind: 'none' } : { kind: 'wallet', wrapped: spent.step === 3 });
    }
    // All four went through: the tank as the factory returned it, or as the chain shows it once a read catches up.
    // The wallet's answer was lost from some step on: only the vault going down and the mind's fuel going up, both seen,
    // say the mind took it; anything less is not known yet, and the screen says so.
    setPhase('check');
    const returned = spent.ok ? tankOf(spent.value, mask.name) : null;
    let left = false;
    for (let i = 0; i < (spent.ok ? 4 : 8); i++) {
      const now = await p.onRefresh();
      if (now.vault && BigInt(now.vault.near) < before.vault) left = true;
      const after = now.masks?.masks.find((m) => m.name === mask.name);
      const added = after ? BigInt(after.fuel) - before.fuel : 0n;
      // Confirmed by the wallet: any rise shows the tank. Answer lost: the vault went down and the mind's fuel went up
      // by exactly this amount, so a fan's refuel in the same seconds is not taken for this one.
      if (after && (spent.ok ? added >= units : left && added === units)) return finish({ kind: 'done', mask: after, units, hash: spent.ok ? spent.hash : null });
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (spent.ok) return finish({ kind: 'done', mask: returned ?? mask, units, hash: spent.hash });
    finish({ kind: 'unknown' });
  };

  const finish = (e: End) => {
    setPhase(null);
    setEnd(e);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (step === 'mask') return go('amount');
    if (reading) return;
    if (empty) return p.onAdd();
    if (units <= 0n || over || under) return document.getElementById(`${id}-amount`)?.focus();
    void fuel();
  };

  if (!mask) return null;
  const who = maskName(mask.name);

  if (end) {
    const line =
      end.kind === 'done' ? (
        <>
          {maskName(end.mask.name)}’s mind took {dollars(usdOf(end.units, NEAR_DECIMALS, price))}.{' '}
          <span className={s.nowrap}>
            It holds {dollars(usdOf(BigInt(end.mask.brain), NEAR_DECIMALS, price))} now.
          </span>
        </>
      ) : end.kind === 'none' ? (
        'It did not go through. Your NEAR is still in your MASK WARS wallet.'
      ) : end.kind === 'unknown' ? (
        `Cannot tell yet how it ended. Check your MASK WARS wallet and ${who}’s mind in a minute, before you fuel again.`
      ) : end.wrapped ? (
        'It stopped halfway. Your NEAR is in your own NEAR wallet as wNEAR, nothing lost.'
      ) : (
        `${who}’s mind did not take it. Your NEAR is in your own NEAR wallet.`
      );
    return (
      <div className={`${s.form} ${s.ended}`} role="status">
        <p className={s.endLine} data-good={end.kind === 'done' ? '' : undefined}>
          {line}
        </p>
        <div className={s.endActions}>
          {end.kind === 'done' && end.hash ? (
            <a className={`${s.btn} ${s.quiet}`} href={`https://nearblocks.io/txns/${end.hash}`} target="_blank" rel="noreferrer">
              <span className={s.word}>See it</span>
            </a>
          ) : null}
          <button type="button" className={s.btn} onClick={p.onClose} ref={quietFocus}>
            <span className={s.word}>{end.kind === 'done' ? 'Done' : 'Back to wallet'}</span>
          </button>
        </div>
      </div>
    );
  }

  const details = `${who}’s mind runs in a TEE on NEAR AI and pays for every race it thinks through from its tank on the mask factory. This puts NEAR from your MASK WARS wallet into that tank. Your own NEAR wallet signs four steps: the NEAR leaves NEAR Intents for your own account, unwraps, and goes to the factory for ${who}. Gas is under 0.02 NEAR from your own NEAR wallet. What the mind does not burn stays yours: the factory gives it back to you alone.`;

  const note = (() => {
    if (phase === 'sign') return 'Sign in your own NEAR wallet: four steps.';
    if (phase === 'check') return `Checking ${who}’s tank.`;
    if (problem) return problem;
    if (step === 'mask') return `${who} has ${dollars(usdOf(BigInt(mask.brain), NEAR_DECIMALS, price))} in its mind.`;
    if (reading) return 'Reading your MASK WARS wallet.';
    if (empty) return 'Your MASK WARS wallet has no NEAR yet. Add money first.';
    if (!typed) return `From ${dollars(leastUsd)} to ${dollars(allUsd)}.`;
    if (over) return 'More than your MASK WARS wallet holds.';
    if (under) return `At least ${dollars(leastUsd)}: the least a mind takes is 0.1 NEAR.`;
    return `${coinText(units, NEAR_DECIMALS)} NEAR into ${who}’s mind.`;
  })();
  const bad = Boolean(problem) || (step === 'amount' && !empty && (!typed || over || under));
  const busy = phase !== null;

  return (
    <form className={s.form} onSubmit={submit} noValidate data-step={step}>
      <Top
        id={id}
        label={step === 'mask' ? 'Mask' : 'Fuel'}
        details={details}
        info={info}
        onInfo={() => setInfo((v) => !v)}
        back={busy ? null : at === 0 ? p.onClose : () => go(steps[at - 1]!)}
        count={steps.length > 1 ? [at + 1, steps.length] : null}
      />

      <div className={s.row} key={step}>
        {step === 'mask' ? (
          <div className={s.chips} data-n={Math.min(3, list.length)} role="radiogroup" aria-labelledby={`${id}-label`}>
            {list.map((m, i) => (
              <button
                key={m.name}
                id={i === 0 ? `${id}-mask` : undefined}
                type="button"
                role="radio"
                aria-checked={m.name === mask.name}
                className={`${s.chip} ${s.maskChip}`}
                onClick={() => setName(m.name)}
              >
                <span className={s.maskFace} aria-hidden>
                  <Image src={faceOf(m.look)} alt="" fill sizes="40px" className={s.maskFaceImg} />
                </span>
                <span className={s.maskChipName}>{maskName(m.name)}</span>
                <span className={s.chipSub}>{dollars(usdOf(BigInt(m.brain), NEAR_DECIMALS, price))}</span>
              </button>
            ))}
          </div>
        ) : empty ? (
          <div className={s.going}>
            <span className={s.maskFace} aria-hidden>
              <Image src={faceOf(mask.look)} alt="" fill sizes="40px" className={s.maskFaceImg} />
            </span>
            <b>{who}</b>
            <span className={s.sendOn}>{dollars(usdOf(BigInt(mask.brain), NEAR_DECIMALS, price))} in its mind</span>
          </div>
        ) : (
          <div className={s.fuel}>
            <label className={s.amount} data-bad={over || under ? '' : undefined}>
              <span className={s.cur}>$</span>
              <input
                id={`${id}-amount`}
                className={s.num}
                inputMode="decimal"
                autoComplete="off"
                aria-labelledby={`${id}-label`}
                aria-invalid={over || under}
                value={all ? allUsd.toFixed(2) : usdText}
                size={Math.max(2, (all ? allUsd.toFixed(2) : usdText).length)}
                disabled={busy}
                onChange={(e) => {
                  setProblem(null);
                  setAll(false);
                  setUsdText(e.target.value.replace(/[^\d.]/g, '').slice(0, 7));
                }}
              />
            </label>
            <div className={s.chips} data-n={amounts.length + 1} role="radiogroup" aria-label="Amount">
              {amounts.map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={!all && typed === n}
                  className={s.chip}
                  disabled={busy}
                  onClick={() => {
                    setAll(false);
                    setUsdText(String(n));
                  }}
                >
                  ${n}
                </button>
              ))}
              <button
                type="button"
                role="radio"
                aria-checked={all}
                className={s.chip}
                disabled={busy}
                onClick={() => setAll(true)}
              >
                All
              </button>
            </div>
          </div>
        )}

        <button
          type="submit"
          id={`${id}-go`}
          className={s.btn}
          disabled={busy || (step === 'amount' && (reading || (!empty && (units <= 0n || over || under))))}
          aria-busy={busy}
        >
          <span className={s.word}>{step === 'mask' ? 'Next' : empty ? 'Add money' : busy ? (phase === 'sign' ? 'Signing' : 'Fueling') : `Fuel ${who}`}</span>
        </button>
      </div>

      <Note id={id} info={info} details={details} bad={bad}>
        {busy ? <span className={s.live} aria-hidden /> : null}
        {note}
      </Note>
    </form>
  );
}
