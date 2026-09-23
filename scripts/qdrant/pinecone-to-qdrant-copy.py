#!/usr/bin/env python3
"""Copy Socratic-Trade vectors from Pinecone to Qdrant.

Owner rule (2026-08-28): copy ALL non-Voyage embeds.  ST's vector-db.ts tags
records with an `embed_model` metadata field; voyage-era records are exactly
the ones WITHOUT it (the voyage query path uses an empty filter), so the copy
keeps records where embed_model exists and is not voyage-*.

Env: PINECONE_API_KEY, QDRANT_URL, QDRANT_API_KEY
Optional: COPY_STATE (state file), COPY_LOG (log file), INDEX_NAME, COLLECTION
Read-only against Pinecone; writes only to the Qdrant collection.

Snapshot semantics: this copies what exists while it runs.  Writes that land in
Pinecone during or after the run are NOT here — point ids are deterministic
(uuid5 of namespace + Pinecone id), so re-running (keep the state file — see
below — or delete it entirely) is an idempotent delta pass.  Run one before
any retrieval cutover.

Cheap delta skip: `done_ns` records the Pinecone vectorCount a namespace had
when it finished, not just its name.  A namespace is only skipped on a later
run if its *current* vectorCount still matches that recorded count — an
unchanged namespace costs one stats lookup, not a full vectors/list+fetch
pass.  A namespace that grew (or is brand new) is rescanned in full; Pinecone
has no "list since timestamp" API, so a grown namespace still costs a full
re-list of its own ids, but every namespace that didn't change is skipped
outright.  This is what makes keeping the state file across runs the right
delta procedure instead of deleting it (deleting it forces a full-corpus
rescan of every namespace, which is only needed for the very first run).

Resumable: pagination state checkpoints only after every queued batch up to
that cursor has completed (fetch + upsert), so a crash never skips records.
Exits nonzero if any batch still fails after retries.
"""
import json, os, sys, time, uuid, threading, queue
import urllib.request, urllib.error, urllib.parse

PC_KEY = os.environ["PINECONE_API_KEY"]
Q_URL = os.environ["QDRANT_URL"].rstrip("/")
Q_KEY = os.environ["QDRANT_API_KEY"]
INDEX = os.environ.get("INDEX_NAME", "socratic-trade")
COLL = os.environ.get("COLLECTION", "socratic-trade")
STATE_PATH = os.environ.get("COPY_STATE", f"qdrant-copy-state.{INDEX}.{COLL}.json")
LOG_PATH = os.environ.get("COPY_LOG", f"qdrant-copy.{INDEX}.{COLL}.log")
# Corpus ids run ~155 chars; Pinecone 414s somewhere above ~8KB of URL.  Budget
# the ENCODED length instead of a fixed count so longer id families can never
# push a fetch back over the limit.
URL_BUDGET = 6000
MAX_IDS = 64
CHECKPOINT_PAGES = 50
WORKERS = 6

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

def pc(method, path, body=None, host=None):
    base = host or "https://api.pinecone.io"
    return http(method, base + path,
                {"Api-Key": PC_KEY, "Content-Type": "application/json",
                 "X-Pinecone-API-Version": "2025-01"}, body)

def qd(method, path, body=None):
    return http(method, Q_URL + path,
                {"api-key": Q_KEY, "Content-Type": "application/json"}, body)

def load_state():
    if os.path.exists(STATE_PATH):
        st = json.load(open(STATE_PATH))
        # Back-compat: older state files recorded done_ns as a flat list (no
        # vectorCount, so we can't tell "unchanged" from "grew").  Treat those
        # namespaces as due for a one-time revalidation rather than trusting
        # them skippable forever.
        if isinstance(st.get("done_ns"), list):
            st["done_ns"] = {ns: None for ns in st["done_ns"]}
        return st
    return {"index": INDEX, "collection": COLL, "done_ns": {}, "current_ns": None,
            "token": None, "scanned": 0, "copied": 0,
            "skipped_no_model": 0, "skipped_voyage": 0}

def save_state(st):
    tmp = STATE_PATH + ".tmp"
    json.dump(st, open(tmp, "w"))
    os.replace(tmp, STATE_PATH)

def to_point(pc_id, values, metadata, ns):
    payload = dict(metadata or {})
    payload["ns"] = ns
    payload["pc_id"] = pc_id
    return {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, "st:" + ns + ":" + pc_id)),
            "vector": values, "payload": payload}

def keep(md):
    m = (md or {}).get("embed_model")
    if not m:
        return "no_model"
    if str(m).lower().startswith("voyage"):
        return "voyage"
    return "keep"

def batches_by_url_budget(ids):
    """Split ids so each fetch URL stays under URL_BUDGET encoded chars."""
    batch, size = [], 0
    for i in ids:
        enc = len(urllib.parse.quote(i)) + 5  # "&ids="
        if batch and (size + enc > URL_BUDGET or len(batch) >= MAX_IDS):
            yield batch
            batch, size = [], 0
        batch.append(i)
        size += enc
    if batch:
        yield batch

