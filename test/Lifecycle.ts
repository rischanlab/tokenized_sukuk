import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";

import { CLAIM, CLASS, DAY, POLICY_B2, STATUS, TENOR, id, units } from "./helpers.js";
import { CONFIGS, assetId, deployWorld, type ConfigName, type World } from "./environment.js";

const network = await hre.network.create();

async function issued(config: ConfigName): Promise<World> {
  const world = await deployWorld(network, config);
  await world.publishPortfolio(30n * DAY);
  const outcome = await world.issueDefaultTranche();
  assert.equal(outcome.ok, true, outcome.error);
  return world;
}
const b0Issued = () => issued("B0");
const b1Issued = () => issued("B1");
const b2Issued = () => issued("B2");
const b2fIssued = () => issued("B2F");
const fixtures: Record<ConfigName, () => Promise<World>> = {
  B0: b0Issued,
  B1: b1Issued,
  B2: b2Issued,
  B2F: b2fIssued,
};

async function b2Fixture(): Promise<World> {
  return deployWorld(network, "B2");
}

describe("Conflicts and double counting (RQ1, RQ3)", function () {
  it("T08: conflicting encumbrance evidence is flagged and the asset stops counting", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    await world.publishPortfolio();
    // Legal verifier says unencumbered (publishPortfolio); custodian says encumbered.
    const tx = world.registry.write.submitAttestation(
      await (async () => {
        const att = await world.buildAttestation({
          claimType: CLAIM.ENCUMBRANCE,
          subjectId: assetId("ASSET-IJARAH-001"),
          flag: true,
        });
        return [att, world.w.custodian.account.address, await world.sign("custodian", att)];
      })(),
    );
    await world.viem.assertions.emit(tx, world.registry, "EvidenceConflict");
    assert.equal(
      await world.registry.read.backingEligible([assetId("ASSET-IJARAH-001"), true]),
      false,
    );
    // Without IJARAH the default tranche lists an ineligible asset.
    const outcome = await world.issueDefaultTranche();
    assert.equal(outcome.reason, "ALLOCATION_INVALID");
  });

  it("T08: an encumbrance notice stays effective after it expires (negative evidence)", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    await world.publishPortfolio(30n * DAY);
    await world.attestEncumbrance("ASSET-IJARAH-001", true);
    await world.increaseTime(8n * DAY);
    assert.equal(await world.registry.read.isEncumbered([assetId("ASSET-IJARAH-001")]), true);
    await world.attestEncumbrance("ASSET-IJARAH-001", false);
    assert.equal(await world.registry.read.isEncumbered([assetId("ASSET-IJARAH-001")]), false);
  });

  it("T08 / I5: the same asset cannot back more than its attested value", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    await world.publishPortfolio();
    assert.equal((await world.issueDefaultTranche()).ok, true); // uses 25m of IJARAH
    const second = await world.buildTranche("TRANCHE-2", units("10"), {
      "ASSET-IJARAH-001": units("10"), // already fully allocated
    });
    const outcome = await world.issue(await world.issueEvidence(second), { inv1: units("10") });
    assert.equal(outcome.reason, "ALLOCATION_INVALID");
  });

  it("I5: an unsorted or duplicated allocation is rejected", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    await world.publishPortfolio();
    const a = assetId("ASSET-IJARAH-001");
    const tranche = await world.buildTranche("DUP", units("20"), {}, {
      assetIds: [a, a],
      amounts: [units("10"), units("10")],
    });
    const outcome = await world.issue(await world.issueEvidence(tranche), { inv1: units("20") });
    assert.equal(outcome.reason, "ALLOCATION_INVALID");
  });

  it("I5: an allocation larger than the proceeds is rejected, and only the bound token can request authorisation", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    await world.publishPortfolio();
    const over = await world.buildTranche("OVER", units("10"), {
      "ASSET-IJARAH-001": units("8"),
      "ASSET-MUSHARAKAH-002": units("8"),
    });
    const outcome = await world.issue(await world.issueEvidence(over), { inv1: units("10") });
    assert.equal(outcome.reason, "ALLOCATION_INVALID");
    // Calling the engine directly, or binding it to a second token, is refused.
    const direct = await world.send(() => world.engine.write.authorizeIssuance(["0x", units("10")]));
    assert.equal(direct.reason, "OnlyToken");
    const rebind = await world.send(() => world.engine.write.bindToken([world.w.attacker.account.address]));
    assert.equal(rebind.reason, "AlreadyBound");
  });
});

