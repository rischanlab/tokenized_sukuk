import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";

import { CLAIM, CLASS, DAY, STATUS, id, units } from "./helpers.js";
import { ASSETS, assetId, deployWorld, type ConfigName, type World } from "./environment.js";

/**
 * Scope boundaries of the controls: behaviour that the encoded rule does not
 * address (aggregate coverage, pledges outside the instrument), the witness
 * fallback variant (B2F), the minimum evidence needed to keep transfers live,
 * and the privileged forced-transfer path. These tests document what the
 * contracts do; several of them record limitations rather than protections.
 */

const network = await hre.network.create();

async function issued(config: ConfigName, validFor?: bigint): Promise<World> {
  const world = await deployWorld(network, config);
  await world.publishPortfolio(validFor);
  const outcome = await world.issueDefaultTranche();
  assert.equal(outcome.ok, true, outcome.error);
  return world;
}
const b2Issued = () => issued("B2");
const b2fIssued = () => issued("B2F");
const fixtures: Partial<Record<ConfigName, () => Promise<World>>> = { B2: b2Issued, B2F: b2fIssued };

async function labelOf(world: World, asset: `0x${string}`): Promise<string> {
  return ASSETS.map((a) => a.label).find((l) => assetId(l) === asset)!;
}

describe("Scope boundaries of the evidence and policy controls", function () {
  it("T15: no-double-counting is scoped to one instrument; a second instrument can pledge the same asset", async function () {
    const first = await deployWorld(network, "B2");
    const second = await deployWorld(network, "B2", id("SYN-SUKUK-WAKALAH-002"));
    for (const world of [first, second]) {
      await world.publishPortfolio();
      assert.equal((await world.issueDefaultTranche()).ok, true);
    }
    // Each engine records 25m against the ijarah asset, whose attested value
    // in each registry is 25m: 50m is pledged against one 25m asset.
    const ijarah = assetId("ASSET-IJARAH-001");
    assert.equal(await first.engine.read.allocated([ijarah]), units("25000000"));
    assert.equal(await second.engine.read.allocated([ijarah]), units("25000000"));
    assert.equal(await first.registry.read.assetValue([ijarah]), units("25000000"));
    // Within one instrument the same allocation is rejected (invariant I5).
    const again = await first.buildTranche("T15-AGAIN", units("1"), { "ASSET-IJARAH-001": units("1") });
    assert.equal((await first.issue(await first.issueEvidence(again), { inv2: units("1") })).reason, "ALLOCATION_INVALID");
  });

  for (const config of ["B2", "B2F"] as ConfigName[]) {
    it(`T16: transfers do not test aggregate coverage; allocation capacity follows current value (${config})`, async function () {
      const world = await network.networkHelpers.loadFixture(fixtures[config]!);
      // Attested values fall to 1%: 1.2m of assets against 100m outstanding.
      for (const a of ASSETS) await world.attestValuation(a.label, units(a.value) / 100n);
      assert.equal((await world.transfer("inv1", "inv3", units("1000"))).ok, true);
      // The ijarah asset already carries 25m; its value is now 250,000.
      const t = await world.buildTranche("T16", units("1"), { "ASSET-IJARAH-001": units("1") });
      assert.equal((await world.issue(await world.issueEvidence(t), { inv2: units("1") })).reason, "ALLOCATION_INVALID");
    });
  }

  it("T03-F: B2F permits transfers without re-nomination while another non-debt asset is eligible", async function () {
    const world = await network.networkHelpers.loadFixture(b2fIssued);
    assert.equal(await world.engine.read.candidateCount(), 3n);
    const witness = await world.engine.read.witnessAssetId();
    await world.attestValuation(await labelOf(world, witness), 0n);
    const viaScan = await world.transfer("inv1", "inv3", units("1000"));
    assert.equal(viaScan.ok, true);
    // The scan is a view: the stored witness is unchanged.
    assert.equal(await world.engine.read.witnessAssetId(), witness);
    // Once no candidate is non-debt-eligible, B2F denies as B2 does.
    for (const label of ["ASSET-IJARAH-001", "ASSET-MUSHARAKAH-002"]) {
      await world.attestValuation(label, 0n);
    }
    assert.equal((await world.transfer("inv1", "inv3", units("1"))).reason, "NON_DEBT_COMPONENT_UNVERIFIED");
    // The murabahah asset is a candidate but, being debt, cannot satisfy the
    // continuing condition through the scan.
    // Re-attestation and re-nomination restore the constant-cost path.
    await world.attestValuation("ASSET-MUSHARAKAH-002", units("15000000"));
    assert.equal(await world.refreshWitness(), true);
    assert.equal(await world.engine.read.witnessAssetId(), assetId("ASSET-MUSHARAKAH-002"));
    assert.equal((await world.transfer("inv1", "inv3", units("1"))).ok, true);
  });

  it("T03-F: the B2F candidate list records first allocations only and stops at 32 assets", async function () {
    const world = await network.networkHelpers.loadFixture(b2fIssued);
    const allocation: Record<string, bigint> = {};
    for (let j = 0; j < 31; ++j) {
      const label = `CAP-ASSET-${j}`;
      await world.attestRights(label, false, "legal");
      await world.attestValuation(label, units("10"));
      await world.attestClassification(label, CLASS.NON_DEBT);
      allocation[label] = units("1");
    }
    // Re-allocating to a fixture asset must not add a duplicate candidate.
    allocation["ASSET-MURABAHAH-003"] = units("1");
    const tranche = await world.buildTranche("CAP", units("32"), allocation);
    assert.equal((await world.issue(await world.issueEvidence(tranche), { inv2: units("32") })).ok, true);
    assert.equal(await world.engine.read.candidateCount(), 32n);
    assert.equal(await world.engine.read.MAX_CANDIDATES(), 32n);
  });

  for (const config of ["B2", "B2F"] as ConfigName[]) {
    it(`T21: a non-debt asset beyond the 32-entry candidate list does not keep transfers live (${config})`, async function () {
      const world = await network.networkHelpers.loadFixture(fixtures[config]!);
      // 29 further non-debt assets bring the instrument to 32 allocated assets
      // (the three fixture assets plus 29); a later tranche allocates a 33rd.
      const extra: string[] = [];
      for (let j = 0; j < 30; ++j) extra.push(`T21-ASSET-${String(j + 1).padStart(2, "0")}`);
      for (const label of extra) {
        await world.attestRights(label, false, "legal");
        await world.attestValuation(label, units("10"));
        await world.attestClassification(label, CLASS.NON_DEBT);
      }
      const first29 = Object.fromEntries(extra.slice(0, 29).map((l) => [l, units("1")]));
      const t1 = await world.buildTranche("T21-FILL", units("29"), first29);
      assert.equal((await world.issue(await world.issueEvidence(t1), { inv2: units("29") })).ok, true);
      const last = extra[29];
      const t2 = await world.buildTranche("T21-33RD", units("1"), { [last]: units("1") });
      assert.equal((await world.issue(await world.issueEvidence(t2), { inv2: units("1") })).ok, true);
      if (config === "B2F") {
        assert.equal(await world.engine.read.candidateCount(), 32n);
        for (let i = 0n; i < 32n; ++i) {
          assert.notEqual(await world.engine.read.witnessCandidates([i]), assetId(last));
        }
      }
      // Every non-debt asset except the 33rd loses its eligibility: the
      // continuing non-debt component is still present in the portfolio.
      for (const label of ["ASSET-IJARAH-001", "ASSET-MUSHARAKAH-002", ...extra.slice(0, 29)]) {
        await world.attestValuation(label, 0n);
      }
      const denied = await world.transfer("inv1", "inv3", units("1"));
      assert.equal(denied.reason, "NON_DEBT_COMPONENT_UNVERIFIED");
      // Re-nominating the 33rd asset as witness restores transfers.
      assert.equal(await world.refreshWitness([last]), true);
      assert.equal((await world.transfer("inv1", "inv3", units("1"))).ok, true);
    });
  }

  it("T17: transfers stay live when only the witness claims and the Shariah status are renewed (B2)", async function () {
    const world = await issued("B2", 7n * DAY);
    const witnessLabel = await labelOf(world, await world.engine.read.witnessAssetId());
    await world.increaseTime(6n * DAY);
    // Four renewals: rights, valuation and classification of the witness, and
    // the instrument's Shariah status.
    const spec = ASSETS.find((a) => a.label === witnessLabel)!;
    assert.equal((await world.attestRights(witnessLabel, false, "legal", 7n * DAY)).ok, true);
    assert.equal((await world.attestValuation(witnessLabel, units(spec.value), "valuer", 7n * DAY)).ok, true);
    assert.equal((await world.attestClassification(witnessLabel, CLASS.NON_DEBT, 1, "shariah", 7n * DAY)).ok, true);
    assert.equal((await world.attestShariahStatus(STATUS.ENDORSED, 1, "shariah", 7n * DAY)).ok, true);
    await world.increaseTime(3n * DAY);
    // The other two assets' claims have lapsed; transfers continue.
    assert.equal((await world.transfer("inv1", "inv3", units("1"))).ok, true);
    // New allocations to a lapsed asset are rejected.
    const other = ASSETS.find((a) => a.label !== witnessLabel && a.class === "NON_DEBT")!.label;
    const t = await world.buildTranche("T17", units("1"), { [other]: units("1") });
    assert.equal((await world.issue(await world.issueEvidence(t), { inv2: units("1") })).reason, "ALLOCATION_INVALID");
  });

  for (const config of ["B1", "B2"] as ConfigName[]) {
    it(`T19: an allocation may reach, and may not exceed, the attested value of an asset (${config})`, async function () {
      const world = await issued(config);
      await world.attestRights("EDGE-ASSET", false, "legal");
      await world.attestValuation("EDGE-ASSET", units("10"));
      await world.attestClassification("EDGE-ASSET", CLASS.NON_DEBT);
      const over = await world.buildTranche("T19-OVER", units("11"), { "EDGE-ASSET": units("10") + 1n });
      assert.equal((await world.issue(await world.issueEvidence(over), { inv2: units("11") })).reason, "ALLOCATION_INVALID");
      const exact = await world.buildTranche("T19-EXACT", units("10"), { "EDGE-ASSET": units("10") });
      assert.equal((await world.issue(await world.issueEvidence(exact), { inv2: units("10") })).ok, true);
    });

    it(`T20: allocations in one tranche may not sum to more than its proceeds (${config})`, async function () {
      const world = await issued(config);
      for (const label of ["EDGE-A", "EDGE-B"]) {
        await world.attestRights(label, false, "legal");
        await world.attestValuation(label, units("10"));
        await world.attestClassification(label, CLASS.NON_DEBT);
      }
      const over = await world.buildTranche("T20-OVER", units("10"), { "EDGE-A": units("6"), "EDGE-B": units("5") });
      assert.equal((await world.issue(await world.issueEvidence(over), { inv2: units("10") })).reason, "ALLOCATION_INVALID");
      const exact = await world.buildTranche("T20-EXACT", units("10"), { "EDGE-A": units("5"), "EDGE-B": units("5") });
      assert.equal((await world.issue(await world.issueEvidence(exact), { inv2: units("10") })).ok, true);
    });
  }

  it("T18: the agent's forced transfer bypasses the continuing-component rule and is logged (B2)", async function () {
    const world = await network.networkHelpers.loadFixture(b2Issued);
    for (const label of ["ASSET-IJARAH-001", "ASSET-MUSHARAKAH-002"]) await world.attestValuation(label, 0n);
    assert.equal(await world.refreshWitness(), false);
    assert.equal((await world.transfer("inv1", "inv3", units("1"))).reason, "NON_DEBT_COMPONENT_UNVERIFIED");
    const tx = world.token.write.forcedTransfer([
      world.w.inv1.account.address,
      world.w.inv3.account.address,
      units("1"),
      id("court-order-002"),
    ]);
    await world.viem.assertions.emitWithArgs(tx, world.token, "ForcedTransfer", [
      world.w.inv1.account.address,
      world.w.inv3.account.address,
      units("1"),
      id("court-order-002"),
      world.w.admin.account.address,
    ]);
    assert.equal(await world.token.read.balanceOf([world.w.inv3.account.address]), units("1"));
  });
});
