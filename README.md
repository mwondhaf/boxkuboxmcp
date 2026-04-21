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

## IDs vs slugs

All store-targeting parameters across every tool use **Convex document IDs** (e.g. `n97bctqtnwn501xcvvqc0g1prn80g382`), not human-readable slugs. The discovery tools (`list_nearby_stores`, `search_stores`) return these IDs in the response — pass them directly into downstream tools without any transformation.

| Discovery tool | ID field to capture | Use it in |
|---|---|---|
| `list_nearby_stores` | `storeId` | `create_guest_cart`, `get_store`, `get_store_timings`, `get_delivery_quote` |
| `search_stores` | `_id` | same as above |
| `search_products` | `variantId` | `add_to_cart` |
| `search_products` | `organizationId` | `create_guest_cart` (if product found before store) |

---

## Tool reference

### `list_nearby_stores`

List active stores within 15 km of the customer's location. Each result includes `storeId` — pass it to cart/quote tools.

**Input:**
```json
{ "lat": 0.3476, "lng": 32.5825, "limit": 20 }
```

**Output:** array of stores sorted by open-first then nearest-first.
```json
[
  {
    "storeId": "n97bctqtnwn501xcvvqc0g1prn80g382",
    "name": "Farm Fresh",
    "slug": "farm-fresh-seguku",
    "logo": "https://cdn.boxkubox.com/logos/farm-fresh.jpg",
    "coverPhotoUrl": "https://cdn.boxkubox.com/covers/farm-fresh.jpg",
    "cityOrDistrict": "Kampala",
    "town": "Seguku",
    "street": "Entebbe Road",
    "lat": 0.2601,
    "lng": 32.5765,
    "distanceMeters": 1840,
    "estimatedMinMin": 18,
    "estimatedMaxMin": 27,
    "category": { "_id": "cat123", "name": "Grocery", "slug": "grocery" },
    "isOpen": true,
    "opensAt": "08:00",
    "closesAt": "22:00",
    "isBusy": false,
    "phone": "0200923088",
    "minimumOrderAmount": 5000
  }
]
```

> `phone` is always masked to the BoxKuBox support number. `geohash` is stripped.

---

### `search_stores`

Typesense-backed store search by name. `_id` is the `storeId` to use in downstream tools.

**Input:**
```json
{ "query": "Farm Fresh", "limit": 10 }
```

**Output:**
```json
[
  {
    "_id": "n97bctqtnwn501xcvvqc0g1prn80g382",
    "name": "Farm Fresh",
    "slug": "farm-fresh-seguku",
    "logo": "https://cdn.boxkubox.com/logos/farm-fresh.jpg",
    "cityOrDistrict": "Kampala",
    "isOpen": true
  }
]
```

---

### `search_products`

Typesense-backed product search with typo tolerance. `variantId` is what you pass to `add_to_cart`; `organizationId` is the store's `storeId`.

**Input:**
```json
{ "query": "tilapia", "limit": 10, "customerLat": 0.3476, "customerLng": 32.5825 }
```

**Output:**
```json
[
  {
    "variantId": "m29abc123",
    "productId": "p81xyz456",
    "name": "Tilapia Fillet",
    "imageUrl": "https://cdn.boxkubox.com/products/tilapia.jpg",
    "unit": "500g",
    "price": 12000,
    "salePrice": 10000,
    "currency": "UGX",
    "inStock": true,
    "organizationId": "n97bctqtnwn501xcvvqc0g1prn80g382",
    "organizationName": "Farm Fresh",
    "organizationLogo": "https://cdn.boxkubox.com/logos/farm-fresh.jpg",
    "estimatedMinMin": 18,
    "estimatedMaxMin": 27
  }
]
```

---

### `get_store`

Full store details including operating status, delivery zones, and pricing rules.

**Input:**
```json
{ "storeId": "n97bctqtnwn501xcvvqc0g1prn80g382" }
```

**Output:**
```json
{
  "_id": "n97bctqtnwn501xcvvqc0g1prn80g382",
  "name": "Farm Fresh",
  "slug": "farm-fresh-seguku",
  "logoUrl": "https://cdn.boxkubox.com/logos/farm-fresh.jpg",
  "coverPhotoUrl": "https://cdn.boxkubox.com/covers/farm-fresh.jpg",
  "cityOrDistrict": "Kampala",
  "town": "Seguku",
  "street": "Entebbe Road",
  "lat": 0.2601,
  "lng": 32.5765,
  "timezone": "Africa/Kampala",
  "isActive": true,
  "isBusy": false,
  "isOpen": true,
  "opensAt": "08:00",
  "closesAt": "22:00",
  "minimumOrderAmount": 5000,
  "selfPickupEnabled": false,
  "businessHours": {
    "monday":    { "open": "08:00", "close": "22:00", "isClosed": false },
    "tuesday":   { "open": "08:00", "close": "22:00", "isClosed": false },
    "wednesday": { "open": "08:00", "close": "22:00", "isClosed": false },
    "thursday":  { "open": "08:00", "close": "22:00", "isClosed": false },
    "friday":    { "open": "08:00", "close": "22:00", "isClosed": false },
    "saturday":  { "open": "09:00", "close": "20:00", "isClosed": false },
    "sunday":    { "open": "00:00", "close": "00:00", "isClosed": true }
  },
  "category": { "_id": "cat123", "name": "Grocery", "slug": "grocery" }
}
```

