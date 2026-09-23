# 2026-08-13 — Alert emails sign off as Socratic-Trade

Owner received Litestream storage-warning mail from `alerts@updates.jays.services` and asked whether Usage Monitor sent it.

It did not.  `notify()` in this repo sent it via Resend.  Subject already had `[Socratic-Trade]`.  The body was title + message only, so the shared From address looked anonymous.

Every Resend body now ends with `(sent by Socratic-Trade)`.

Usage Monitor gets the same footer in a sibling change so a shared From cannot hide either app.
