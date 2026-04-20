/**
 * Output sanitization for MCP tool responses.
 *
 * The MCP server is a public-facing surface exposed to AI assistants and
 * chat bots. Vendor and partner contact details (real phone numbers, bank
 * info, tax IDs, emails) must never leak through it. Replace any phone-like
 * field with the central customer-care number and drop anything else that
 * identifies a partner.
 *
 * Customer-owned fields (`guestPhone`, `deliveryLocation.phone`) are kept —
 * those belong to the caller and they already know them.
 */

export const SUPPORT_PHONE = "0200923088";

// Fields replaced with the support number. Anything matching these keys on
// any nested object is rewritten.
const PHONE_FIELDS = new Set([
  "phone",
  "contactPersonPhone",
  "mobileMoneyNumber",
  "riderPhone",
  "pickupPhone",
  "recipientPhone",
  "supportPhone",
  "supportWhatsApp",
]);

// Fields stripped entirely — internal / PII / payout / identifiers that
// should never reach an AI client.
const STRIPPED_FIELDS = new Set([
  "contactPersonName",
  "contactPersonEmail",
  "email",
  "tin",
  "mobileMoneyName",
  "mobileMoneyProvider",
  "bankName",
  "bankAccountNumber",
  "bankAccountName",
  "bankBranch",
  "payoutMethod",
  "googlePlacesId",
  "clerkOrgId",
  "geohash",
]);

type Opts = {
  /** Keys that should NOT be masked even if they match PHONE_FIELDS. */
  preserve?: ReadonlySet<string>;
};

/**
 * Deep-clone the value, masking phone fields and stripping PII fields.
 */
export function sanitize<T>(value: T, opts: Opts = {}): T {
  return walk(value, opts, new Set()) as T;
}

function walk(value: unknown, opts: Opts, parents: Set<object>): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, opts, parents));
  }
  if (value && typeof value === "object") {
    // Avoid cycles.
    if (parents.has(value as object)) {
      return undefined;
    }
    parents.add(value as object);

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (STRIPPED_FIELDS.has(k)) {
        continue;
      }
      if (PHONE_FIELDS.has(k) && !opts.preserve?.has(k)) {
        // Replace with support number when the field is non-empty; leave
        // it null/undefined otherwise so consumers can tell "not set".
        out[k] = v == null || v === "" ? v : SUPPORT_PHONE;
        continue;
      }
      out[k] = walk(v, opts, parents);
    }

    parents.delete(value as object);
    return out;
  }
  return value;
}

/**
 * Specialization: sanitize an order returned by `check_order_status`.
 * The caller owns `guestPhone` and `deliveryLocation.phone` so those are
 * kept; rider/vendor phones are masked.
 */
export function sanitizeOrder<T>(order: T): T {
  return sanitize(order, {
    preserve: new Set(["guestPhone"]),
  });
}
