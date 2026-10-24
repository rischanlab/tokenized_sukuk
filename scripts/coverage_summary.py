#!/usr/bin/env python3
"""Summarises coverage/lcov.info (written by `npm run coverage`) into
outputs/coverage_summary.csv: line and branch counts per contract, and a
total over the production contracts (test harnesses, mocks and the Solidity
fuzz contracts are excluded from the total)."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
rows, cur = [], None
for line in (ROOT / "coverage" / "lcov.info").read_text().splitlines():
    if line.startswith("SF:"):
        cur = {"file": line[3:], "LF": 0, "LH": 0, "BRF": 0, "BRH": 0}
    elif cur is not None and line.split(":")[0] in ("LF", "LH", "BRF", "BRH"):
        k, v = line.split(":")
        cur[k] = int(v)
    elif line == "end_of_record" and cur is not None:
        rows.append(cur)
        cur = None


def production(f):
    return not (f.startswith("contracts/test/") or f.startswith("contracts/fuzz/") or f.endswith(".t.sol"))


out = ["file,lines_found,lines_hit,line_pct,branches_found,branches_hit,branch_pct,production"]
pct = lambda h, n: f"{100 * h / n:.2f}" if n else ""
for r in sorted(rows, key=lambda r: r["file"]):
    out.append(f"{r['file']},{r['LF']},{r['LH']},{pct(r['LH'], r['LF'])},{r['BRF']},{r['BRH']},{pct(r['BRH'], r['BRF'])},{str(production(r['file'])).lower()}")
p = [r for r in rows if production(r["file"])]
LF, LH = sum(r["LF"] for r in p), sum(r["LH"] for r in p)
BRF, BRH = sum(r["BRF"] for r in p), sum(r["BRH"] for r in p)
out.append(f"production_total,{LF},{LH},{pct(LH, LF)},{BRF},{BRH},{pct(BRH, BRF)},true")
(ROOT / "outputs" / "coverage_summary.csv").write_text("\n".join(out) + "\n")
print("\n".join(out))
