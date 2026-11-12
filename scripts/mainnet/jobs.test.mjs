// node --test scripts/mainnet/jobs.test.mjs: the mainnet plan of the jobs market stays in its budget and in step with
// the testnet deployment script and the contracts' code.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { budget, CODE, initArgs, KEPT, KEY_METHODS, keyBytes, maskTopUps, near, storageOf, yocto } from './jobs.mjs';

const net = JSON.parse(readFileSync(new URL('../../packages/network/mainnet.json', import.meta.url), 'utf8'));
// The quote of the jobs contract for 1 NEAR, 0.01 NEAR of fuel, three slots: read from jobs.tinygif8324.testnet.
const quote = { reward: '1000000000000000000000000', fuel: '30000000000000000000000', judge: '80000000000000000000000', reserve: '240000000000000000000000', record: '44000000000000000000000', total: '1394000000000000000000000' };
const bytes = { jobsBytes: 568619, crewsBytes: 275896 };

test('the market, the masks\' storage, a first job and its bonds fit in 15 NEAR', () => {
  const b = budget({ ...bytes, quote, bond: yocto('0.01') });
  assert.ok(b.total <= yocto('15'), `${near(b.total)} NEAR`);
  assert.equal(near(b.total), '10.156');
  // What came back on testnet with the same code: the job's deposit but the reward and 0.00979, the three bonds.
  assert.equal(near(b.back), '0.41421');
  assert.equal(near(yocto(net.fund.jobs) + yocto(net.fund.crews)), '8.65');
  // The crew's 0.05 is ORACLE's own: no row of maskwars.near attaches it.
  assert.ok(!b.rows.some((r) => r.yocto === yocto('0.05') && /crew/.test(r.what) && !/storage/.test(r.what)));
});

test('each mask gets the storage of its two keys first, and ORACLE the crew\'s record too', () => {
  // nova.maskwars.near: 100 bytes of account, 1 349 of code (home) and four keys give the 2 439 bytes it holds.
  const race = keyBytes('bounty.maskwars.near', ['commit', 'reveal', 'claim_drain', 'settle']);
  assert.equal(race, 172n);
  assert.equal(keyBytes(net.jobs, KEY_METHODS.jobs), 201n);
  assert.equal(keyBytes(net.crews, KEY_METHODS.crews), 153n);
  const m = maskTopUps();
  assert.equal(m.keys, 354n);
  assert.equal(near(m.each), '0.004');
  assert.deepEqual(m.sends.map((s) => [s.name, near(s.yocto)]), [['NOVA', '0.004'], ['ONYX', '0.004'], ['ORACLE', '0.012']]);
  assert.ok(m.sends.find((s) => s.name === 'ORACLE').yocto - m.each >= KEPT.crew);
  // The owner's key script grants exactly these methods.
  const ps1 = readFileSync(new URL('../testnet/jobs-keys.ps1', import.meta.url), 'utf8');
  assert.match(ps1, new RegExp(`'${KEY_METHODS.jobs.join(', ')}'`));
  assert.match(ps1, new RegExp(`'${KEY_METHODS.crews.join(', ')}'`));
});

test('each contract account holds at least the storage of its code and first state', () => {
  assert.ok(yocto(net.fund.jobs) >= storageOf(bytes.jobsBytes));
  assert.ok(yocto(net.fund.crews) >= storageOf(bytes.crewsBytes));
  // And not much more: what an account holds beyond its storage stays there for good.
  assert.ok(yocto(net.fund.jobs) - storageOf(bytes.jobsBytes) < yocto('0.2'));
  assert.ok(yocto(net.fund.crews) - storageOf(bytes.crewsBytes) < yocto('0.2'));
  assert.throws(() => budget({ ...bytes, jobsBytes: 600_000, quote, bond: yocto('0.01') }), /fund.jobs/);
});

test('new(...) names the same accounts as jobs-deploy.ps1, and no judge until one is published for mainnet', () => {
  const init = initArgs();
  assert.deepEqual(Object.keys(init.jobs), ['admin', 'meter', 'treasury', 'outlayer', 'crews', 'judges', 'bounties', 'factories', 'fee_bps', 'fee_to']);
  const ps1 = readFileSync(new URL('../testnet/jobs-deploy.ps1', import.meta.url), 'utf8');
  for (const k of Object.keys(init.jobs)) assert.match(ps1, new RegExp(`\\b${k} =`), k);
  assert.equal(init.jobs.admin, 'maskwars.near');
  assert.equal(init.jobs.outlayer, 'outlayer.near');
  assert.deepEqual(init.jobs.bounties, ['bounty.maskwars.near']);
  assert.deepEqual(init.jobs.judges, []);
  assert.ok(init.jobs.fee_bps <= 1000);
  // The fuel of a counted step goes to maskwars.near: it pays the masks' inference.
  assert.equal(init.jobs.meter, 'maskwars.near');
  assert.equal(init.jobs.treasury, 'maskwars.near');
  // The mask factory is on chain on mainnet: it is named, so a job can open for forged masks. Where there is none, none
  // is named, and no job can open for forged masks nobody has.
  assert.equal(net.sections.forge, true);
  assert.deepEqual(init.jobs.factories, ['masks.maskwars.near']);
  assert.deepEqual(init.crews, { admin: 'maskwars.near', factories: ['masks.maskwars.near'] });
  const unforged = initArgs({ ...net, sections: { ...net.sections, forge: false } });
  assert.deepEqual(unforged.jobs.factories, []);
  assert.deepEqual(unforged.crews.factories, []);
  assert.throws(() => initArgs(net, { fee_bps: 1500, judges: [] }), /at most 1000/);
});

test('the code pinned is the build of contracts/jobs, when it is built here', () => {
  for (const [which, c] of Object.entries(CODE)) {
    assert.match(c.sha256, /^[0-9a-f]{64}$/, which);
    let size = null;
    try {
      size = statSync(new URL(`../../contracts/jobs/target/wasm/${c.file}`, import.meta.url)).size;
    } catch {
      continue; // not built in this checkout: contracts/jobs/build.sh
    }
    assert.equal(size, which === 'jobs' ? bytes.jobsBytes : bytes.crewsBytes, which);
  }
});
