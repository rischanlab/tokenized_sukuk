import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";

import {
  CLAIM,
  DAY,
  INSTRUMENT_ID,
  MAX_CLAIM_VALIDITY,
  ROLE,
  evidenceDomain,
  id,
  units,
} from "./helpers.js";
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
async function b1Issued(): Promise<World> {
  const world = await deployWorld(network, "B1");
  await world.publishPortfolio();
  const issued = await world.issueDefaultTranche();
  assert.equal(issued.ok, true, issued.error);
  return world;
}

const IJARAH = "ASSET-IJARAH-001";

describe("Credential verification (RQ1)", function () {
  it("T05: rejects a claim signed by an unregistered key", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    const att = await world.buildAttestation({
      claimType: CLAIM.VALUATION,
      subjectId: assetId(IJARAH),
      amount: units("1"),
    });
    const outcome = await world.submit("attacker", att);
    assert.equal(outcome.reason, "UnauthorizedSigner");
  });

  it("T05: rejects a claim signed by a registered attestor outside its role", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    // The valuer may not attest legal rights; the wakeel may not classify.
    const rights = await world.buildAttestation({
      claimType: CLAIM.RIGHTS,
      subjectId: assetId(IJARAH),
    });
    assert.equal((await world.submit("valuer", rights)).reason, "UnauthorizedSigner");
    const cls = await world.buildAttestation({
      claimType: CLAIM.CLASSIFICATION,
      subjectId: assetId(IJARAH),
      code: 1,
      policyVersion: 1,
    });
    assert.equal((await world.submit("wakeel", cls)).reason, "UnauthorizedSigner");
  });

  it("T05: rejects an altered payload and a signature attributed to another signer", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    const att = await world.buildAttestation({
      claimType: CLAIM.VALUATION,
      subjectId: assetId(IJARAH),
      amount: units("25000000"),
    });
    const signature = await world.sign("valuer", att);
    const altered = { ...att, amount: units("95000000") };
    assert.equal(
      (await world.submit("valuer", altered, { signature })).reason,
      "InvalidSignature",
    );
    // Attacker signs, but claims the valuer's address as signer.
    const forged = await world.sign("attacker", att);
    assert.equal(
      (await world.submit("valuer", att, { signature: forged })).reason,
      "InvalidSignature",
    );
    assert.equal((await world.submit("valuer", att, { signature })).ok, true);
  });

  it("T05: an issuer-side key cannot hold an independent verification role", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    const outcome = await world.send(() =>
      world.registry.write.registerAttestor([
        world.w.wakeel.account.address,
        ROLE.LEGAL_VERIFIER,
      ]),
    );
    assert.equal(outcome.reason, "AttestorAlreadyAssigned");
  });

  it("T05: a tranche needs one wakeel and one trustee signature", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    await world.publishPortfolio();
    const tranche = await world.buildTranche("T05-T", units("100"), {
      [IJARAH]: units("100"),
    });
    const twoWakeel = await world.issueEvidence(tranche, ["wakeel", "wakeel"]);
    assert.equal((await world.issue(twoWakeel, { inv1: units("100") })).reason, "TRANCHE_INVALID");
    const withAttacker = await world.issueEvidence(tranche, ["wakeel", "attacker"]);
    assert.equal(
      (await world.issue(withAttacker, { inv1: units("100") })).reason,
      "TRANCHE_INVALID",
    );
    const valid = await world.issueEvidence(tranche, ["trustee", "wakeel"]);
    assert.equal((await world.issue(valid, { inv1: units("100") })).ok, true);
  });

  it("accepts an institutional signer that uses an EIP-1271 contract wallet", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    const wallet = await world.viem.deployContract("Mock1271Wallet", [
      world.w.legal2.account.address,
    ]);
    await world.registry.write.registerAttestor([wallet.address, ROLE.LEGAL_VERIFIER]);
    const att = await world.buildAttestation({
      claimType: CLAIM.RIGHTS,
      subjectId: assetId(IJARAH),
      code: 1,
    });
    const signature = await world.sign("legal2", att);
    const outcome = await world.submit("legal2", att, {
      signerAddress: wallet.address,
      signature,
    });
    assert.equal(outcome.ok, true, outcome.error);
    const stored = await world.registry.read.claimOf([assetId(IJARAH), CLAIM.RIGHTS]);
    assert.equal(stored.signer.toLowerCase(), wallet.address.toLowerCase());
  });
});

