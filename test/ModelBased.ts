import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import hre from "hardhat";
import type { Hex } from "viem";

import { CLAIM, CLASS, DAY, STATUS, TENOR, id, units } from "./helpers.js";
import {
  ASSETS,
  PORTFOLIO,
  assetId,
  deployWorld,
  isShariahConfig,
  type ConfigName,
  type World,
  type WalletName,
} from "./environment.js";

/**
 * Seeded model-based (differential) test. A random sequence of evidence
 * updates, revocations, time steps, suspensions, issuances, transfers,
 * redemptions and settlements is applied to the contracts and, in parallel,
 * to an independent TypeScript reference model of the written policy
 * (docs/policy_specification.md). After every step the contract decision must
 * equal the model decision and invariants I1, I2, I5, I6 and I7 must hold.
 *
 * Two event profiles are run. "adversarial" draws short validity windows and
 * frequent disposals, revocations, encumbrances and suspensions, so most
 * operations are denied. "maintained" keeps evidence longer-lived and
 * disruptions rare, so that successful transfers, issuances and redemptions
 * are exercised more often. Seeds 1-5 of the adversarial profile at 250 steps
 * reproduce the event sequence of the earlier five-seed runs.
 */

const network = await hre.network.create();
const SEED_COUNT = Number(process.env.MODEL_SEEDS ?? 20);
const SEEDS = Array.from({ length: SEED_COUNT }, (_, i) => i + 1);
const STEPS = Number(process.env.MODEL_STEPS ?? 500);
const CANDIDATE_CAP = 32;

type Profile = "adversarial" | "maintained";
const PROFILES = (process.env.MODEL_PROFILES ?? "adversarial,maintained").split(",") as Profile[];
// Output directory under outputs/; a separate directory keeps replication runs
// from overwriting the main model-based results.
const OUT_DIR = process.env.MODEL_OUT ? `../outputs/${process.env.MODEL_OUT}/` : "../outputs/";

/** Event mix and disruption probabilities for each profile. */
const PROFILE = {
  adversarial: {
    // Cumulative thresholds: transfer, valuation, re-attest, encumbrance,
    // revoke, status, time, witness, suspension, issuance; rest redemption.
    cut: [0.28, 0.40, 0.48, 0.53, 0.58, 0.63, 0.70, 0.77, 0.80, 0.93],
    initialValidity: 20n * DAY,
    validityDays: [1, 10],
    statusDays: [2, 11],
    zeroValuation: 0.25,
    debtReclass: 0.2,
    encumberedRights: 0.15,
    noticeEncumbered: 0.5,
    suspensionSkip: 0.65,
    notEndorsed: 0.15,
    maxTimeStep: 3,
  },
  maintained: {
    cut: [0.35, 0.47, 0.57, 0.59, 0.60, 0.66, 0.72, 0.77, 0.78, 0.93],
    initialValidity: 30n * DAY,
    validityDays: [10, 30],
    statusDays: [10, 30],
    zeroValuation: 0.05,
    debtReclass: 0.05,
    encumberedRights: 0.03,
    noticeEncumbered: 0.1,
    suspensionSkip: 0.9,
    notEndorsed: 0.03,
    maxTimeStep: 1,
  },
} as const;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type MClaim = { validUntil: bigint; revoked: boolean; code: number; flag: boolean; version: number };

class Model {
  claims = new Map<string, MClaim>();
  value = new Map<string, bigint>();
  allocated = new Map<string, bigint>();
  witness: Hex | null = null;
  suspended = false;
  resumeVotes = new Set<string>();
  usedTranches = new Set<string>();
  balances = new Map<string, bigint>();
  totalIssued = 0n;
  pending = 0n;
  settled = 0n;
  redemptions: Array<{ units: bigint; settled: bigint }> = [];
  candidates: Hex[] = [];

  constructor(readonly config: ConfigName, readonly maturity: bigint) {}

