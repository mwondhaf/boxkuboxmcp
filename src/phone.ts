import libphonenumber from "google-libphonenumber";

const { PhoneNumberUtil, PhoneNumberFormat, PhoneNumberType } = libphonenumber;
const phoneUtil = PhoneNumberUtil.getInstance();

const MOBILE_TYPES = new Set<number>([
  PhoneNumberType.MOBILE,
  PhoneNumberType.FIXED_LINE_OR_MOBILE,
]);

export class InvalidPhoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPhoneError";
  }
}

/**
 * Validate and normalize a Ugandan mobile phone number to E.164 (+256XXXXXXXXX).
 * Accepts raw input like "0772123456", "+256772123456", "256 772 123 456".
 * Throws InvalidPhoneError with a user-facing message on failure.
 */
export function normalizeUgMobile(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new InvalidPhoneError("Phone number is required");
  }

  let parsed;
  try {
    parsed = phoneUtil.parseAndKeepRawInput(trimmed, "UG");
  } catch {
    throw new InvalidPhoneError(
      "Could not parse phone number. Use a Ugandan number like 0772123456 or +256772123456."
    );
  }

  if (!phoneUtil.isValidNumberForRegion(parsed, "UG")) {
    throw new InvalidPhoneError("Not a valid Ugandan phone number");
  }

  const type = phoneUtil.getNumberType(parsed);
  if (!MOBILE_TYPES.has(type)) {
    throw new InvalidPhoneError(
      "Only mobile numbers are accepted (landlines cannot receive delivery updates)."
    );
  }

  return phoneUtil.format(parsed, PhoneNumberFormat.E164);
}