> Returns `null` if the store does not exist or `isActive` is `false`.

---

### `get_store_timings`

Current open/closed status and full weekly schedule. Lighter than `get_store` — use this when you only need availability.

**Input:**
```json
{ "storeId": "n97bctqtnwn501xcvvqc0g1prn80g382" }
```

**Output:**
```json
{
  "_id": "n97bctqtnwn501xcvvqc0g1prn80g382",
  "name": "Farm Fresh",
  "slug": "farm-fresh-seguku",
  "timezone": "Africa/Kampala",
  "isBusy": false,
  "isOpen": true,
  "opensAt": "08:00",
  "closesAt": "22:00",
  "businessHours": {
    "monday":    { "open": "08:00", "close": "22:00", "isClosed": false },
    "tuesday":   { "open": "08:00", "close": "22:00", "isClosed": false },
    "wednesday": { "open": "08:00", "close": "22:00", "isClosed": false },
    "thursday":  { "open": "08:00", "close": "22:00", "isClosed": false },
    "friday":    { "open": "08:00", "close": "22:00", "isClosed": false },
    "saturday":  { "open": "09:00", "close": "20:00", "isClosed": false },
    "sunday":    { "open": "00:00", "close": "00:00", "isClosed": true }
  }
}
```

> Returns `null` if the store does not exist or `isActive` is `false`.

---

### `create_guest_cart`

Create a new cart for a specific store. **Store `cartId` and `sessionId` against the conversation** — both are required for every subsequent cart and order call.

**Input:**
```json
{ "storeId": "n97bctqtnwn501xcvvqc0g1prn80g382", "currencyCode": "UGX" }
```

**Output:**
```json
{
  "cartId": "k17def789",
  "sessionId": "mcp_a1b2c3d4e5f6",
  "storeId": "n97bctqtnwn501xcvvqc0g1prn80g382",
  "storeName": "Farm Fresh"
}
```

---

### `get_cart`

Fetch the current state of a cart including all line items and totals.

**Input:**
```json
{ "cartId": "k17def789" }
```

**Output:**
```json
{
  "_id": "k17def789",
  "sessionId": "mcp_a1b2c3d4e5f6",
  "organizationId": "n97bctqtnwn501xcvvqc0g1prn80g382",
  "currencyCode": "UGX",
  "expiresAt": 1714000000000,
  "subtotal": 20000,
  "itemCount": 2,
  "items": [
    {
      "_id": "ci001",
      "cartId": "k17def789",
      "variantId": "m29abc123",
      "quantity": 2,
      "variant": {
        "_id": "m29abc123",
        "sku": "FF-TIL-500",
        "unit": "500g",
        "isAvailable": true
      },
      "product": {
        "_id": "p81xyz456",
        "name": "Tilapia Fillet",
        "slug": "tilapia-fillet"
      },
      "price": 12000,
      "salePrice": 10000,
      "effectivePrice": 10000,
      "currency": "UGX",
      "subtotal": 20000
    }
  ]
}
```

---

### `add_to_cart`

Add a product variant to a cart (or increment its quantity if already present). Returns the updated cart in the same shape as `get_cart`.

**Input:**
```json
{ "cartId": "k17def789", "variantId": "m29abc123", "quantity": 2 }
```

---

### `update_cart_item`

Update the quantity of an item already in the cart. Returns the updated cart.

**Input:**
```json
{ "cartId": "k17def789", "variantId": "m29abc123", "quantity": 1 }
```

---

### `remove_from_cart`

Remove an item from the cart entirely. Returns the updated cart.

**Input:**
```json
{ "cartId": "k17def789", "variantId": "m29abc123" }
```

---

### `get_delivery_quote`

Fare preview before checkout. Always call this so the customer sees the full cost.

**Input:**
```json
{
  "storeId": "n97bctqtnwn501xcvvqc0g1prn80g382",
  "lat": 0.3476,
  "lng": 32.5825,
  "orderSubtotal": 20000,
  "isExpress": false
}
```

**Output (delivery available):**
```json
{
  "available": true,
  "distanceKm": 1.84,
  "storeName": "Farm Fresh",
  "estimatedDeliveryTime": { "minMinutes": 18, "maxMinutes": 27 },
  "fare": {
    "baseFare": 2000,
    "distanceFare": 1000,
    "surgeFare": 0,
    "smallOrderFee": 1500,
    "expressFee": 0,
    "heavyItemFee": 0,
    "discount": 0,
    "total": 4500,
    "currency": "UGX",
    "isFreeDelivery": false
  }
}
```

