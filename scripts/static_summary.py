#!/usr/bin/env python3
"""Summarises the Slither JSON reports in outputs/static/ (current contracts)
and outputs/static/initial/ (before the fixes) into
outputs/static/slither_summary.csv. Each compilation unit is analysed
separately, so a finding in a shared contract appears in several reports;
findings are de-duplicated by detector and description."""

import csv
import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "outputs" / "static"
rows = []
for phase, folder in [("initial", STATIC / "initial"), ("current", STATIC)]:
    seen = {}
    for f in sorted(folder.glob("slither_*.json")):
        for d in json.loads(f.read_text()).get("results", {}).get("detectors", []):
            key = (d["check"], d["description"].strip())
            src = d["elements"][0]["source_mapping"]["filename_relative"] if d.get("elements") else ""
            seen[key] = (d["impact"], d["confidence"], src)
    agg = defaultdict(lambda: [0, set()])
    for (check, _), (impact, conf, src) in seen.items():
        a = agg[(check, impact, conf)]
        a[0] += 1
        a[1].add(Path(src).name)
    for (check, impact, conf), (n, files) in sorted(agg.items()):
        rows.append([phase, check, impact, conf, n, ";".join(sorted(files))])
with open(STATIC / "slither_summary.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["phase", "detector", "impact", "confidence", "unique_findings", "contracts"])
    w.writerows(rows)
for r in rows:
    print(r)
