import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";

interface OpenApiBaseline {
  pathCount: number;
  sha256: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

const baselinePath = fileURLToPath(new URL("../openapi-contract-baseline.json", import.meta.url));
const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as OpenApiBaseline;
const app = await buildApp();

try {
  await app.ready();
  const spec = app.swagger() as { paths?: Record<string, unknown> };
  const actual: OpenApiBaseline = {
    pathCount: Object.keys(spec.paths ?? {}).length,
    sha256: createHash("sha256").update(canonicalJson(spec)).digest("hex"),
  };

  if (actual.pathCount !== baseline.pathCount || actual.sha256 !== baseline.sha256) {
    throw new Error(
      `OpenAPI contract changed: expected ${baseline.pathCount}/${baseline.sha256}, ` +
        `received ${actual.pathCount}/${actual.sha256}. Review the API change and intentionally update openapi-contract-baseline.json.`,
    );
  }

  console.log(`OpenAPI contract verified (${actual.pathCount} paths, ${actual.sha256})`);
} finally {
  await app.close();
}
