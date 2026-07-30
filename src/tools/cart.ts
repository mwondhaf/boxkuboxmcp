import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, convex } from "../convex";
import { assertConvexId, idErrorResult, REMEDY } from "../ids";
import { projectCart, toolText } from "../project";
import { newSessionId } from "../session";

/**
 * Callers were passing invented slugs ("onions-1kg") here, which the Convex
 * mutation rejects with an opaque ArgumentValidationError. Spell out that this
 * is an opaque ID copied verbatim from a catalog result.
 */
const variantIdSchema = z
  .string()
  .describe(
    "Convex document ID of the product variant, copied exactly from the `variantId` field of a search_store_products / list_category_products result (looks like 'nd70037ferat6npd9wgekeg7s5883y4e'). Never a slug, product name, or guess — search for the product first if you don't have one."
  );

const cartIdSchema = z
  .string()
  .describe(
    "Convex document ID returned by create_guest_cart. Never a placeholder such as 'temp-cart-id' — create the cart first if you don't have one."
  );

/** Validate the IDs a cart mutation needs before touching Convex. */
function checkCartArgs(cartId: string, variantId?: string) {
  assertConvexId(cartId, "cartId", REMEDY.cartId);
  if (variantId !== undefined) {
    assertConvexId(variantId, "variantId", REMEDY.variantId);
  }
}

export function registerCartTools(server: McpServer) {
  server.tool(
    "create_guest_cart",
    "Create a new guest shopping cart for a specific store. Returns `{ cartId, sessionId, storeId, storeName }`. Keep `cartId` and `sessionId` for the duration of the conversation — both are required for every subsequent cart and order call.",
    {
      storeId: z
        .string()
        .describe(
          "Convex document ID of the store (from list_nearby_stores or search_stores)"
        ),
      currencyCode: z.string().optional().default("UGX"),
    },
    async ({ storeId, currencyCode }) => {
      try {
        assertConvexId(storeId, "storeId", REMEDY.storeId);
      } catch (err) {
        return idErrorResult(err);
      }
      const store = await convex.query(api.organizations.getStoreTimings, {
        identifier: storeId,
      });
      if (!store) {
        return {
          content: [
            {
              type: "text",
              text: `No store found with storeId "${storeId}". ${REMEDY.storeId}`,
            },
          ],
          isError: true,
        };
      }
      const sessionId = newSessionId();
      const cartId = await convex.mutation(api.carts.create, {
        sessionId,
        organizationId: store._id,
        currencyCode,
      });
      return {
        content: [
          {
            type: "text",
            text: toolText({
              cartId,
              sessionId,
              storeId: store._id,
              storeName: store.name,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "get_cart",
    "Fetch the current state of a cart including line items and total.",
    {
      cartId: cartIdSchema,
    },
    async ({ cartId }) => {
      try {
        checkCartArgs(cartId);
      } catch (err) {
        return idErrorResult(err);
      }
      const cart = await convex.query(api.carts.get, { id: cartId });
      return {
        content: [{ type: "text", text: toolText(projectCart(cart)) }],
      };
    }
  );

  server.tool(
    "add_to_cart",
    "Add a product variant to a cart, or increment its quantity if already present.",
    {
      cartId: cartIdSchema,
      variantId: variantIdSchema,
      quantity: z.number().int().positive(),
    },
    async (args) => {
      try {
        checkCartArgs(args.cartId, args.variantId);
      } catch (err) {
        return idErrorResult(err);
      }
      await convex.mutation(api.carts.addItem, args);
      const cart = await convex.query(api.carts.get, { id: args.cartId });
      return {
        content: [{ type: "text", text: toolText(projectCart(cart)) }],
      };
    }
  );

  server.tool(
    "update_cart_item",
    "Update the quantity of an item already in the cart.",
    {
      cartId: cartIdSchema,
      variantId: variantIdSchema,
      quantity: z.number().int().min(0),
    },
    async (args) => {
      try {
        checkCartArgs(args.cartId, args.variantId);
      } catch (err) {
        return idErrorResult(err);
      }
      await convex.mutation(api.carts.updateItemQuantity, args);
      const cart = await convex.query(api.carts.get, { id: args.cartId });
      return {
        content: [{ type: "text", text: toolText(projectCart(cart)) }],
      };
    }
  );

  server.tool(
    "remove_from_cart",
    "Remove an item from the cart.",
    {
      cartId: cartIdSchema,
      variantId: variantIdSchema,
    },
    async (args) => {
      try {
        checkCartArgs(args.cartId, args.variantId);
      } catch (err) {
        return idErrorResult(err);
      }
      await convex.mutation(api.carts.removeItem, args);
      const cart = await convex.query(api.carts.get, { id: args.cartId });
      return {
        content: [{ type: "text", text: toolText(projectCart(cart)) }],
      };
    }
  );
}
