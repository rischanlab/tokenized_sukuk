import { readFileSync } from "node:fs";
import { keccak256, toBytes, type Address, type Hex } from "viem";

import {
  CLAIM,
  CLASS,
  DAY,
  GOVERNANCE_TIMELOCK,
  INSTRUMENT_ID,
  MAX_CLAIM_VALIDITY,
  OK,
  POLICY_B1,
  POLICY_B2,
  QUORUM,
  RIGHTS_TYPE,
  ROLE,
  STATUS,
  TENOR,
  decodeReason,
  encodeIssuanceEvidence,
  evidenceDomain,
  id,
  signAttestation,
  signTranche,
  sortAllocation,
  units,
  type Attestation,
  type Domain,
  type PolicyParams,
  type TrancheAllocation,
} from "./helpers.js";

export type ConfigName = "B0" | "B1" | "B2" | "B2F";
export const CONFIGS: ConfigName[] = ["B0", "B1", "B2", "B2F"];

/** Configurations that apply the Shariah rules (B2 and its fallback variant). */
export const isShariahConfig = (c: ConfigName): boolean => c === "B2" || c === "B2F";

const fixturePath = new URL(
  "../fixtures/synthetic_portfolios/wakalah_portfolio_v1.json",
  import.meta.url,
);
export const PORTFOLIO = JSON.parse(readFileSync(fixturePath, "utf8"));

export type AssetSpec = {
  label: string;
  class: "NON_DEBT" | "DEBT";
  rightsType: keyof typeof RIGHTS_TYPE;
  value: string;
};

export const ASSETS: AssetSpec[] = PORTFOLIO.assets;
export const assetId = (label: string): Hex => id(label);
export const docHash = (label: string): Hex => keccak256(toBytes(`doc:${label}`));

/** Named wallets. Index positions are fixed so runs are reproducible. */
const WALLET_NAMES = [
  "admin", // 0: deployer, token agent, governor 1, registry governor
  "governor2", // 1
  "governor3", // 2
  "wakeel", // 3
  "trustee", // 4
  "legal", // 5
  "valuer", // 6
  "custodian", // 7
  "shariah", // 8
  "settlement", // 9
  "inv1", // 10
  "inv2", // 11
  "inv3", // 12
  "outsider", // 13 (never registered as an investor)
  "attacker", // 14 (never registered as an attestor)
  "legal2", // 15 (replacement key for the legal verifier)
  "shariah2", // 16 (replacement key for the Shariah adviser)
] as const;
export type WalletName = (typeof WALLET_NAMES)[number];

export type TxOutcome = {
  ok: boolean;
  reason: string;
  gasUsed?: bigint;
  error?: string;
};

/**
 * One deployed configuration (B0, B1, B2 or B2F) of the prototype, with helpers
 * that issue signed evidence and attempt operations. Evidence helpers are
 * no-ops under B0, which has no evidence layer, so that one scenario script
 * can be replayed against all three configurations.
 */
export class World {
  readonly seq = new Map<string, bigint>();

  constructor(
    readonly config: ConfigName,
    readonly viem: any,
    readonly networkHelpers: any,
    readonly publicClient: any,
    readonly w: Record<WalletName, any>,
    readonly identity: any,
    readonly token: any,
    readonly compliance: any,
    readonly registry: any | undefined,
    readonly engine: any | undefined,
    readonly domain: Domain | undefined,
    readonly chainId: number,
    readonly instrumentId: Hex = INSTRUMENT_ID,
  ) {}

  get hasEvidence(): boolean {
    return this.config !== "B0";
  }

  get policy(): PolicyParams {
    return isShariahConfig(this.config) ? POLICY_B2 : POLICY_B1;
  }

  async now(): Promise<bigint> {
    return BigInt(await this.networkHelpers.time.latest());
  }

  async increaseTime(seconds: bigint): Promise<void> {
    await this.networkHelpers.time.increase(seconds);
  }

  nextSeq(subject: Hex, claimType: number): bigint {
    const key = `${subject}:${claimType}`;
    const next = (this.seq.get(key) ?? 0n) + 1n;
    this.seq.set(key, next);
    return next;
  }

  async receipt(hash: Hex) {
    return this.publicClient.waitForTransactionReceipt({ hash });
  }

  // -------------------------------------------------------------------------
  // Evidence
  // -------------------------------------------------------------------------

