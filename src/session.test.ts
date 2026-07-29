/**
 * Self-check for phone binding — the rule that decides whose orders and
 * addresses a tool call can read. Run with `bun src/session.test.ts`.
 */

import { strict as assert } from "node:assert";
import type { IncomingMessage } from "node:http";
import {
  CUSTOMER_PHONE_HEADER,
  readBoundPhone,
  resolveCustomerPhone,
} from "./session";

const BOUND = "+256772123456";
const OTHER = "0700111222";

function req(headers: Record<string, string | string[]>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function setRequireCustomerPhone(value: boolean): void {
  process.env.MCP_REQUIRE_CUSTOMER_PHONE = value ? "true" : "";
}

function main() {
  // --- readBoundPhone -------------------------------------------------------
  assert.equal(readBoundPhone(req({})), undefined, "no header → unbound");
  assert.equal(
    readBoundPhone(req({ [CUSTOMER_PHONE_HEADER]: "  " })),
    undefined,
    "blank header → unbound"
  );
  assert.equal(
    readBoundPhone(req({ [CUSTOMER_PHONE_HEADER]: "0772123456" })),
    BOUND,
    "header normalized to E.164"
  );
  assert.equal(
    readBoundPhone(req({ [CUSTOMER_PHONE_HEADER]: ["0772123456", "0700"] })),
    BOUND,
    "repeated header → first value"
  );
  assert.throws(
    () => readBoundPhone(req({ [CUSTOMER_PHONE_HEADER]: "not-a-number" })),
    "garbage header fails loudly rather than falling back"
  );

  // --- operator mode (unset flag) ------------------------------------------
  setRequireCustomerPhone(false);
  const operator = resolveCustomerPhone;
  assert.equal(
    operator(undefined, "0700111222"),
    "+256700111222",
    "unbound: operator's own input is used"
  );
  assert.throws(
    () => operator(undefined, undefined),
    "unbound with no argument is still an error"
  );

  // --- the actual security property ----------------------------------------
  assert.equal(
    operator(BOUND, OTHER),
    BOUND,
    "bound session ignores a model-supplied number"
  );
  assert.equal(
    operator(BOUND, undefined),
    BOUND,
    "bound session needs no argument"
  );

  // --- customer-facing mode fails closed -----------------------------------
  setRequireCustomerPhone(true);
  const strict = resolveCustomerPhone;
  assert.throws(
    () => strict(undefined, OTHER),
    "MCP_REQUIRE_CUSTOMER_PHONE: an unbound session cannot fall back to an argument"
  );
  assert.equal(
    strict(BOUND, OTHER),
    BOUND,
    "MCP_REQUIRE_CUSTOMER_PHONE: bound session still works, argument ignored"
  );

  console.log("session binding: all checks passed");
}

main();
