import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, convex } from "../convex";
import { normalizeUgMobile, phoneError } from "../phone";
import { sanitize } from "../sanitize";

// Phone fields on a customer profile (the top-level number and the phone on
// each saved delivery location) all belong to the customer themselves, so they
// are preserved rather than masked with the support number.
const PRESERVE_CUSTOMER_PHONES = new Set(["phone"]);

export function registerCustomerTools(server: McpServer) {
  server.tool(
    "lookup_customer",
    "Start here for every order. Look up a customer by phone number. Returns whether they have ordered before (`exists`), their name, the delivery locations they have used before (reusable — feed `lat`/`lng` straight into `get_delivery_quote` and `place_guest_order`), and their recent orders. If `exists` is false this is a NEW customer: ask for their name and a delivery location (share GPS, or describe it and use `find_address`). The phone is normalized to a Ugandan E.164 number; reuse that normalized value for the rest of the conversation.",
    {
      phone: z
        .string()
        .describe(
          "Customer phone in any format, e.g. 0772123456 or +256772123456"
        ),
    },
    async ({ phone }) => {
      let normalized: string;
      try {
        normalized = normalizeUgMobile(phone);
      } catch (err) {
        phoneError(err);
      }

      const profile = await convex.query(api.guestOrders.getGuestProfile, {
        phone: normalized!,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              sanitize(profile, { preserve: PRESERVE_CUSTOMER_PHONES }),
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
