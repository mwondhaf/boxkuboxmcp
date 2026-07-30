/**
 * Guardrails for IDs supplied by an AI caller.
 *
 * Language models routinely invent plausible-looking identifiers
 * ("temp-cart-id", "onions_1kg_boxmart") when they have not yet called the
 * tool that produces the real one. Passing those through to Convex produces
 * an ArgumentValidationError, which tells the model that something is wrong
 * but not what to do about it — so it guesses again.
 *
 * These helpers reject obviously-fabricated IDs at the edge and return an
 * instruction the model can act on.
 */

/**
 * Convex document IDs are base32-ish strings of uniform length with no
 * separators. Anything containing a hyphen, underscore, space, or uppercase
 * word structure is a fabrication.
 */
const CONVEX_ID = /^[a-z0-9]{20,40}$/;

export class InvalidIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidIdError";
  }
}

/**
 * Throw a corrective error if `value` cannot be a Convex document ID.
 *
 * @param value    the candidate ID supplied by the caller
 * @param field    argument name, e.g. "cartId"
 * @param remedy   what the caller should do instead
 */
export function assertConvexId(
  value: string,
  field: string,
  remedy: string
): void {
  if (CONVEX_ID.test(value)) {
    return;
  }
  throw new InvalidIdError(
    `"${value}" is not a valid ${field}. It looks like a placeholder or a name, ` +
      `not a real ID. ${remedy} Never invent, shorten, or construct an ID — ` +
      `use the exact value a tool returned.`
  );
}

/** Convert a thrown error into an MCP error result. */
export function idErrorResult(err: unknown) {
  const message =
    err instanceof InvalidIdError
      ? err.message
      : `Invalid ID: ${err instanceof Error ? err.message : String(err)}`;
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export const REMEDY = {
  cartId:
    "Call create_guest_cart first and use the cartId it returns, or reuse the cartId from earlier in this conversation.",
  sessionId:
    "Use the sessionId returned by create_guest_cart for this cart.",
  variantId:
    "Call search_products, search_store_products, or list_category_products and use the variantId field from the item the customer chose.",
  storeId:
    "Call list_nearby_stores or search_products and use the storeId (or organizationId) field from the store the customer chose.",
  orderId:
    "Use the orderId returned by place_guest_order, or call list_my_orders to find it.",
  categoryId:
    "Call list_store_categories and use the categoryId field from the section the customer chose.",
} as const;
