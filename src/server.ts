import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCartTools } from "./tools/cart";
import { registerCatalogTools } from "./tools/catalog";
import { registerCustomerTools } from "./tools/customer";
import { registerLocationTools } from "./tools/location";
import { registerOrderTools } from "./tools/orders";
import { registerSearchTools } from "./tools/search";

// Shown to the connected client (e.g. Claude) so it knows how to drive the
// tools as an end-to-end order-taking flow when a customer calls or messages.
const INSTRUCTIONS = `BoxConv lets you take a grocery delivery order on behalf of a customer who is calling or messaging (e.g. on WhatsApp). You are the operator's assistant. Money is in UGX; payment is cash on delivery.

Typical order journey:
1. lookup_customer(phone) — ALWAYS start here. If exists=true, greet them by name and offer to reuse a savedLocation. If exists=false, it's a new customer: collect their name and a delivery location.
2. Get the delivery location:
   - Best: the customer shares GPS (lat/lng) from WhatsApp/Telegram — confirm it with reverse_geocode(lat,lng).
   - On a call or by description: find_address(query) then resolve_address(placeId) to get lat/lng.
   - Returning customer: reuse a savedLocation from lookup_customer.
3. Pick a store: list_nearby_stores(lat,lng) for stores that deliver there, or search_stores(name). Check get_store_timings before promising delivery.
4. create_guest_cart(storeId) — keep the returned cartId AND sessionId for the rest of the conversation.
5. Add items. If the customer knows what they want: search_store_products(organizationId, query). If they want to browse: list_store_categories(organizationId) then list_category_products(organizationId, categoryId). Then add_to_cart(cartId, variantId, quantity). Adjust with update_cart_item / remove_from_cart. Review with get_cart.
6. preview_order(cartId, sessionId, deliveryLat, deliveryLng) — this returns the REAL grand total (subtotal + delivery + service fee + small-order fee) and canPlace. Quote that total to the customer; if canPlace is false, resolve the listed issues first.
7. place_guest_order(cartId, sessionId, guestName, guestPhone, deliveryLat, deliveryLng, ...) — confirm details first. Returns a displayId; read it back and remind the customer to keep their phone for status checks. (You must send the confirmation message yourself — placing an order does not auto-notify the customer.)
8. Later: check_order_status(orderId, phone), list_my_orders(phone), or cancel_guest_order(orderId, phone) while still pending.

Notes: a cart can only contain items from one store. Phone numbers are Ugandan and are normalized automatically. Never invent prices, fees, or stock — always read them from tool results, and prefer preview_order over get_delivery_quote for the final total.`;

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "boxconv-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: INSTRUCTIONS,
    }
  );

  registerCustomerTools(server);
  registerLocationTools(server);
  registerSearchTools(server);
  registerCatalogTools(server);
  registerCartTools(server);
  registerOrderTools(server);

  return server;
}
