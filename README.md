# boxconv-mcp

MCP server that exposes BoxConv's guest ordering flow to AI assistants and chat-bot gateways such as WhatsApp and Telegram. It covers the whole order journey: **look up a customer by phone** (returning customers get their name, reusable delivery locations, and recent orders), **resolve a spoken address** to coordinates, find a store, build a cart, quote the delivery fee, and place a cash-on-delivery order.

No end-user authentication is required — guests are identified by their Ugandan mobile phone number plus a server-issued session ID. Payment is cash-on-delivery.

Connect this to Claude (or any MCP client) and an operator can take an order end-to-end while a customer is on a call or on WhatsApp. The server ships an `instructions` block describing the journey, so the client knows the recommended tool order.

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
| `GOOGLE_API_KEY` | yes | Google Maps key (Places + Geocoding). Validated at startup — the server **will not boot without it**. See note below. |
| `PORT` | no | HTTP port. Default `3000`. |
| `ALLOWED_ORIGINS` | no | Comma-separated CORS origins for browser-based MCP clients. Leave empty for server-to-server use. |

> **Important — `GOOGLE_API_KEY` is needed in two places.** The geocoding tools (`find_address`, `resolve_address`, `reverse_geocode`) run as Convex **actions**, so the key is actually consumed by the Convex deployment, not by this process. This server still requires the var at startup so a container can't be deployed without it — but you must **also** set the same key in Convex for those tools to work:
>
> ```bash
> npx convex env set GOOGLE_API_KEY <your-key>   # in the boxconv repo
> ```

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
| `search_store_products` | `variantId` | `add_to_cart` |
| `list_store_categories` | `categoryId` | `list_category_products` |
| `list_category_products` | `variantId` | `add_to_cart` |
| `lookup_customer` | `savedLocations[].lat/lng` | `preview_order`, `place_guest_order` |
| `resolve_address` / `reverse_geocode` | `lat` / `lng` | `preview_order`, `place_guest_order` |

---

## Tool reference

### `lookup_customer`

**Start here for every order.** Reconstructs a customer profile from a phone number. Returning customers get their name, the delivery locations they have used before (reusable), and recent orders. A new number returns `{ exists: false }`.

**Input:**
```json
{ "phone": "0772123456" }
```

**Output (returning customer):**
```json
{
  "exists": true,
  "phone": "+256772123456",
  "name": "Sarah N.",
  "orderCount": 7,
  "savedLocations": [
    {
      "lat": 0.3476,
      "lng": 32.5825,
      "description": "Green gate next to KFC, Bukoto",
      "phone": "+256772123456",
      "lastUsedAt": 1718000000000
    }
  ],
  "recentOrders": [
    {
      "orderId": "j57xyz...",
      "displayId": 1042,
      "status": "delivered",
      "fulfillmentType": "delivery",
      "total": 38500,
      "currencyCode": "UGX",
      "storeName": "Farm Fresh",
      "createdAt": 1717900000000
    }
  ]
}
```

**Output (new customer):**
```json
{ "exists": false, "phone": "+256772123456" }
```

> The phone fields here are the customer's own and are returned unmasked. Reuse the normalized `phone` for the rest of the conversation.

---

### `find_address`

Find a place by free text when the customer describes where they are instead of sharing GPS (common on a phone call). Returns Google Places suggestions, each with a `placeId`. Pass the chosen `placeId` to `resolve_address`. Defaults to Uganda. Requires `GOOGLE_API_KEY` in the Convex deployment.

**Input:**
```json
{ "query": "Acacia Mall Kololo", "countryCode": "ug" }
```

**Output:**
```json
[
  {
    "placeId": "ChIJ...",
    "description": "Acacia Mall, Cooper Road, Kampala, Uganda",
    "mainText": "Acacia Mall",
    "secondaryText": "Cooper Road, Kampala, Uganda"
  }
]
```

---

### `resolve_address`

Resolve a `placeId` (from `find_address`) into coordinates and a formatted address. Feed `lat`/`lng` into `get_delivery_quote` and `place_guest_order`, and use `formattedAddress` as the delivery `description`.

**Input:**
```json
{ "placeId": "ChIJ..." }
```

**Output:**
```json
{
  "placeId": "ChIJ...",
  "name": "Acacia Mall",
  "formattedAddress": "Acacia Mall, Cooper Road, Kampala, Uganda",
  "lat": 0.3373,
  "lng": 32.5899
}
```

> Returns an error result if the place could not be resolved.

---

### `reverse_geocode`

Turn shared GPS coordinates into a readable address — use it to confirm a customer's location pin back to them before ordering. Requires `GOOGLE_API_KEY` in the Convex deployment.

**Input:**
```json
{ "lat": 0.3373, "lng": 32.5899 }
```

