import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { config } from "./config";
import { normalizeUgMobile } from "./phone";

export function newSessionId(): string {
  return `mcp_${randomUUID()}`;
}

/**
 * Header carrying the phone number the calling runtime has already verified for
 * this conversation — for WhatsApp, the sender's MSISDN.
 *
 * This exists because a phone number is the authorization for reading a
 * customer's orders and addresses, and when an AI agent drives these tools the
 * *customer* writes the tool arguments. A model can be talked into passing
 * someone else's number; it cannot set an HTTP header. So when this header is
 * present, phone-scoped tools use it and ignore whatever the model supplied.
 */
export const CUSTOMER_PHONE_HEADER = "x-customer-phone";

/**
 * Read and normalize the bound phone for a session. Throws InvalidPhoneError if
 * the header is present but unusable — better to fail loudly at session setup
 * than to silently fall back to model-supplied numbers.
 */
export function readBoundPhone(req: IncomingMessage): string | undefined {
  const raw = req.headers[CUSTOMER_PHONE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value?.trim()) {
    return undefined;
  }
  return normalizeUgMobile(value);
}

/**
 * Decide which phone number a phone-scoped tool call should act on.
 *
 * - session bound (customer-facing agent): always the bound number. An argument,
 *   if the model sent one, is discarded rather than trusted.
 * - not bound (human operator taking a call): the supplied number, which is the
 *   operator's own input.
 * - not bound and MCP_REQUIRE_CUSTOMER_PHONE set: refuse. This is what makes a
 *   misconfigured customer-facing deployment fail closed instead of quietly
 *   reverting to the unsafe path.
 */
export function resolveCustomerPhone(
  boundPhone: string | undefined,
  provided: string | undefined
): string {
  if (boundPhone) {
    return boundPhone;
  }

  if (config.requireCustomerPhone) {
    throw new Error(
      `This server only acts on the phone number verified for the current conversation, and none was supplied. The calling runtime must set the ${CUSTOMER_PHONE_HEADER} header.`
    );
  }

  if (!provided?.trim()) {
    throw new Error(
      `A phone number is required: pass one, or have the calling runtime set the ${CUSTOMER_PHONE_HEADER} header.`
    );
  }

  return normalizeUgMobile(provided);
}