describe("Identity and transfer paths (RQ2, I7)", function () {
  for (const config of CONFIGS) {
    it(`T09: transfer to a non-allowlisted wallet is denied under ${config}`, async function () {
      const world = await network.networkHelpers.loadFixture(fixtures[config]);
      const outcome = await world.transfer("inv1", "outsider", units("1"));
      assert.equal(outcome.reason, "RECEIVER_NOT_VERIFIED");
      assert.equal((await world.transfer("inv1", "inv3", units("1"))).ok, true);
    });
  }

  it("I7: transferFrom is subject to the same checks as transfer", async function () {
    const world = await network.networkHelpers.loadFixture(b2Issued);
    await world.token.write.approve([world.w.inv2.account.address, units("5")], {
      account: world.w.inv1.account,
    });
    await world.engine.write.suspend([id("DISPUTE")]);
    const outcome = await world.send(() =>
      world.token.write.transferFrom(
        [world.w.inv1.account.address, world.w.inv3.account.address, units("5")],
        { account: world.w.inv2.account },
      ),
    );
    assert.equal(outcome.reason, "INSTRUMENT_SUSPENDED");
  });

  it("I7: issuance is possible only through the authorised issue path and to verified wallets", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    await world.publishPortfolio();
    // Non-agent cannot issue.
    const t = await world.buildTranche("I7", units("100"), { "ASSET-IJARAH-001": units("100") });
    const ev = await world.issueEvidence(t);
    const byInvestor = await world.issue(ev, { inv1: units("100") }, "inv1");
    assert.equal(byInvestor.reason, "AccessControlUnauthorizedAccount");
    // Agent cannot mint to an unverified wallet even with valid evidence.
    const toOutsider = await world.issue(ev, { outsider: units("100") });
    assert.equal(toOutsider.reason, "RECEIVER_NOT_VERIFIED");
    // Amount must equal the attested proceeds.
    const mismatch = await world.issue(ev, { inv1: units("101") });
    assert.equal(mismatch.reason, "TRANCHE_AMOUNT_MISMATCH");
  });

  it("I7/I8: forced transfer needs an agent, a justification and a verified receiver, and is logged", async function () {
    const world = await network.networkHelpers.loadFixture(b2Issued);
    const inv1 = world.w.inv1.account.address;
    const inv3 = world.w.inv3.account.address;
    const noJustification = await world.send(() =>
      world.token.write.forcedTransfer([inv1, inv3, units("1"), `0x${"0".repeat(64)}`]),
    );
    assert.equal(noJustification.reason, "JustificationRequired");
    const toOutsider = await world.send(() =>
      world.token.write.forcedTransfer([
        inv1,
        world.w.outsider.account.address,
        units("1"),
        id("court-order-001"),
      ]),
    );
    assert.equal(toOutsider.reason, "RECEIVER_NOT_VERIFIED");
    // The forced path bypasses the Shariah tradability rule by design (as in
    // ERC-3643); it remains available while ordinary transfers are suspended.
    await world.engine.write.suspend([id("DISPUTE")]);
    const tx = world.token.write.forcedTransfer([inv1, inv3, units("1"), id("court-order-001")]);
    await world.viem.assertions.emit(tx, world.token, "ForcedTransfer");
  });
});

describe("Agent controls inherited from the regulated-token baseline (RQ2)", function () {
  for (const config of CONFIGS) {
    it(`the compliance contract binds once, to a non-zero token, under ${config}`, async function () {
      const world = await network.networkHelpers.loadFixture(fixtures[config]);
      const zero = await world.send(() =>
        world.compliance.write.bindToken(["0x0000000000000000000000000000000000000000"]),
      );
      assert.equal(zero.reason, "ZeroAddress");
      const again = await world.send(() => world.compliance.write.bindToken([world.w.attacker.account.address]));
      assert.equal(again.reason, "AlreadyBound");
      const stranger = await world.send(() =>
        world.compliance.write.bindToken([world.w.attacker.account.address], { account: world.w.attacker.account }),
      );
      assert.equal(stranger.reason, "AlreadyBound");
    });

    it(`pause, freeze and identity removal or expiry deny transfers under ${config}`, async function () {
      const world = await network.networkHelpers.loadFixture(fixtures[config]);
      await world.token.write.pause();
      assert.equal((await world.transfer("inv1", "inv2", units("1"))).reason, "TOKEN_PAUSED");
      await world.token.write.unpause();
      await world.token.write.setFrozen([world.w.inv1.account.address, true]);
      assert.equal((await world.transfer("inv1", "inv2", units("1"))).reason, "WALLET_FROZEN");
      assert.equal((await world.transfer("inv2", "inv1", units("1"))).reason, "WALLET_FROZEN");
      await world.token.write.setFrozen([world.w.inv1.account.address, false]);
      assert.equal((await world.transfer("inv1", "inv2", units("1"))).ok, true);
      // Only an agent can use these controls.
      const byInvestor = await world.send(() => world.token.write.pause({ account: world.w.inv1.account }));
      assert.equal(byInvestor.reason, "AccessControlUnauthorizedAccount");
      // Removing an identity, or letting eligibility lapse, makes the wallet ineligible to receive.
      await world.identity.write.removeIdentity([world.w.inv2.account.address]);
      assert.equal((await world.transfer("inv1", "inv2", units("1"))).reason, "RECEIVER_NOT_VERIFIED");
      const now = await world.now();
      await world.identity.write.registerIdentity([world.w.inv3.account.address, 458, now + 10n]);
      assert.equal((await world.transfer("inv1", "inv3", units("1"))).ok, true);
      await world.increaseTime(20n);
      assert.equal((await world.transfer("inv1", "inv3", units("1"))).reason, "RECEIVER_NOT_VERIFIED");
    });
  }
});

