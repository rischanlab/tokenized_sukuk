import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import hre from "hardhat";

import { CLAIM, CLASS, DAY, STATUS, TENOR, evidenceDomain, id, units } from "./helpers.js";
import {
  ASSETS,
  CONFIGS,
  assetId,
  isShariahConfig,
  deployWorld,
  type ConfigName,
  type TxOutcome,
  type World,
} from "./environment.js";

/**
 * Replays every scenario of fixtures/test_oracle.csv against B0, B1, B2 and
 * B2F and records the observed decision. Each configuration is compared with
 * (a) its own design oracle (expected_<config>) and (b) the sukuk policy oracle
 * (expected_policy), which states what the authors' encoding of the SAC rule
 * and their stated controls require. The primary set (S01-S26) and the
 * supplementary set (G01-G04), which targets gaps found in the coverage
 * analysis, are summarised separately.
 */

const network = await hre.network.create();
// ORACLE_OUT redirects the decision files, so that runs against mutated
// contracts (scripts/run_mutants.py) do not overwrite the reported outputs.
const OUT_DIR = process.env.ORACLE_OUT
  ? pathToFileURL(resolve(process.env.ORACLE_OUT) + "/")
  : new URL("../outputs/", import.meta.url);

type Decision = "ALLOW" | "DENY" | "N/A";
type Row = Record<string, string>;

function parseCsv(text: string): Row[] {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const cols = header.split(",");
  return lines.map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
  });
}

const decision = (o: TxOutcome): { decision: Decision; reason: string } => ({
  decision: o.ok ? "ALLOW" : "DENY",
  reason: o.ok ? "OK" : o.reason,
});

// Base states, one fixture per configuration and stage.
const published: Record<ConfigName, () => Promise<World>> = {
  B0: async function publishedB0() {
    const w = await deployWorld(network, "B0");
    await w.publishPortfolio();
    return w;
  },
  B1: async function publishedB1() {
    const w = await deployWorld(network, "B1");
    await w.publishPortfolio();
    return w;
  },
  B2: async function publishedB2() {
    const w = await deployWorld(network, "B2");
    await w.publishPortfolio();
    return w;
  },
  B2F: async function publishedB2F() {
    const w = await deployWorld(network, "B2F");
    await w.publishPortfolio();
    return w;
  },
};
const issuedFixtures: Record<ConfigName, () => Promise<World>> = {
  B0: async function issuedB0() {
    const w = await published.B0();
    assert.equal((await w.issueDefaultTranche()).ok, true);
    return w;
  },
  B1: async function issuedB1() {
    const w = await published.B1();
    assert.equal((await w.issueDefaultTranche()).ok, true);
    return w;
  },
  B2: async function issuedB2() {
    const w = await published.B2();
    assert.equal((await w.issueDefaultTranche()).ok, true);
    return w;
  },
  B2F: async function issuedB2F() {
    const w = await published.B2F();
    assert.equal((await w.issueDefaultTranche()).ok, true);
    return w;
  },
};

const NON_DEBT = ["ASSET-IJARAH-001", "ASSET-MUSHARAKAH-002"];
const PROCEEDS = units("100000000");

async function issueSplit(w: World, label: string, alloc: Record<string, string>) {
  const allocation = Object.fromEntries(
    Object.entries(alloc).map(([k, v]) => [k, units(v)]),
  );
  const tranche = await w.buildTranche(label, PROCEEDS, allocation);
  return w.issue(await w.issueEvidence(tranche), { inv1: PROCEEDS });
}

/** Ordinary transfer preceded by the relayer's witness re-nomination. */
async function relayedTransfer(w: World) {
  await w.refreshWitness();
  return decision(await w.transfer("inv1", "inv3", units("1000")));
}

const scenarios: Record<
  string,
  (config: ConfigName) => Promise<{ decision: Decision; reason: string }>
