import pg from "pg";

import { parseStartupConfig } from "./config.js";

async function expectDatabaseError(client: pg.Client, sql: string, code: string): Promise<void> {
    await client.query("SAVEPOINT expected_failure");
    try {
        await client.query(sql);
        throw new Error(`Database unexpectedly accepted: ${sql}`);
    } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== code) throw error;
    } finally {
        await client.query("ROLLBACK TO SAVEPOINT expected_failure");
        await client.query("RELEASE SAVEPOINT expected_failure");
    }
}

async function main(): Promise<void> {
    const config = parseStartupConfig(process.env);
    const client = new pg.Client({ connectionString: config.DATABASE_URL });
    await client.connect();
    try {
        const migrations = await client.query<{ name: string }>(
            "SELECT name FROM schema_migrations ORDER BY name",
        );
        if (
            !migrations.rows.some((row) => row.name === "0001_foundation.sql") ||
            !migrations.rows.some((row) => row.name === "0003_eligibility_issuance.sql") ||
            !migrations.rows.some((row) => row.name === "0007_distribution_revisions.sql") ||
            !migrations.rows.some((row) => row.name === "0008_settlement.sql") ||
            !migrations.rows.some((row) => row.name === "0009_settlement_integrity.sql")
        ) {
            throw new Error("Expected foundation through Phase 4 migrations are missing");
        }
        const tables = await client.query<{ table_name: string }>(
            `SELECT table_name FROM information_schema.tables WHERE table_schema='public'
             AND table_name IN ('distribution_epochs','distribution_entitlements','distribution_claims',
                                'distribution_chain_steps','distribution_reconciliation_incidents',
                                'phase4_appraisals','phase4_cases','phase4_tenders','phase4_allocations',
                                'phase4_receipts','phase4_operations','phase4_chain_steps')`,
        );
        if (tables.rows.length !== 12) throw new Error("Phase 3 or Phase 4 tables are missing");
        const triggers = await client.query<{ tgname: string }>(
            `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
             ('distribution_entitlements_append_only','distribution_claims_append_only',
              'distribution_reconciliation_incidents_append_only',
              'phase4_allocations_append_only','phase4_receipts_append_only',
              'phase4_appraisal_protected','phase4_case_protected','phase4_tender_protected',
              'phase4_chain_steps_append_only')`,
        );
        if (triggers.rows.length !== 9)
            throw new Error("Phase 3 or Phase 4 evidence protections are missing");

        await client.query("BEGIN");
        await client.query(`INSERT INTO audit_events
            (actor_ref, actor_role, action, resource_type, resource_id, source_version, reason, request_id)
            VALUES ('synthetic:operator', 'ISSUER', 'CHECK', 'issuer', gen_random_uuid(), 'v1', 'schema check', gen_random_uuid())`);
        await expectDatabaseError(client, "UPDATE audit_events SET reason = 'changed'", "P0001");
        await expectDatabaseError(client, "DELETE FROM audit_events", "P0001");
        await expectDatabaseError(
            client,
            `INSERT INTO audit_events
             (actor_ref, actor_role, action, resource_type, resource_id, source_version, reason, request_id)
             VALUES ('synthetic:operator', 'ISSUER', 'CHECK', 'issuer', gen_random_uuid(), 'v1', '', gen_random_uuid())`,
            "23514",
        );
        await expectDatabaseError(
            client,
            "INSERT INTO issuers (public_id, display_name, fictional) VALUES ('invalid', 'Invalid', false)",
            "23514",
        );
        console.log("Foundation through Phase 4 migrations and database constraints verified");
    } finally {
        await client.query("ROLLBACK");
        await client.end();
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Database check failed");
    process.exitCode = 1;
});