describe("Governance and lifecycle (RQ3, I3, I8)", function () {
  it("T10: a policy update without quorum, before the timelock or by a non-governor is rejected", async function () {
    const world = await network.networkHelpers.loadFixture(b2Issued);
    const next = { ...POLICY_B2, version: 2, minNonDebtBps: 5000, policyDocHash: id("v2") };
    const byOutsider = await world.send(() =>
      world.engine.write.proposePolicy([next], { account: world.w.attacker.account }),
    );
    assert.equal(byOutsider.reason, "NotGovernor");

    await world.engine.write.proposePolicy([next]);
    const proposalId = 1n;
    await world.engine.write.approvePolicy([proposalId]);
    const noQuorum = await world.send(() => world.engine.write.activatePolicy([proposalId]));
    assert.equal(noQuorum.reason, "QuorumNotReached");
    const dup = await world.send(() => world.engine.write.approvePolicy([proposalId]));
    assert.equal(dup.reason, "AlreadyApproved");

    await world.engine.write.approvePolicy([proposalId], { account: world.w.governor2.account });
    const early = await world.send(() => world.engine.write.activatePolicy([proposalId]));
    assert.equal(early.reason, "TimelockActive");
    assert.equal((await world.engine.read.activePolicy())[0], 1);
  });

  it("T10: an approved update applies after the timelock, only prospectively, and fails closed until re-attested", async function () {
    const world = await network.networkHelpers.loadFixture(b2Issued);
    const trancheId = id("TRANCHE-1");
    const next = { ...POLICY_B2, version: 2, policyDocHash: id("v2") };
    await world.engine.write.proposePolicy([next]);
    await world.engine.write.approvePolicy([1n]);
    await world.engine.write.approvePolicy([1n], { account: world.w.governor2.account });
    await world.increaseTime(DAY);
    const activated = await world.send(() => world.engine.write.activatePolicy([1n]));
    assert.equal(activated.ok, true);
    assert.equal((await world.engine.read.activePolicy())[0], 2);
    // The recorded tranche keeps the version in force when it was issued.
    assert.equal((await world.engine.read.tranches([trancheId]))[2], 1);
    // Classification and Shariah status were attested under v1: fail closed.
    assert.equal(
      (await world.transfer("inv1", "inv3", units("1"))).reason,
      "SHARIAH_STATUS_INVALID",
    );
    await world.attestShariahStatus(STATUS.ENDORSED, 2);
    assert.equal(
      (await world.transfer("inv1", "inv3", units("1"))).reason,
      "NON_DEBT_COMPONENT_UNVERIFIED",
    );
    await world.attestClassification("ASSET-IJARAH-001", CLASS.NON_DEBT, 2);
    assert.equal(await world.refreshWitness(["ASSET-IJARAH-001"]), true);
    assert.equal((await world.transfer("inv1", "inv3", units("1"))).ok, true);
  });

  it("T10: malformed proposals, closed proposals and tranches bound to another policy version are rejected", async function () {
    const world = await network.networkHelpers.loadFixture(b2Issued);
    const skip = await world.send(() => world.engine.write.proposePolicy([{ ...POLICY_B2, version: 3 }]));
    assert.equal(skip.reason, "InvalidPolicy");
    const over = await world.send(() => world.engine.write.proposePolicy([{ ...POLICY_B2, version: 2, minNonDebtBps: 10001 }]));
    assert.equal(over.reason, "InvalidPolicy");
    const unknown = await world.send(() => world.engine.write.approvePolicy([99n]));
    assert.equal(unknown.reason, "ProposalClosed");
    // A tranche signed for a version other than the active one is not authorised.
    const t = await world.buildTranche("V2-TRANCHE", units("100"), { "ASSET-IJARAH-001": units("100") }, { policyVersion: 2 });
    const out = await world.issue(await world.issueEvidence(t), { inv3: units("100") });
    assert.equal(out.reason, "TRANCHE_POLICY_MISMATCH");
    // An executed proposal cannot be approved or activated again.
    await world.engine.write.proposePolicy([{ ...POLICY_B2, version: 2, policyDocHash: id("v2") }]);
    await world.engine.write.approvePolicy([1n]);
    await world.engine.write.approvePolicy([1n], { account: world.w.governor2.account });
    await world.increaseTime(DAY);
    await world.engine.write.activatePolicy([1n]);
    const again = await world.send(() => world.engine.write.activatePolicy([1n]));
    assert.equal(again.reason, "ProposalClosed");
  });

  it("suspension cannot be stacked, and resume votes do not carry over to a later suspension", async function () {
    const world = await network.networkHelpers.loadFixture(b2Issued);
    const notSuspended = await world.send(() => world.engine.write.approveResume());
    assert.equal(notSuspended.reason, "NotSuspended");
    await world.engine.write.suspend([id("FIRST")]);
    const twice = await world.send(() => world.engine.write.suspend([id("AGAIN")], { account: world.w.governor2.account }));
    assert.equal(twice.reason, "AlreadySuspended");
    await world.engine.write.approveResume();
    const dup = await world.send(() => world.engine.write.approveResume());
    assert.equal(dup.reason, "AlreadyApproved");
    await world.engine.write.approveResume([], { account: world.w.governor2.account });
    assert.equal((await world.transfer("inv1", "inv3", units("1"))).ok, true);
    // New suspension epoch: one fresh vote is not enough.
    await world.engine.write.suspend([id("SECOND")]);
    await world.engine.write.approveResume([], { account: world.w.governor3.account });
    assert.equal((await world.transfer("inv1", "inv3", units("1"))).reason, "INSTRUMENT_SUSPENDED");
  });

  it("suspension by one governor halts transfers and issuance; resumption needs a quorum", async function () {
    const world = await network.networkHelpers.loadFixture(b2Issued);
    const tx = world.engine.write.suspend([id("SUSPECTED_KEY_COMPROMISE")], {
      account: world.w.governor3.account,
    });
    await world.viem.assertions.emit(tx, world.engine, "InstrumentSuspended");
    assert.equal((await world.transfer("inv1", "inv3", units("1"))).reason, "INSTRUMENT_SUSPENDED");
    await world.engine.write.approveResume();
    assert.equal((await world.transfer("inv1", "inv3", units("1"))).reason, "INSTRUMENT_SUSPENDED");
    await world.engine.write.approveResume([], { account: world.w.governor2.account });
    assert.equal((await world.transfer("inv1", "inv3", units("1"))).ok, true);
  });
});

