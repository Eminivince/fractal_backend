import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = process.cwd();
const schemaPath = resolve(packageRoot, "src/config/env.ts");
const examplePath = resolve(packageRoot, ".env.example");
const [schemaSource, exampleSource] = await Promise.all([
  readFile(schemaPath, "utf8"),
  readFile(examplePath, "utf8"),
]);

const schemaStart = schemaSource.indexOf("const schema = z.object({");
const schemaEnd = schemaSource.indexOf("}).superRefine", schemaStart);
if (schemaStart < 0 || schemaEnd < 0) {
  throw new Error("Could not locate the top-level environment schema");
}

const schemaBlock = schemaSource.slice(schemaStart, schemaEnd);
const schemaKeys = [...schemaBlock.matchAll(/^  ([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1]!);
const exampleKeys = [...exampleSource.matchAll(/^(?:export\s+)?([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]!);

function duplicates(keys: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) repeated.add(key);
    seen.add(key);
  }
  return [...repeated].sort();
}

const schemaSet = new Set(schemaKeys);
const exampleSet = new Set(exampleKeys);
const missing = schemaKeys.filter((key) => !exampleSet.has(key));
const extra = exampleKeys.filter((key) => !schemaSet.has(key));
const schemaDuplicates = duplicates(schemaKeys);
const exampleDuplicates = duplicates(exampleKeys);

const result = {
  schemaVariables: schemaKeys.length,
  exampleVariables: exampleKeys.length,
  missing,
  extra,
  schemaDuplicates,
  exampleDuplicates,
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ ...result, variables: schemaKeys }, null, 2)}\n`);
}

if (missing.length || extra.length || schemaDuplicates.length || exampleDuplicates.length) {
  if (!process.argv.includes("--json")) {
    console.error("Environment contract drift detected:");
    if (missing.length) console.error(`  Missing from .env.example: ${missing.join(", ")}`);
    if (extra.length) console.error(`  Not present in runtime schema: ${extra.join(", ")}`);
    if (schemaDuplicates.length) console.error(`  Duplicate schema keys: ${schemaDuplicates.join(", ")}`);
    if (exampleDuplicates.length) console.error(`  Duplicate .env.example keys: ${exampleDuplicates.join(", ")}`);
  }
  process.exitCode = 1;
} else if (!process.argv.includes("--json")) {
  console.log(`Environment contract verified: ${schemaKeys.length} runtime variables are documented exactly once.`);
}
