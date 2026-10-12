import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { parseStartupConfig } from "./config.js";
import { migrate } from "./migrate.js";
import { publishTerms } from "./modules/eligibility/service.js";
import { importFinancialFixture } from "./modules/metrics/mutations.js";

const appTables = [
    "audit_events",
    "customer_metric_rows",
    "distribution_chain_steps",
    "distribution_claims",
    "distribution_entitlements",
    "distribution_epochs",
    "distribution_operations",
    "distribution_reconciliation_incidents",
    "financial_approvals",
    "financial_imports",
    "financial_operations",
    "financial_review_cases",
    "financial_source_rows",
    "issuers",
    "outbox_events",
    "phase2_chain_steps",
    "phase2_holders",
    "phase2_operations",
    "phase4_allocations",
    "phase4_appraisals",
    "phase4_cases",
    "phase4_chain_steps",
    "phase4_operations",
    "phase4_receipts",
    "phase4_tenders",
    "prototype_terms",
    "wallet_challenges",
] as const;

export function assertLocalResetTarget(
    environment: NodeJS.ProcessEnv,
    confirmation: string,
): {
    databaseUrl: string;
    rpcUrl: string;
    databaseName: string;
} {
    const config = parseStartupConfig(environment);
    const database = new URL(config.DATABASE_URL);
    const rpc = new URL(environment.CHAIN_RPC_URL ?? "http://127.0.0.1:8545");
    const databaseName = decodeURIComponent(database.pathname.slice(1));
    const local = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (
        !["local", "test"].includes(config.APP_ENV) ||
        config.CHAIN_ID !== 31337 ||
        !local(database.hostname) ||
        !local(rpc.hostname) ||
        !["http:", "https:"].includes(rpc.protocol) ||
        !databaseName ||
        confirmation !== databaseName ||
        environment.TEPA_TOKEN_ADDRESS ||
        environment.TEST_USDC_ADDRESS ||
        environment.BASE_SEPOLIA_RPC_URL
    ) {
        throw new Error(
            "Reset requires a loopback PostgreSQL database and Anvil RPC, chain 31337, no configured deployment addresses, and --confirm=<database name>.",
        );
    }
    return { databaseUrl: config.DATABASE_URL, rpcUrl: rpc.toString(), databaseName };
}

async function anvilRequest(rpcUrl: string, method: string): Promise<unknown> {
    const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
        signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Anvil RPC failed (${response.status}).`);
    const result = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (result.error || !("result" in result))
        throw new Error(result.error?.message ?? `Anvil did not answer ${method}.`);
    return result.result;
}

export async function resetAndSeedLocalDemo(environment: NodeJS.ProcessEnv, confirmation: string) {
    const target = assertLocalResetTarget(environment, confirmation);
    await migrate(target.databaseUrl);
    const pool = new pg.Pool({ connectionString: target.databaseUrl, max: 2 });
    try {
        const actual = await pool.query<{ name: string }>("SELECT current_database() AS name");
        if (actual.rows[0]?.name !== target.databaseName) throw new Error("Database target changed.");
        const tables = await pool.query<{ tablename: string }>(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations' ORDER BY tablename",
        );
        if (tables.rows.map((row) => row.tablename).join(",") !== [...appTables].sort().join(","))
            throw new Error("Database tables differ from the reviewed demo schema; reset refused.");
        if ((await anvilRequest(target.rpcUrl, "eth_chainId")) !== "0x7a69")
            throw new Error("Anvil must report chain ID 31337.");
        const resetResult = await anvilRequest(target.rpcUrl, "anvil_reset");
        if (resetResult !== null && resetResult !== true) throw new Error("Anvil did not confirm its reset.");

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(`TRUNCATE ${appTables.join(", ")} RESTART IDENTITY CASCADE`);
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
        const imported = await importFinancialFixture(
            pool,
            {
                actor: { actorRef: "synthetic:issuer-preparer", role: "ISSUER_PREPARER" },
                idempotencyKey: randomUUID(),
                expectedVersion: 0,
                reason: "Seed fictional demo financial evidence",
                body: { fixtureVersion: 1 },
            },
            1,
        );
        await publishTerms(pool, {
            actor: { actorRef: "synthetic:issuer-preparer", role: "ISSUER_PREPARER" },
            action: "PUBLISH_TERMS",
            key: randomUUID(),
            expectedVersion: imported.resourceVersion,
            reason: "Seed fictional prototype terms and holders",
            body: {},
        });
        return { databaseName: target.databaseName, chainId: 31337, fixtureVersion: 1 };
    } finally {
        await pool.end();
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    resetAndSeedLocalDemo(process.env, process.argv[2]?.replace(/^--confirm=/, "") ?? "")
        .then((result) =>
            console.log(
                `Reset ${result.databaseName} and Anvil 31337; seeded fictional fixture v1 and terms v1.`,
            ),
        )
        .catch((error: unknown) => {
            const safe =
                error instanceof Error &&
                /^(Reset requires|Database target changed|Database tables differ|Anvil must|Anvil did not|Anvil RPC failed)/.test(
                    error.message,
                );
            console.error(safe ? error.message : "Demo reset failed. Check local PostgreSQL and Anvil.");
            process.exitCode = 1;
        });
}
