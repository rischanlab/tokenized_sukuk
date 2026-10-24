# Tokenised Sukuk: evidence-dependent, Shariah-aware compliance (research prototype)

This repository contains the Solidity contracts, tests, fixtures, experiment
scripts, raw outputs and LaTeX sources for the paper *Tokenised Sukuk: A
Verifiable Architecture for Asset Evidence and Programmable Shariah
Compliance* and its supplementary material. Every number in the paper is
generated from the files in `outputs/` by `paper/scripts/make_tables.py`.

> **Disclaimer.** This is a research prototype on a synthetic instrument. It is
> not a Shariah ruling, a legal opinion, an audited contract or a deployable
> financial product. The encoded rule is the authors' reading of one
> Securities Commission Malaysia Shariah Advisory Council (SAC) resolution
> (16 March 2023, Sukuk Wakalah bi al-Istithmar) and has not been reviewed by a
> Shariah scholar or a lawyer. No real issuer, asset or investor is
> represented. See `docs/threat_model.md` for what the contracts can and cannot
> establish.

## 1. What the prototype does

A permissioned ERC-20 sukuk token with ERC-3643-style identity, pause, freeze
and forced-transfer controls delegates issuance and transfer decisions to a
policy engine. The engine decides on the basis of EIP-712 claims signed by
separate institutional roles (legal verifier, valuer, custodian, Shariah
adviser, wakeel and trustee) and stored in an evidence registry. For the SAC
resolution it checks:

* at issuance, that at least 33.00% of the tranche's proceeds is allocated to
  assets currently evidenced as non-debt investment assets (R1);
* nothing about that percentage after issuance (R2);
* on every ordinary transfer, that a non-debt asset is currently evidenced
  (R3), through one nominated *witness* asset (B2) or the witness plus a scan
  of the first 32 allocated assets (B2F).

