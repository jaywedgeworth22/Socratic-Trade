# Robinhood MCP OAuth & Connection Guide

This document is the definitive guide for configuring, connecting, and maintaining Robinhood MCP OAuth connections in **Socratic-Trade**.

---

## 1. Architecture Overview

Robinhood integration uses the official **Robinhood Model Context Protocol (MCP) Trading Server** (`https://agent.robinhood.com/mcp/trading`).

- **OAuth Discovery**: `https://agent.robinhood.com/.well-known/oauth-protected-resource/mcp/trading` and `https://agent.robinhood.com/mcp/trading/.well-known/oauth-authorization-server`
- **Dynamic Client Registration**: RFC 7591 (`https://agent.robinhood.com/oauth/trading/register`)
- **Protocol**: OAuth 2.0 with PKCE (S256), scope `internal` (or `tools:call`), resource `https://agent.robinhood.com/mcp/trading`
- **Token Persistence**: Access & Refresh tokens are encrypted and stored in SQLite `settings` table (`/app/data/app.db`) under key `robinhood_mcp_oauth_token:<userId>`.

---

## 2. Why Connection Attempts Landed on `robinhood.com/oauth/error`

Robinhood's OAuth authorization server (`https://robinhood.com/oauth`) enforces strict redirect security:

1. **Unregistered Dynamic Clients**: When using dynamic registration without a pre-approved partner Client ID, Robinhood's server policy **requires loopback redirect URIs** (`http://localhost:...`, RFC 8252) and **rejects third-party public HTTPS redirect URIs** (`https://socratictrade.com/...`).
2. **Failure Symptom**: The authorization page loads and sends a 2FA push notification to the user's Robinhood iOS/Android app. At the exact moment the user approves the push notification, Robinhood's backend validates the redirect URI, rejects public HTTPS URLs, and redirects the browser to `https://robinhood.com/oauth/error` ("Uh oh! Something's gone wrong").

---

## 3. Zero-SSH / No-Tunnel Connection Options (Solution 3)

When Robinhood redirects the browser to `http://localhost:4000/api/auth/robinhood/callback?code=...&state=...`, the browser displays **"Safari Can't Connect to the Server 'localhost'"**.

You do **NOT** need SSH tunnels or root server access to complete the flow. Use either of these two methods:

### Method A: Address Bar Edit (Easiest)
1. When Safari shows *"Safari Can't Connect to the Server 'localhost'"*, look at the address bar:
   `http://localhost:4000/api/auth/robinhood/callback?code=AUTH_CODE&state=STATE`
2. Replace `http://localhost:4000` with `https://socratictrade.com`:
   `https://socratictrade.com/api/auth/robinhood/callback?code=AUTH_CODE&state=STATE`
3. Hit **Enter**.
4. The production app receives `code` & `state`, exchanges them for tokens, stores them in `app.db`, and completes the connection.

### Method B: Copy/Paste Callback URL in App UI or API
1. Copy the failed `http://localhost:4000/api/auth/robinhood/callback?code=...&state=...` URL from your address bar.
2. Submit a `POST /api/auth/robinhood/callback` request with body:
   ```json
   {
     "url": "http://localhost:4000/api/auth/robinhood/callback?code=...&state=..."
   }
   ```
   Or paste it into the **Paste Callback URL** field on the Connections page.
3. The backend extracts `code` & `state`, validates PKCE state, stores the tokens, and returns `{ "ok": true, "connected": true }`.

---

## 4. Automatic Background Token Maintenance

Once tokens are stored in SQLite:
- **Server-to-Server Refresh**: The background strategy loop, portfolio engine, and health checks use `refreshMcpAccessToken`.
- **No Browser Needed**: Token refresh makes direct HTTP POST calls to `https://api.robinhood.com/oauth2/token/`. **No browser interaction or redirect URIs are required once connected.**
- **Persistence**: Robinhood remains connected indefinitely unless explicitly deleted.

---

## 5. How to Register an Official Static Partner Client ID with Robinhood

To allow end-users to connect directly from `https://socratictrade.com` in 1 click without loopbacks or manual URL copy/paste:

1. **Submit Developer Application**: Contact Robinhood API Developer Support (`mcp-support@robinhood.com` or `developer.robinhood.com`).
2. **Provide Application Details**:
   - **Application Name**: `Socratic-Trade`
   - **Redirect URI**: `https://socratictrade.com/api/auth/robinhood/callback`
   - **Requested Scopes**: `internal`, `tools:call`
   - **Resource**: `https://agent.robinhood.com/mcp/trading`
3. **Configure Secrets**:
   Once Robinhood approves the application and issues a Client ID & Secret:
   - Set `ROBINHOOD_MCP_CLIENT_ID=<issued_client_id>`
   - Set `ROBINHOOD_MCP_CLIENT_SECRET=<issued_client_secret>`
   - Set `ROBINHOOD_MCP_REDIRECT_URI=https://socratictrade.com/api/auth/robinhood/callback`
   - Set `ROBINHOOD_MCP_ALLOW_LOOPBACK_REDIRECT=off`
4. **Result**: All users can connect with 1 click directly on `socratictrade.com` with zero SSH or loopback requirements.
