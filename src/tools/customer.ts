import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, convex } from "../convex";
import { phoneError } from "../phone";
import { toolText } from "../project";
import { sanitize } from "../sanitize";
import { resolveCustomerPhone } from "../session";

// Phone fields on a customer profile (the top-level number and the phone on
// each saved delivery location) all belong to the customer themselves, so they
// are preserved rather than masked with the support number.
const PRESERVE_CUSTOMER_PHONES = new Set(["phone"]);

export function registerCustomerTools(server: McpServer, boundPhone?: string) {
  server.tool(
    "lookup_customer",
    "Start here for every order. Look up a customer by phone number. Returns whether they have ordered before (`exists`), their name, the delivery locations they have used before (reusable — feed `lat`/`lng` straight into `get_delivery_quote` and `place_guest_order`), and their recent orders. If `exists` is false this is a NEW customer: ask for their name and a delivery location (share GPS, or describe it and use `find_address`). The phone is normalized to a Ugandan E.164 number; reuse that normalized value for the rest of the conversation. Omit `phone` when the conversation is bound to a verified caller — any value you pass is then ignored.",
    {
      phone: z
        .string()
        .optional()
        .describe(
          "Customer phone in any format, e.g. 0772123456 or +256772123456. Ignored if the session is bound to a verified number."
        ),
    },
    async ({ phone }) => {
      let normalized: string;
      try {
        normalized = resolveCustomerPhone(boundPhone, phone);
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
            text: toolText(
              sanitize(profile, { preserve: PRESERVE_CUSTOMER_PHONES })
            ),
          },
        ],
      };
    }
  );
}