describe("Claim content and attestor registry (RQ1)", function () {
  it("T05: malformed claims and invalid attestor registrations are rejected", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    const asset = assetId("ASSET-IJARAH-001");
    // Classification code outside {non-debt, debt}.
    const badClass = await world.buildAttestation({ claimType: CLAIM.CLASSIFICATION, subjectId: asset, code: 7, policyVersion: 1 });
    assert.equal((await world.submit("shariah", badClass)).reason, "InvalidClaimContent");
    // Shariah status about an asset instead of the instrument.
    const badStatus = await world.buildAttestation({ claimType: CLAIM.SHARIAH_STATUS, subjectId: asset, code: 1, policyVersion: 1 });
    assert.equal((await world.submit("shariah", badStatus)).reason, "InvalidClaimContent");
    // Empty subject.
    const noSubject = await world.buildAttestation({ claimType: CLAIM.RIGHTS, subjectId: `0x${"0".repeat(64)}`, code: 1 });
    assert.equal((await world.submit("legal", noSubject)).reason, "InvalidClaimContent");
    // Unknown claim type.
    const unknownType = await world.buildAttestation({ claimType: 9, subjectId: asset });
    assert.equal((await world.submit("legal", unknownType)).reason, "InvalidClaimType");
    // Unknown role, zero address, revocation of an unknown attestor, non-governor caller.
    assert.equal((await world.registerAttestor("outsider", id("AUDITOR"))).reason, "InvalidRole");
    const zero = await world.send(() =>
      world.registry.write.registerAttestor([`0x${"0".repeat(40)}`, ROLE.VALUER]),
    );
    assert.equal(zero.reason, "UnknownAttestor");
    assert.equal((await world.revokeAttestor("outsider")).reason, "UnknownAttestor");
    const byAttacker = await world.send(() =>
      world.registry.write.registerAttestor([world.w.attacker.account.address, ROLE.VALUER], {
        account: world.w.attacker.account,
      }),
    );
    assert.equal(byAttacker.reason, "AccessControlUnauthorizedAccount");
  });
});

