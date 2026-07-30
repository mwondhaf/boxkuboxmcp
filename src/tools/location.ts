import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, convex } from "../convex";
import { toolText } from "../project";

export function registerLocationTools(server: McpServer) {
  server.tool(
    "find_address",
    "Find a place by text when the customer describes where they are instead of sharing GPS (e.g. on a phone call: 'Acacia Mall, Kololo' or 'Ntinda, opposite Capital Shoppers'). Returns address suggestions, each with a `placeId`. Read the options back to the customer, then pass the chosen `placeId` to `resolve_address` to get coordinates. Defaults to Uganda.",
    {
      query: z
        .string()
        .min(2)
        .describe("Address, landmark, or area the customer described"),
      countryCode: z
        .string()
        .length(2)
        .optional()
        .default("ug")
        .describe("ISO 3166-1 alpha-2 country code to bias results"),
    },
    async ({ query, countryCode }) => {
      const suggestions = await convex.action(api.places.autocomplete, {
        input: query,
        countryCode,
      });
      return {
        content: [
          { type: "text", text: toolText(suggestions) },
        ],
      };
    }
  );

  server.tool(
    "resolve_address",
    "Resolve a `placeId` (from `find_address`) into coordinates and a formatted address. Use the returned `lat`/`lng` with `get_delivery_quote` and `place_guest_order`, and the `formattedAddress` as the delivery `description`. Returns null if the place could not be resolved.",
    {
      placeId: z
        .string()
        .describe("placeId returned by find_address"),
    },
    async ({ placeId }) => {
      const details = await convex.action(api.places.placeDetails, {
        placeId,
      });
      if (!details) {
        return {
          content: [
            {
              type: "text",
              text: "Could not resolve that place. Try find_address again with a more specific query.",
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: toolText(details) }],
      };
    }
  );

  server.tool(
    "reverse_geocode",
    "Turn shared GPS coordinates into a human-readable address. Use this to read a customer's shared location pin back to them for confirmation ('that's near Acacia Mall, correct?') before using it for the order. Returns null if no address matches.",
    {
      lat: z.number().describe("Latitude from the shared location pin"),
      lng: z.number().describe("Longitude from the shared location pin"),
    },
    async ({ lat, lng }) => {
      const result = await convex.action(api.places.reverseGeocode, {
        lat,
        lng,
      });
      if (!result) {
        return {
          content: [
            {
              type: "text",
              text: "No address found for those coordinates. Ask the customer to describe a nearby landmark.",
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: toolText(result) }],
      };
    }
  );
}