  get nonDebtRules() {
    return isShariahConfig(this.config);
  }
  get fallback() {
    return this.config === "B2F";
  }

  key(subject: string, type: number) {
    return `${subject}:${type}`;
  }
  current(subject: string, type: number, t: bigint): MClaim | null {
    const c = this.claims.get(this.key(subject, type));
    return c && !c.revoked && t <= c.validUntil ? c : null;
  }
  encumbered(asset: string, t: bigint): boolean {
    const rights = this.current(asset, CLAIM.RIGHTS, t);
    const notice = this.claims.get(this.key(asset, CLAIM.ENCUMBRANCE));
    return (rights?.flag ?? false) || (notice !== undefined && notice.flag && !notice.revoked);
  }
  backing(asset: string, t: bigint): boolean {
    const v = this.current(asset, CLAIM.VALUATION, t);
    return (
      this.current(asset, CLAIM.RIGHTS, t) !== null &&
      v !== null &&
      v.flag &&
      !this.encumbered(asset, t)
    );
  }
  nonDebt(asset: string, t: bigint): boolean {
    const c = this.current(asset, CLAIM.CLASSIFICATION, t);
    return c !== null && c.code === CLASS.NON_DEBT && c.version === 1 && this.backing(asset, t);
  }
  witnessOk(asset: string | null, t: bigint): boolean {
    if (!asset) return false;
    return this.nonDebtRules ? this.nonDebt(asset, t) : this.backing(asset, t);
  }
  statusOk(t: bigint): boolean {
    if (!this.nonDebtRules) return true;
    const s = this.current("STATUS", CLAIM.SHARIAH_STATUS, t);
    return s !== null && s.code === STATUS.ENDORSED && s.version === 1;
  }
  transferReason(to: WalletName, amount: bigint, from: WalletName, t: bigint): string {
    if (t >= this.maturity) return "INSTRUMENT_MATURED";
    if (to === "outsider") return "RECEIVER_NOT_VERIFIED";
    if (this.suspended) return "INSTRUMENT_SUSPENDED";
    if (!this.statusOk(t)) return "SHARIAH_STATUS_INVALID";
    if (!this.witnessOk(this.witness, t)) {
      const rescued =
        this.fallback && this.candidates.some((c) => c !== this.witness && this.witnessOk(c, t));
      if (!rescued) {
        return this.nonDebtRules ? "NON_DEBT_COMPONENT_UNVERIFIED" : "BACKING_EVIDENCE_INVALID";
      }
    }
    if ((this.balances.get(from) ?? 0n) < amount) return "ERC20InsufficientBalance";
    return "OK";
  }
}

