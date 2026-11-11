"""Final layout step 1: every $ref occurrence in the schema tree, with its JSON pointer.

Usage: python3 -I -B edges_final.py <schema source dir>
Writes raw/edges.csv (src, dst, ptr, path, under_experimental) and raw/source.json (file list and counts).
FINAL_REF in the environment names the commit the tree was exported from (recorded as `head`).
Placement-independent: later steps label the ends.
"""
import csv
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common_final import RAW, dump, load_schemas, prop_path, ref_occurrences  # noqa: E402

SRC = sys.argv[1]
os.makedirs(RAW, exist_ok=True)
files = load_schemas(SRC)
occ = ref_occurrences(files)
with open(os.path.join(RAW, "edges.csv"), "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["src", "dst", "ptr", "path", "under_experimental"])
    for s, d, ptr, exp in sorted(occ):
        w.writerow([s, d, ptr, prop_path(ptr), exp or ""])
head = os.environ.get("FINAL_REF")
if not head:
    try:
        head = subprocess.run(["git", "-C", SRC, "rev-parse", "--short=10", "HEAD"], capture_output=True,
                              text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        head = "unknown"
experimental = sorted(p for p, d in files.items() if isinstance(d, dict) and d.get("x-status") == "experimental")
dump({"source": "static/schemas/source", "head": head, "files": sorted(files), "file_count": len(files),
      "ref_occurrences": len(occ), "file_edges": len({(s, d) for s, d, _, _ in occ}),
      "experimental_files": experimental}, os.path.join(RAW, "source.json"))
print(f"source {head}: {len(files)} files, {len(occ)} $ref occurrences, "
      f"{len({(s, d) for s, d, _, _ in occ})} file edges")