describe("Maturity, redemption and obligations (T13, I6)", function () {
  for (const config of CONFIGS) {
    it(`T13: partial redemption with pending obligations keeps accounting consistent under ${config}`, async function () {
      const world = await network.networkHelpers.loadFixture(fixtures[config]);
      const t = world.token;
      const early = await world.send(() =>
        t.write.requestRedemption([units("1")], { account: world.w.inv1.account }),
      );
      assert.equal(early.reason, "NotMatured");

      await world.increaseTime(TENOR);
      assert.equal((await world.transfer("inv1", "inv3", units("1"))).reason, "INSTRUMENT_MATURED");

      // inv1 redeems 20m of 60m: burned and recorded as pending.
      await t.write.requestRedemption([units("20000000")], { account: world.w.inv1.account });
      // Cannot redeem more than the remaining balance (no double redemption).
      const over = await world.send(() =>
        t.write.requestRedemption([units("40000001")], { account: world.w.inv1.account }),
      );
      assert.equal(over.reason, "ERC20InsufficientBalance");

      const settle = (amount: bigint) =>
        world.send(() =>
          t.write.confirmSettlement([1n, amount, id("payment-ref")], {
            account: world.w.settlement.account,
          }),
        );
      assert.equal((await settle(units("5000000"))).ok, true);
      assert.equal((await settle(units("15000001"))).reason, "InvalidRedemption");
      const unauthorised = await world.send(() =>
        t.write.confirmSettlement([1n, units("1"), id("x")], { account: world.w.inv1.account }),
      );
      assert.equal(unauthorised.reason, "AccessControlUnauthorizedAccount");

      const supply = await t.read.totalSupply();
      const pending = await t.read.pendingRedemptionUnits();
      const settled = await t.read.settledRedemptionUnits();
      const issuedUnits = await t.read.totalIssued();
      assert.equal(pending, units("15000000"));
      assert.equal(settled, units("5000000"));
      assert.equal(supply + pending + settled, issuedUnits);
    });
  }
});
