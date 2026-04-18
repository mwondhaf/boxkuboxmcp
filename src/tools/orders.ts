import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, convex } from "../convex";
import { InvalidPhoneError, normalizeUgMobile } from "../phone";

function phoneError(err: unknown): never {
  if (err instanceof InvalidPhoneError) {
    throw new Error(err.message);
  }
  throw err;
}

export function registerOrderTools(server: McpServer) {
  server.tool(
    "get_delivery_quote",
    "Get a delivery fare quote for a specific store + customer location. Call before placing the order so the customer knows the total.",
    {
      organizationId: z.string(),
      lat: z.number().describe("Customer latitude"),
      lng: z.number().describe("Customer longitude"),
      orderSubtotal: z.number().int().min(0),
      isExpress: z.boolean().optional(),
    },
    async (args) => {
      const quote = await convex.query(
        api.guestOrders.getGuestDeliveryQuote,
        args
      );
      return {
        content: [{ type: "text", text: JSON.stringify(quote, null, 2) }],
      };
    }
  );

  server.tool(
    "place_guest_order",
    "Place a cash-on-delivery guest order. Requires a cart with items, the sessionId from create_guest_cart, guest contact info, and a shared location (lat/lng from WhatsApp location share, Telegram location share, or equivalent).",
    {
      cartId: z.string(),
      sessionId: z.string(),
      guestName: z.string().min(1),
      guestPhone: z
        .string()
        .describe(
          "Ugandan mobile number, any format (will be normalized to E.164)"
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
        guestPhone = normalizeUgMobile(args.guestPhone);
        deliveryPhone = normalizeUgMobile(
          args.deliveryPhone ?? args.guestPhone
        );
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
      phone: z.string(),
    },
    async ({ orderId, phone }) => {
      let normalized: string;
      try {
        normalized = normalizeUgMobile(phone);
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
      return {
        content: [{ type: "text", text: JSON.stringify(order, null, 2) }],
      };
    }
  );

  server.tool(
    "list_my_orders",
    "List recent guest orders placed from a phone number.",
    {
      phone: z.string(),
      limit: z.number().int().positive().max(50).default(10),
    },
    async ({ phone, limit }) => {
      let normalized: string;
      try {
        normalized = normalizeUgMobile(phone);
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
}
