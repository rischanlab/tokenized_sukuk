import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";

import { CLASS, STATUS, units } from "./helpers.js";
import { assetId, deployWorld, type World } from "./environment.js";

const network = await hre.network.create();

async function b2Fixture(): Promise<World> {
  return deployWorld(network, "B2");
}
async function b2Issued(): Promise<World> {
  const world = await deployWorld(network, "B2");
  await world.publishPortfolio();
  const issued = await world.issueDefaultTranche();
  assert.equal(issued.ok, true, issued.error);
  return world;
}

/** Issues TRANCHE-X with the given non-debt amount out of 100m proceeds. */
async function issueWithNonDebt(world: World, nonDebt: bigint, label = "TRANCHE-X") {
  const proceeds = units("100000000");
  const tranche = await world.buildTranche(label, proceeds, {
    "ASSET-IJARAH-001": nonDebt,
    "ASSET-MURABAHAH-003": proceeds - nonDebt > units("80000000")
      ? units("80000000")
      : proceeds - nonDebt,
  });
  const evidence = await world.issueEvidence(tranche);
  return world.issue(evidence, { inv1: proceeds });
}

describe("Shariah issuance and tradability rules (B2)", function () {
  it("T01: allows issuance with valid credentials and >= 33% non-debt allocation", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    await world.publishPortfolio();
    const outcome = await world.issueDefaultTranche();
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(await world.token.read.totalSupply(), units("100000000"));
    const record = await world.engine.read.tranches([
      (await world.buildTranche("TRANCHE-1", 0n, {})).trancheId,
    ]);
    assert.equal(record[1], units("35000000")); // non-debt allocated
    assert.equal(record[2], 1); // policy version recorded
  });

  it("T01 boundary: exactly 33.00% non-debt is allowed", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    await world.publishPortfolio();
    // 25m from IJARAH + 8m from MUSHARAKAH = 33m of 100m
    const proceeds = units("100000000");
    const tranche = await world.buildTranche("TRANCHE-B", proceeds, {
      "ASSET-IJARAH-001": units("25000000"),
      "ASSET-MUSHARAKAH-002": units("8000000"),
      "ASSET-MURABAHAH-003": units("67000000"),
    });
    const outcome = await world.issue(await world.issueEvidence(tranche), {
      inv1: proceeds,
    });
    assert.equal(outcome.ok, true, outcome.error);
  });

  it("T02: denies issuance when the non-debt share is below 33% (32.99%)", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    await world.publishPortfolio();
    // 24.99m non-debt out of 100m proceeds (the remainder is only partly
    // allocated, which the engine permits): ratio 24.99% < 33%.
    const outcome = await issueWithNonDebt(world, units("24990000"), "T02");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "NON_DEBT_RATIO_BELOW_MINIMUM");

    const proceeds = units("100000000");
    const tranche = await world.buildTranche("T02b", proceeds, {
      "ASSET-IJARAH-001": units("25000000"),
      "ASSET-MUSHARAKAH-002": units("7990000"),
      "ASSET-MURABAHAH-003": units("67010000"),
    });
    const boundary = await world.issue(await world.issueEvidence(tranche), {
      inv1: proceeds,
    });
    assert.equal(boundary.ok, false);
    assert.equal(boundary.reason, "NON_DEBT_RATIO_BELOW_MINIMUM");
    assert.equal(await world.token.read.totalSupply(), 0n);
  });

  it("T02: a debt-classified asset does not count towards the non-debt share", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    await world.publishPortfolio();
    // Reclassify MUSHARAKAH as debt; 25m + 10m would otherwise be 35%.
    await world.attestClassification("ASSET-MUSHARAKAH-002", CLASS.DEBT);
    const outcome = await world.issueDefaultTranche();
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "NON_DEBT_RATIO_BELOW_MINIMUM");
  });

  it("T03: share falls below 33% after issuance but a non-debt component remains: transfers stay allowed", async function () {
    const world = await network.networkHelpers.loadFixture(b2Issued);
    // Non-debt assets written down to 5m of a 85m portfolio (~5.9%).
    await world.attestValuation("ASSET-IJARAH-001", units("5000000"));
    await world.attestValuation("ASSET-MUSHARAKAH-002", 0n);
    // The relayer that submits the update also re-nominates a witness.
    assert.equal(await world.refreshWitness(), true);
    const outcome = await world.transfer("inv1", "inv3", units("1000"));
    assert.equal(outcome.ok, true, outcome.error);
  });

  it("T03 liveness: if the witness is invalidated and not re-nominated, transfers fail closed", async function () {
    const world = await network.networkHelpers.loadFixture(b2Issued);
    const witness = await world.engine.read.witnessAssetId();
    const label = witness === assetId("ASSET-IJARAH-001")
      ? "ASSET-IJARAH-001"
      : "ASSET-MUSHARAKAH-002";
    await world.attestValuation(label, 0n);
    // Another non-debt asset is still eligible, but nobody re-nominated it.
    const denied = await world.transfer("inv1", "inv3", units("1"));
    assert.equal(denied.reason, "NON_DEBT_COMPONENT_UNVERIFIED");
    assert.equal(await world.refreshWitness(), true);
    assert.equal((await world.transfer("inv1", "inv3", units("1"))).ok, true);
  });

  it("T04: transfers are denied when the non-debt component disappears", async function () {
    const world = await network.networkHelpers.loadFixture(b2Issued);
    // Non-debt assets disposed: valuer attests zero value for both.
    await world.attestValuation("ASSET-IJARAH-001", 0n);
    await world.attestValuation("ASSET-MUSHARAKAH-002", 0n);
    assert.equal(await world.refreshWitness(), false);
    const outcome = await world.transfer("inv1", "inv3", units("1000"));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "NON_DEBT_COMPONENT_UNVERIFIED");
    // The debt asset alone cannot serve as the witness under B2.
    const debtWitness = await world.send(() =>
      world.engine.write.setWitness([assetId("ASSET-MURABAHAH-003")]),
    );
    assert.equal(debtWitness.ok, false);
  });

  it("T04: transfers resume when a new non-debt asset is evidenced and set as witness", async function () {
    const world = await network.networkHelpers.loadFixture(b2Issued);
    await world.attestValuation("ASSET-IJARAH-001", 0n);
    await world.attestValuation("ASSET-MUSHARAKAH-002", 0n);
    assert.equal((await world.transfer("inv1", "inv3", units("1"))).ok, false);
    await world.attestValuation("ASSET-MUSHARAKAH-002", units("2000000"));
    assert.equal(await world.refreshWitness(), true);
    assert.equal((await world.transfer("inv1", "inv3", units("1"))).ok, true);
  });

  it("requires a current Shariah status attestation for issuance and transfer", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    await world.publishPortfolio();
    await world.attestShariahStatus(STATUS.NOT_ENDORSED);
    const denied = await world.issueDefaultTranche();
    assert.equal(denied.reason, "SHARIAH_STATUS_INVALID");
    await world.attestShariahStatus(STATUS.ENDORSED);
    assert.equal((await world.issueDefaultTranche()).ok, true);
    await world.revoke("", 5, "shariah");
    const transfer = await world.transfer("inv1", "inv3", units("1"));
    assert.equal(transfer.reason, "SHARIAH_STATUS_INVALID");
  });
});
