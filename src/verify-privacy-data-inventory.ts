import { connectPostgres, disconnectPostgres, requirePostgres } from "./db/postgres.js";

type GapRow = { relation_name: string };
type SummaryRow = { authorities: string; sources: string; postgres_relations: string; external_sources: string; unresolved_sources: string; access_ready: string; portability_ready: string };

try {
  await connectPostgres({ required: true });
  const database = requirePostgres();
  const [missing, stale, emptyAuthorities, summary] = await Promise.all([
    database.query<GapRow>(
      `SELECT 'fractal.' || table_record.tablename AS relation_name
         FROM pg_catalog.pg_tables table_record
         LEFT JOIN fractal.privacy_data_sources source
           ON source.source_kind='postgres_relation'
          AND source.source_locator='fractal.' || table_record.tablename
        WHERE table_record.schemaname='fractal' AND source.source_key IS NULL
        ORDER BY table_record.tablename`,
    ),
    database.query<GapRow>(
      `SELECT source.source_locator AS relation_name
         FROM fractal.privacy_data_sources source
         LEFT JOIN pg_catalog.pg_tables table_record
           ON table_record.schemaname='fractal'
          AND 'fractal.' || table_record.tablename=source.source_locator
        WHERE source.source_kind='postgres_relation' AND table_record.tablename IS NULL
        ORDER BY source.source_locator`,
    ),
    database.query<{ authority_key: string }>(
      `SELECT authority.authority_key
         FROM fractal.privacy_data_authorities authority
         LEFT JOIN fractal.privacy_data_sources source ON source.authority_key=authority.authority_key
        GROUP BY authority.authority_key
       HAVING count(source.source_key)=0
        ORDER BY authority.authority_key`,
    ),
    database.query<SummaryRow>(
      `SELECT
         (SELECT count(*) FROM fractal.privacy_data_authorities)::text AS authorities,
         count(*)::text AS sources,
         count(*) FILTER (WHERE source_kind='postgres_relation')::text AS postgres_relations,
         count(*) FILTER (WHERE source_kind<>'postgres_relation')::text AS external_sources,
         count(*) FILTER (WHERE inventory_status='unresolved')::text AS unresolved_sources,
         count(*) FILTER (WHERE access_status='available')::text AS access_ready,
         count(*) FILTER (WHERE portability_status='available')::text AS portability_ready
       FROM fractal.privacy_data_sources`,
    ),
  ]);

  const problems = [
    missing.rowCount ? `uncatalogued relations: ${missing.rows.map((row) => row.relation_name).join(", ")}` : null,
    stale.rowCount ? `stale relation entries: ${stale.rows.map((row) => row.relation_name).join(", ")}` : null,
    emptyAuthorities.rowCount ? `authorities without sources: ${emptyAuthorities.rows.map((row) => row.authority_key).join(", ")}` : null,
  ].filter(Boolean);
  if (problems.length) throw new Error(`Privacy data inventory verification failed (${problems.join("; ")})`);

  const row = summary.rows[0]!;
  console.log(`Privacy data inventory verified: ${row.authorities} authorities, ${row.sources} sources, ${row.postgres_relations} PostgreSQL relations, ${row.external_sources} external sources; ${row.unresolved_sources} explicitly unresolved; ${row.access_ready} access-ready and ${row.portability_ready} portability-ready.`);
} finally {
  await disconnectPostgres();
}
