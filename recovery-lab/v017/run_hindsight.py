#!/usr/bin/env python3
import argparse, json, pathlib, time
from dataclasses import asdict, is_dataclass

from hindsight_client import Hindsight

BANK = "threadline-v017-retrieval-lab"

def plain(v):
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if is_dataclass(v):
        return asdict(v)
    if hasattr(v, "model_dump"):
        return v.model_dump()
    if isinstance(v, dict):
        return {str(k): plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [plain(x) for x in v]
    return str(v)

def score_dict(result):
    s = getattr(result, "scores", None)
    return plain(s) if s is not None else None

def summarize_result(r):
    return {
        "document_id": getattr(r, "document_id", None),
        "text": getattr(r, "text", ""),
        "type": getattr(r, "type", None),
        "tags": plain(getattr(r, "tags", None)),
        "metadata": plain(getattr(r, "metadata", None)),
        "scores": score_dict(r),
    }

def evaluate(query, rows):
    ids = [r["document_id"] for r in rows]
    expected = query.get("expected", [])
    rank = None
    for target in expected:
        if target in ids:
            rr = ids.index(target) + 1
            rank = rr if rank is None else min(rank, rr)
    ok = True
    reasons = []
    if query.get("must_top1") and rank != 1:
        ok = False
        reasons.append(f"expected top1, got rank={rank}")
    if query.get("must_top5") and (rank is None or rank > 5):
        ok = False
        reasons.append(f"expected top5, got rank={rank}")
    expected_all = query.get("expected_all_top5", [])
    if expected_all:
        top5 = set(ids[:5])
        missing = [target for target in expected_all if target not in top5]
        if missing:
            ok = False
            reasons.append(f"expected all in top5, missing={missing}")
    forbid = query.get("forbid_text")
    if forbid and any(forbid in (r.get("text") or "") for r in rows):
        ok = False
        reasons.append(f"forbidden stale text returned: {forbid}")
    excluded = query.get("exclude_session")
    if excluded:
        tag = f"session:{excluded}"
        if any(tag in (r.get("tags") or []) for r in rows):
            ok = False
            reasons.append(f"excluded session leaked: {excluded}")
    return {"pass": ok, "rank": rank, "reasons": reasons}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixture", required=True)
    ap.add_argument("--url", default="http://127.0.0.1:8888")
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    fixture = json.loads(pathlib.Path(args.fixture).read_text(encoding="utf-8"))
    outpath = pathlib.Path(args.output)
    outpath.parent.mkdir(parents=True, exist_ok=True)

    client = Hindsight(base_url=args.url)

    # Best-effort clean start. The bank may not exist.
    try:
        import requests
        requests.delete(f"{args.url}/v1/default/banks/{BANK}", timeout=10)
    except Exception:
        pass

    # Explicitly exercise stable-document replacement before loading the final fixture.
    client.retain_batch(
        bank_id=BANK,
        items=[{
            "content": "STALE_VERSION_SENTINEL_119 is the obsolete pre-update form and must disappear after replacement.",
            "timestamp": "2026-08-19T12:00:00Z",
            "context": "synthetic retrieval lab message",
            "metadata": {"message_id": "lab-update-target", "version": "stale"},
            "tags": ["session:openai:lab-update", "branch:active", "source:archive"],
            "document_id": "lab-update-target",
        }],
    )

    items = []
    for d in fixture["documents"]:
        items.append({
            "content": d["content"],
            "timestamp": d["timestamp"],
            "context": "synthetic retrieval lab message",
            "metadata": {
                "message_id": d["id"],
                "session_id": d["session_id"],
                "branch": d["branch"],
                "source": d["source"],
            },
            "tags": [
                f"session:{d['session_id']}",
                f"branch:{d['branch']}",
                f"source:{d['source']}",
            ],
            "document_id": d["id"],
            **({"entities": [{"text": e, "type": "CONCEPT"} for e in d.get("entities", [])], "resolve_entities": False} if d.get("entities") else {}),
        })
    client.retain_batch(bank_id=BANK, items=items)

    results = {
        "engine": "hindsight",
        "mode": "llm-provider-none / automatic chunks mode",
        "bank": BANK,
        "query_timestamp": "2026-09-22T12:00:00Z",
        "cases": [],
    }

    for q in fixture["queries"]:
        kwargs = {
            "bank_id": BANK,
            "query": q["query"],
            "budget": "high",
            "max_tokens": 4096,
            "query_timestamp": "2026-09-22T12:00:00Z",
        }
        if q.get("temporal_window"):
            kwargs["temporal_window"] = q["temporal_window"]
        excluded = q.get("exclude_session")
        if excluded:
            kwargs["tag_groups"] = [{
                "not": {
                    "tags": [f"session:{excluded}"],
                    "match": "any_strict",
                }
            }]
        response = client.recall(**kwargs)
        rows = [summarize_result(r) for r in response.results]
        ev = evaluate(q, rows)
        case = {
            "id": q["id"],
            "query": q["query"],
            "expected": q.get("expected"),
            "exclude_session": q.get("exclude_session"),
            "evaluation": ev,
            "results": rows[:10],
        }
        results["cases"].append(case)
        print(json.dumps({
            "engine": "hindsight",
            "case": q["id"],
            "pass": ev["pass"],
            "rank": ev["rank"],
            "top": [r["document_id"] for r in rows[:5]],
            "reasons": ev["reasons"],
        }, ensure_ascii=False))

    results["summary"] = {
        "passed": sum(1 for c in results["cases"] if c["evaluation"]["pass"]),
        "total": len(results["cases"]),
        "failed_cases": [c["id"] for c in results["cases"] if not c["evaluation"]["pass"]],
    }
    outpath.write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

if __name__ == "__main__":
    main()
