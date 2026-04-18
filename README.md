# boxconv-mcp

MCP server that exposes BoxConv's guest ordering flow (product search, cart, checkout, order status) to AI assistants and chat-bot gateways such as WhatsApp and Telegram.

No end-user authentication is required — guests are identified by their Ugandan mobile phone number plus a server-issued session ID. Payment is cash-on-delivery.

---

## Architecture

```
 ┌────────────┐    HTTPS    ┌──────────────┐    Convex     ┌─────────────┐
 │ Chat bot   │ ─────────── │ boxconv-mcp  │ ───────────── │ Convex prod │
 │ (WA / TG)  │  Bearer+JSON│ (Bun server) │  HTTP client  │ (orders DB) │
 └────────────┘             └──────────────┘               └─────────────┘
```

- The bot is a separate service you run (Node, Python, anything). It owns the chat transport.
- `boxconv-mcp` is a single stateless HTTP endpoint that speaks the MCP Streamable HTTP protocol.
- The bot authenticates to the MCP server with a shared `Bearer` token. Users never see this token.
- Each MCP session corresponds to one conversation. The session ID is returned on first call and must be echoed on every subsequent request in the `Mcp-Session-Id` header.

---

## Prerequisites

- [Bun](https://bun.sh) 1.x
- A BoxConv Convex deployment (schema must include the guest-order additions — deployed via `npx convex deploy` from the boxconv repo).
- A strong random string for `MCP_CLIENT_SECRET` (32+ chars).

---

## Setup

```bash
cd boxconv-mcp
bun install
cp .env.example .env
# fill in CONVEX_URL, MCP_CLIENT_SECRET
bun run dev      # hot-reload
# or
bun run start    # production
```

The server listens on `PORT` (default 3000) at `/mcp` for MCP traffic and `/health` for liveness checks.

---

## Environment

| Variable | Required | Description |
|---|---|---|
| `CONVEX_URL` | yes | Convex deployment URL, e.g. `https://healthy-iguana-292.convex.cloud` |
| `MCP_CLIENT_SECRET` | yes | Shared secret between your bot and this server. Used as `Authorization: Bearer <secret>`. |
| `PORT` | no | HTTP port. Default `3000`. |
| `ALLOWED_ORIGINS` | no | Comma-separated CORS origins for browser-based MCP clients. Leave empty for server-to-server use. |

---

## Authentication

Every request to `/mcp` must carry:

```
Authorization: Bearer <MCP_CLIENT_SECRET>
```

This is caller-level auth (bot → MCP). It is **not** end-user auth. There is no user token because guests do not log in. The user's identity is established per-request by the phone number they provide when placing an order.

Requests without the correct header return `401 Unauthorized`.

---

## Session lifecycle

1. Bot sends first MCP request (typically `initialize`) with no `Mcp-Session-Id` header.
2. Server creates a transport, returns a session ID in the `Mcp-Session-Id` response header.
3. Bot stores the session ID keyed to the chat (WhatsApp `wa_id`, Telegram `chat_id`, etc.) and sends it back on every subsequent request for that conversation.
4. When the conversation ends, let the session go idle. Transports are discarded on close.

A separate **cart session** (different thing) is created via the `create_guest_cart` tool — that session ID lives inside the tool arguments and ties a cart to an order.

---

## Tool reference

### Discovery

#### `list_nearby_stores`
List active stores. Pair with `get_delivery_quote` to confirm coverage.
```json
{ "lat": 0.3476, "lng": 32.5825, "limit": 20 }
```

#### `search_products`
Typesense-backed product search with typo tolerance.
```json
{ "query": "pizza", "limit": 10, "customerLat": 0.3476, "customerLng": 32.5825 }
```

#### `search_stores`
Typesense-backed store search by name.
```json
{ "query": "Cafe Javas", "limit": 10 }
```

#### `get_store`
Full store details including delivery zones, categories, pricing rules.
```json
{ "organizationId": "j57..." }
```

### Cart

#### `create_guest_cart`
Create a new cart for a specific store. Returns `{ cartId, sessionId }`. **Keep the `sessionId` for the duration of the conversation.**
```json
{ "organizationId": "j57...", "currencyCode": "UGX" }
```

#### `get_cart` / `add_to_cart` / `update_cart_item` / `remove_from_cart`
Standard cart operations. All take `cartId`. Variant-level operations take `variantId`.

### Checkout

#### `get_delivery_quote`
Fare preview for a specific store + drop-off location.
```json
{
  "organizationId": "j57...",
  "lat": 0.3476,
  "lng": 32.5825,
  "orderSubtotal": 15000,
  "isExpress": false
}
```

#### `place_guest_order`
Place a cash-on-delivery order. Returns `{ orderId, displayId, total, rememberPhone }`. **Store `orderId` + `rememberPhone` on the conversation** — both are needed to check status later.
```json
{
  "cartId": "k17...",
  "sessionId": "mcp_...",
  "guestName": "Alice Nakato",
  "guestPhone": "0772123456",
  "deliveryLat": 0.3476,
  "deliveryLng": 32.5825,
  "deliveryPhone": "0772123456",
  "deliveryDescription": "Green gate next to KFC",
  "fulfillmentType": "delivery",
  "notes": "Please bring change for UGX 20,000",
  "source": "whatsapp"
}
```

Phone numbers accept any Ugandan format — `0772123456`, `+256772123456`, `256 772 123 456` — and are normalised to E.164 (`+256772123456`) before hitting Convex. Non-UG or landline numbers are rejected.

### Post-checkout

#### `check_order_status`
Phone-match authorization. Returns `null` if the phone does not match the order.
```json
{ "orderId": "j01...", "phone": "+256772123456" }
```

#### `list_my_orders`
Recent orders for a phone number.
```json
{ "phone": "+256772123456", "limit": 10 }
```

---

## Typical flow

1. User shares their location with the bot (WhatsApp location message, Telegram location share).
2. Bot calls `list_nearby_stores` with `{ lat, lng }`, picks the most relevant few and presents them to the user.
3. User picks a store → bot calls `get_store` to show categories / popular items, or `search_products` scoped later.
4. Bot calls `create_guest_cart` → stores `{ cartId, sessionId }` against the chat.
5. User adds items → bot calls `add_to_cart` for each.
6. Bot calls `get_delivery_quote` to show the total before checkout.
7. Bot collects name + phone (and delivery description if any) from the user.
8. Bot calls `place_guest_order` with the captured data and `source: "whatsapp"` or `"telegram"`. Stores the returned `orderId` + phone.
9. (Optional) Bot polls `check_order_status` every ~30s while the order is active and pushes updates to the user.

---

## Channel integrations

The MCP server is channel-agnostic. A minimal bot needs to do three things:

1. Extract location from the chat platform's location-share payload.
2. Extract phone from a "share contact" flow (or ask the user to type it).
3. Pass `source: "<channel>"` on `place_guest_order` so the vendor dashboard shows the order's origin.

### WhatsApp (Cloud API)
- Location → webhook payload `messages[0].location.latitude` / `.longitude`.
- Phone → either ask the user, or prefill from `messages[0].from` (already E.164).

### Telegram (Bot API)
- Location → update payload `message.location.latitude` / `.longitude`.
- Phone → `sendContact` button (`KeyboardButton` with `request_contact: true`) → `message.contact.phone_number`.

### Other (SMS gateway, Slack, etc.)
- Anything that can deliver lat/lng + a UG phone works. Pass `source: "api"` or a custom label.

---

## Deployment

### Docker

```bash
bun install          # generate bun.lock
docker build -t boxconv-mcp .
docker run --rm -p 3000:3000 \
  -e CONVEX_URL=https://xxxxx.convex.cloud \
  -e MCP_CLIENT_SECRET=$(openssl rand -hex 32) \
  boxconv-mcp
```

Image runs as the non-root `bun` user, exposes `3000/tcp`, and includes a healthcheck against `/health`.

### Hosting

Any container platform works — Fly.io, Railway, Render, fly.io machines, a plain VPS behind Caddy. The server is stateless apart from in-memory session transports; no sticky sessions are required as long as each chat conversation talks to the same instance. Running a single instance is fine until traffic justifies more; if you scale out, ensure session affinity (hash on `Mcp-Session-Id`).

### TLS

Always put the server behind TLS (reverse proxy or platform-level termination). The `Authorization` header carries the shared secret in plaintext over the wire.

---

## Operations

### Rate limits

Convex enforces a per-phone rate limit on order creation (10/min token bucket). The MCP server itself does not rate-limit beyond what Convex does — add a reverse-proxy rate limit if abuse becomes an issue.

### Abuse protection

No OTP is required for guest orders. The vendor's manual confirmation call (placed after the order is accepted in the vendor dashboard) is the final fraud gate. Guest orders surface with a `Guest · <source>` badge in the vendor dashboard so staff know to verify before prep.

### Observability

`stdout` only. Pipe to your logging stack. Each request logs errors via `console.error`; MCP success paths are silent by default.

---

## Security notes

- **Never expose `MCP_CLIENT_SECRET` to user-facing clients.** It is a server-to-server credential.
- The server does **not** validate that the phone number used at checkout matches any external channel identity. A malicious bot caller could set any phone. Vendor-side manual verification is the control.
- `CORS` is locked to `ALLOWED_ORIGINS`. Leave empty for server-to-server deployments.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `401 Unauthorized` | Missing or wrong `Authorization` header |
| `Invalid Uganda phone number` | Non-UG number or landline — only mobile `+2567XXXXXXXX` accepted |
| `Cart does not belong to this session` | `sessionId` doesn't match the one returned by `create_guest_cart` |
| `Delivery address is outside the 15km delivery zone` | Drop-off too far from store; offer a different store |
| `Store is currently not accepting orders` | Vendor has paused their store (`isBusy` flag) |

---

## License

Internal BoxConv project — not for redistribution.
# boxkuboxmcp
