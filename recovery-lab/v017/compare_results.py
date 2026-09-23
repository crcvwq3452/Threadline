#!/usr/bin/env python3
import argparse, json, pathlib

def mark(case):
    ev=case.get("evaluation",{})
    return ("PASS" if ev.get("pass") else "MISS", ev.get("rank"), "; ".join(ev.get("reasons") or []))

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--threadline",required=True)
    ap.add_argument("--hindsight",required=True)
    ap.add_argument("--output",required=True)
    args=ap.parse_args()
    t=json.loads(pathlib.Path(args.threadline).read_text())
    h=json.loads(pathlib.Path(args.hindsight).read_text())
    tm={c["id"]:c for c in t["cases"]}
    hm={c["id"]:c for c in h["cases"]}
    ids=list(dict.fromkeys([*(c["id"] for c in t["cases"]),*(c["id"] for c in h["cases"])]))
    lines=[
      "# Retrieval Lab v0.17",
      "",
      "Synthetic fixture only. No private corpus content is used.",
      "",
      "| Case | Threadline v0.16 | Hindsight 0.10.1 | Notes |",
      "|---|---:|---:|---|",
    ]
    for cid in ids:
      tc, hc=tm.get(cid,{}),hm.get(cid,{})
      ts,tr,tn=mark(tc); hs,hr,hn=mark(hc)
      notes=" / ".join(x for x in [tn,hn] if x)
      lines.append(f"| {cid} | {ts} (rank {tr}) | {hs} (rank {hr}) | {notes} |")
    lines += [
      "",
      f"Threadline: **{t['summary']['passed']}/{t['summary']['total']}** fixture invariants.",
      f"Hindsight: **{h['summary']['passed']}/{h['summary']['total']}** fixture invariants.",
      "",
      "## Interpretation guardrails",
      "",
      "- This is a retrieval torture test, not a product popularity score.",
      "- Threadline is exercised as the real built MV3 extension with its real local embeddings.",
      "- Hindsight is exercised with LLM provider disabled, so ingestion uses chunk mode and no extraction model rewrites the fixture.",
      "- Current-session exclusion is applied in the bridge layer for Threadline and as a native NOT tag filter for Hindsight.",
      "- A later LLM/observation benchmark, if run, must remain separate from this raw-evidence benchmark.",
    ]
    pathlib.Path(args.output).write_text("\n".join(lines)+"\n",encoding="utf-8")
    print("\n".join(lines))

if __name__=="__main__":
    main()
