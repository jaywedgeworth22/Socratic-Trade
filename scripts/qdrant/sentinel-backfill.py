#!/usr/bin/env python3
"""Backfill sentinel payload fields on the Socratic-Trade Qdrant collection.

Four fields were added to the payload schema after the initial Pinecone ->
Qdrant copy (see pinecone-to-qdrant-copy.py) ran, so points copied before the
schema addition are missing them:

    scope             -> "__absent__"
    tenant_scope      -> "__absent__"
    receipt_required  -> false
    as_of_epoch_ms    -> 0

This script never overwrites an existing value.  A point is only touched when
the field key is truly absent from its payload (checked twice: once cheaply
server-side via a scroll `is_empty` filter, then again locally against the
actual fetched payload before any write, so an explicit falsy value already
present -- `false`, `0`, an empty string -- is never mistaken for "missing").

Env: QDRANT_URL, QDRANT_API_KEY
Optional: COLLECTION (default socratic-trade), BACKFILL_STATE (state file),
          BACKFILL_LOG (log file)

Resumable: the scroll cursor is a point-id offset, not an index into filtered
results, so it stays valid even though points drop out of the `is_empty`
filter as they get updated -- resuming from a stale offset just re-scrolls
past already-fixed points, which the local "key not in payload" check then
skips for free.  Checkpoints are only persisted after every batch queued
before that cursor has finished (fetch + set_payload), so a crash never loses
a checkpoint for work that didn't actually complete.

Exits nonzero if any batch still fails after retries.
"""
import json, os, sys, time, threading, queue, argparse
import urllib.request, urllib.error

Q_URL = os.environ["QDRANT_URL"].rstrip("/")
Q_KEY = os.environ["QDRANT_API_KEY"]
COLL = os.environ.get("COLLECTION", "socratic-trade")
STATE_PATH = os.environ.get("BACKFILL_STATE", f"qdrant-sentinel-backfill-state.{COLL}.json")
LOG_PATH = os.environ.get("BACKFILL_LOG", f"qdrant-sentinel-backfill.{COLL}.log")

PAGE_LIMIT = 250
CHECKPOINT_PAGES = 20
WORKERS = 4

# Order matters only for log readability; each field is independent.
SENTINELS = [
    ("scope", "__absent__"),
    ("tenant_scope", "__absent__"),
    ("receipt_required", False),
    ("as_of_epoch_ms", 0),
]

log_lock = threading.Lock()
def log(msg):
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    with log_lock:
        with open(LOG_PATH, "a") as f:
            f.write(line + "\n")

def http(method, url, headers, body=None, tries=5):
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as e:
            code = getattr(e, "code", None)
            if code is not None and 400 <= code < 500 and code != 429:
                raise
            time.sleep(min(2 ** attempt, 20))
    raise RuntimeError(f"retries exhausted: {method} {url.split('?')[0]}")

def qd(method, path, body=None):
    return http(method, Q_URL + path,
                {"api-key": Q_KEY, "Content-Type": "application/json"}, body)

def load_state():
    if os.path.exists(STATE_PATH):
        st = json.load(open(STATE_PATH))
        if st.get("collection", COLL) != COLL:
            sys.exit(f"state file {STATE_PATH} belongs to collection "
                     f"{st.get('collection')}, not {COLL}")
        return st
    return {"collection": COLL,
            "fields": {name: {"done": False, "offset": None, "scanned": 0,
                               "updated": 0, "skipped": 0} for name, _ in SENTINELS}}

def save_state(st):
    tmp = STATE_PATH + ".tmp"
    json.dump(st, open(tmp, "w"))
    os.replace(tmp, STATE_PATH)

def is_empty_filter(field):
    return {"must": [{"is_empty": {"key": field}}]}

def dry_run():
    counts = {}
    for field, default in SENTINELS:
        res = qd("POST", f"/collections/{COLL}/points/count",
                 {"filter": is_empty_filter(field), "exact": True})
        counts[field] = res.get("result", {}).get("count")
        print(f"{field}: {counts[field]} points missing (would set to {default!r})")
    print(json.dumps(counts))