> = {
  S01: async (c) => {
    const w = await network.networkHelpers.loadFixture(published[c]);
    return decision(await w.issueDefaultTranche());
  },
  S02: async (c) => {
    const w = await network.networkHelpers.loadFixture(published[c]);
    return decision(
      await issueSplit(w, "S02", {
        "ASSET-IJARAH-001": "25000000",
        "ASSET-MUSHARAKAH-002": "8000000",
        "ASSET-MURABAHAH-003": "67000000",
      }),
    );
  },
  S03: async (c) => {
    const w = await network.networkHelpers.loadFixture(published[c]);
    return decision(
      await issueSplit(w, "S03", {
        "ASSET-IJARAH-001": "25000000",
        "ASSET-MUSHARAKAH-002": "7990000",
        "ASSET-MURABAHAH-003": "67010000",
      }),
    );
  },
  S04: async (c) => {
    const w = await network.networkHelpers.loadFixture(published[c]);
    await w.attestClassification("ASSET-MUSHARAKAH-002", CLASS.DEBT);
    return decision(await w.issueDefaultTranche());
  },
  S05: async (c) => {
    const w = await network.networkHelpers.loadFixture(issuedFixtures[c]);
    await w.attestValuation("ASSET-IJARAH-001", units("5000000"));
    await w.attestValuation("ASSET-MUSHARAKAH-002", 0n);
    return relayedTransfer(w);
  },
  S06: async (c) => {
    const w = await network.networkHelpers.loadFixture(issuedFixtures[c]);
    for (const a of NON_DEBT) await w.attestValuation(a, 0n);
    return relayedTransfer(w);
  },
  S07: async (c) => {
    const w = await network.networkHelpers.loadFixture(published[c]);
    const tranche = await w.buildTranche("S07", units("100"), {
      "ASSET-IJARAH-001": units("100"),
    });
    const ev = await w.issueEvidence(tranche, ["wakeel", "attacker"]);
    return decision(await w.issue(ev, { inv1: units("100") }));
  },
  S08: async (c) => {
    const w = await network.networkHelpers.loadFixture(published[c]);
    // Forged valuation (attacker signs, claims valuer's address): rejected.
    const forged = await w.buildAttestation({
      claimType: CLAIM.VALUATION,
      subjectId: assetId("ASSET-IJARAH-001"),
      amount: units("60000000"),
    });
    const sig = w.hasEvidence ? await w.sign("attacker", forged) : undefined;
    const sub = await w.submit("valuer", forged, { signature: sig });
    if (w.hasEvidence) assert.equal(sub.ok, false);
    return decision(
      await issueSplit(w, "S08", {
        "ASSET-IJARAH-001": "50000000",
        "ASSET-MURABAHAH-003": "50000000",
      }),
    );
  },
  S09: async (c) => {
    const w = await network.networkHelpers.loadFixture(issuedFixtures[c]);
    await w.increaseTime(8n * DAY);
    return relayedTransfer(w);
  },
  S10: async (c) => {
    const w = await network.networkHelpers.loadFixture(issuedFixtures[c]);
    // Earliest expiry among the claims the transfer check reads.
    let earliest = (await w.now()) + 7n * DAY;
    if (w.hasEvidence) {
      const witness = await w.engine.read.witnessAssetId();
      const kinds: number[] = [CLAIM.RIGHTS, CLAIM.VALUATION];
      if (isShariahConfig(c)) kinds.push(CLAIM.CLASSIFICATION);
      const subjects: Array<[`0x${string}`, number]> = kinds.map((k) => [witness, k]);
      if (isShariahConfig(c)) subjects.push([await w.registry.read.instrumentId(), CLAIM.SHARIAH_STATUS]);
      for (const [s, k] of subjects) {
        const claim = await w.registry.read.claimOf([s, k]);
        if (BigInt(claim.validUntil) < earliest) earliest = BigInt(claim.validUntil);
      }
    }
    await w.networkHelpers.time.setNextBlockTimestamp(earliest);
    return decision(await w.transfer("inv1", "inv3", units("1000")));
  },
  S11: async (c) => {
    const w = await network.networkHelpers.loadFixture(issuedFixtures[c]);
    for (const a of NON_DEBT) await w.revoke(a, CLAIM.RIGHTS, "legal");
    return relayedTransfer(w);
  },
  S12: async (c) => {
    const w = await network.networkHelpers.loadFixture(published[c]);
    const tranche = await w.buildTranche("S12", units("100"), {
      "ASSET-IJARAH-001": units("100"),
    });
    const ev = await w.issueEvidence(tranche);
    assert.equal((await w.issue(ev, { inv1: units("100") })).ok, true);
    return decision(await w.issue(ev, { inv1: units("100") }));
  },
  S13: async (c) => {
    const w = await network.networkHelpers.loadFixture(published[c]);
    const tranche = await w.buildTranche("S13", units("100"), {
      "ASSET-IJARAH-001": units("100"),
    });
    const domain = w.hasEvidence
      ? evidenceDomain(w.chainId + 1, w.registry.address)
      : undefined;
    const ev = await w.issueEvidence(tranche, ["wakeel", "trustee"], domain);
    return decision(await w.issue(ev, { inv1: units("100") }));
  },
  S14: async (c) => {
    const w = await network.networkHelpers.loadFixture(issuedFixtures[c]);
    for (const a of NON_DEBT) await w.attestEncumbrance(a, true);
    return relayedTransfer(w);
  },
  S15: async (c) => {
    const w = await network.networkHelpers.loadFixture(issuedFixtures[c]);
    const t = await w.buildTranche("S15", units("10"), {
      "ASSET-IJARAH-001": units("10"),
    });
    return decision(await w.issue(await w.issueEvidence(t), { inv2: units("10") }));
  },
  S16: async (c) => {
    const w = await network.networkHelpers.loadFixture(issuedFixtures[c]);
    return decision(await w.transfer("inv1", "outsider", units("1000")));
  },
  S17: async (c) => {
    if (c === "B0") return { decision: "N/A", reason: "NO_POLICY_GOVERNANCE" };
    const w = await network.networkHelpers.loadFixture(issuedFixtures[c]);
    const active = await w.engine.read.activePolicy();
    const next = {
      version: Number(active[0]) + 1,
      minNonDebtBps: 0,
      applyNonDebtRules: false,
      requireShariahStatus: false,
      excludeEncumbered: false,
      policyDocHash: id("weakened"),
    };
    await w.engine.write.proposePolicy([next]);
    await w.engine.write.approvePolicy([1n]);
    await w.increaseTime(2n * DAY);
    return decision(await w.send(() => w.engine.write.activatePolicy([1n])));
  },
  S18: async (c) => {
    const w = await network.networkHelpers.loadFixture(issuedFixtures[c]);
    await w.revokeAttestor("legal");
    return relayedTransfer(w);
  },
  S19: async (c) => {
    const w = await network.networkHelpers.loadFixture(issuedFixtures[c]);
    await w.revokeAttestor("legal");
    await w.registerAttestor("legal2", id("LEGAL_VERIFIER"));
    for (const a of NON_DEBT) await w.attestRights(a, false, "legal2");
    await w.attestRights("ASSET-MURABAHAH-003", false, "legal2");
    return relayedTransfer(w);
  },
  S20: async (c) => {
    if (c === "B0") return { decision: "N/A", reason: "NO_EVIDENCE_LAYER" };
    const w = await network.networkHelpers.loadFixture(published[c]);
    const subject = assetId("ASSET-IJARAH-001");
    const current = await w.registry.read.lastSeq([subject, CLAIM.VALUATION]);
    const older = await w.buildAttestation({
      claimType: CLAIM.VALUATION,
      subjectId: subject,
      amount: units("1"),
      seq: current - 1n,
    });
    return decision(await w.submit("valuer", older));
  },
  S21: async (c) => {
    const w = await network.networkHelpers.loadFixture(issuedFixtures[c]);
    await w.increaseTime(TENOR);
    const t = w.token;
    await t.write.requestRedemption([units("20000000")], { account: w.w.inv1.account });
    return decision(
      await w.send(() =>
        t.write.requestRedemption([units("40000001")], { account: w.w.inv1.account }),
      ),
    );
  },
  S22: async (c) => {
    const w = await network.networkHelpers.loadFixture(issuedFixtures[c]);
    await w.increaseTime(TENOR);
    const t = w.token;
    await t.write.requestRedemption([units("20000000")], { account: w.w.inv1.account });
    return decision(
      await w.send(() =>
        t.write.confirmSettlement([1n, units("20000001"), id("pay")], {
          account: w.w.settlement.account,
        }),
      ),
    );
  },
  S23: async (c) => {
    const w = await network.networkHelpers.loadFixture(issuedFixtures[c]);
    return relayedTransfer(w);
  },
  S24: async (c) => {
    const w = await network.networkHelpers.loadFixture(published[c]);
    await w.attestShariahStatus(STATUS.NOT_ENDORSED);
    return decision(await w.issueDefaultTranche());
  },
  S25: async (c) => {
    if (c === "B0") return { decision: "N/A", reason: "NO_LIFECYCLE_SUSPENSION" };
    const w = await network.networkHelpers.loadFixture(issuedFixtures[c]);
    await w.engine.write.suspend([id("DISPUTE")], { account: w.w.governor3.account });
    return relayedTransfer(w);
  },
  S26: async (c) => {
    const w = await network.networkHelpers.loadFixture(issuedFixtures[c]);
    await w.increaseTime(TENOR);
    return decision(await w.transfer("inv1", "inv3", units("1000")));
  },
  // Supplementary scenarios. No relayer re-nominates the witness.
  G01: async (c) => {
    const w = await network.networkHelpers.loadFixture(issuedFixtures[c]);
    const witness = w.hasEvidence ? await w.engine.read.witnessAssetId() : assetId(NON_DEBT[0]);
    const label = ASSET_LABELS.find((l) => assetId(l) === witness)!;
    await w.attestValuation(label, 0n);
    return decision(await w.transfer("inv1", "inv3", units("1000")));
  },
  G02: async (c) => {
    const w = await network.networkHelpers.loadFixture(issuedFixtures[c]);
    const witness = w.hasEvidence ? await w.engine.read.witnessAssetId() : assetId(NON_DEBT[0]);
    const label = ASSET_LABELS.find((l) => assetId(l) === witness)!;
    await w.attestClassification(label, CLASS.DEBT);
    return decision(await w.transfer("inv1", "inv3", units("1000")));
  },
  G03: async (c) => {
    const w = await network.networkHelpers.loadFixture(issuedFixtures[c]);
    for (const a of ASSETS) await w.attestValuation(a.label, units(a.value) / 100n);
    return decision(await w.transfer("inv1", "inv3", units("1000")));
  },
  G04: async (c) => {
    const w = await network.networkHelpers.loadFixture(issuedFixtures[c]);
    // TRANCHE-1 allocated 25m to the ijarah asset; its value is cut to 20m.
    await w.attestValuation("ASSET-IJARAH-001", units("20000000"));
    const t = await w.buildTranche("G04", units("1000"), {
      "ASSET-IJARAH-001": units("1000"),
    });
    return decision(await w.issue(await w.issueEvidence(t), { inv2: units("1000") }));
  },
};

