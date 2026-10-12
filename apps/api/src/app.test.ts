import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createApp } from "./app.js";
import { parseStartupConfig } from "./config.js";

describe("Base Sepolia demo role access", () => {
    let server: Server | null = null;
    let pool: pg.Pool | null = null;
    afterEach(async () => {
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
        if (pool) await pool.end();
    });
    async function session(origin: string) {
        pool = new pg.Pool({ connectionString: "postgresql://localhost:5432/unused" });
        const config = parseStartupConfig({
            APP_ENV: "demo",
            CHAIN_ID: "84532",
            BASE_SEPOLIA_RPC_URL: "https://example.invalid/rpc",
            WEB_ORIGIN: origin,
        });
        server = createApp(config, pool).listen(0, "127.0.0.1");
        await new Promise<void>((resolve) => server!.once("listening", resolve));
        const port = (server.address() as AddressInfo).port;
        const response = await fetch(`http://127.0.0.1:${port}/demo/session`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ role: "INVESTOR_A" }),
        });
        return response.status;
    }
    it("allows simulated roles for a loopback UI", async () => {
        expect(await session("http://localhost:5173")).toBe(200);
    });
    it("does not expose simulated roles to a hosted origin", async () => {
        expect(await session("https://demo.example.invalid")).toBe(404);
    });
});