async function runWalk(config: ConfigName, seed: number, profile: Profile) {
  const P = PROFILE[profile];
  const rand = mulberry32(seed);
  // Uniform whole number of days in [lo, hi].
  const days = (range: readonly number[]) =>
    BigInt(range[0] + Math.floor(rand() * (range[1] - range[0] + 1))) * DAY;
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const world: World = await deployWorld(network, config);
  const maturity: bigint = BigInt(await world.token.read.maturity());
  const model = new Model(config, maturity);
  let t = await world.now();
  const tick = async (dt = 1n) => {
    t += dt;
    await world.networkHelpers.time.setNextBlockTimestamp(t);
  };
  const labels = ASSETS.map((a) => a.label);
  const investors: WalletName[] = ["inv1", "inv2", "inv3"];
  let trancheNo = 0;
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  // Records a claim in the model with the same fields the contract stores.
  const recordClaim = (subject: string, type: number, att: any) => {
    model.claims.set(model.key(subject, type), {
      validUntil: att.validUntil,
      revoked: false,
      code: att.code,
      flag: type === CLAIM.VALUATION ? att.amount > 0n : att.flag,
      version: att.policyVersion,
    });
    if (type === CLAIM.VALUATION) model.value.set(subject, att.amount);
  };

  const submit = async (signer: WalletName, type: number, label: string, fields: any, validFor: bigint) => {
    await tick();
    const subject = type === CLAIM.SHARIAH_STATUS ? (await world.registry.read.instrumentId()) : assetId(label);
    const att = await world.buildAttestation(
      { claimType: type, subjectId: subject, issuedAt: t, ...fields },
      validFor,
    );
    const out = await world.submit(signer, att);
    assert.equal(out.ok, true, `submit failed: ${out.reason}`);
    recordClaim(type === CLAIM.SHARIAH_STATUS ? "STATUS" : subject, type, att);
  };

  const publishAsset = async (label: string, validFor: bigint) => {
    const spec = ASSETS.find((a) => a.label === label)!;
    await submit("legal", CLAIM.RIGHTS, label, { code: 1, flag: false }, validFor);
    await submit("valuer", CLAIM.VALUATION, label, { amount: units(spec.value) }, validFor);
    if (isShariahConfig(config)) {
      await submit("shariah", CLAIM.CLASSIFICATION, label, { code: CLASS[spec.class], policyVersion: 1 }, validFor);
    }
  };

  for (const l of labels) await publishAsset(l, P.initialValidity);
  if (isShariahConfig(config)) {
    await submit("shariah", CLAIM.SHARIAH_STATUS, "", { code: STATUS.ENDORSED, policyVersion: 1 }, P.initialValidity);
  }

  const checkInvariants = async () => {
    const supply: bigint = await world.token.read.totalSupply();
    const issued: bigint = await world.token.read.totalIssued();
    const pending: bigint = await world.token.read.pendingRedemptionUnits();
    const settled: bigint = await world.token.read.settledRedemptionUnits();
    // I6: supply and redemption accounting conserve issued units.
    assert.equal(supply + pending + settled, issued, "I6");
    assert.equal(issued, model.totalIssued, "issued");
    assert.equal(pending, model.pending, "pending");
    // I7: balances match the model; the outsider never holds tokens.
    let sum = 0n;
    for (const n of [...investors, "outsider"] as WalletName[]) {
      const b: bigint = await world.token.read.balanceOf([world.w[n].account.address]);
      assert.equal(b, model.balances.get(n) ?? 0n, `balance ${n}`);
      sum += b;
    }
    assert.equal(sum, supply, "I7 sum");
    assert.equal(model.balances.get("outsider") ?? 0n, 0n, "I7 outsider");
    // I5: no asset is allocated beyond the value attested when allocated.
    for (const l of labels) {
      const a: bigint = await world.engine.read.allocated([assetId(l)]);
      assert.equal(a, model.allocated.get(assetId(l)) ?? 0n, `allocated ${l}`);
    }
    // Witness agrees with the model.
    const w: Hex = await world.engine.read.witnessAssetId();
    assert.equal(w === `0x${"0".repeat(64)}` ? null : w, model.witness, "witness");
    if (model.fallback) {
      assert.equal(Number(await world.engine.read.candidateCount()), model.candidates.length, "candidates");
    }
  };


  // Builds, signs and submits a tranche; the model decides with the same order
  // of checks as the engine and is updated only when the contract accepts.
  const tryIssue = async (label: string, entries: Array<[string, bigint]>, proceeds: bigint, recipient: WalletName, step: number) => {
    await tick();
    const tranche = await world.buildTranche(label, proceeds, Object.fromEntries(entries), { issuedAt: t, validUntil: t + DAY });
    const evidence = await world.issueEvidence(tranche);
    let expected = "OK";
    let nonDebtSum = 0n;
    let first: Hex | null = null;
    if (t >= maturity) expected = "InvalidIssuance";
    else if (model.suspended) expected = "INSTRUMENT_SUSPENDED";
    else if (!model.statusOk(t)) expected = "SHARIAH_STATUS_INVALID";
    else {
      for (let i = 0; i < tranche.assetIds.length; ++i) {
        const a = tranche.assetIds[i];
        const amt = tranche.amounts[i];
        if (!model.backing(a, t) || (model.allocated.get(a) ?? 0n) + amt > (model.value.get(a) ?? 0n)) {
          expected = "ALLOCATION_INVALID";
          break;
        }
        if (model.nonDebtRules) {
          if (model.nonDebt(a, t)) {
            nonDebtSum += amt;
            first ??= a;
          }
        } else first ??= a;
      }
      if (expected === "OK" && model.nonDebtRules && nonDebtSum * 10000n < 3300n * proceeds) {
        expected = "NON_DEBT_RATIO_BELOW_MINIMUM";
      }
    }
    const out = await world.issue(evidence, { [recipient]: proceeds });
    const actual = out.ok ? "OK" : out.reason;
    assert.equal(actual, expected, `step ${step} issue`);
    if (out.ok) {
      // I1: a recorded tranche satisfies the issuance minimum under B2.
      if (isShariahConfig(config)) assert.ok(nonDebtSum * 10000n >= 3300n * proceeds, "I1");
      tranche.assetIds.forEach((a, i) => {
        const before = model.allocated.get(a) ?? 0n;
        if (before === 0n && model.candidates.length < CANDIDATE_CAP) model.candidates.push(a);
        model.allocated.set(a, before + tranche.amounts[i]);
      });
      model.balances.set(recipient, (model.balances.get(recipient) ?? 0n) + proceeds);
      model.totalIssued += proceeds;
      if (first && !model.witnessOk(model.witness, t)) model.witness = first;
    }
    bump(`issue:${actual}`);
    return actual;
  };

  // Every walk starts from the fixture's valid first tranche so that later
  // transfers operate on non-zero balances.
  const t0 = PORTFOLIO.tranches[0];
  const initial = await tryIssue(
    `MB-${seed}-0`,
    Object.entries(t0.allocation).map(([k, v]) => [k, units(v as string)] as [string, bigint]),
    units(t0.proceeds),
    "inv1",
    -1,
  );
  assert.equal(initial, "OK", "initial tranche");
  await checkInvariants();

  for (let step = 0; step < STEPS; ++step) {
    const r = rand();
    const cut = P.cut;
    if (r < cut[0]) {
      // Transfer between random wallets (I2, I7).
      const from = pick(investors);
      const to = pick([...investors, "outsider"] as WalletName[]);
      const bal = model.balances.get(from) ?? 0n;
      // Mostly a fraction of the sender's balance; occasionally more than it holds.
      const amount =
        rand() < 0.8 && bal > 0n ? (bal * BigInt(1 + Math.floor(rand() * 100))) / 100n : units(String(1 + Math.floor(rand() * 50_000_000)));
      await tick();
      const expected = model.transferReason(to, amount, from, t);
      const out = await world.send(() =>
        world.token.write.transfer([world.w[to].account.address, amount], { account: world.w[from].account }),
      );
      const actual = out.ok ? "OK" : out.reason;
      assert.equal(actual, expected, `step ${step} transfer ${from}->${to}`);
      if (out.ok) {
        model.balances.set(from, (model.balances.get(from) ?? 0n) - amount);
        model.balances.set(to, (model.balances.get(to) ?? 0n) + amount);
      }
      bump(`transfer:${actual}`);
    } else if (r < cut[1]) {
      // New valuation, sometimes zero (asset disposed) or written down.
      const label = pick(labels);
      const spec = ASSETS.find((a) => a.label === label)!;
      const amount = rand() < P.zeroValuation ? 0n : (units(spec.value) * BigInt(1 + Math.floor(rand() * 150))) / 100n;
      await submit("valuer", CLAIM.VALUATION, label, { amount }, days(P.validityDays));
      bump("valuation");
    } else if (r < cut[2]) {
      // Re-attest rights (occasionally encumbered) or classification.
      const label = pick(labels);
      const validFor = days(P.validityDays);
      if (isShariahConfig(config) && rand() < 0.4) {
        const spec = ASSETS.find((a) => a.label === label)!;
        const cls = rand() < 1 - P.debtReclass ? CLASS[spec.class] : CLASS.DEBT;
        await submit("shariah", CLAIM.CLASSIFICATION, label, { code: cls, policyVersion: 1 }, validFor);
      } else {
        await submit("legal", CLAIM.RIGHTS, label, { code: 1, flag: rand() < P.encumberedRights }, validFor);
      }
      bump("reattest");
    } else if (r < cut[3]) {
      // Custodian encumbrance notice set or cleared.
      const label = pick(labels);
      await submit("custodian", CLAIM.ENCUMBRANCE, label, { flag: rand() < P.noticeEncumbered }, 5n * DAY);
      bump("encumbrance");
    } else if (r < cut[4]) {
      // Revoke a random current claim by its signer.
      const label = pick(labels);
      const type = pick(isShariahConfig(config) ? [CLAIM.RIGHTS, CLAIM.VALUATION, CLAIM.CLASSIFICATION] : [CLAIM.RIGHTS, CLAIM.VALUATION]);
      const signer: WalletName = type === CLAIM.RIGHTS ? "legal" : type === CLAIM.VALUATION ? "valuer" : "shariah";
      const c = model.claims.get(model.key(assetId(label), type));
      await tick();
      const out = await world.revoke(label, type, signer);
      assert.equal(out.ok, c !== undefined && !c.revoked, `revoke ${label}`);
      if (out.ok) c!.revoked = true;
      bump("revoke");
    } else if (r < cut[5]) {
      // Shariah status renewed or, rarely, withdrawn (B2 and B2F only).
      if (isShariahConfig(config)) {
        const status = rand() < 1 - P.notEndorsed ? STATUS.ENDORSED : STATUS.NOT_ENDORSED;
        await submit("shariah", CLAIM.SHARIAH_STATUS, "", { code: status, policyVersion: 1 }, days(P.statusDays));
      }
      bump("status");
    } else if (r < cut[6]) {
      // Time passes.
      t += 1n + BigInt(Math.floor(rand() * P.maxTimeStep * Number(DAY)));
      await world.networkHelpers.time.setNextBlockTimestamp(t);
      await world.networkHelpers.mine(1);
      bump("time");
    } else if (r < cut[7]) {
      // Relayer re-nominates a witness.
      let chosen: Hex | null = null;
      for (const l of labels) {
        await tick();
        const out = await world.send(() => world.engine.write.setWitness([assetId(l)]));
        assert.equal(out.ok, model.witnessOk(assetId(l), t), `setWitness ${l}`);
        if (out.ok) {
          chosen = assetId(l);
          break;
        }
      }
      if (chosen) model.witness = chosen;
      bump("witness");
    } else if (r < cut[8]) {
      // Suspension and resumption (I8).
      await tick();
      if (!model.suspended && rand() < P.suspensionSkip) {
        // Most visits leave an unsuspended instrument alone, so that the walk
        // does not spend most of its steps in the suspended state.
      } else if (!model.suspended) {
        await world.engine.write.suspend([id("RANDOM")], { account: world.w.governor3.account });
        model.suspended = true;
        model.resumeVotes.clear();
      } else {
        const g = pick(["admin", "governor2", "governor3"] as WalletName[]);
        const out = await world.send(() => world.engine.write.approveResume([], { account: world.w[g].account }));
        assert.equal(out.ok, !model.resumeVotes.has(g));
        if (out.ok) model.resumeVotes.add(g);
        if (model.resumeVotes.size >= 2) model.suspended = false;
      }
      bump("suspension");
    } else if (r < cut[9]) {
      // Issue a tranche (I1, I5). Half of the allocations are drawn within the
      // remaining attested capacity so that issuance is not almost always denied.
      trancheNo += 1;
      const feasible = rand() < 0.5;
      const entries: Array<[string, bigint]> = [];
      for (const l of labels) {
        if (rand() >= 0.7) continue;
        if (feasible) {
          const room = (model.value.get(assetId(l)) ?? 0n) - (model.allocated.get(assetId(l)) ?? 0n);
          if (room > 0n) entries.push([l, (room * BigInt(1 + Math.floor(rand() * 100))) / 100n]);
        } else {
          entries.push([l, units(String(1 + Math.floor(rand() * 20_000_000)))]);
        }
      }
      if (entries.length === 0) entries.push([labels[0], units("1000000")]);
      const allocTotal = entries.reduce((s, e) => s + e[1], 0n);
      const slack = feasible ? allocTotal / BigInt(1 + Math.floor(rand() * 20)) : units(String(Math.floor(rand() * 10_000_000)));
      await tryIssue(`MB-${seed}-${trancheNo}`, entries, allocTotal + slack, pick(investors), step);
    } else {
      // Redemption or settlement (only meaningful after maturity).
      await tick();
      if (t < maturity && rand() < 0.97) {
        bump("noop");
        continue;
      }
      if (t < maturity) {
        t = maturity;
        await world.networkHelpers.time.setNextBlockTimestamp(t);
        await world.networkHelpers.mine(1);
        await tick();
      }
      if (rand() < 0.5) {
        const h = pick(investors);
        const bal = model.balances.get(h) ?? 0n;
        const amount = bal === 0n ? 1n : (bal * BigInt(1 + Math.floor(rand() * 120))) / 100n;
        const out = await world.send(() => world.token.write.requestRedemption([amount], { account: world.w[h].account }));
        assert.equal(out.ok, amount > 0n && amount <= bal, "redeem");
        if (out.ok) {
          model.balances.set(h, bal - amount);
          model.pending += amount;
          model.redemptions.push({ units: amount, settled: 0n });
        }
        bump("redeem");
      } else if (model.redemptions.length > 0) {
        const idx = Math.floor(rand() * model.redemptions.length);
        const red = model.redemptions[idx];
        const amount = (red.units * BigInt(1 + Math.floor(rand() * 120))) / 100n;
        const out = await world.send(() =>
          world.token.write.confirmSettlement([BigInt(idx + 1), amount, id("pay")], { account: world.w.settlement.account }),
        );
        assert.equal(out.ok, amount > 0n && red.settled + amount <= red.units, "settle");
        if (out.ok) {
          red.settled += amount;
          model.pending -= amount;
          model.settled += amount;
        }
        bump("settle");
      }
    }
    await checkInvariants();
  }
  return counts;
}