def main():
    st = load_state()
    if st.get("index", INDEX) != INDEX or st.get("collection", COLL) != COLL:
        sys.exit(f"state file {STATE_PATH} belongs to "
                 f"{st.get('index')}/{st.get('collection')}, not {INDEX}/{COLL}")
    host = "https://" + pc("GET", f"/indexes/{INDEX}")["host"]
    stats = http("POST", host + "/describe_index_stats",
                 {"Api-Key": PC_KEY, "Content-Type": "application/json",
                  "X-Pinecone-API-Version": "2025-01"}, {})
    namespaces = sorted(stats.get("namespaces", {}).items(),
                        key=lambda kv: kv[1].get("vectorCount", 0))
    log(f"start: {len(namespaces)} namespaces, resume state scanned={st['scanned']}")

    work_q, err = queue.Queue(maxsize=WORKERS * 2), []
    counts_lock = threading.Lock()

    def worker():
        while True:
            item = work_q.get()
            if item is None:
                return
            ns, ids = item
            try:
                qs = "&".join(["ids=" + urllib.parse.quote(i) for i in ids])
                nsq = "&namespace=" + urllib.parse.quote(ns) if ns != "__default__" else ""
                res = http("GET", f"{host}/vectors/fetch?{qs}{nsq}",
                           {"Api-Key": PC_KEY, "X-Pinecone-API-Version": "2025-01"})
                points, n_nm, n_v = [], 0, 0
                for pc_id, rec in (res.get("vectors") or {}).items():
                    k = keep(rec.get("metadata"))
                    if k == "keep":
                        points.append(to_point(pc_id, rec["values"], rec.get("metadata"), ns))
                    elif k == "no_model":
                        n_nm += 1
                    else:
                        n_v += 1
                if points:
                    # wait=true: acknowledged AND applied — a crash after a
                    # checkpoint can then never lose acknowledged points.
                    qd("PUT", f"/collections/{COLL}/points?wait=true", {"points": points})
                with counts_lock:
                    st["scanned"] += len(ids)
                    st["copied"] += len(points)
                    st["skipped_no_model"] += n_nm
                    st["skipped_voyage"] += n_v
            except Exception as e:
                code = getattr(e, "code", "")
                err.append((ns, ids))
                log(f"WORKER-ERROR ns={ns} {type(e).__name__} {code} batch={len(ids)}")
            finally:
                work_q.task_done()

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(WORKERS)]
    for t in threads:
        t.start()

    def checkpoint(ns, token):
        """Persist the cursor only once everything queued before it is done."""
        work_q.join()
        st["current_ns"], st["token"] = ns, token
        save_state(st)

    for ns, meta in namespaces:
        done_count = st["done_ns"].get(ns)
        if done_count is not None and done_count == meta.get("vectorCount", 0):
            continue
        token = st["token"] if st["current_ns"] == ns else None
        pages = 0
        while True:
            nsq = "?limit=99" + ("&namespace=" + urllib.parse.quote(ns) if ns != "__default__" else "")
            if token:
                nsq += "&paginationToken=" + urllib.parse.quote(token)
            page = http("GET", f"{host}/vectors/list{nsq}",
                        {"Api-Key": PC_KEY, "X-Pinecone-API-Version": "2025-01"})
            ids = [v["id"] for v in page.get("vectors", [])]
            for batch in batches_by_url_budget(ids):
                work_q.put((ns, batch))
            token = (page.get("pagination") or {}).get("next")
            pages += 1
            if pages % CHECKPOINT_PAGES == 0:
                checkpoint(ns, token)
                log(f"progress scanned={st['scanned']} copied={st['copied']} "
                    f"no_model={st['skipped_no_model']} voyage={st['skipped_voyage']} ns={ns}")
            if not token:
                break
        work_q.join()
        retries = [b for b in err if b[0] == ns]
        if retries:
            log(f"retrying {len(retries)} failed batches for {ns} in halves")
            err[:] = [b for b in err if b[0] != ns]
            for _, bad in retries:
                half = max(1, len(bad) // 2)
                for j in range(0, len(bad), half):
                    work_q.put((ns, bad[j:j + half]))
            work_q.join()
        if any(b[0] == ns for b in err):
            log(f"NAMESPACE-INCOMPLETE {ns}: "
                f"{sum(1 for b in err if b[0] == ns)} batches still failing — NOT marking done")
            st["current_ns"], st["token"] = None, None
            save_state(st)
            continue
        st["done_ns"][ns] = meta.get("vectorCount", 0)
        st["current_ns"], st["token"] = None, None
        save_state(st)
        if meta.get("vectorCount", 0) > 1000:
            log(f"namespace done: {ns} ({meta.get('vectorCount')} src vectors)")
    work_q.join()
    for _ in threads:
        work_q.put(None)
    final = qd("POST", f"/collections/{COLL}/points/count", {"exact": True})
    incomplete = sorted({b[0] for b in err})
    log(f"DONE scanned={st['scanned']} copied={st['copied']} no_model={st['skipped_no_model']} "
        f"voyage={st['skipped_voyage']} failed_batches={len(err)} "
        f"incomplete_ns={len(incomplete)} qdrant_count={final.get('result', {}).get('count')}")
    save_state(st)
    print(json.dumps({"scanned": st["scanned"], "copied": st["copied"],
                      "skipped_no_model": st["skipped_no_model"],
                      "skipped_voyage": st["skipped_voyage"],
                      "failed_batches": len(err), "incomplete_namespaces": incomplete,
                      "qdrant_count": final.get("result", {}).get("count")}))
    if err:
        sys.exit(1)

if __name__ == "__main__":
    main()
