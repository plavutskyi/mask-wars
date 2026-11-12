import { near } from '@maskwars/arena/format';
import {
  priceState,
  priceText,
  pricedByText,
  timesText,
  usdText,
  type MindSpend,
  type PriceCounts,
  type RaceThought,
  type SeasonThought,
} from '@maskwars/arena/minds';
import { modelName } from '@/lib/verified';
import { Info, type InfoRow } from './Info';
import s from './page.module.css';
import t from './thought.module.css';

/** `×65` beside what a mask took: earned over what its mind cost. Only a real × above zero is shown. */
export function Times({ x, label }: { x: number | null; label: string }) {
  if (x === null || !(x > 0)) return null;
  const text = timesText(x);
  return (
    <span className={t.times} aria-label={`${text} ${label}`}>
      {text}
    </span>
  );
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const tokensText = (m: Pick<MindSpend, 'tokens'>) =>
  `${m.tokens.prompt.toLocaleString('en-US')} in${m.tokens.cached ? ` (${m.tokens.cached.toLocaleString('en-US')} cached)` : ''} · ${m.tokens.completion.toLocaleString('en-US')} out`;
const nearPriceText = (usd: number) => `$${usd.toFixed(2)} a NEAR, NEAR Intents (1Click)`;
/** `$0.0085 · 1 answer · DeepSeek V4.1 Flash`, `≥$0.0085` when calls are left out, or, when no answer came back, that. */
const mindText = (m: MindSpend) =>
  `${m.answers ? `${priceText(m.usd, priceState(m))} · ${plural(m.answers, 'answer', 'answers')}` : 'no answer came back'} · ${modelName(m.model)}`;

/** The answers whose TEE signature was checked, when the record says: never claimed for a record that does not. */
const verifiedRows = (c: PriceCounts): InfoRow[] =>
  c.verified !== null && c.answers > 0
    ? [{ label: 'TEE signature checked', value: `${c.verified} of ${plural(c.answers, 'answer', 'answers')}, against the attestation made when the race began` }]
    : [];

/** One quiet pill: the price of the thinking, its details one tap away. */
function Pill({ label, value, rows, info }: { label: string; value: string; rows: InfoRow[]; info: string }) {
  return (
    <p className={t.pill}>
      <span className={`${s.word} ${t.label}`}>{label}</span>
      <span className={t.value}>{value}</span>
      <Info rows={rows} label={info} align="start" />
    </p>
  );
}

/**
 * A race's minds: what the winner's mind cost (or, in a race nobody won, every mind together), and in the details
 * the winner's mind and its ×, then each other mask's mind, NEAR's price and how it was priced.
 */
export function RaceMind({ thought, takes }: { thought: RaceThought; takes: string | null }) {
  const { record, winner } = thought;
  const won = winner?.spend.account;
  const others = record.masks.filter((m) => m.account !== won).sort((a, b) => b.usd - a.usd);
  const rows: InfoRow[] = [
    ...(winner
      ? [
          { label: `${winner.spend.name}'s mind`, value: mindText(winner.spend) },
          ...(takes && winner.earnedUsd !== null ? [{ label: `${winner.spend.name} took`, value: `${near(takes)} NEAR = ${usdText(winner.earnedUsd)}` }] : []),
          ...(winner.x !== null
            ? [{ label: 'Earned ÷ its mind', value: timesText(winner.x) }]
            : winner.earnedUsd !== null
              ? [{ label: 'Earned ÷ its mind', value: "Shown once NEAR AI's bill prices every call" }]
              : []),
          { label: `${winner.spend.name}'s tokens`, value: tokensText(winner.spend) },
        ]
      : []),
    ...others.map((m) => ({ label: `${m.name}'s mind`, value: mindText(m) })),
    ...(record.masks.length > 1 ? [{ label: 'All minds', value: `${priceText(thought.usd, thought.state)} · ${plural(thought.answers, 'answer', 'answers')}` }] : []),
    { label: 'Priced by', value: pricedByText(thought.counts) },
    ...verifiedRows(thought.counts),
    ...(record.near ? [{ label: 'NEAR at the race', value: nearPriceText(record.near.usd) }] : []),
    { label: 'Where it thinks', value: 'NEAR AI Cloud, in a TEE' },
    ...(record.run ? [{ label: 'Race log', value: 'GitHub Actions', href: record.run }] : []),
  ];
  return winner ? (
    <Pill label="Thought for" value={priceText(winner.spend.usd, winner.state)} rows={rows} info={`What ${winner.spend.name}'s mind cost`} />
  ) : (
    <Pill label="Thought for" value={priceText(thought.usd, thought.state)} rows={rows} info="What the masks' minds cost" />
  );
}

/**
 * A mask of the arena: the model it thinks with, and, over its races with a record, what its thinking cost with the
 * season's × in the details. Before its first answer is counted only the model shows.
 */
export function MaskMind({ name, season, model, races }: { name: string; season: SeasonThought | null; model: string | null; races: number }) {
  const counted = season && season.answers > 0 ? season : null;
  if (!model && !counted) return null;
  const rows: InfoRow[] = counted
    ? [
        { label: 'Its mind', value: `${priceText(counted.usd, counted.state)} · ${plural(counted.answers, 'answer', 'answers')}` },
        { label: 'Races counted', value: `${counted.races} of ${races}, from the first race with its price` },
        ...(counted.earnedUsd !== null ? [{ label: 'Took in them', value: `${near(counted.earned)} NEAR = ${usdText(counted.earnedUsd)}` }] : []),
        ...(counted.x !== null
          ? [{ label: 'Earned ÷ its mind', value: timesText(counted.x) }]
          : counted.earnedUsd !== null && counted.earnedUsd > 0
            ? [{ label: 'Earned ÷ its mind', value: "Shown once NEAR AI's bill prices every call" }]
            : []),
        { label: counted.models.length > 1 ? 'Models' : 'Model', value: counted.models.map(modelName).join(', ') },
        { label: 'Priced by', value: `${pricedByText(counted.counts)}; NEAR at each race's price (1Click)` },
        ...verifiedRows(counted.counts),
        { label: 'Where it thinks', value: 'NEAR AI Cloud, in a TEE' },
      ]
    : [];
  return (
    <div className={t.row}>
      {model ? (
        <p className={t.pill}>
          <span className={`${s.word} ${t.label}`}>Mind</span>
          <span className={t.value}>{modelName(model)}</span>
        </p>
      ) : null}
      {counted ? <Pill label="Thought for" value={priceText(counted.usd, counted.state)} rows={rows} info={`What ${name}'s mind cost`} /> : null}
    </div>
  );
}
