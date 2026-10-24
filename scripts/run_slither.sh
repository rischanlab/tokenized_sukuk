#!/usr/bin/env bash
# Runs Slither on each deployable contract and writes outputs/static/slither_<Name>.{json,txt}.
# SukukPolicyEngineFallback imports SukukPolicyEngine and EvidenceRegistry, so
# those two are analysed as part of its compilation unit.
# Requires slither-analyzer 0.11.6 on PATH and a local solc 0.8.28 (SOLC_PATH,
# or `solc` on PATH). Usage: scripts/run_slither.sh [output-dir]
set -u
cd "$(dirname "$0")/.."
OUT="${1:-outputs/static}"
SOLC="${SOLC_PATH:-$(command -v solc)}"
mkdir -p "$OUT"
for f in contracts/token/SukukToken.sol contracts/policy/SukukPolicyEngineFallback.sol \
         contracts/registry/IdentityRegistry.sol contracts/baseline/BasicCompliance.sol; do
  n=$(basename "$f" .sol)
  rm -f "$OUT/slither_$n.json"
  # Slither exits non-zero whenever it reports findings; that is expected.
  slither "$f" --solc "$SOLC" \
    --solc-remaps "@openzeppelin/=node_modules/@openzeppelin/" \
    --solc-args "--evm-version cancun --optimize --optimize-runs 200" \
    --filter-paths "node_modules" \
    --json "$OUT/slither_$n.json" > "$OUT/slither_$n.txt" 2>&1
  echo "$n: $(test -s "$OUT/slither_$n.json" && echo written || echo FAILED)"
done
