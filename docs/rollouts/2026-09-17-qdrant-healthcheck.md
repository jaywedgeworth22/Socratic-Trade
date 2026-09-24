# 2026-09-17 - qdrant-healthcheck

## Summary
Added a Docker `HEALTHCHECK` to the `qdrant-st` Coolify service to resolve the `running:unknown` status on the ST admin pages.

## Why
Coolify parses Docker's health status to report service health in its API (`running:healthy`, `running:unhealthy`, `running:unknown`). The Qdrant image (`qdrant/qdrant:v1.19.0`) does not include a `HEALTHCHECK` instruction by default. As a result, ST admin pages rendered Qdrant as `running:unknown`.

## Changes Made
- Patched the Coolify PostgreSQL database (`services` table) for `qdrant-st` to include a custom healthcheck.
- Updated the local `/data/coolify/services/ookh0qmlgrbxlwbbe6lolx6g/docker-compose.yml` on the Hetzner host to match and restarted the container.
- Because the Qdrant image is minimal and lacks `curl` or `wget`, the healthcheck uses bash's built-in `/dev/tcp` to send an HTTP GET request to Qdrant's `/healthz` endpoint:
  ```yaml
  healthcheck:
    test: ["CMD", "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/6333; echo -e \"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n\" >&3; cat <&3 | grep -q '200 OK'"]
    interval: 10s
    timeout: 5s
    retries: 3
  ```

## Verification
- `docker ps` on the Hetzner box now shows the container as `(healthy)`.
- The Socratic-Trade admin page `/admin` should now correctly reflect Qdrant's status as `running:healthy`.