**Output:**
```json
{
  "placeId": "ChIJ...",
  "formattedAddress": "Acacia Mall, Cooper Road, Kampala, Uganda",
  "lat": 0.3373,
  "lng": 32.5899
}
```

> Returns a "no address found" message if nothing matches the coordinates.

---

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

### `search_store_products`

Search products **within one store** (everything in a cart must be from a single vendor). Use this after a store/cart is chosen. Same result shape as `search_products` (without the cross-store distance fields).

**Input:**
```json
{ "organizationId": "n97bctqtnwn501xcvvqc0g1prn80g382", "query": "tilapia", "limit": 30 }
```

---

### `list_store_categories`

Browse a store's catalog without a search term. Returns the categories that have active products, with a count each. Pass a `categoryId` to `list_category_products`.

**Input:**
```json
{ "organizationId": "n97bctqtnwn501xcvvqc0g1prn80g382" }
```

**Output:**
```json
[
  { "categoryId": "cat_veg", "name": "Vegetables", "productCount": 24 },
  { "categoryId": "cat_meat", "name": "Meat & Fish", "productCount": 11 }
]
```

---

### `list_category_products`

List products in a store, optionally filtered to one category. `variantId` goes to `add_to_cart`; prices are the raw amounts the order charges. Omit `categoryId` to list across the whole store.

**Input:**
```json
{ "organizationId": "n97bctqtnwn501xcvvqc0g1prn80g382", "categoryId": "cat_veg", "limit": 30 }
```

**Output:** same shape as `search_store_products` results, plus `categoryId`.

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

Quick fare estimate from a known subtotal — includes delivery fee, **service fee, small-order fee, and the grand total**. For the authoritative total from the actual cart, prefer `preview_order`.

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
  "deliveryFee": 4500,
  "baseFee": 2000,
  "distanceFee": 2500,
  "serviceFeeTotal": 1000,
  "smallOrderFeeTotal": 0,
  "subtotal": 20000,
  "total": 25500,
  "zoneName": "Kampala Central",
  "estimatedDeliveryTime": { "minMinutes": 18, "maxMinutes": 27 },
  "storeName": "Farm Fresh",
  "currency": "UGX"
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

### `preview_order`

The pre-checkout summary. Returns the **real grand total** (subtotal + delivery + service fee + small-order fee) — exactly what `place_guest_order` will charge — and `canPlace` plus blocking `issues`. Quote this to the customer before placing. Use this instead of `get_delivery_quote` at checkout, since that one omits service/small-order fees.

**Input:**
```json
{
  "cartId": "k17abc...",
  "sessionId": "mcp_3f...",
  "deliveryLat": 0.3476,
  "deliveryLng": 32.5825,
  "fulfillmentType": "delivery"
}
```

**Output:**
```json
{
  "canPlace": true,
  "issues": [],
  "storeName": "Farm Fresh",
  "fulfillmentType": "delivery",
  "currency": "UGX",
  "minimumOrderAmount": 5000,
  "items": [
    { "title": "Tilapia Fillet - 500g", "quantity": 2, "unitPrice": 10000, "subtotal": 20000, "available": true }
  ],
  "subtotal": 20000,
  "deliveryTotal": 4500,
  "serviceFeeTotal": 1000,
  "smallOrderFeeTotal": 0,
  "total": 25500,
  "distanceKm": 1.8,
  "estimatedDeliveryTime": { "minMinutes": 18, "maxMinutes": 27 },
  "zoneName": "Kampala Central"
}
```

> When `canPlace` is false, `issues` lists every blocking problem (below minimum order, outside delivery zone, store busy, item unavailable, etc.). Resolve them before calling `place_guest_order`, which rejects with the first issue.

---

### `place_guest_order`

Place a cash-on-delivery order. Call `preview_order` first and confirm the total. **Store `orderId` and `rememberPhone` on the conversation** — both are needed for `check_order_status` and `cancel_guest_order`.

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

### `cancel_guest_order`

Cancel an order the customer changed their mind about. Authorized by the phone used at checkout. Only `pending` orders can be cancelled here — once a rider has picked it up the customer must call support.

**Input:**
```json
{ "orderId": "j01ghi012", "phone": "0772123456", "reason": "Changed my mind" }
```

**Output:**
```json
{ "orderId": "j01ghi012", "displayId": 1042, "status": "canceled" }
```

> Errors with a "call support" message if the order is already being prepared or on its way.

---

## Typical flow

1. Get the phone number → call `lookup_customer`. Returning customer: greet by name, offer a `savedLocation`. New customer (`exists: false`): collect a name.
2. Get the delivery location:
   - Customer shares GPS (WhatsApp/Telegram location message) → use `lat`/`lng` directly, or
   - Customer describes it (phone call) → `find_address` then `resolve_address` for `lat`/`lng`, or
   - Returning customer → reuse a `savedLocation` from step 1.
