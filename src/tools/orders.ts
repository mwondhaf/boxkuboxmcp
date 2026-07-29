import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, convex } from "../convex";
import { normalizeUgMobile, phoneError } from "../phone";
import { sanitizeOrder } from "../sanitize";
import { resolveCustomerPhone } from "../session";

export function registerOrderTools(server: McpServer, boundPhone?: string) {
  server.tool(
    "get_delivery_quote",
    "Get a fare quote for a store + customer location: delivery fee, service fee, small-order fee, and the grand total for the given subtotal. A quick estimate from a known subtotal; for the authoritative checkout total from the actual cart, use `preview_order`. Use the `storeId` returned by `list_nearby_stores` or `search_stores`.",
    {
      storeId: z
        .string()
        .describe(
          "Convex document ID of the store (from list_nearby_stores or search_stores)"
        ),
      lat: z.number().describe("Customer latitude"),
      lng: z.number().describe("Customer longitude"),
      orderSubtotal: z.number().int().min(0),
      isExpress: z.boolean().optional(),
    },
    async ({ storeId, lat, lng, orderSubtotal, isExpress }) => {
      const quote = await convex.query(api.guestOrders.getGuestDeliveryQuote, {
        organizationId: storeId,
        lat,
        lng,
        orderSubtotal,
        isExpress,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(quote, null, 2) }],
      };
    }
  );

  server.tool(
    "preview_order",
    "Preview the FINAL cost of an order before placing it — subtotal, delivery fee, service fee, small-order fee, and grand total — and check it can actually be placed (`canPlace`). The total here is exactly what `place_guest_order` will charge, so quote this to the customer first. If `canPlace` is false, read `issues` (e.g. below minimum order, outside delivery zone, store busy, item unavailable) and resolve them before placing.",
    {
      cartId: z.string(),
      sessionId: z.string().describe("sessionId from create_guest_cart"),
      deliveryLat: z.number().describe("Customer latitude"),
      deliveryLng: z.number().describe("Customer longitude"),
      fulfillmentType: z.enum(["delivery", "pickup"]).default("delivery"),
      isExpress: z.boolean().optional(),
    },
    async (args) => {
      const summary = await convex.query(
        api.guestOrders.getGuestCheckoutSummary,
        {
          cartId: args.cartId,
          sessionId: args.sessionId,
          deliveryLat: args.deliveryLat,
          deliveryLng: args.deliveryLng,
          fulfillmentType: args.fulfillmentType,
          isExpress: args.isExpress,
        }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    }
  );

  server.tool(
    "place_guest_order",
    "Place a cash-on-delivery guest order. Call `preview_order` first and confirm the total with the customer. Requires a cart with items, the sessionId from create_guest_cart, guest contact info, and a shared location (lat/lng from WhatsApp location share, Telegram location share, or equivalent).",
    {
      cartId: z.string(),
      sessionId: z.string(),
      guestName: z.string().min(1),
      guestPhone: z
        .string()
        .optional()
        .describe(
          "Ugandan mobile number, any format (will be normalized to E.164). Omit when the session is bound to a verified caller — any value passed is then ignored."
        ),
      deliveryLat: z
        .number()
        .describe("Customer latitude from shared location"),
      deliveryLng: z
        .number()
        .describe("Customer longitude from shared location"),
      deliveryPhone: z
        .string()
        .optional()
        .describe(
          "Phone the rider should call when arriving — defaults to guestPhone"
        ),
      deliveryDescription: z
        .string()
        .optional()
        .describe("Landmark / directions note, e.g. 'green gate next to KFC'"),
      fulfillmentType: z.enum(["delivery", "pickup"]).default("delivery"),
      notes: z.string().optional(),
      source: z
        .enum(["whatsapp", "telegram", "mcp", "api"])
        .default("mcp")
        .describe(
          "Channel the order is being placed from. Surfaces on the order and is visible to the vendor."
        ),
    },
    async (args) => {
      let guestPhone: string;
      let deliveryPhone: string;
      try {
        guestPhone = resolveCustomerPhone(boundPhone, args.guestPhone);
        // Defaults to the number the order is actually placed under. A different
        // one is fine here — it only tells the rider who to call, and grants no
        // access to anybody's order history.
        deliveryPhone = args.deliveryPhone
          ? normalizeUgMobile(args.deliveryPhone)
          : guestPhone;
      } catch (err) {
        phoneError(err);
      }

      const result = await convex.mutation(api.guestOrders.createGuestOrder, {
        cartId: args.cartId,
        sessionId: args.sessionId,
        guest: { name: args.guestName, phone: guestPhone! },
        deliveryLocation: {
          lat: args.deliveryLat,
          lng: args.deliveryLng,
          phone: deliveryPhone!,
          description: args.deliveryDescription,
        },
        fulfillmentType: args.fulfillmentType,
        notes: args.notes,
        source: args.source,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...result,
                // Remind the caller to store the phone — needed for future status checks.
                rememberPhone: guestPhone,
                paymentMethod: "cash_on_delivery",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "check_order_status",
    "Check the status of a previously placed guest order. Requires both orderId and the phone used at checkout — the phone-match is the authorization.",
    {
      orderId: z.string(),
      phone: z
        .string()
        .optional()
        .describe(
          "Phone used at checkout. Ignored if the session is bound to a verified number."
        ),
    },
    async ({ orderId, phone }) => {
      let normalized: string;
      try {
        normalized = resolveCustomerPhone(boundPhone, phone);
      } catch (err) {
        phoneError(err);
      }
      const order = await convex.query(api.guestOrders.getGuestOrder, {
        orderId,
        phone: normalized!,
      });
      if (!order) {
        return {
          content: [
            {
              type: "text",
              text: "No matching order found for that phone number.",
            },
          ],
          isError: true,
        };
      }

      // Mask rider/partner phones; keep the customer's own phones (guestPhone
      // and the delivery-location phone — they already know these).
      const masked = sanitizeOrder(order) as typeof order;
      if (order.deliveryLocation && masked.deliveryLocation) {
        (masked.deliveryLocation as { phone?: string }).phone =
          order.deliveryLocation.phone;
      }

      return {
        content: [{ type: "text", text: JSON.stringify(masked, null, 2) }],
      };
    }
  );

  server.tool(
    "list_my_orders",
    "List recent guest orders placed from a phone number. When the session is bound to a verified caller this returns only that caller's orders — it cannot be used to read another number's history.",
    {
      phone: z
        .string()
        .optional()
        .describe(
          "Ignored if the session is bound to a verified number, which is then the only number readable."
        ),
      limit: z.number().int().positive().max(50).default(10),
    },
    async ({ phone, limit }) => {
      let normalized: string;
      try {
        normalized = resolveCustomerPhone(boundPhone, phone);
      } catch (err) {
        phoneError(err);
      }
      const orders = await convex.query(api.guestOrders.getGuestOrdersByPhone, {
        phone: normalized!,
        limit,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(orders, null, 2) }],
      };
    }
  );

  server.tool(
    "cancel_guest_order",
    "Cancel a guest order. Requires both orderId and the phone used at checkout (the phone-match is the authorization). Only orders that are still `pending` can be cancelled — once a rider has picked it up the customer must call support.",
    {
      orderId: z.string(),
      phone: z
        .string()
        .optional()
        .describe(
          "Phone used at checkout. Ignored if the session is bound to a verified number."
        ),
      reason: z.string().optional().describe("Why the customer is cancelling"),
    },
    async ({ orderId, phone, reason }) => {
      let normalized: string;
      try {
        normalized = resolveCustomerPhone(boundPhone, phone);
      } catch (err) {
        phoneError(err);
      }
      const result = await convex.mutation(api.guestOrders.cancelGuestOrder, {
        orderId,
        phone: normalized!,
        reason,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
