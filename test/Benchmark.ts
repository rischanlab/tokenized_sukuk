import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";
import hre from "hardhat";
import { size, type Hex } from "viem";

import {
  CLAIM,
  CLASS,
  DAY,
  INSTRUMENT_ID,
  MAX_CLAIM_VALIDITY,
  ROLE,
  STATUS,
  decodeReason,
  evidenceDomain,
  id,
  signAttestation,
  units,
  type Attestation,
} from "./helpers.js";
import { CONFIGS, assetId, deployWorld, isShariahConfig, type ConfigName, type World } from "./environment.js";

/**
 * T14: gas and latency measurements on the local Hardhat (EDR) network.
 *
 * Gas figures are deterministic properties of the compiled contracts and the
 * chosen inputs. Wall-clock figures measure an in-process simulated chain on
 * the machine recorded in outputs/environment.json; they are reported to show
 * relative cost between configurations, not public-network latency.
 */

const network = await hre.network.create();
const TRIALS = Number(process.env.BENCH_TRIALS ?? 200);
const CHECKPOINTS = [1, 10, 100, 1000];
const ISSUANCE_ASSETS = [1, 2, 4, 8, 16, 32];
const RENEWALS = 100;
const CONTRACTS = [
  "IdentityRegistry",
  "BasicCompliance",
  "EvidenceRegistry",
  "SukukPolicyEngine",
  "SukukPolicyEngineFallback",
  "SukukToken",
  "InlineEvidenceHarness",
];

type Row = { experiment: string; config: string; parameter: string; metric: string; value: string; unit: string };
const rows: Row[] = [];
const latency: string[] = ["config,operation,trials,median_ms,q1_ms,q3_ms,iqr_ms,min_ms,max_ms"];
const record = (experiment: string, config: string, parameter: string | number, metric: string, value: bigint | number | string, unit = "gas") =>
  rows.push({ experiment, config, parameter: String(parameter), metric, value: String(value), unit });

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summarise(config: string, operation: string, samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const q1 = quantile(s, 0.25);
  const q3 = quantile(s, 0.75);
  const f = (x: number) => x.toFixed(3);
  latency.push(
    [config, operation, s.length, f(quantile(s, 0.5)), f(q1), f(q3), f(q3 - q1), f(s[0]), f(s[s.length - 1])].join(","),
  );
}

function stats(values: bigint[]) {
  const sum = values.reduce((a, b) => a + b, 0n);
  const min = values.reduce((a, b) => (b < a ? b : a));
  const max = values.reduce((a, b) => (b > a ? b : a));
  return { sum, min, max, mean: Number(sum) / values.length };
}

/** Sums gas of every transaction mined between two block numbers, by created contract. */
async function deploymentGas(world: World, fromBlock: bigint, toBlock: bigint) {
  const names = new Map<string, string>([
    [world.identity.address.toLowerCase(), "IdentityRegistry"],
    [world.token.address.toLowerCase(), "SukukToken"],
    [
      world.compliance.address.toLowerCase(),
      world.config === "B0" ? "BasicCompliance" : world.config === "B2F" ? "SukukPolicyEngineFallback" : "SukukPolicyEngine",
    ],
  ]);
  if (world.registry) names.set(world.registry.address.toLowerCase(), "EvidenceRegistry");
  const byName: Record<string, bigint> = {};
  let setup = 0n;
  for (let b = fromBlock; b <= toBlock; ++b) {
    const block = await world.publicClient.getBlock({ blockNumber: b });
    for (const hash of block.transactions as Hex[]) {
      const receipt = await world.publicClient.getTransactionReceipt({ hash });
      const name = receipt.contractAddress ? names.get(receipt.contractAddress.toLowerCase()) : undefined;
      if (name) byName[name] = (byName[name] ?? 0n) + receipt.gasUsed;
      else setup += receipt.gasUsed;
    }
  }
  return { byName, setup };
}

/** Deploys a configuration, publishes evidence and issues the fixture tranche. */
async function readyWorld(config: ConfigName) {
  const from = (await network.viem.getPublicClient().then((c: any) => c.getBlockNumber())) + 1n;
  const world = await deployWorld(network, config);
  const to = await world.publicClient.getBlockNumber();
  const deployment = await deploymentGas(world, from, to);
  await world.publishPortfolio(30n * DAY);
  const issued = await world.issueDefaultTranche();
  assert.equal(issued.ok, true, `${config} default tranche: ${issued.reason}`);
  return { world, deployment, firstIssuanceGas: issued.gasUsed! };
}