const ASSET_LABELS = ASSETS.map((a) => a.label);

describe("Scenario oracle across B0, B1, B2 and B2F", function () {
  it("replays every scenario and writes the decision matrix", async function () {
    const oracle = parseCsv(
      await readFile(new URL("../fixtures/test_oracle.csv", import.meta.url), "utf8"),
    );
    const results: string[] = [
      "scenario_id,set,test_id,operation,config,expected_design,expected_sukuk_policy,actual,actual_reason,expected_reason_B2,matches_design,matches_sukuk_policy",
    ];
    const mismatches: string[] = [];

    for (const row of oracle) {
      const run = scenarios[row.scenario_id];
      assert.ok(run, `no implementation for ${row.scenario_id}`);
      for (const config of CONFIGS) {
        const actual = await run(config);
        const expectedDesign = row[`expected_${config}`] as Decision;
        const expectedPolicy = row.expected_policy as Decision;
        const matchesDesign = actual.decision === expectedDesign;
        const matchesPolicy =
          actual.decision === "N/A" ? "n/a" : String(actual.decision === expectedPolicy);
        if (!matchesDesign) {
          mismatches.push(`${row.scenario_id}/${config}: expected ${expectedDesign}, got ${actual.decision} (${actual.reason})`);
        }
        if (isShariahConfig(config) && actual.decision === "DENY") {
          assert.equal(actual.reason, row.expected_reason_B2, `${row.scenario_id} reason`);
        }
        results.push(
          [
            row.scenario_id,
            row.set,
            row.test_id,
            row.operation,
            config,
            expectedDesign,
            expectedPolicy,
            actual.decision,
            actual.reason,
            row.expected_reason_B2,
            String(matchesDesign),
            matchesPolicy,
          ].join(","),
        );
      }
    }

    // Summary against the sukuk policy oracle (decisions that apply only),
    // per scenario set. Columns: 0 id, 1 set, 4 config, 6 policy, 7 actual,
    // 10 matches design.
    const summary = ["set,config,scenarios_applicable,agree,false_accept,false_reject,design_conformance"];
    for (const set of ["primary", "supplementary"]) {
      for (const config of CONFIGS) {
        const rows = results
          .slice(1)
          .map((r) => r.split(","))
          .filter((r) => r[1] === set && r[4] === config);
        const applicable = rows.filter((r) => r[7] !== "N/A");
        const agree = applicable.filter((r) => r[7] === r[6]).length;
        const falseAccept = applicable.filter((r) => r[6] === "DENY" && r[7] === "ALLOW").length;
        const falseReject = applicable.filter((r) => r[6] === "ALLOW" && r[7] === "DENY").length;
        const design = rows.filter((r) => r[10] === "true").length;
        summary.push(
          [set, config, applicable.length, agree, falseAccept, falseReject, `${design}/${rows.length}`].join(","),
        );
      }
    }

    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(new URL("decision_matrix.csv", OUT_DIR), results.join("\n") + "\n");
    await writeFile(new URL("decision_summary.csv", OUT_DIR), summary.join("\n") + "\n");
    console.log(summary.join("\n"));
    assert.deepEqual(mismatches, []);
  });
});