**Output (out of range):**
```json
{
  "available": false,
  "reason": "Delivery address is too far (17.2km). Maximum is 15km.",
  "distanceKm": 17.2
}
```

> Surge pricing applies at peak hours: morning rush 07–09 (1.3×), lunch 12–14 (1.2×), evening 17–20 (1.4×), late night 22–05 (1.5×). A small-order fee of UGX 1,500 is added for orders under UGX 15,000. Free delivery for orders over UGX 100,000.

---

### `place_guest_order`

Place a cash-on-delivery order. **Store `orderId` and `rememberPhone` on the conversation** — both are needed for `check_order_status`.

**Input:**
```json
{
  "cartId": "k17def789",
  "sessionId": "mcp_a1b2c3d4e5f6",
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

**Output:**
```json
{
  "orderId": "j01ghi012",
  "displayId": 1042,
  "total": 24500,
  "itemCount": 2,
  "rememberPhone": "+256772123456",
  "paymentMethod": "cash_on_delivery"
}
```

> Phone numbers accept any Ugandan format — `0772123456`, `+256772123456`, `256 772 123 456` — and are normalised to E.164 before hitting Convex. Non-UG or landline numbers are rejected.
>
> The cart is deleted after a successful order. Do not reuse `cartId`.

---

### `check_order_status`

Phone-match authorization — returns `null` if the phone does not match the order.

**Input:**
```json
{ "orderId": "j01ghi012", "phone": "+256772123456" }
```

**Output:**
```json
{
  "_id": "j01ghi012",
  "displayId": 1042,
  "status": "confirmed",
  "fulfillmentStatus": "in_progress",
  "paymentStatus": "awaiting",
  "paymentMethod": "cash_on_delivery",
  "fulfillmentType": "delivery",
  "currencyCode": "UGX",
  "subtotal": 20000,
  "deliveryTotal": 4500,
  "total": 24500,
  "guestName": "Alice Nakato",
  "guestPhone": "+256772123456",
  "deliveryLocation": {
    "lat": 0.3476,
    "lng": 32.5825,
    "phone": "+256772123456",
    "description": "Green gate next to KFC"
  },
  "riderName": "David Ssemakula",
  "riderPhone": "0200923088",
  "items": [
    { "title": "Tilapia Fillet - 500g", "quantity": 2, "unitPrice": 10000, "subtotal": 20000 }
  ],
  "storeName": "Farm Fresh",
  "createdAt": 1713990000000
}
```

> `riderPhone` is always masked to the BoxKuBox support number.

**Possible `status` values:** `pending` → `confirmed` → `completed` / `cancelled`

**Possible `fulfillmentStatus` values:** `not_fulfilled` → `in_progress` → `fulfilled`

---

### `list_my_orders`

Recent orders for a phone number, newest first.

**Input:**
```json
{ "phone": "+256772123456", "limit": 10 }
```

**Output:**
```json
[
  {
    "_id": "j01ghi012",
    "displayId": 1042,
    "status": "confirmed",
    "total": 24500,
    "currencyCode": "UGX",
    "createdAt": 1713990000000
  },
  {
    "_id": "j00abc999",
    "displayId": 1031,
    "status": "completed",
    "total": 18000,
    "currencyCode": "UGX",
    "createdAt": 1713800000000
  }
]
```

---

## Typical flow

1. User shares their location with the bot (WhatsApp location message, Telegram location share).
2. Bot calls `list_nearby_stores` with `{ lat, lng }` → captures `storeId` from each result.
3. User picks a store → bot calls `get_store` with `{ storeId }` to show categories / popular items, or calls `search_products` with the user's query.
4. Bot calls `create_guest_cart` with `{ storeId }` → stores `{ cartId, sessionId }` against the chat.
5. User adds items → bot calls `add_to_cart` with `variantId` from the search results.
6. Bot calls `get_delivery_quote` with `{ storeId, lat, lng, orderSubtotal }` to show the total before checkout.
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

Any container platform works — Fly.io, Railway, Render, a plain VPS behind Caddy. The server is stateless apart from in-memory session transports; no sticky sessions are required as long as each chat conversation talks to the same instance. If you scale out, ensure session affinity (hash on `Mcp-Session-Id`).

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
| `Store not found: <id>` | Store does not exist in this deployment, or its `isActive` flag is `false` — check the Convex dashboard |
| `Invalid Uganda phone number` | Non-UG number or landline — only mobile `+2567XXXXXXXX` accepted |
| `Cart does not belong to this session` | `sessionId` doesn't match the one returned by `create_guest_cart` |
| `Delivery address is outside the 15km delivery zone` | Drop-off too far from store; offer a different store |
| `Store is currently not accepting orders` | Vendor has paused their store (`isBusy` flag) |

---

## License

Internal BoxConv project — not for redistribution.