async function publishSyntheticAsset(world: World, label: string, value: bigint) {
  const subjectId = id(label);
  const submit = async (signer: "legal" | "valuer" | "shariah", fields: Partial<Attestation> & { claimType: number }) => {
    const att = await world.buildAttestation({ subjectId, ...fields }, 30n * DAY);
    const out = await world.submit(signer, att);
    assert.equal(out.ok, true, `${label}: ${out.reason}`);
  };
  await submit("legal", { claimType: CLAIM.RIGHTS, code: 1 });
  await submit("valuer", { claimType: CLAIM.VALUATION, amount: value });
  if (isShariahConfig(world.config)) {
    await submit("shariah", { claimType: CLAIM.CLASSIFICATION, code: CLASS.NON_DEBT, policyVersion: 1 });
  }
}

describe("T14 gas and latency benchmark", function () {
  const transferMean: Record<string, number> = {};
  const issuanceGas: Record<string, Record<number, bigint>> = {};

  for (const config of CONFIGS) {
    it(`${config}: deployment, transfers, credential updates, issuance and latency`, async function () {
      const { world, deployment, firstIssuanceGas } = await readyWorld(config);

      // Deployment gas by contract, plus role/identity setup transactions.
      let deployTotal = 0n;
      for (const [name, gas] of Object.entries(deployment.byName)) {
        record("deployment", config, name, "gas_used", gas);
        deployTotal += gas;
      }
      record("deployment", config, "all_contracts", "gas_used", deployTotal);
      record("deployment", config, "setup_transactions", "gas_used", deployment.setup);
      record("issuance", config, "fixture_tranche_first", "gas_used", firstIssuanceGas);

      // Transfers between two verified holders with non-zero balances.
      const holders = ["inv1", "inv2"] as const;
      const transferGas: bigint[] = [];
      const transferMs: number[] = [];
      const max = CHECKPOINTS[CHECKPOINTS.length - 1];
      for (let i = 0; i < max; ++i) {
        const from = holders[i % 2];
        const to = holders[(i + 1) % 2];
        const t0 = performance.now();
        const out = await world.send(() =>
          world.token.write.transfer([world.w[to].account.address, units("1")], { account: world.w[from].account }),
        );
        const elapsed = performance.now() - t0;
        assert.equal(out.ok, true, `${config} transfer ${i}: ${out.reason}`);
        transferGas.push(out.gasUsed!);
        if (i < TRIALS) transferMs.push(elapsed);
      }
      for (const n of CHECKPOINTS) {
        const s = stats(transferGas.slice(0, n));
        record("transfer", config, n, "total_gas", s.sum);
        record("transfer", config, n, "mean_gas_per_transfer", s.mean.toFixed(1));
        record("transfer", config, n, "min_gas", s.min);
        record("transfer", config, n, "max_gas", s.max);
      }
      transferMean[config] = stats(transferGas).mean;
      summarise(config, "transfer_send_to_receipt", transferMs);

      // A transfer that creates a new holder balance (zero to non-zero).
      const cold = await world.send(() =>
        world.token.write.transfer([world.w.inv3.account.address, units("1")], { account: world.w.inv1.account }),
      );
      assert.equal(cold.ok, true);
      record("transfer", config, "new_recipient_balance", "gas_used", cold.gasUsed!);

      // Read-only pre-check (eth_call) latency.
      const preMs: number[] = [];
      for (let i = 0; i < TRIALS; ++i) {
        const t0 = performance.now();
        const r = await world.preCheck("inv1", "inv2", units("1"));
        preMs.push(performance.now() - t0);
        assert.equal(r, "OK");
      }
      summarise(config, "precheck_eth_call", preMs);

      // Credential updates: repeated valuation refreshes of one asset.
      if (world.hasEvidence) {
        const updateGas: bigint[] = [];
        const updateMs: number[] = [];
        for (let i = 0; i < max; ++i) {
          const t0 = performance.now();
          const out = await world.attestValuation("ASSET-IJARAH-001", units("25000000") + BigInt(i), "valuer", 30n * DAY);
          const elapsed = performance.now() - t0;
          assert.equal(out.ok, true, `${config} update ${i}: ${out.reason}`);
          updateGas.push(out.gasUsed!);
          if (i < TRIALS) updateMs.push(elapsed);
        }
        for (const n of CHECKPOINTS) {
          const s = stats(updateGas.slice(0, n));
          record("credential_update", config, n, "total_gas", s.sum);
          record("credential_update", config, n, "mean_gas_per_update", s.mean.toFixed(1));
          record("credential_update", config, n, "min_gas", s.min);
          record("credential_update", config, n, "max_gas", s.max);
        }
        summarise(config, "credential_update_sign_and_submit", updateMs);

        // First attestation of a claim slot (new asset), per claim type.
        const subjectId = id("BENCH-FIRST-CLAIM");
        const first = async (signer: "legal" | "valuer" | "shariah", fields: Partial<Attestation> & { claimType: number }, name: string) => {
          const att = await world.buildAttestation({ subjectId, ...fields }, 30n * DAY);
          const out = await world.submit(signer, att);
          assert.equal(out.ok, true);
          record("credential_update", config, `first_${name}`, "gas_used", out.gasUsed!);
        };
        await first("legal", { claimType: CLAIM.RIGHTS, code: 1 }, "rights");
        await first("valuer", { claimType: CLAIM.VALUATION, amount: units("1") }, "valuation");
        if (isShariahConfig(config)) {
          await first("shariah", { claimType: CLAIM.CLASSIFICATION, code: CLASS.NON_DEBT, policyVersion: 1 }, "classification");
        }

        // Renewals of an existing claim slot, per claim type (the recurring
        // cost of keeping evidence current). Valuation renewals are measured
        // above; the Shariah status is renewed only where it is required.
        const renew = async (name: string, submitOne: (i: number) => Promise<{ ok: boolean; gasUsed?: bigint; reason: string }>) => {
          const gas: bigint[] = [];
          for (let i = 0; i < RENEWALS; ++i) {
            const out = await submitOne(i);
            assert.equal(out.ok, true, `${config} renew ${name} ${i}: ${out.reason}`);
            gas.push(out.gasUsed!);
          }
          const s = stats(gas);
          record("renewal", config, name, "mean_gas", s.mean.toFixed(1));
          record("renewal", config, name, "min_gas", s.min);
          record("renewal", config, name, "max_gas", s.max);
        };
        await renew("rights", () => world.attestRights("ASSET-IJARAH-001", false, "legal", 30n * DAY));
        if (isShariahConfig(config)) {
          await renew("classification", () =>
            world.attestClassification("ASSET-IJARAH-001", CLASS.NON_DEBT, 1, "shariah", 30n * DAY),
          );
          await renew("shariah_status", () => world.attestShariahStatus(STATUS.ENDORSED, 1, "shariah", 30n * DAY));
        }
      }

      // Issuance gas against the number of allocated assets (fresh assets each time).
      issuanceGas[config] = {};
      let n = 0;
      for (const k of ISSUANCE_ASSETS) {
        const allocation: Record<string, bigint> = {};
        for (let j = 0; j < k; ++j) {
          const label = `BENCH-ASSET-${k}-${j}`;
          if (world.hasEvidence) await publishSyntheticAsset(world, label, units("10000000"));
          allocation[label] = units("1000000");
        }
        const proceeds = units("1000000") * BigInt(k);
        const tranche = await world.buildTranche(`BENCH-TRANCHE-${++n}`, proceeds, allocation);
        const evidence = await world.issueEvidence(tranche);
        const t0 = performance.now();
        const out = await world.issue(evidence, { inv3: proceeds });
        const elapsed = performance.now() - t0;
        assert.equal(out.ok, true, `${config} issuance k=${k}: ${out.reason}`);
        record("issuance", config, k, "gas_used", out.gasUsed!);
        record("issuance", config, k, "evidence_bytes", size(evidence), "bytes");
        record("issuance", config, k, "wall_clock_ms", elapsed.toFixed(3), "ms");
        issuanceGas[config][k] = out.gasUsed!;
      }

      // Governance and lifecycle operations (evidence-layer configurations).
      if (world.engine) {
        const suspend = await world.send(() => world.engine.write.suspend([id("BENCH")], { account: world.w.governor2.account }));
        record("lifecycle", config, "suspend", "gas_used", suspend.gasUsed!);
        const r1 = await world.send(() => world.engine.write.approveResume([], { account: world.w.admin.account }));
        const r2 = await world.send(() => world.engine.write.approveResume([], { account: world.w.governor3.account }));
        record("lifecycle", config, "approve_resume_first", "gas_used", r1.gasUsed!);
        record("lifecycle", config, "approve_resume_quorum", "gas_used", r2.gasUsed!);
        const witness = await world.send(() => world.engine.write.setWitness([id("ASSET-IJARAH-001")]));
        record("lifecycle", config, "set_witness", "gas_used", witness.gasUsed!);
      }
    });
  }

  it("B2F: transfer gas when the witness fails and the scan finds an eligible candidate", async function () {
    const { world } = await readyWorld("B2F");
    // Grow the candidate list to its cap with fresh non-debt assets.
    const fresh: Record<string, bigint> = {};
    for (let j = 0; j < 29; ++j) {
      const label = `SCAN-ASSET-${j}`;
      await publishSyntheticAsset(world, label, units("10000000"));
      fresh[label] = units("1000000");
    }
    const tranche = await world.buildTranche("SCAN-TRANCHE", units("29000000"), fresh);
    assert.equal((await world.issue(await world.issueEvidence(tranche), { inv3: units("29000000") })).ok, true);
    const n = Number(await world.engine.read.candidateCount());
    assert.equal(n, 32);
    const candidates: Hex[] = [];
    for (let i = 0; i < n; ++i) candidates.push(await world.engine.read.witnessCandidates([BigInt(i)]));
    const witness: Hex = await world.engine.read.witnessAssetId();
    const valuation = async (subjectId: Hex, amount: bigint) => {
      const att = await world.buildAttestation({ claimType: CLAIM.VALUATION, subjectId, amount }, 30n * DAY);
      const out = await world.submit("valuer", att);
      assert.equal(out.ok, true, out.reason);
    };
    // Witness valid: constant-cost path.
    const direct = await world.transfer("inv1", "inv2", units("1"));
    assert.equal(direct.ok, true);
    record("fallback_scan", "B2F", "witness_valid", "gas_used", direct.gasUsed!);
    await valuation(witness, 0n);
    // The first eligible candidate (other than the witness) sits at position p.
    for (let p = 0; p < n; ++p) {
      // The witness and the debt-classified murabahah asset cannot end the scan.
      if (candidates[p] === witness || candidates[p] === assetId("ASSET-MURABAHAH-003")) continue;
      const out = await world.transfer("inv1", "inv2", units("1"));
      assert.equal(out.ok, true, `scan position ${p + 1}: ${out.reason}`);
      record("fallback_scan", "B2F", p + 1, "gas_used", out.gasUsed!);
      await valuation(candidates[p], 0n);
    }
    // Nothing eligible remains: the scan reads every candidate and denies.
    assert.equal((await world.transfer("inv1", "inv2", units("1"))).reason, "NON_DEBT_COMPONENT_UNVERIFIED");
  });

  it("Inline (per-transfer signature verification) versus stored evidence", async function () {
    const { world } = await readyWorld("B2");
    const { viem } = network;
    const chainId = world.chainId;

    const stored = await viem.deployContract("StoredEvidenceHarness", [world.engine.address]);
    const storedSim = await stored.simulate.checkStored();
    assert.equal(decodeReason(storedSim.result), "OK");
    const storedOut = await world.send(() => stored.write.checkStored());
    record("inline_vs_stored", "B2", "stored_state_check", "gas_used", storedOut.gasUsed!);

    const inline = await viem.deployContract("InlineEvidenceHarness", [INSTRUMENT_ID, MAX_CLAIM_VALIDITY, world.w.admin.account.address]);
    for (const [name, role] of [
      ["shariah", ROLE.SHARIAH_ADVISER],
      ["legal", ROLE.LEGAL_VERIFIER],
      ["valuer", ROLE.VALUER],
    ] as const) {
      await inline.write.registerAttestor([world.w[name].account.address, role]);
    }
    const domain = evidenceDomain(chainId, inline.address);
    const now = await world.now();
    const asset = id("ASSET-IJARAH-001");
    const base = { instrumentId: INSTRUMENT_ID, code: 0, flag: false, amount: 0n, policyVersion: 0, seq: 1n, issuedAt: now, validUntil: now + 7n * DAY };
    const bundle: Attestation[] = [
      { ...base, claimType: CLAIM.SHARIAH_STATUS, subjectId: INSTRUMENT_ID, code: STATUS.ENDORSED, policyVersion: 1, evidenceHash: id("status") },
      { ...base, claimType: CLAIM.RIGHTS, subjectId: asset, code: 1, evidenceHash: id("rights") },
      { ...base, claimType: CLAIM.VALUATION, subjectId: asset, amount: units("25000000"), evidenceHash: id("valuation") },
      { ...base, claimType: CLAIM.CLASSIFICATION, subjectId: asset, code: CLASS.NON_DEBT, policyVersion: 1, evidenceHash: id("class") },
    ];
    const signerNames = ["shariah", "legal", "valuer", "shariah"] as const;
    const signers = signerNames.map((n) => world.w[n].account.address);
    const sigs: Hex[] = [];
    for (let i = 0; i < 4; ++i) sigs.push(await signAttestation(world.w[signerNames[i]], domain, bundle[i]));
    const sim = await inline.simulate.checkInline([bundle, signers, sigs, 1]);
    assert.equal(decodeReason(sim.result), "OK");
    const inlineOut = await world.send(() => inline.write.checkInline([bundle, signers, sigs, 1]));
    record("inline_vs_stored", "B2", "inline_four_signatures", "gas_used", inlineOut.gasUsed!);
    const tx = await world.publicClient.getTransaction({ hash: (await world.publicClient.getBlock({ includeTransactions: true })).transactions[0].hash });
    record("inline_vs_stored", "B2", "inline_four_signatures", "calldata_bytes", size(tx.input), "bytes");
    record(
      "inline_vs_stored",
      "B2",
      "inline_minus_stored",
      "gas_used",
      inlineOut.gasUsed! - storedOut.gasUsed!,
    );
  });

  it("writes outputs/gas_metrics.csv, latency_metrics.csv and environment.json", async function () {
    // Relative overhead of the evidence layer per transfer and per issuance.
    for (const c of ["B1", "B2", "B2F"]) {
      if (transferMean[c] !== undefined && transferMean.B0 !== undefined) {
        record("overhead", c, "transfer_mean_vs_B0", "relative", ((transferMean[c] - transferMean.B0) / transferMean.B0).toFixed(4), "ratio");
      }
      for (const k of ISSUANCE_ASSETS) {
        const a = issuanceGas[c]?.[k];
        const b = issuanceGas.B0?.[k];
        if (a !== undefined && b !== undefined) {
          record("overhead", c, `issuance_k${k}_vs_B0`, "relative", (Number(a - b) / Number(b)).toFixed(4), "ratio");
        }
      }
    }

    // Runtime bytecode sizes (EIP-170 limit is 24,576 bytes).
    for (const name of CONTRACTS) {
      const artifact = await hre.artifacts.readArtifact(name);
      record("bytecode", "-", name, "runtime_bytes", (artifact.deployedBytecode.length - 2) / 2, "bytes");
      record("bytecode", "-", name, "initcode_bytes", (artifact.bytecode.length - 2) / 2, "bytes");
    }

    const out = new URL("../outputs/", import.meta.url);
    await mkdir(out, { recursive: true });
    const header = "experiment,config,parameter,metric,value,unit";
    const body = rows.map((r) => [r.experiment, r.config, r.parameter, r.metric, r.value, r.unit].join(","));
    await writeFile(new URL("gas_metrics.csv", out), [header, ...body].join("\n") + "\n");
    await writeFile(new URL("latency_metrics.csv", out), latency.join("\n") + "\n");

    const pkg = async (name: string) =>
      JSON.parse(await readFile(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8")).version;
    const cpus = os.cpus();
    const env = {
      generated_at: new Date().toISOString(),
      node: process.version,
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu_model: cpus[0]?.model ?? "unknown",
      cpu_count: cpus.length,
      memory_gb: Number((os.totalmem() / 2 ** 30).toFixed(1)),
      hardhat: await pkg("hardhat"),
      viem: await pkg("viem"),
      openzeppelin_contracts: await pkg("@openzeppelin/contracts"),
      solc: hre.config.solidity.profiles.default.compilers[0].version,
      optimizer: hre.config.solidity.profiles.default.compilers[0].settings?.optimizer ?? null,
      evm_version: hre.config.solidity.profiles.default.compilers[0].settings?.evmVersion ?? "solc default",
      network: "Hardhat 3 in-process EDR simulated network (automine)",
      network_hardfork: (hre.config.networks.default as any).hardfork ?? "unknown",
      latency_trials: TRIALS,
      transfer_checkpoints: CHECKPOINTS,
      issuance_asset_counts: ISSUANCE_ASSETS,
    };
    await writeFile(new URL("environment.json", out), JSON.stringify(env, null, 2) + "\n");
  });
});
