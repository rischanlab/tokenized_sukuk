import {
  encodeAbiParameters,
  hexToString,
  keccak256,
  parseUnits,
  stringToHex,
  toBytes,
  type Address,
  type Hex,
} from "viem";

// ---------------------------------------------------------------------------
// Units, identifiers and policy constants
// ---------------------------------------------------------------------------

export const units = (value: string) => parseUnits(value, 18);
export const DAY = 86_400n;

export const id = (label: string): Hex => keccak256(toBytes(label));
export const reason = (code: string): Hex => stringToHex(code, { size: 32 });
export const OK: Hex = `0x${"0".repeat(64)}`;
export function decodeReason(value: Hex): string {
  return value === OK ? "OK" : hexToString(value, { size: 32 }).replace(/\0+$/, "");
}

/** Synthetic instrument used throughout the tests (not a real security). */
export const INSTRUMENT_ID = id("SYN-SUKUK-WAKALAH-001");
export const POLICY_DOC_HASH = id("docs/policy_specification.md#MY-SAC-WAKALAH-2023-v1");
export const MAX_CLAIM_VALIDITY = 30n * DAY;
export const GOVERNANCE_TIMELOCK = 1n * DAY;
export const QUORUM = 2;
export const TENOR = 365n * DAY;

export const CLAIM = {
  RIGHTS: 1,
  VALUATION: 2,
  CLASSIFICATION: 3,
  ENCUMBRANCE: 4,
  SHARIAH_STATUS: 5,
} as const;

export const CLASS = { NON_DEBT: 1, DEBT: 2 } as const;
export const STATUS = { ENDORSED: 1, NOT_ENDORSED: 2 } as const;
export const RIGHTS_TYPE = {
  BENEFICIAL_INTEREST: 1,
  LEGAL_TITLE: 2,
  RECEIVABLE: 3,
} as const;

export const ROLE = {
  WAKEEL: id("WAKEEL"),
  TRUSTEE: id("TRUSTEE"),
  LEGAL_VERIFIER: id("LEGAL_VERIFIER"),
  VALUER: id("VALUER"),
  CUSTODIAN: id("CUSTODIAN"),
  SHARIAH_ADVISER: id("SHARIAH_ADVISER"),
} as const;

export type PolicyParams = {
  version: number;
  minNonDebtBps: number;
  applyNonDebtRules: boolean;
  requireShariahStatus: boolean;
  excludeEncumbered: boolean;
  policyDocHash: Hex;
};

/** B2: encoded reading of the SAC 2023 Sukuk Wakalah resolution. */
export const POLICY_B2: PolicyParams = {
  version: 1,
  minNonDebtBps: 3300,
  applyNonDebtRules: true,
  requireShariahStatus: true,
  excludeEncumbered: true,
  policyDocHash: POLICY_DOC_HASH,
};

/** B1: same engine and evidence, Shariah rules disabled. */
export const POLICY_B1: PolicyParams = {
  version: 1,
  minNonDebtBps: 0,
  applyNonDebtRules: false,
  requireShariahStatus: false,
  excludeEncumbered: true,
  policyDocHash: id("evidence-only-v1"),
};

// ---------------------------------------------------------------------------
// EIP-712 types (must match EvidenceRegistry.sol)
// ---------------------------------------------------------------------------

export const attestationTypes = {
  Attestation: [
    { name: "instrumentId", type: "bytes32" },
    { name: "claimType", type: "uint8" },
    { name: "subjectId", type: "bytes32" },
    { name: "code", type: "uint8" },
    { name: "flag", type: "bool" },
    { name: "amount", type: "uint256" },
    { name: "policyVersion", type: "uint32" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "seq", type: "uint64" },
    { name: "issuedAt", type: "uint64" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

export const trancheTypes = {
  TrancheAllocation: [
    { name: "instrumentId", type: "bytes32" },
    { name: "trancheId", type: "bytes32" },
    { name: "proceeds", type: "uint256" },
    { name: "assetIds", type: "bytes32[]" },
    { name: "amounts", type: "uint256[]" },
    { name: "policyVersion", type: "uint32" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

export type Attestation = {
  instrumentId: Hex;
  claimType: number;
  subjectId: Hex;
  code: number;
  flag: boolean;
  amount: bigint;
  policyVersion: number;
  evidenceHash: Hex;
  seq: bigint;
  issuedAt: bigint;
  validUntil: bigint;
};

export type TrancheAllocation = {
  instrumentId: Hex;
  trancheId: Hex;
  proceeds: bigint;
  assetIds: Hex[];
  amounts: bigint[];
  policyVersion: number;
  evidenceHash: Hex;
  issuedAt: bigint;
  validUntil: bigint;
};

export type Domain = {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
};

export function evidenceDomain(chainId: number, registry: Address): Domain {
  return {
    name: "TokenizedSukukEvidence",
    version: "1",
    chainId,
    verifyingContract: registry,
  };
}

export async function signAttestation(
  wallet: any,
  domain: Domain,
  message: Attestation,
): Promise<Hex> {
  return wallet.signTypedData({
    account: wallet.account,
    domain,
    types: attestationTypes,
    primaryType: "Attestation",
    message,
  });
}

export async function signTranche(
  wallet: any,
  domain: Domain,
  message: TrancheAllocation,
): Promise<Hex> {
  return wallet.signTypedData({
    account: wallet.account,
    domain,
    types: trancheTypes,
    primaryType: "TrancheAllocation",
    message,
  });
}

const trancheTuple = {
  type: "tuple",
  components: trancheTypes.TrancheAllocation,
} as const;

/** ABI-encodes the issuance evidence consumed by SukukPolicyEngine. */
export function encodeIssuanceEvidence(
  tranche: TrancheAllocation,
  signers: Address[],
  signatures: Hex[],
): Hex {
  return encodeAbiParameters(
    [trancheTuple, { type: "address[]" }, { type: "bytes[]" }],
    [tranche, signers, signatures],
  );
}

/** Sorts allocation entries by asset id, as the engine requires. */
export function sortAllocation(entries: Array<[Hex, bigint]>): {
  assetIds: Hex[];
  amounts: bigint[];
} {
  const sorted = [...entries].sort((a, b) =>
    BigInt(a[0]) < BigInt(b[0]) ? -1 : BigInt(a[0]) > BigInt(b[0]) ? 1 : 0,
  );
  return {
    assetIds: sorted.map((e) => e[0]),
    amounts: sorted.map((e) => e[1]),
  };
}