The price consequence in the resolution (R4: negotiated-price trading without
bai' al-dayn) is **not** implemented: a token transfer carries no price. In its
place, ordinary transfers fail closed while R3 is not evidenced, a control
chosen by the authors (`docs/policy_specification.md`).

| Config | Compliance contract | Evidence layer | Shariah rules |
|---|---|---|---|
| B0 | `BasicCompliance` (always allows) | no | no |
| B1 | `SukukPolicyEngine` | rights, valuation, encumbrance; tranche co-signatures | off |
| B2 | `SukukPolicyEngine` | as B1 plus classification and Shariah status | on (single witness) |
| B2F | `SukukPolicyEngineFallback` | as B2 | on; if the witness fails, scans up to 32 recorded candidates |

## 2. Requirements

| Tool | Version used for the paper | Needed for |
|---|---|---|
| Node.js | 22.22.0 | everything |
| npm | bundled with Node 22 | dependency install |
| Python | 3.10 or later, standard library only | tables, coverage and static summaries, mutation checks |
| slither-analyzer | 0.11.6 | static analysis (optional) |
| solc | 0.8.28 (downloaded by Hardhat, or `SOLC_PATH`) | compilation, Slither |
| TeX Live with `latexmk`, `pdflatex`, `bibtex` | 2023 | the manuscript and supplement (optional) |

All JavaScript dependencies are pinned in `package-lock.json` (Hardhat
3.11.1, viem 2.55.10, OpenZeppelin Contracts 5.6.1). The compiler settings are
in `hardhat.config.ts` (solc 0.8.28, optimiser 200 runs, `cancun` target; the
simulated network uses `osaka` rules).

If Hardhat cannot download the compiler (for example behind a restrictive
proxy), download the `solc-static-linux` 0.8.28 binary from the Solidity
GitHub releases and set `SOLC_PATH=/path/to/solc-0.8.28` before any command
below.

## 3. Quick start

```bash
npm ci
npx hardhat build
npm run test:boundaries     # 13 scope-boundary tests, under a minute
npm run oracle              # S01-S26 and G01-G04 under B0/B1/B2/B2F
```

## 4. Reproducing every reported result

One command runs the whole pipeline in the order used for the paper:

```bash
npm ci
scripts/reproduce.sh                 # all steps
SKIP_STATIC=1 scripts/reproduce.sh   # without Slither and mutation checks
SKIP_PAPER=1  scripts/reproduce.sh   # without LaTeX
```

The steps, their commands and what they produce:

| Step | Command | Writes | Used in the paper |
|---|---|---|---|
| 1. Build | `npx hardhat build` | `artifacts/` | — |
| 2. Instrumented coverage run (changes gas, so it runs **before** step 3) | `npx hardhat test --coverage`, then `python3 scripts/coverage_summary.py` | `coverage/lcov.info`, `outputs/coverage_summary.csv` | line coverage (§4.7, Table S13) |
| 3. Measured run of all suites | `MODEL_SEEDS=20 MODEL_STEPS=500 MODEL_PROFILES=adversarial,maintained npx hardhat test 2>&1 \| tee outputs/test_log.txt` | `outputs/decision_matrix.csv`, `decision_summary.csv`, `model_based_*.csv`, `gas_metrics.csv`, `latency_metrics.csv`, `environment.json`, `test_log.txt` | Tables 4–6, Figure 2, Tables S5, S9, S10, S14–S17 |
| 4. Short model-based check (5 seeds × 250 steps, adversarial) | `npm run model:replicate` | `outputs/model_based_replication_5x250/` | supplement §S5 |
| 5. Static analysis | `scripts/run_slither.sh && python3 scripts/static_summary.py` | `outputs/static/slither_*.json`, `slither_summary.csv` | §4.7, Table S11 |
| 6. Mutation checks (the oracle suite writes to a temporary directory here, so step 3's decision files are kept) | `python3 scripts/run_mutants.py` | `outputs/static/mutation_checks.csv` | §4.7, Table S12 |
| 7. Tables and documents | `python3 paper/scripts/make_tables.py`, then `npm run paper` | `paper/tables/*.tex`, `paper/*.pdf` | all |

Step 3 is the run that produces the paper's model-based results: **20 seeds ×
500 steps × 2 profiles (adversarial, maintained) × 3 configurations (B1, B2,
B2F)**, 60,000 configuration-steps in total. These are the defaults of
`test/ModelBased.ts`, so `npx hardhat test` and `npm run model:full` produce
the same run. The variables `MODEL_SEEDS`, `MODEL_STEPS`, `MODEL_PROFILES`,
`MODEL_OUT`, `BENCH_TRIALS` (default 200) and `FUZZ_RUNS` (default 1000) size
the runs; smaller values are useful as smoke tests but do not reproduce the
reported tables.

Two archived inputs cannot be regenerated from the current sources, because
they describe the code before later fixes: `outputs/static/initial/` (Slither
findings before the fixes of uninitialised locals and the missing zero-address
check) and `outputs/static/mutation_checks_initial.csv` (mutation results
before tests T19 and T20 were added). Both are reported as "initial" in the
paper.

Gas figures are deterministic up to a few tens of gas, because timestamps and
signatures enter calldata. Latency figures depend on the machine
(`outputs/environment.json` records it) and describe Hardhat's in-process
network only.

## 5. Individual suites

| npm script | Suite | Contents |
|---|---|---|
| `npm run test:rules` | `test/ShariahRules.ts` | T01–T04 and Shariah status |
| `npm run test:credentials` | `test/Credentials.ts` | T05–T07, T11, T12, EIP-1271 signer |
| `npm run test:lifecycle` | `test/Lifecycle.ts` | T08–T10, T13, invariants I5–I8, agent controls, governance |
| `npm run oracle` | `test/Oracle.ts` | replays `fixtures/test_oracle.csv` (S01–S26, G01–G04) under all configurations |
| `npm run test:boundaries` | `test/Boundaries.ts` | T15–T21: cross-instrument pledges, coverage, fallback scan and its 32-candidate cap, renewals, forced transfer, allocation bounds |
| `npm run model` / `model:full` | `test/ModelBased.ts` | seeded random walks checked against a TypeScript reference model |
| `npm run bench` | `test/Benchmark.ts` | T14: gas and latency |
| `npx hardhat test solidity` | `contracts/fuzz/PropertyFuzz.t.sol` | four Solidity fuzz properties |
| `npm run static` | Slither | requires slither on `PATH` |
| `npm run mutants` | six hand-written mutants | applies each, runs the fuzz and functional suites, restores the source |

## 6. Repository layout

```
contracts/
  token/SukukToken.sol                 permissioned ERC-20, issuance, redemption accounting
  registry/EvidenceRegistry.sol        attestor registry, EIP-712 verifier, claim store
  registry/IdentityRegistry.sol        simplified investor eligibility registry
  policy/SukukPolicyEngine.sol         issuance and transfer policy, governance, lifecycle (B1, B2)
  policy/SukukPolicyEngineFallback.sol B2F: bounded fallback scan over allocated assets
  baseline/BasicCompliance.sol         B0 compliance
  fuzz/PropertyFuzz.t.sol              Solidity fuzz properties
  libraries/ReasonCodes.sol            bytes32 reason codes
  test/                                EIP-1271 wallet and benchmark harnesses (not production)
test/                                  TypeScript suites (section 5) and helpers
fixtures/                              synthetic portfolio, mock documents, scenario oracle,
                                       scenario coverage matrix
scripts/                               reproduce.sh, run_slither.sh, run_mutants.py,
                                       coverage and static-analysis summaries
outputs/                               raw results (section 7)
docs/                                  policy specification, threat model, architecture,
                                       claim schemas, prior-art matrix
paper/                                 manuscript.tex (anonymised), supplementary.tex,
                                       highlights.tex, sections/, supplement/,
                                       tables/ (generated), scripts/make_tables.py
```

## 7. Outputs

| File | Content |
|---|---|
| `outputs/decision_matrix.csv` | every oracle scenario under every configuration: expected and actual decision and reason |
| `outputs/decision_summary.csv` | agreement, false accepts and false rejects per scenario set and configuration |
| `outputs/model_based_{B1,B2,B2F}.csv` | per-seed, per-profile operation and outcome counts of the random walks |
| `outputs/model_based_summary.csv` | the same, aggregated |
| `outputs/model_based_replication_5x250/` | the short five-seed, 250-step adversarial check |
| `outputs/gas_metrics.csv` | deployment, transfer, claim updates, issuance by asset count, fallback scan by position, lifecycle, bytecode |
| `outputs/latency_metrics.csv` | wall-clock distributions on the simulated network |
| `outputs/coverage_summary.csv` | line coverage per contract |
| `outputs/static/` | Slither reports (initial and current), summary, mutation checks |
| `outputs/test_log.txt` | log of the measured run (step 3) |
| `outputs/environment.json` | machine, Node, Hardhat, viem, OpenZeppelin, solc, optimiser and hardfork |

The Hardhat summary line in `test_log.txt` counts the two helper modules
`test/environment.ts` and `test/helpers.ts` as passing tests; the paper's test
count excludes them.

## 8. Building the paper

```bash
python3 paper/scripts/make_tables.py
cd paper
latexmk -pdf manuscript.tex supplementary.tex highlights.tex
python3 scripts/check_xrefs.py   # checks cross-document table numbers
```

`manuscript.tex` and `supplementary.tex` compile independently (for example
on Overleaf or in Editorial Manager). References from one to the other, such
as "Table~S5" in the manuscript, are written as plain numbers;
`scripts/check_xrefs.py` compares them with the labels in both `.aux` files
and fails if one no longer exists.

## 9. Trust assumptions in one paragraph

The contracts check who signed a claim, whether that key holds the role the
claim type requires, whether the claim is bound to this instrument, chain and
registry, and whether it is still current. They do not check that the claim is
true, that proceeds were actually invested, that the portfolio covers the
certificates outstanding, or that the same asset is not pledged to another
instrument. A valuer who signs a false valuation, or an asset sold off-chain
whose claims have not yet expired or been revoked, produces evidence the
contracts accept. Agents can pause, freeze and force transfers, and the forced
path bypasses the Shariah rule, as ERC-3643's does. One governor can suspend
trading; two of three governors can change the policy after a one-day
timelock; one designated governor key onboards and revokes attestors.

## 10. Licence

MIT licence, see `LICENSE`.
