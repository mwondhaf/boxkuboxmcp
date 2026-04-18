import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, convex } from "../convex";
import { newSessionId } from "../session";

export function registerCartTools(server: McpServer) {
  server.tool(
    "create_guest_cart",
    "Create a new guest shopping cart for a specific store. Returns a sessionId that must be passed to every subsequent cart/order call during this conversation.",
    {
      organizationId: z.string().describe("Convex Id<'organizations'>"),
      currencyCode: z.string().optional().default("UGX"),
    },
    async ({ organizationId, currencyCode }) => {
      const sessionId = newSessionId();
      const cartId = await convex.mutation(api.carts.create, {
        sessionId,
        organizationId,
        currencyCode,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ cartId, sessionId }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_cart",
    "Fetch the current state of a cart including line items and total.",
    {
      cartId: z.string(),
    },
    async ({ cartId }) => {
      const cart = await convex.query(api.carts.get, { cartId });
      return {
        content: [{ type: "text", text: JSON.stringify(cart, null, 2) }],
      };
    }
  );

  server.tool(
    "add_to_cart",
    "Add a product variant to a cart, or increment its quantity if already present.",
    {
      cartId: z.string(),
      variantId: z.string(),
      quantity: z.number().int().positive(),
    },
    async (args) => {
      await convex.mutation(api.carts.addItem, args);
      const cart = await convex.query(api.carts.get, { cartId: args.cartId });
      return {
        content: [{ type: "text", text: JSON.stringify(cart, null, 2) }],
      };
    }
  );

  server.tool(
    "update_cart_item",
    "Update the quantity of an item already in the cart.",
    {
      cartId: z.string(),
      variantId: z.string(),
      quantity: z.number().int().min(0),
    },
    async (args) => {
      await convex.mutation(api.carts.updateItemQuantity, args);
      const cart = await convex.query(api.carts.get, { cartId: args.cartId });
      return {
        content: [{ type: "text", text: JSON.stringify(cart, null, 2) }],
      };
    }
  );

  server.tool(
    "remove_from_cart",
    "Remove an item from the cart.",
    {
      cartId: z.string(),
      variantId: z.string(),
    },
    async (args) => {
      await convex.mutation(api.carts.removeItem, args);
      const cart = await convex.query(api.carts.get, { cartId: args.cartId });
      return {
        content: [{ type: "text", text: JSON.stringify(cart, null, 2) }],
      };
    }
  );
}
