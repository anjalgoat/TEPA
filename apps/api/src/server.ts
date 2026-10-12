import { createApp } from "./app.js";
import { parseStartupConfig } from "./config.js";
import pg from "pg";

const config = parseStartupConfig(process.env);
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 8 });
try {
    const result = await pool.query<{ name: string }>(
        "SELECT name FROM schema_migrations WHERE name = '0009_settlement_integrity.sql'",
    );
    if (!result.rows[0]) throw new Error("Phase 4 migration is missing. Run npm run db:migrate.");
} catch (error) {
    await pool.end();
    throw error;
}

const localDemo =
    config.APP_ENV === "demo" && ["localhost", "127.0.0.1"].includes(new URL(config.WEB_ORIGIN).hostname);
const server = createApp(config, pool).listen(config.PORT, localDemo ? "127.0.0.1" : "0.0.0.0", () => {
    console.log(`TEPA API listening on port ${config.PORT}`);
});

let stopping = false;
function stop() {
    if (stopping) return;
    stopping = true;
    server.close(() => void pool.end());
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
