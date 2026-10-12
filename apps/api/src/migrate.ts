import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

import { parseStartupConfig } from "./config.js";

export const migrationsDirectory = fileURLToPath(new URL("../../../database/migrations/", import.meta.url));

export async function migrate(databaseUrl: string, directory = migrationsDirectory): Promise<string[]> {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const applied: string[] = [];

    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(1413828673)");
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
            name text PRIMARY KEY,
            sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
            applied_at timestamptz NOT NULL DEFAULT now()
        )`);

        const filenames = (await readdir(directory))
            .filter((filename) => /^\d{4}_[a-z0-9_]+\.sql$/.test(filename))
            .sort();
        const existing = await client.query<{ name: string; sha256: string }>(
            "SELECT name, sha256 FROM schema_migrations",
        );
        const checksums = new Map(existing.rows.map((row) => [row.name, row.sha256]));

        for (const filename of filenames) {
            const sql = await readFile(path.join(directory, filename), "utf8");
            const sha256 = createHash("sha256").update(sql).digest("hex");
            const oldChecksum = checksums.get(filename);
            if (oldChecksum !== undefined) {
                if (oldChecksum !== sha256) throw new Error(`Applied migration changed: ${filename}`);
                continue;
            }
            await client.query(sql);
            await client.query("INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)", [
                filename,
                sha256,
            ]);
            applied.push(filename);
        }

        if (
            checksums.size > filenames.length ||
            [...checksums.keys()].some((name) => !filenames.includes(name))
        ) {
            throw new Error("Database has a migration missing from this checkout");
        }
        await client.query("COMMIT");
        return applied;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        await client.end();
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const config = parseStartupConfig(process.env);
    migrate(config.DATABASE_URL)
        .then((names) =>
            console.log(
                names.length ? `Applied migrations: ${names.join(", ")}` : "Migrations already current",
            ),
        )
        .catch((error: unknown) => {
            console.error(error instanceof Error ? error.message : "Migration failed");
            process.exitCode = 1;
        });
}