  async buildAttestation(
    fields: Partial<Attestation> & { claimType: number; subjectId: Hex },
    validFor: bigint = 7n * DAY,
  ): Promise<Attestation> {
    const now = await this.now();
    const issuedAt = fields.issuedAt ?? now;
    return {
      instrumentId: this.instrumentId,
      code: 0,
      flag: false,
      amount: 0n,
      policyVersion: 0,
      evidenceHash: docHash(fields.subjectId),
      seq: fields.seq ?? this.nextSeq(fields.subjectId, fields.claimType),
      issuedAt,
      validUntil: issuedAt + validFor,
      ...fields,
    };
  }

  async sign(signer: WalletName | any, att: Attestation, domain?: Domain) {
    const wallet = typeof signer === "string" ? this.w[signer as WalletName] : signer;
    return signAttestation(wallet, domain ?? this.domain!, att);
  }

  /** Signs with `signer` and submits; returns the outcome instead of throwing. */
  async submit(
    signer: WalletName,
    att: Attestation,
    opts: { signerAddress?: Address; signature?: Hex; domain?: Domain } = {},
  ): Promise<TxOutcome> {
    if (!this.hasEvidence) return { ok: true, reason: "NO_EVIDENCE_LAYER" };
    const signature = opts.signature ?? (await this.sign(signer, att, opts.domain));
    const signerAddress = opts.signerAddress ?? this.w[signer].account.address;
    return this.send(() =>
      this.registry.write.submitAttestation([att, signerAddress, signature], {
        account: this.w.admin.account,
      }),
    );
  }

  async attestRights(label: string, encumbered = false, signer: WalletName = "legal", validFor?: bigint) {
    const spec = ASSETS.find((a) => a.label === label);
    const att = await this.buildAttestation(
      {
        claimType: CLAIM.RIGHTS,
        subjectId: assetId(label),
        code: RIGHTS_TYPE[spec?.rightsType ?? "BENEFICIAL_INTEREST"],
        flag: encumbered,
      },
      validFor,
    );
    return this.submit(signer, att);
  }

  async attestValuation(label: string, value: bigint, signer: WalletName = "valuer", validFor?: bigint) {
    const att = await this.buildAttestation(
      { claimType: CLAIM.VALUATION, subjectId: assetId(label), amount: value },
      validFor,
    );
    return this.submit(signer, att);
  }

  async attestClassification(
    label: string,
    assetClass: number,
    policyVersion = 1,
    signer: WalletName = "shariah",
    validFor?: bigint,
  ) {
    if (!isShariahConfig(this.config)) return { ok: true, reason: "NOT_APPLICABLE" } as TxOutcome;
    const att = await this.buildAttestation(
      {
        claimType: CLAIM.CLASSIFICATION,
        subjectId: assetId(label),
        code: assetClass,
        policyVersion,
      },
      validFor,
    );
    return this.submit(signer, att);
  }

  async attestEncumbrance(label: string, encumbered: boolean, signer: WalletName = "custodian") {
    const att = await this.buildAttestation({
      claimType: CLAIM.ENCUMBRANCE,
      subjectId: assetId(label),
      flag: encumbered,
    });
    return this.submit(signer, att);
  }

  async attestShariahStatus(
    status: number = STATUS.ENDORSED,
    policyVersion = 1,
    signer: WalletName = "shariah",
    validFor?: bigint,
  ) {
    if (!isShariahConfig(this.config)) return { ok: true, reason: "NOT_APPLICABLE" } as TxOutcome;
    const att = await this.buildAttestation(
      {
        claimType: CLAIM.SHARIAH_STATUS,
        subjectId: this.instrumentId,
        code: status,
        policyVersion,
        evidenceHash: docHash("SHARIAH-PRONOUNCEMENT-001"),
      },
      validFor,
    );
    return this.submit(signer, att);
  }

  /** Publishes rights, valuation and (B2) classification for every asset. */
  async publishPortfolio(validFor?: bigint) {
    for (const asset of ASSETS) {
      await this.attestRights(asset.label, false, "legal", validFor);
      await this.attestValuation(asset.label, units(asset.value), "valuer", validFor);
      await this.attestClassification(
        asset.label,
        CLASS[asset.class],
        1,
        "shariah",
        validFor,
      );
    }
    await this.attestShariahStatus(STATUS.ENDORSED, 1, "shariah", validFor);
  }

