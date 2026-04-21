import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, convex } from "../convex";
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
      limit: z.number().int().positive().max(50).default(20),
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
      // Mirror the 15km hard limit enforced by getGuestDeliveryQuote
      const MAX_DELIVERY_KM = 15;
      const inZone = stores.filter(
        (s) =>
          s.distanceMeters !== undefined &&
          s.distanceMeters <= MAX_DELIVERY_KM * 1000
      );
      const top = inZone.slice(0, limit).map(({ _id, ...store }) => ({
        storeId: _id,
        ...store,
      }));
      return {
        content: [
          { type: "text", text: JSON.stringify(sanitize(top), null, 2) },
        ],
      };
    }
  );

  server.tool(
    "search_products",
    "Search products across all active vendors by name/description. Typesense-backed with typo tolerance. Each result includes `organizationId` (the store's Convex document ID) and `variantId` — use `variantId` with `add_to_cart`.",
    {
      query: z.string().min(1),
      limit: z.number().int().positive().max(50).default(20),
      customerLat: z.number().optional(),
      customerLng: z.number().optional(),
    },
    async (args) => {
      const results = await convex.action(api.typesense.searchProducts, args);
      return {
        content: [
          { type: "text", text: JSON.stringify(sanitize(results), null, 2) },
        ],
      };
    }
  );

  server.tool(
    "search_stores",
    "Search stores by name. Typesense-backed. Each result includes `_id` (the store's Convex document ID) — use that as `storeId` with `create_guest_cart`, `get_store`, `get_store_timings`, and `get_delivery_quote`.",
    {
      query: z.string().min(1),
      limit: z.number().int().positive().max(50).default(20),
    },
    async (args) => {
      const results = await convex.action(api.typesense.searchStores, args);
      return {
        content: [
          { type: "text", text: JSON.stringify(sanitize(results), null, 2) },
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
      const store = await convex.query(api.organizations.getStoreDetails, {
        id: storeId,
      });
      return {
        content: [
          { type: "text", text: JSON.stringify(sanitize(store), null, 2) },
        ],
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
          { type: "text", text: JSON.stringify(sanitize(timings), null, 2) },
        ],
      };
    }
  );
}
