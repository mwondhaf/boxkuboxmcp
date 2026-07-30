import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, convex } from "../convex";
import { assertConvexId, idErrorResult, REMEDY } from "../ids";
import {
  projectMany,
  projectProduct,
  projectStore,
  projectTimings,
  toolText,
} from "../project";
import { sanitize } from "../sanitize";

export function registerSearchTools(server: McpServer) {
  server.tool(
    "list_nearby_stores",
    "List active stores that can deliver to a location. Requires the customer's shared lat/lng from WhatsApp. Each result includes a `storeId` (Convex document ID) — use that as the `storeId` argument to `create_guest_cart`, `get_store`, `get_store_timings`, and `get_delivery_quote`.",
    {
      lat: z
        .number()
        .describe("Customer latitude (from shared WhatsApp location)"),
      lng: z
        .number()
        .describe("Customer longitude (from shared WhatsApp location)"),
      limit: z.number().int().positive().max(20).default(8),
    },
    async ({ lat, lng, limit }) => {
      type StoreRow = {
        _id: string;
        slug: string;
        distanceMeters?: number;
        [key: string]: unknown;
      };
      const stores = (await convex.query(
        api.organizations.listActiveWithStatus,
        { customerLat: lat, customerLng: lng }
      )) as StoreRow[];
      // Pre-filter to stores that report a distance (i.e. have a location).
      // The authoritative zone + distance check happens in get_delivery_quote.
      const inZone = stores.filter(
        (s) => s.distanceMeters !== undefined
      );
      const top = inZone.slice(0, limit).map(({ _id, ...store }) => ({
        storeId: _id,
        ...store,
      }));
      return {
        content: [
          {
            type: "text",
            text: toolText(projectMany(sanitize(top), projectStore)),
          },
        ],
      };
    }
  );

  server.tool(
    "search_products",
    "Search products across all active vendors by name/description. Typesense-backed with typo tolerance. Each result includes `storeId` (the store's Convex document ID) and `variantId` — use `variantId` with `add_to_cart`, and `storeId` wherever a store or `organizationId` is asked for.",
    {
      query: z.string().min(1),
      limit: z.number().int().positive().max(20).default(8),
      customerLat: z.number().optional(),
      customerLng: z.number().optional(),
    },
    async (args) => {
      const results = await convex.action(api.typesense.searchProducts, args);
      return {
        content: [
          {
            type: "text",
            text: toolText(projectMany(sanitize(results), projectProduct)),
          },
        ],
      };
    }
  );

  server.tool(
    "search_store_products",
    "Search products within ONE specific store. Use this once a store/cart has been chosen so results all come from the same vendor (everything in a cart must be from one store). Each result includes a `variantId` — use it with `add_to_cart`.",
    {
      storeName: z
        .string()
        .describe(
          "Exact store name as returned by create_guest_cart (`storeName`), list_nearby_stores or search_stores (`name`)"
        ),
      query: z.string().min(2),
      limit: z.number().int().positive().max(20).default(10),
    },
    async (args) => {
      const results = await convex.action(
        api.typesense.searchProductsInStore,
        args
      );
      return {
        content: [
          {
            type: "text",
            text: toolText(projectMany(sanitize(results), projectProduct)),
          },
        ],
      };
    }
  );

  server.tool(
    "search_stores",
    "Search stores by name. Typesense-backed. Each result includes `storeId` (the store's Convex document ID) — use it with `create_guest_cart`, `get_store`, `get_store_timings`, and `get_delivery_quote`, and wherever an `organizationId` is asked for.",
    {
      query: z.string().min(1),
      limit: z.number().int().positive().max(20).default(8),
    },
    async (args) => {
      const results = await convex.action(api.typesense.searchStores, args);
      return {
        content: [
          {
            type: "text",
            text: toolText(projectMany(sanitize(results), projectStore)),
          },
        ],
      };
    }
  );

  server.tool(
    "get_store",
    "Get full details for a single store including delivery zones, categories, and pricing rules. Use the `storeId` returned by `list_nearby_stores` or `search_stores`.",
    {
      storeId: z
        .string()
        .describe(
          "Convex document ID of the store (from list_nearby_stores or search_stores)"
        ),
    },
    async ({ storeId }) => {
      try {
        assertConvexId(storeId, "storeId", REMEDY.storeId);
      } catch (err) {
        return idErrorResult(err);
      }
      const store = await convex.query(api.organizations.getStoreDetails, {
        id: storeId,
      });
      return {
        content: [{ type: "text", text: toolText(sanitize(store)) }],
      };
    }
  );

  server.tool(
    "get_store_timings",
    "Get the operating hours and current open/closed status for a store. Returns the full weekly schedule, whether the store is open right now, and what time it opens/closes today. Use the `storeId` returned by `list_nearby_stores` or `search_stores`.",
    {
      storeId: z
        .string()
        .describe(
          "Convex document ID of the store (from list_nearby_stores or search_stores)"
        ),
    },
    async ({ storeId }) => {
      const timings = await convex.query(api.organizations.getStoreTimings, {
        identifier: storeId,
      });
      return {
        content: [
          {
            type: "text",
            text: toolText(
              projectTimings(sanitize(timings) as Record<string, unknown> | null)
            ),
          },
        ],
      };
    }
  );
}
