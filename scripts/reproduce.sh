#!/usr/bin/env bash
# Regenerates every reported result, table and the manuscript, in the order
# used for the paper. Run from anywhere; requires Node.js 22, Python 3 and,
# for steps 5-6, slither-analyzer 0.11.6. Set SOLC_PATH to a local solc 0.8.28
# binary if Hardhat cannot download the compiler.
#
#   scripts/reproduce.sh            all steps
#   SKIP_STATIC=1 scripts/reproduce.sh   skip Slither and mutation checks
#   SKIP_PAPER=1  scripts/reproduce.sh   skip LaTeX
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1. build"
npx hardhat build

echo "== 2. instrumented coverage run (changes gas, so it runs before the measured run)"
npx hardhat test --coverage > outputs/coverage_log.txt 2>&1
python3 scripts/coverage_summary.py

echo "== 3. measured run: all suites, oracle S01-S26 and G01-G04, model-based"
echo "      20 seeds x 500 steps x 2 profiles x B1/B2/B2F, fuzzing, gas benchmark"
MODEL_SEEDS=20 MODEL_STEPS=500 MODEL_PROFILES=adversarial,maintained \
  npx hardhat test 2>&1 | tee outputs/test_log.txt

echo "== 4. replication of the earlier 5 seeds x 250 steps adversarial walks"
MODEL_SEEDS=5 MODEL_STEPS=250 MODEL_PROFILES=adversarial \
  MODEL_OUT=model_based_replication_5x250 npx hardhat test test/ModelBased.ts

if [ -z "${SKIP_STATIC:-}" ]; then
  echo "== 5. Slither"
  scripts/run_slither.sh outputs/static
  python3 scripts/static_summary.py
  echo "== 6. mutation checks (six mutants; slow)"
  python3 scripts/run_mutants.py outputs/static/mutation_checks.csv
fi

if [ -z "${SKIP_PAPER:-}" ]; then
  echo "== 7. tables and manuscript"
  python3 paper/scripts/make_tables.py
  (cd paper && latexmk -pdf manuscript.tex supplementary.tex highlights.tex)
fi