const summary: string[] = ["config,profile,event,outcome,count"];

describe("Model-based differential test with invariants", function () {
  for (const config of ["B1", "B2", "B2F"] as ConfigName[]) {
    it(`${config}: ${PROFILES.length} profiles x ${SEEDS.length} seeds x ${STEPS} steps agree with the reference model`, async function () {
      const rows: string[] = [];
      for (const profile of PROFILES) {
        const total: Record<string, number> = {};
        for (const seed of SEEDS) {
          const counts = await runWalk(config, seed, profile);
          for (const [k, v] of Object.entries(counts)) total[k] = (total[k] ?? 0) + v;
          rows.push(`${config},${profile},${seed},${STEPS},${JSON.stringify(counts).replaceAll(",", ";")}`);
        }
        for (const k of Object.keys(total).sort()) {
          const [event, outcome = ""] = k.split(":");
          summary.push(`${config},${profile},${event},${outcome},${total[k]}`);
        }
      }
      await mkdir(new URL(OUT_DIR, import.meta.url), { recursive: true });
      const file = new URL(`${OUT_DIR}model_based_${config}.csv`, import.meta.url);
      await writeFile(file, ["config,profile,seed,steps,operation_counts", ...rows].join("\n") + "\n");
      await writeFile(new URL(`${OUT_DIR}model_based_summary.csv`, import.meta.url), summary.join("\n") + "\n");
    });
  }
});
