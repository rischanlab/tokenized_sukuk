"""Hand-written mutation checks (Table S12 of the supplementary material).

Each mutant weakens one boundary in a production contract. For every mutant
the script applies the change, runs the Solidity fuzz suite and the
functional TypeScript suites, restores the original source and records
whether each suite failed ("killed") or passed ("survived"). The model-based
and benchmark suites are not run against mutants. The oracle suite writes its
decision files to a temporary directory (ORACLE_OUT), so the reported
outputs/decision_*.csv are never overwritten by a run on mutated code.

Usage (from the repository root, after `npm ci`):
    python3 scripts/run_mutants.py [outputs/static/mutation_checks.csv]
"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "outputs/static/mutation_checks.csv"
SCRATCH = tempfile.mkdtemp(prefix="oracle-mutants-")

MUTANTS = [
    ("M1", "contracts/policy/SukukPolicyEngine.sol",
     "nonDebtSum * BPS < uint256(p.minNonDebtBps) * t.proceeds",
     "nonDebtSum * BPS < uint256(p.minNonDebtBps - 1) * t.proceeds",
     "issuance threshold lowered to 3299 bps"),
    ("M2", "contracts/policy/SukukPolicyEngine.sol",
     "if (allocated[assetId] + amount > evidence.assetValue(assetId)) {",
     "if (allocated[assetId] + amount > evidence.assetValue(assetId) + 1) {",
     "allocation may exceed attested value by one unit"),
    ("M3", "contracts/policy/SukukPolicyEngine.sol",
     "if (total > t.proceeds) {",
     "if (total > t.proceeds + t.proceeds / 2) {",
     "allocation total may exceed proceeds by half"),
    ("M4", "contracts/token/SukukToken.sol",
     "uint256(redemption.settledUnits) + units > redemption.units",
     "uint256(redemption.settledUnits) + units > redemption.units + 1",
     "settlement may exceed a claim by one unit"),
    ("M5", "contracts/registry/EvidenceRegistry.sol",
     "a.validUntil - a.issuedAt > maxClaimValidity",
     "a.validUntil - a.issuedAt > maxClaimValidity + 1 days",
     "claim windows up to 31 days accepted"),
    ("M6", "contracts/registry/EvidenceRegistry.sol",
     "if (a.seq <= lastSeq[a.subjectId][a.claimType]) {",
     "if (a.seq < lastSeq[a.subjectId][a.claimType]) {",
     "equal sequence number accepted (replay)"),
]

FUZZ = "npx hardhat test solidity"
FUNCTIONAL = ("npx hardhat test nodejs test/ShariahRules.ts test/Credentials.ts "
              "test/Lifecycle.ts test/Oracle.ts test/Boundaries.ts")


def suite(cmd: str) -> str:
    env = dict(os.environ, ORACLE_OUT=SCRATCH)
    result = subprocess.run(cmd, shell=True, cwd=ROOT, env=env, capture_output=True, text=True, timeout=3600)
    return "killed" if result.returncode != 0 else "survived"


def main() -> None:
    # The unmutated code must pass both suites, or a "killed" result means nothing.
    for cmd in (FUZZ, FUNCTIONAL):
        if suite(cmd) != "survived":
            sys.exit(f"baseline run failed: {cmd}")
    rows = ["mutation,file,description,fuzz_suite_result,typescript_suite_result"]
    for mid, rel, original, mutated, description in MUTANTS:
        path = ROOT / rel
        source = path.read_text()
        assert source.count(original) == 1, (mid, original)
        path.write_text(source.replace(original, mutated))
        try:
            fuzz, functional = suite(FUZZ), suite(FUNCTIONAL)
        finally:
            path.write_text(source)
        rows.append(",".join([mid, path.name, description, fuzz, functional]))
        print(rows[-1], flush=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(rows) + "\n")


if __name__ == "__main__":
    main()
