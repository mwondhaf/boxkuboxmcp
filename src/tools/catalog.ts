import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, convex } from "../convex";
import { assertConvexId, idErrorResult, REMEDY } from "../ids";
import {
  projectCategory,
  projectMany,
  projectProduct,
  toolText,
} from "../project";
import { sanitize } from "../sanitize";

export function registerCatalogTools(server: McpServer) {
  server.tool(
    "list_store_categories",
    "List the product categories a store sells, with a product count each. Use this when the customer wants to browse instead of searching ('what do you have?'). Read the sections back, then call `list_category_products` with the chosen `categoryId`.",
    {
      organizationId: z
        .string()
        .describe(
          "Convex document ID of the store (storeId from create_guest_cart / list_nearby_stores / search_stores)"
        ),
    },
    async ({ organizationId }) => {
      try {
        assertConvexId(organizationId, "organizationId", REMEDY.storeId);
      } catch (err) {
        return idErrorResult(err);
      }
      const categories = await convex.query(
        api.guestCatalog.listStoreCategories,
        { organizationId }
      );
      return {
        content: [
          {
            type: "text",
            text: toolText(projectMany(sanitize(categories), projectCategory)),
          },
        ],
      };
    }
  );

  server.tool(
    "list_category_products",
    "List products in a store, optionally filtered to one category. Each result has a `variantId` for `add_to_cart` and the price the order will actually charge. Omit `categoryId` to list across the whole store.",
    {
      organizationId: z
        .string()
        .describe("Convex document ID of the store"),
      categoryId: z
        .string()
        .optional()
        .describe("Category to filter by (from list_store_categories)"),
      limit: z.number().int().positive().max(30).default(12),
    },
    async (args) => {
      try {
        assertConvexId(args.organizationId, "organizationId", REMEDY.storeId);
        if (args.categoryId !== undefined) {
          assertConvexId(args.categoryId, "categoryId", REMEDY.categoryId);
        }
      } catch (err) {
        return idErrorResult(err);
      }
      const products = await convex.query(
        api.guestCatalog.listStoreProducts,
        args
      );
      return {
        content: [
          {
            type: "text",
            text: toolText(projectMany(sanitize(products), projectProduct)),
          },
        ],
      };
    }
  );
}