  async revoke(label: string, claimType: number, by: WalletName) {
    if (!this.hasEvidence) return { ok: true, reason: "NO_EVIDENCE_LAYER" } as TxOutcome;
    const subject = claimType === CLAIM.SHARIAH_STATUS ? this.instrumentId : assetId(label);
    return this.send(() =>
      this.registry.write.revokeAttestation([subject, claimType], {
        account: this.w[by].account,
      }),
    );
  }

  async revokeAttestor(name: WalletName) {
    if (!this.hasEvidence) return { ok: true, reason: "NO_EVIDENCE_LAYER" } as TxOutcome;
    return this.send(() =>
      this.registry.write.revokeAttestor([this.w[name].account.address], {
        account: this.w.admin.account,
      }),
    );
  }

  async registerAttestor(name: WalletName, role: Hex) {
    if (!this.hasEvidence) return { ok: true, reason: "NO_EVIDENCE_LAYER" } as TxOutcome;
    return this.send(() =>
      this.registry.write.registerAttestor([this.w[name].account.address, role], {
        account: this.w.admin.account,
      }),
    );
  }

  /** Points the transfer check at the first currently eligible asset, if any. */
  async refreshWitness(labels: string[] = ASSETS.map((a) => a.label)): Promise<boolean> {
    if (!this.hasEvidence) return true;
    for (const label of labels) {
      const outcome = await this.send(() =>
        this.engine.write.setWitness([assetId(label)], { account: this.w.admin.account }),
      );
      if (outcome.ok) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Issuance and transfers
  // -------------------------------------------------------------------------

  async buildTranche(
    trancheLabel: string,
    proceeds: bigint,
    allocation: Record<string, bigint>,
    overrides: Partial<TrancheAllocation> = {},
  ): Promise<TrancheAllocation> {
    const now = await this.now();
    const { assetIds, amounts } = sortAllocation(
      Object.entries(allocation).map(([label, amount]) => [assetId(label), amount]),
    );
    return {
      instrumentId: this.instrumentId,
      trancheId: id(trancheLabel),
      proceeds,
      assetIds,
      amounts,
      policyVersion: 1,
      evidenceHash: docHash(trancheLabel),
      issuedAt: now,
      validUntil: now + DAY,
      ...overrides,
    };
  }

  async issueEvidence(
    tranche: TrancheAllocation,
    signerNames: WalletName[] = ["wakeel", "trustee"],
    domain?: Domain,
  ): Promise<Hex> {
    if (!this.hasEvidence) return "0x";
    const signatures: Hex[] = [];
    for (const name of signerNames) {
      signatures.push(await signTranche(this.w[name], domain ?? this.domain!, tranche));
    }
    return encodeIssuanceEvidence(
      tranche,
      signerNames.map((n) => this.w[n].account.address),
      signatures,
    );
  }

  async issue(
    evidence: Hex,
    subscribers: Record<string, bigint>,
    account: WalletName = "admin",
  ): Promise<TxOutcome> {
    const recipients = Object.keys(subscribers).map(
      (n) => this.w[n as WalletName].account.address,
    );
    const amounts = Object.values(subscribers);
    return this.send(() =>
      this.token.write.issue([evidence, recipients, amounts], {
        account: this.w[account].account,
      }),
    );
  }

  /** Issues the fixture's TRANCHE-1 with valid evidence. */
  async issueDefaultTranche(): Promise<TxOutcome> {
    const t = PORTFOLIO.tranches[0];
    const allocation = Object.fromEntries(
      Object.entries(t.allocation).map(([k, v]) => [k, units(v as string)]),
    );
    const tranche = await this.buildTranche(t.label, units(t.proceeds), allocation);
    const evidence = await this.issueEvidence(tranche);
    const subscribers = Object.fromEntries(
      Object.entries(t.subscribers).map(([k, v]) => [k, units(v as string)]),
    );
    return this.issue(evidence, subscribers);
  }

  async preCheck(from: WalletName, to: WalletName, amount: bigint): Promise<string> {
    const r: Hex = await this.token.read.preCheckTransfer([
      this.w[from].account.address,
      this.w[to].account.address,
      amount,
    ]);
    return decodeReason(r);
  }

  async transfer(from: WalletName, to: WalletName, amount: bigint): Promise<TxOutcome> {
    const pre = await this.preCheck(from, to, amount);
    const outcome = await this.send(() =>
      this.token.write.transfer([this.w[to].account.address, amount], {
        account: this.w[from].account,
      }),
    );
    // The pre-check and the executed transfer must agree.
    if (outcome.ok !== (pre === "OK")) {
      throw new Error(`pre-check (${pre}) disagrees with execution (${outcome.ok})`);
    }
    return { ...outcome, reason: outcome.ok ? "OK" : pre };
  }

  /** Runs a write; returns {ok, reason, gasUsed} instead of throwing. */
  async send(fn: () => Promise<Hex>): Promise<TxOutcome> {
    try {
      const hash = await fn();
      const receipt = await this.receipt(hash);
      return { ok: receipt.status === "success", reason: "OK", gasUsed: receipt.gasUsed };
    } catch (err: any) {
      return { ok: false, reason: extractRevert(err), error: String(err?.shortMessage ?? err) };
    }
  }
}

/** Extracts a custom-error name, and a reason code if present, from a viem error. */
export function extractRevert(err: any): string {
  const text = `${err?.message ?? ""}\n${err?.details ?? ""}`;
  const m = text.match(/reverted with custom error '([A-Za-z0-9_]+)\(([^)]*)\)'/);
  if (m) {
    const args = m[2].trim();
    const hex = args.match(/0x[0-9a-fA-F]{64}/);
    if (hex) {
      const decoded = decodeReason(hex[0] as Hex);
      if (/^[A-Z0-9_]+$/.test(decoded)) return decoded;
    }
    return m[1];
  }
  const m2 = text.match(/reverted with reason string '([^']+)'/);
  if (m2) return m2[1];
  const m3 = text.match(/Error: ([A-Za-z0-9_]+)\(/);
  if (m3) return m3[1];
  return "REVERTED";
}

export async function deployWorld(
  hreNetwork: { viem: any; networkHelpers: any },
  config: ConfigName,
  instrumentId: Hex = INSTRUMENT_ID,
): Promise<World> {
  const { viem, networkHelpers } = hreNetwork;
  const wallets = await viem.getWalletClients();
  const w = Object.fromEntries(
    WALLET_NAMES.map((name, i) => [name, wallets[i]]),
  ) as Record<WalletName, any>;
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const now = BigInt(await networkHelpers.time.latest());
  const admin = w.admin.account.address as Address;

  const identity = await viem.deployContract("IdentityRegistry", [admin]);
  let compliance: any;
  let registry: any;
  let engine: any;
  let domain: Domain | undefined;

  if (config === "B0") {
    compliance = await viem.deployContract("BasicCompliance");
  } else {
    registry = await viem.deployContract("EvidenceRegistry", [
      instrumentId,
      MAX_CLAIM_VALIDITY,
      admin,
    ]);
    engine = await viem.deployContract(config === "B2F" ? "SukukPolicyEngineFallback" : "SukukPolicyEngine", [
      registry.address,
      [admin, w.governor2.account.address, w.governor3.account.address],
      QUORUM,
      GOVERNANCE_TIMELOCK,
      isShariahConfig(config) ? POLICY_B2 : POLICY_B1,
    ]);
    compliance = engine;
    domain = evidenceDomain(chainId, registry.address);
  }

  const token = await viem.deployContract("SukukToken", [
    "Synthetic Sukuk Wakalah",
    "SYNSW",
    identity.address,
    compliance.address,
    now + TENOR,
    admin,
  ]);
  await compliance.write.bindToken([token.address]);
  await token.write.grantRole([id("SETTLEMENT_ROLE"), w.settlement.account.address]);

  const eligibleUntil = now + 10n * TENOR;
  for (const name of ["inv1", "inv2", "inv3"] as WalletName[]) {
    await identity.write.registerIdentity([w[name].account.address, 458, eligibleUntil]);
  }

  if (registry) {
    const roles: Array<[WalletName, Hex]> = [
      ["wakeel", ROLE.WAKEEL],
      ["trustee", ROLE.TRUSTEE],
      ["legal", ROLE.LEGAL_VERIFIER],
      ["valuer", ROLE.VALUER],
      ["custodian", ROLE.CUSTODIAN],
    ];
    if (isShariahConfig(config)) roles.push(["shariah", ROLE.SHARIAH_ADVISER]);
    for (const [name, role] of roles) {
      await registry.write.registerAttestor([w[name].account.address, role]);
    }
  }

  return new World(
    config,
    viem,
    networkHelpers,
    publicClient,
    w,
    identity,
    token,
    compliance,
    registry,
    engine,
    domain,
    chainId,
    instrumentId,
  );
}

export { OK };
