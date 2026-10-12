import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../../app.js";
import { parseStartupConfig } from "../../config.js";
import { migrate } from "../../migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const walletA = privateKeyToAccount(`0x${"1".repeat(64)}`);
const walletB = privateKeyToAccount(`0x${"2".repeat(64)}`);

type Body = Record<string, unknown> & {
    code?: string;
    resourceVersion?: number;
    message?: string;
    challengeId?: string;
    terms?: { sha256: string };
    holders?: Array<{ recordedUnits: number; subscriptionStatus: string; walletAddress: string }>;
};

describe.skipIf(!databaseUrl)("Phase 2 eligibility and issuance API", () => {
    let pool: pg.Pool;
    let server: Server;
    let baseUrl: string;
    let version = 0;
    const sessions = new Map<string, string>();

    beforeAll(async () => {
        await migrate(databaseUrl!);
        pool = new pg.Pool({ connectionString: databaseUrl });
        await pool.query(`TRUNCATE phase2_chain_steps,phase2_operations,wallet_challenges,phase2_holders,prototype_terms,
            financial_operations,financial_approvals,financial_review_cases,customer_metric_rows,
            financial_source_rows,financial_imports,issuers,audit_events,outbox_events CASCADE`);
        await pool.query(
            "INSERT INTO issuers (public_id,display_name,fictional,version) VALUES ('example-saas','Example SaaS, Inc.',true,0)",
        );
        server = createApp(
            parseStartupConfig({
                APP_ENV: "test",
                DATABASE_URL: databaseUrl,
                DEMO_HOLDER_A_ADDRESS: walletA.address,
                DEMO_HOLDER_B_ADDRESS: walletB.address,
            }),
            pool,
        ).listen(0);
        await new Promise<void>((resolve) => server.once("listening", resolve));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        for (const role of [
            "ISSUER_PREPARER",
            "COMPLIANCE_OPERATOR",
            "REGISTRY_AGENT",
            "INVESTOR_A",
            "INVESTOR_B",
            "AUDITOR",
        ]) {
            const result = await request("/demo/session", "POST", undefined, { role });
            sessions.set(role, result.body.token as string);
        }
    });
    afterAll(async () => {
        if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
        if (pool) await pool.end();
    });

    async function request(
        path: string,
        method = "GET",
        role?: string,
        body?: unknown,
        options?: { version?: number; key?: string },
    ) {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (role) headers.Authorization = `Bearer ${sessions.get(role)}`;
        if (method !== "GET" && role) {
            headers["If-Match"] = String(options?.version ?? version);
            headers["Idempotency-Key"] = options?.key ?? randomUUID();
            headers["X-Action-Reason"] = "Fictional Phase 2 workflow check";
        }
        const response = await fetch(`${baseUrl}${path}`, {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const data = (await response.json()) as Body;
        if (data.resourceVersion !== undefined && response.ok) version = data.resourceVersion;
        return { status: response.status, body: data };
    }
    const path = (holder: "a" | "b", suffix: string) =>
        `/api/v1/phase2/holders/synthetic-holder-${holder}/${suffix}`;

    it("requires role, terms, a signed right-chain wallet, and a recorded allocation", async () => {
        expect((await request("/api/v1/phase2")).status).toBe(401);
        expect((await request("/api/v1/phase2/terms/publish", "POST", "AUDITOR", {})).status).toBe(403);
        expect((await request("/api/v1/phase2/terms/publish", "POST", "ISSUER_PREPARER", {})).status).toBe(
            201,
        );
        const state = await request("/api/v1/phase2", "GET", "INVESTOR_A");
        expect(state.body.holders).toHaveLength(1);
        const termsSha256 = state.body.terms!.sha256;
        expect((await request(path("b", "acknowledge"), "POST", "INVESTOR_A", { termsSha256 })).status).toBe(
            403,
        );
        expect((await request(path("a", "acknowledge"), "POST", "INVESTOR_A", { termsSha256 })).status).toBe(
            200,
        );
        expect((await request(path("a", "allocate"), "POST", "REGISTRY_AGENT", {})).body.code).toBe(
            "ALLOCATION_NOT_READY",
        );
        expect(
            (
                await request(path("a", "eligibility"), "POST", "COMPLIANCE_OPERATOR", {
                    identity: "PASS",
                    sanctions: "CLEAR",
                    expiresAt: new Date(Date.now() + 86400_000).toISOString(),
                    jurisdiction: "US",
                })
            ).status,
        ).toBe(200);
        expect(
            (
                await request(path("a", "challenge"), "POST", "INVESTOR_A", {
                    walletAddress: walletA.address,
                    chainId: 84532,
                })
            ).body.code,
        ).toBe("WRONG_CHAIN_OR_WALLET");
        expect(
            (
                await request(path("a", "challenge"), "POST", "INVESTOR_A", {
                    walletAddress: walletB.address,
                    chainId: 31337,
                })
            ).body.code,
        ).toBe("UNEXPECTED_DEMO_WALLET");
        const challenge = await request(path("a", "challenge"), "POST", "INVESTOR_A", {
            walletAddress: walletA.address,
            chainId: 31337,
        });
        expect(challenge.status).toBe(200);
        const badSig = await walletB.signMessage({ message: challenge.body.message! });
        expect(
            (
                await request(path("a", "bind"), "POST", "INVESTOR_A", {
                    challengeId: challenge.body.challengeId,
                    signature: badSig,
                })
            ).body.code,
        ).toBe("SIGNATURE_INVALID");
        const signature = await walletA.signMessage({ message: challenge.body.message! });
        expect(
            (
                await request(path("a", "bind"), "POST", "INVESTOR_A", {
                    challengeId: challenge.body.challengeId,
                    signature,
                })
            ).status,
        ).toBe(200);
        expect(
            (
                await request(path("a", "bind"), "POST", "INVESTOR_A", {
                    challengeId: challenge.body.challengeId,
                    signature,
                })
            ).body.code,
        ).toBe("WALLET_ALREADY_BOUND");
        expect((await request(path("a", "commit"), "POST", "INVESTOR_A", {})).status).toBe(200);
        expect((await request(path("a", "allocate"), "POST", "REGISTRY_AGENT", {})).status).toBe(200);
        expect((await request(path("a", "issue"), "POST", "AUDITOR", {})).status).toBe(403);
        const issued = await request(path("a", "issue"), "POST", "REGISTRY_AGENT", {});
        expect(issued.status).toBe(202);
        expect(issued.body.status).toBe("PENDING");
        const holder = (await request("/api/v1/phase2", "GET", "REGISTRY_AGENT")).body.holders![0]!;
        expect(holder.recordedUnits).toBe(0);
        expect(holder.subscriptionStatus).toBe("ALLOCATED");
        const outbox = await pool.query(
            "SELECT status FROM outbox_events WHERE event_type='DEMO_ISSUANCE_REQUESTED'",
        );
        expect(outbox.rows[0]?.status).toBe("PENDING");
    });

    it("rejects failed simulated checks and stale versions", async () => {
        const termsSha256 = (await request("/api/v1/phase2", "GET", "INVESTOR_B")).body.terms!.sha256;
        expect((await request(path("b", "acknowledge"), "POST", "INVESTOR_B", { termsSha256 })).status).toBe(
            200,
        );
        const rejected = await request(path("b", "eligibility"), "POST", "COMPLIANCE_OPERATOR", {
            identity: "PASS",
            sanctions: "HIT",
            expiresAt: new Date(Date.now() + 86400_000).toISOString(),
            jurisdiction: "US",
        });
        expect(rejected.body.eligibilityStatus).toBe("REJECTED");
        expect(
            (
                await request(path("b", "challenge"), "POST", "INVESTOR_B", {
                    walletAddress: walletB.address,
                    chainId: 31337,
                })
            ).body.code,
        ).toBe("NOT_ELIGIBLE");
        const stale = await request(path("b", "allocate"), "POST", "REGISTRY_AGENT", {}, { version: 0 });
        expect(stale.body.code).toBe("STALE_VERSION");
    });
});
