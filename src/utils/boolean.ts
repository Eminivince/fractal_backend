import { z } from "zod";

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

/**
 * Environment and query values arrive as strings. Do not use
 * `z.coerce.boolean()` here: JavaScript treats every non-empty string,
 * including "false", as truthy.
 */
export function booleanFromString(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const normalized = value.trim().toLowerCase();
    if (TRUE_VALUES.has(normalized)) return true;
    if (FALSE_VALUES.has(normalized)) return false;
    return value;
  }, z.boolean()).default(defaultValue);
}