3. Call `list_nearby_stores` with `{ lat, lng }` → capture `storeId`. (Or `search_stores` by name.) Check `get_store_timings` before promising delivery.
4. Call `create_guest_cart` with `{ storeId }` → store `{ cartId, sessionId }` against the conversation.
5. Add items. Knows what they want → `search_store_products` with `{ organizationId, query }`. Wants to browse → `list_store_categories` then `list_category_products`. Then `add_to_cart` with the `variantId`. Review with `get_cart`.
6. Call `preview_order` with `{ cartId, sessionId, deliveryLat, deliveryLng }` to show the **real grand total** (subtotal + delivery + service fee + small-order fee) and confirm `canPlace`. Resolve any `issues` before continuing.
7. Confirm name + phone (and delivery description if any) with the customer.
8. Call `place_guest_order` with the captured data and `source: "whatsapp"` / `"telegram"` / `"mcp"`. Read back the `displayId`; store the returned `orderId` + phone. (Send the confirmation message yourself — placing an order does not auto-notify the customer.)
9. (Optional) Poll `check_order_status` while the order is active, `list_my_orders` to recap, or `cancel_guest_order` while still `pending`.

> `get_delivery_quote` still exists for a quick delivery-fee-only estimate, but `preview_order` is preferred at checkout because it includes service/small-order fees — i.e. the number you quote equals the number charged.

---

## Connecting to Claude

The server speaks MCP Streamable HTTP at `/mcp` and authenticates callers with a static `Bearer` token (`MCP_CLIENT_SECRET`). Once connected, you can take an order just by talking to Claude — e.g. *"Customer on +256772123456 wants groceries delivered to Bukoto."* Claude reads the server's built-in `instructions`, calls `lookup_customer` first, walks the journey above, and confirms the total before placing the order.

Pick the surface you use:

### Claude Code (CLI) — recommended

```bash
# Remote (deployed) server
claude mcp add --transport http boxconv https://your-mcp-host/mcp \
  --header "Authorization: Bearer <MCP_CLIENT_SECRET>"

# Local server for testing
claude mcp add --transport http boxconv http://localhost:3000/mcp \
  --header "Authorization: Bearer <MCP_CLIENT_SECRET>"
```

Verify with `claude mcp list` (should show `boxconv` ✓ connected), then in a session run `/mcp` to see the tools. Remove with `claude mcp remove boxconv`.

> `--scope user` makes the connection available in every project; `--scope project` writes it to a shared `.mcp.json`. **Don't commit the secret** — prefer `--scope local` (default) or an env placeholder.

### Claude Desktop (macOS / Windows)

Claude Desktop launches MCP servers over stdio, so bridge to this HTTP server with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote). Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "boxconv": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://your-mcp-host/mcp",
        "--header",
        "Authorization: Bearer ${BOXCONV_MCP_SECRET}"
      ],
      "env": { "BOXCONV_MCP_SECRET": "<MCP_CLIENT_SECRET>" }
    }
  }
}
```

Restart Claude Desktop; the tools appear under the connectors (plug) icon.

### Claude.ai (web — Pro / Team / Enterprise)

Settings → **Connectors** → **Add custom connector** → enter `https://your-mcp-host/mcp`. The web connector UI is built around **OAuth**, not static Bearer headers, so a raw `MCP_CLIENT_SECRET` can't be entered there. Two options:

- Use **Claude Code** or **Claude Desktop** (above), which support the Bearer header directly — simplest.
- Or put the server behind an OAuth-capable proxy if you specifically need the web app.

### Requirements & sanity checks

- The server must be reachable over **HTTPS** for any remote Claude client (see **Deployment → TLS**). Plain `http://localhost` only works for local Claude Code.
- Confirm reachability before adding it:
  ```bash
  curl https://your-mcp-host/health        # → ok
  ```
- A wrong/missing token returns `401 Unauthorized` — Claude will show the connector as failed.

### Whole-journey example prompt

> *"A customer just called from 0772123456. They want 2kg sugar and a loaf of bread delivered to Ntinda, near Capital Shoppers. Set up the order and tell me the total before placing it."*

Claude will: `lookup_customer` → `find_address`/`resolve_address` (or reuse a saved location) → `list_nearby_stores` → `create_guest_cart` → `search_store_products` / browse → `add_to_cart` → `preview_order` (so it can quote you the real total) → `place_guest_order` once you confirm.

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
  -e GOOGLE_API_KEY=AIza... \
  boxconv-mcp
```

> All three of `CONVEX_URL`, `MCP_CLIENT_SECRET`, and `GOOGLE_API_KEY` are validated at startup; the container exits immediately if any is missing. Remember to also run `npx convex env set GOOGLE_API_KEY <key>` so the geocoding tools work server-side.

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
