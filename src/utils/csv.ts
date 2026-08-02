/**
 * Minimal, dependency-free CSV serializer (RFC 4180 quoting).
 */

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === "object") s = JSON.stringify(value);
  else s = String(value);
  // Quote if the cell contains a comma, quote, CR or LF; double internal quotes.
  if (/[",\r\n]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Serialize an array of row objects to CSV. Columns default to the union of keys
 * (in first-seen order). Header row uses the column keys.
 */
export function toCsv(
  rows: Array<Record<string, unknown>>,
  columns?: string[],
): string {
  const cols =
    columns ??
    Array.from(
      rows.reduce<Set<string>>((set, row) => {
        for (const k of Object.keys(row)) set.add(k);
        return set;
      }, new Set<string>()),
    );

  const lines: string[] = [];
  lines.push(cols.map(escapeCell).join(","));
  for (const row of rows) {
    lines.push(cols.map((c) => escapeCell(row[c])).join(","));
  }
  return lines.join("\r\n");
}