describe("Freshness and revocation (RQ1, RQ3)", function () {
  it("T06: rejects a claim that is already expired, future-dated or over-long", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    const now = await world.now();
    const expired = await world.buildAttestation({
      claimType: CLAIM.VALUATION,
      subjectId: assetId(IJARAH),
      amount: units("1"),
      issuedAt: now - 10n * DAY,
      validUntil: now - DAY,
    });
    assert.equal((await world.submit("valuer", expired)).reason, "InvalidTimeWindow");
    const future = await world.buildAttestation({
      claimType: CLAIM.VALUATION,
      subjectId: assetId(IJARAH),
      amount: units("1"),
      issuedAt: now + DAY,
    });
    assert.equal((await world.submit("valuer", future)).reason, "InvalidTimeWindow");
    const tooLong = await world.buildAttestation(
      { claimType: CLAIM.VALUATION, subjectId: assetId(IJARAH), amount: units("1") },
      MAX_CLAIM_VALIDITY + 1n,
    );
    assert.equal((await world.submit("valuer", tooLong)).reason, "InvalidTimeWindow");
  });

  it("T06: transfers are denied once the evidence they rely on expires (B1 and B2)", async function () {
    for (const fixture of [b1Issued, b2Issued]) {
      const world = await network.networkHelpers.loadFixture(fixture);
      assert.equal((await world.transfer("inv1", "inv3", units("1"))).ok, true);
      await world.increaseTime(7n * DAY + 1n); // default validity is 7 days
      const outcome = await world.transfer("inv1", "inv3", units("1"));
      assert.equal(outcome.ok, false);
      assert.match(outcome.reason, /SHARIAH_STATUS_INVALID|BACKING_EVIDENCE_INVALID/);
    }
  });

  it("T06: a revoked rights credential stops the asset counting as evidence", async function () {
    const world = await network.networkHelpers.loadFixture(b2Issued);
    const witness = await world.engine.read.witnessAssetId();
    const label = witness === assetId(IJARAH) ? IJARAH : "ASSET-MUSHARAKAH-002";
    const revoked = await world.revoke(label, CLAIM.RIGHTS, "legal");
    assert.equal(revoked.ok, true);
    assert.equal((await world.transfer("inv1", "inv3", units("1"))).reason, "NON_DEBT_COMPONENT_UNVERIFIED");
    // Only the signer or governance may revoke.
    const byOther = await world.revoke("ASSET-MURABAHAH-003", CLAIM.RIGHTS, "valuer");
    assert.equal(byOther.reason, "NotRevocable");
  });

  it("T07: rejects replay of the same claim and of an older sequence number", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    const att = await world.buildAttestation({
      claimType: CLAIM.VALUATION,
      subjectId: assetId(IJARAH),
      amount: units("10"),
    });
    const signature = await world.sign("valuer", att);
    assert.equal((await world.submit("valuer", att, { signature })).ok, true);
    assert.equal(
      (await world.submit("valuer", att, { signature })).reason,
      "StaleOrReplayedClaim",
    );
  });

  it("T07: rejects a claim bound to another instrument, chain or verifier contract", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    const other = await world.buildAttestation({
      claimType: CLAIM.VALUATION,
      subjectId: assetId(IJARAH),
      amount: units("10"),
      instrumentId: id("SYN-SUKUK-OTHER-002"),
    });
    assert.equal((await world.submit("valuer", other)).reason, "WrongInstrument");

    const att = await world.buildAttestation({
      claimType: CLAIM.VALUATION,
      subjectId: assetId(IJARAH),
      amount: units("10"),
    });
    const wrongChain = evidenceDomain(world.chainId + 1, world.registry.address);
    assert.equal(
      (await world.submit("valuer", att, { domain: wrongChain })).reason,
      "InvalidSignature",
    );

    // A second registry for the same instrument id (e.g. a redeployment).
    const twin = await world.viem.deployContract("EvidenceRegistry", [
      INSTRUMENT_ID,
      MAX_CLAIM_VALIDITY,
      world.w.admin.account.address,
    ]);
    const twinSig = await world.sign(
      "valuer",
      att,
      evidenceDomain(world.chainId, twin.address),
    );
    assert.equal(
      (await world.submit("valuer", att, { signature: twinSig })).reason,
      "InvalidSignature",
    );
  });

  it("T07: rejects re-use of an authorised tranche", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    await world.publishPortfolio();
    const tranche = await world.buildTranche("T07-T", units("100"), {
      [IJARAH]: units("100"),
    });
    const evidence = await world.issueEvidence(tranche);
    assert.equal((await world.issue(evidence, { inv1: units("100") })).ok, true);
    assert.equal(
      (await world.issue(evidence, { inv1: units("100") })).reason,
      "TRANCHE_REPLAYED",
    );
    assert.equal(await world.token.read.totalSupply(), units("100"));
  });

  it("T06: a tranche allocation that has expired, is over-long or has mismatched arrays is rejected", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    await world.publishPortfolio();
    const now = await world.now();
    const expired = await world.buildTranche("T06-EXP", units("100"), { [IJARAH]: units("100") }, {
      issuedAt: now - 2n * DAY,
      validUntil: now - DAY,
    });
    assert.equal((await world.issue(await world.issueEvidence(expired), { inv1: units("100") })).reason, "TRANCHE_INVALID");
    const overLong = await world.buildTranche("T06-LONG", units("100"), { [IJARAH]: units("100") }, {
      validUntil: now + MAX_CLAIM_VALIDITY + DAY,
    });
    assert.equal((await world.issue(await world.issueEvidence(overLong), { inv1: units("100") })).reason, "TRANCHE_INVALID");
    const mismatched = await world.buildTranche("T06-ARR", units("100"), { [IJARAH]: units("100") }, {
      amounts: [units("50"), units("50")],
    });
    assert.equal((await world.issue(await world.issueEvidence(mismatched), { inv1: units("100") })).reason, "TRANCHE_INVALID");
  });

  it("T11: a compromised attestor is revoked and remediated with a new key", async function () {
    const world = await network.networkHelpers.loadFixture(b2Issued);
    assert.equal((await world.transfer("inv1", "inv3", units("1"))).ok, true);

    // Compromise: all claims signed by the legal verifier stop counting.
    assert.equal((await world.revokeAttestor("legal")).ok, true);
    assert.equal(
      (await world.transfer("inv1", "inv3", units("1"))).reason,
      "NON_DEBT_COMPONENT_UNVERIFIED",
    );
    // New claims signed with the compromised key are rejected.
    const att = await world.buildAttestation({
      claimType: CLAIM.RIGHTS,
      subjectId: assetId(IJARAH),
      code: 1,
    });
    assert.equal((await world.submit("legal", att)).reason, "UnauthorizedSigner");
    // The revoked address cannot be re-registered under any role.
    assert.equal(
      (await world.registerAttestor("legal", ROLE.LEGAL_VERIFIER)).reason,
      "AttestorAlreadyAssigned",
    );

    // Remediation: a new key re-attests rights and a witness is re-nominated.
    assert.equal((await world.registerAttestor("legal2", ROLE.LEGAL_VERIFIER)).ok, true);
    await world.attestRights(IJARAH, false, "legal2");
    assert.equal(await world.refreshWitness([IJARAH]), true);
    assert.equal((await world.transfer("inv1", "inv3", units("1"))).ok, true);
  });

  it("T12: out-of-order updates in the same block cannot overwrite a newer claim", async function () {
    const world = await network.networkHelpers.loadFixture(b2Fixture);
    const subject = assetId(IJARAH);
    const newer = await world.buildAttestation({
      claimType: CLAIM.VALUATION,
      subjectId: subject,
      amount: units("30"),
      seq: 3n,
    });
    const older = await world.buildAttestation({
      claimType: CLAIM.VALUATION,
      subjectId: subject,
      amount: units("20"),
      seq: 2n,
    });
    const sigNewer = await world.sign("valuer", newer);
    const sigOlder = await world.sign("valuer", older);
    const valuer = world.w.valuer.account.address;

    await world.networkHelpers.mine(1);
    await network.provider.send("evm_setAutomine", [false]);
    const hNewer = await world.registry.write.submitAttestation([newer, valuer, sigNewer], {
      account: world.w.admin.account,
      gas: 500_000n,
    });
    const hOlder = await world.registry.write.submitAttestation([older, valuer, sigOlder], {
      account: world.w.governor2.account,
      gas: 500_000n,
    });
    await world.networkHelpers.mine(1);
    await network.provider.send("evm_setAutomine", [true]);

    const rNewer = await world.receipt(hNewer);
    const rOlder = await world.receipt(hOlder);
    assert.equal(rNewer.blockNumber, rOlder.blockNumber);
    assert.equal(rNewer.status, "success");
    assert.equal(rOlder.status, "reverted");
    assert.equal(await world.registry.read.assetValue([subject]), units("30"));
    assert.equal(await world.registry.read.lastSeq([subject, CLAIM.VALUATION]), 3n);
  });
});
