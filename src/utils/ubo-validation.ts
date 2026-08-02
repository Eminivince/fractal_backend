/**
 * C7: Beneficial ownership validation.
 * Ensures UBO disclosure meets regulatory requirements (CAMA 2020 / FCCPA).
 */

interface UboEntry {
  fullName?: string;
  ownershipPct: number;
  dateOfBirth?: Date | string;
  nationality?: string;
  idDocumentRef?: string;
}

interface UboValidationResult {
  valid: boolean;
  totalPct: number;
  errors: string[];
}

const MIN_TOTAL_COVERAGE_PCT = 75;
const SIGNIFICANT_OWNERSHIP_THRESHOLD = 25;

export function validateUboCoverage(ubos: UboEntry[]): UboValidationResult {
  const errors: string[] = [];
  const totalPct = ubos.reduce((sum, u) => sum + (u.ownershipPct ?? 0), 0);

  if (totalPct < MIN_TOTAL_COVERAGE_PCT) {
    errors.push(
      `UBOs account for only ${totalPct}% of ownership. At least ${MIN_TOTAL_COVERAGE_PCT}% must be disclosed.`,
    );
  }

  for (const u of ubos) {
    if (u.ownershipPct >= SIGNIFICANT_OWNERSHIP_THRESHOLD) {
      if (!u.fullName?.trim()) {
        errors.push(`A UBO with ${u.ownershipPct}% ownership is missing a full name.`);
      }
      if (!u.nationality?.trim()) {
        errors.push(`UBO "${u.fullName || "unnamed"}" (${u.ownershipPct}%) is missing nationality.`);
      }
      if (!u.idDocumentRef?.trim()) {
        errors.push(`UBO "${u.fullName || "unnamed"}" (${u.ownershipPct}%) is missing an ID document reference.`);
      }
    }
  }

  return { valid: errors.length === 0, totalPct, errors };
}