def apply_payload(field, default, ids):
    """Set `field` on `ids`.  On failure, halve and retry (mirrors the copy
    script's halving retry) so one bad point never sinks a whole page."""
    try:
        qd("POST", f"/collections/{COLL}/points/payload?wait=true",
           {"payload": {field: default}, "points": ids})
        return len(ids), []
    except Exception as e:
        if len(ids) <= 1:
            log(f"WRITE-ERROR field={field} id={ids} {type(e).__name__} {getattr(e, 'code', '')}")
            return 0, ids
        mid = len(ids) // 2
        ok1, fail1 = apply_payload(field, default, ids[:mid])
        ok2, fail2 = apply_payload(field, default, ids[mid:])
        return ok1 + ok2, fail1 + fail2

def backfill(fix_missing_only=None):
    st = load_state()
    work_q, err = queue.Queue(maxsize=WORKERS * 2), []
    counts_lock = threading.Lock()

    def worker():
        while True:
            item = work_q.get()
            if item is None:
                return
            field, default, batch = item  # batch: list of (id, payload)
            try:
                missing_ids = [pid for pid, payload in batch if field not in payload]
                ok, failed = (0, []) if not missing_ids else apply_payload(field, default, missing_ids)
                with counts_lock:
                    fst = st["fields"][field]
                    fst["scanned"] += len(batch)
                    fst["updated"] += ok
                    fst["skipped"] += (len(batch) - len(missing_ids)) + len(failed)
                if failed:
                    err.append((field, failed))
            except Exception as e:
                err.append((field, [pid for pid, _ in batch]))
                log(f"WORKER-ERROR field={field} {type(e).__name__} {getattr(e, 'code', '')} batch={len(batch)}")
            finally:
                work_q.task_done()

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(WORKERS)]
    for t in threads:
        t.start()

    def checkpoint(field, offset):
        work_q.join()
        st["fields"][field]["offset"] = offset
        save_state(st)

    for field, default in SENTINELS:
        fst = st["fields"][field]
        if fst["done"]:
            continue
        offset = fst["offset"]
        pages = 0
        while True:
            body = {"filter": is_empty_filter(field), "limit": PAGE_LIMIT,
                     "with_payload": [field], "with_vector": False}
            if offset is not None:
                body["offset"] = offset
            page = qd("POST", f"/collections/{COLL}/points/scroll", body)["result"]
            pts = page.get("points", [])
            if pts:
                batch = [(p["id"], p.get("payload") or {}) for p in pts]
                work_q.put((field, default, batch))
            offset = page.get("next_page_offset")
            pages += 1
            if pages % CHECKPOINT_PAGES == 0:
                checkpoint(field, offset)
                log(f"progress field={field} scanned={fst['scanned']} "
                    f"updated={fst['updated']} skipped={fst['skipped']}")
            if offset is None:
                break
        work_q.join()
        if any(e[0] == field for e in err):
            n = sum(len(e[1]) for e in err if e[0] == field)
            log(f"FIELD-INCOMPLETE {field}: {n} points still failing -- NOT marking done")
            fst["offset"] = None
            save_state(st)
            continue
        fst["done"] = True
        fst["offset"] = None
        save_state(st)
        log(f"field done: {field} scanned={fst['scanned']} updated={fst['updated']} skipped={fst['skipped']}")

    for _ in threads:
        work_q.put(None)
    for t in threads:
        t.join()

    total_failed = sum(len(ids) for _, ids in err)
    report = {name: st["fields"][name] for name, _ in SENTINELS}
    log(f"DONE {json.dumps(report)} failed_points={total_failed}")
    print(json.dumps({"fields": report, "failed_points": total_failed}))
    save_state(st)
    if err:
        sys.exit(1)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="report per-field missing counts only; no writes")
    args = ap.parse_args()
    if args.dry_run:
        dry_run()
    else:
        backfill()

if __name__ == "__main__":
    main()
