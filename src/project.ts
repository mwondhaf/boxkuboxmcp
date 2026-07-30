/**
 * Response projection for MCP tool output.
 *
 * Every tool result is appended to the calling agent's conversation and
 * re-sent on each subsequent model call in the agent loop. Full Convex
 * documents (image URLs, geohashes, timestamps, nested category objects)
 * inflate that context by an order of magnitude and, in practice, push long
 * ordering conversations past the point where the provider returns a usable
 * completion.
 *
 * These helpers project each entity down to the fields an ordering agent
 * actually needs: what to show the customer, and the IDs required for the
 * next tool call. Nothing here changes what the tools *do* — only how much
 * of the result travels back to the model.
 *
 * Rule of thumb when adding a field: if the agent cannot either say it to a
 * customer or pass it to another tool, leave it out.
 */

/** Drop null/undefined/empty-string keys so they cost no tokens. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === "") {
      continue;
    }
    out[k] = v;
  }
  return out as Partial<T>;
}

type AnyRecord = Record<string, unknown>;

const num = (v: unknown): number | undefined =>
  typeof v === "number" ? v : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/**
 * Store summary for list_nearby_stores / search_stores.
 * Drops logo + cover URLs, geohash, lat/lng, category objects, timestamps.
 */
export function projectStore(store: AnyRecord) {
  const distanceMeters = num(store.distanceMeters);
  const category = store.category as AnyRecord | null | undefined;
  return compact({
    storeId: str(store.storeId) ?? str(store._id),
    name: str(store.name),
    area: str(store.town) ?? str(store.cityOrDistrict),
    distanceKm:
      distanceMeters === undefined
        ? undefined
        : Math.round(distanceMeters / 100) / 10,
    etaMinutes:
      num(store.estimatedMinMin) !== undefined &&
      num(store.estimatedMaxMin) !== undefined
        ? `${store.estimatedMinMin}-${store.estimatedMaxMin}`
        : undefined,
    isOpen: typeof store.isOpen === "boolean" ? store.isOpen : undefined,
    opensAt: str(store.opensAt),
    closesAt: str(store.closesAt),
    category: str(category?.name as string | undefined),
    minimumOrderAmount: num(store.minimumOrderAmount),
  });
}

/**
 * Product/variant summary for search_products, search_store_products,
 * list_category_products. Drops image URLs and internal productId.
 */
export function projectProduct(p: AnyRecord) {
  const price = num(p.price);
  const salePrice = num(p.salePrice);
  return compact({
    variantId: str(p.variantId) ?? str(p._id),
    name: str(p.name),
    unit: str(p.unit),
    price: salePrice !== undefined && price !== undefined && salePrice < price
      ? salePrice
      : price,
    wasPrice:
      salePrice !== undefined && price !== undefined && salePrice < price
        ? price
        : undefined,
    currency: str(p.currency),
    inStock: typeof p.inStock === "boolean" ? p.inStock : undefined,
    storeId: str(p.organizationId),
    storeName: str(p.organizationName),
  });
}

/**
 * Cart summary for create_guest_cart / get_cart / add_to_cart and friends.
 * Collapses each line to name, qty, unit price and subtotal.
 */
export function projectCart(cart: AnyRecord | null) {
  if (!cart) {
    return null;
  }
  const items = Array.isArray(cart.items) ? (cart.items as AnyRecord[]) : [];
  return compact({
    cartId: str(cart._id),
    currency: str(cart.currencyCode) ?? "UGX",
    itemCount: num(cart.itemCount),
    subtotal: num(cart.subtotal),
    items: items.map((item) => {
      const product = item.product as AnyRecord | null | undefined;
      const variant = item.variant as AnyRecord | null | undefined;
      const modifiers = Array.isArray(item.modifiers)
        ? (item.modifiers as AnyRecord[])
        : [];
      return compact({
        variantId: str(variant?._id as string | undefined),
        name: str(product?.name as string | undefined),
        unit: str(variant?.unit as string | undefined),
        quantity: num(item.quantity),
        unitPrice: num(item.effectivePrice),
        subtotal: num(item.subtotal),
        modifiers: modifiers.length
          ? modifiers
              .map((m) => str(m.name as string | undefined))
              .filter(Boolean)
              .join(", ")
          : undefined,
      });
    }),
  });
}

/** Store category summary for list_store_categories. */
export function projectCategory(c: AnyRecord) {
  return compact({
    categoryId: str(c._id) ?? str(c.categoryId),
    name: str(c.name),
    productCount: num(c.productCount),
  });
}

/** Opening-hours summary for get_store_timings. */
export function projectTimings(t: AnyRecord | null) {
  if (!t) {
    return null;
  }
  return compact({
    storeId: str(t._id),
    name: str(t.name),
    isOpen: typeof t.isOpen === "boolean" ? t.isOpen : undefined,
    opensAt: str(t.opensAt),
    closesAt: str(t.closesAt),
    isBusy: typeof t.isBusy === "boolean" ? t.isBusy : undefined,
  });
}

/** Map an array through a projector, tolerating non-array input. */
export function projectMany<T>(
  value: unknown,
  fn: (row: AnyRecord) => T
): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return (value as AnyRecord[]).map(fn);
}

/**
 * Serialize a tool payload compactly. Pretty-printing with 2-space indent
 * costs roughly 30% extra tokens for no benefit to the model.
 */
export function toolText(value: unknown): string {
  return JSON.stringify(value);
}
