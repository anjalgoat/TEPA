import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { buildFinancialReview } from "@tepa/domain";
import { createApp } from "../../app.js";
import { parseStartupConfig } from "../../config.js";
import { migrate } from "../../migrate.js";
import { loadFinancialFixture, sampleOffering } from "./data.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

type TestBody = {
    token: string;
    operationId: string;
    resourceVersion: number;
    code: string;
    cases: Array<{ caseKey: string; kind: string; status: string }>;
    sourceRows: Array<{ sourceRef: string; rowSha256: string }>;
    metrics: unknown[];
    review: {
        annual: { definedDistributableCashMinor: string; distributionPoolMinor: string };
        periods: Array<{ lines: { receipts: { sourceRefs: string[] } } }>;
    };
    approval: { status: string };
    events: Array<{ action: string }>;
};

describe.skipIf(!databaseUrl)("Phase 1 API and PostgreSQL", () => {
    let pool: pg.Pool;
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
        await migrate(databaseUrl!);
        pool = new pg.Pool({ connectionString: databaseUrl });
        await pool.query(`TRUNCATE financial_operations, financial_approvals, financial_review_cases,
            customer_metric_rows, financial_source_rows, financial_imports, issuers,
            audit_events, outbox_events CASCADE`);
        const app = createApp(parseStartupConfig({ APP_ENV: "test", DATABASE_URL: databaseUrl }), pool);
        server = app.listen(0);
        await new Promise<void>((resolve) => server.once("listening", resolve));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
        if (pool) await pool.end();
    });

    async function request(
        path: string,
        options: {
            method?: string;
            token?: string;
            body?: unknown;
            version?: number;
            reason?: string;
            key?: string;
        } = {},
    ) {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (options.token) headers.Authorization = `Bearer ${options.token}`;
        if (options.version !== undefined) {
            headers["If-Match"] = String(options.version);
            headers["Idempotency-Key"] = options.key ?? randomUUID();
            headers["X-Action-Reason"] = options.reason ?? "Synthetic review test action";
        }
        const response = await fetch(`${baseUrl}${path}`, {
            method: options.method ?? "GET",
            headers,
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        });
        return { status: response.status, body: (await response.json()) as TestBody };
    }

    async function session(role: string): Promise<string> {
        const result = await request("/demo/session", { method: "POST", body: { role } });
        expect(result.status).toBe(200);
        return result.body.token as string;
    }

    it("imports, reviews, approves, and invalidates revised synthetic inputs", async () => {
        const preparer = await session("ISSUER_PREPARER");
        const reviewer = await session("FINANCE_REVIEWER");
        const auditor = await session("AUDITOR");
        expect((await request("/api/v1/issuer")).status).toBe(401);
        expect(
            (
                await request("/api/v1/financial-imports", {
                    method: "POST",
                    token: auditor,
                    version: 0,
                    body: { fixtureVersion: 1 },
                })
            ).status,
        ).toBe(403);

        const key = randomUUID();
        const first = await request("/api/v1/financial-imports", {
            method: "POST",
            token: preparer,
            version: 0,
            key,
            reason: "Load the first fictional financial source set",
            body: { fixtureVersion: 1 },
        });
        expect(first.status).toBe(201);
        expect(first.body.resourceVersion).toBe(1);
        const replay = await request("/api/v1/financial-imports", {
            method: "POST",
            token: preparer,
            version: 0,
            key,
            reason: "Load the first fictional financial source set",
            body: { fixtureVersion: 1 },
        });
        expect(replay.body.operationId).toBe(first.body.operationId);
        const conflict = await request("/api/v1/financial-imports", {
            method: "POST",
            token: preparer,
            version: 0,
            key,
            reason: "Different request using the same idempotency key",
            body: { fixtureVersion: 2 },
        });
        expect(conflict.body.code).toBe("IDEMPOTENCY_CONFLICT");
        const operation = await request(`/api/v1/operations/${first.body.operationId}`, { token: preparer });
        expect(operation.body).toEqual(first.body);

        let overview = await request("/api/v1/issuer", { token: reviewer });
        expect(overview.status).toBe(200);
        expect(overview.body.cases).toHaveLength(3);
        expect(overview.body.sourceRows).toHaveLength(96);
        expect(overview.body.metrics).toHaveLength(12);
        const fixture = loadFinancialFixture(1).fixture;
        const domainResult = buildFinancialReview(
            fixture.rows,
            fixture.metrics,
            sampleOffering.participationBasisPoints,
        );
        expect(overview.body.review.annual).toEqual(domainResult.annual);
        const firstRow = overview.body.sourceRows.find(
            (row: { sourceRef: string }) => row.sourceRef === fixture.rows[0]?.sourceRef,
        );
        expect(firstRow?.rowSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(overview.body.review.periods[0]?.lines.receipts.sourceRefs).toEqual(["processor:2025-01"]);

        expect(
            (
                await request("/api/v1/reconciliations/approve", {
                    method: "POST",
                    token: reviewer,
                    version: 1,
                    body: {},
                })
            ).body.code,
        ).toBe("UNRESOLVED_CASES");
        const cases = overview.body.cases as Array<{ caseKey: string; kind: string }>;
        let version = 1;
        for (const reviewCase of cases) {
            const resolutionCode =
                reviewCase.kind === "RELATED_PARTY" ? "ACKNOWLEDGE_RELATED_PARTY" : "ACCEPT_PROCESSOR";
            const result = await request(
                `/api/v1/reconciliations/${encodeURIComponent(reviewCase.caseKey)}/resolve`,
                {
                    method: "POST",
                    token: reviewer,
                    version,
                    reason: `Reviewed synthetic ${reviewCase.kind} evidence and retained the processor-based preview`,
                    body: { resolutionCode },
                },
            );
            expect(result.status).toBe(200);
            version = result.body.resourceVersion as number;
        }
        expect(version).toBe(4);
        expect(
            (
                await request("/api/v1/reconciliations/approve", {
                    method: "POST",
                    token: reviewer,
                    version: 3,
                    body: {},
                })
            ).body.code,
        ).toBe("STALE_VERSION");
        const approved = await request("/api/v1/reconciliations/approve", {
            method: "POST",
            token: reviewer,
            version: 4,
            body: {},
            reason: "Approve the reviewed fictional cash preview",
        });
        expect(approved.status).toBe(200);
        overview = await request("/api/v1/issuer", { token: auditor });
        expect(overview.body.approval.status).toBe("CURRENT");
        expect(overview.body.cases.every((item: { status: string }) => item.status === "RESOLVED")).toBe(
            true,
        );

        const revised = await request("/api/v1/financial-imports", {
            method: "POST",
            token: preparer,
            version: 5,
            body: { fixtureVersion: 2 },
            reason: "Load revised fictional operating expense evidence",
        });
        expect(revised.status).toBe(201);
        overview = await request("/api/v1/issuer", { token: auditor });
        expect(overview.body.approval.status).toBe("INVALIDATED_BY_NEW_IMPORT");
        expect(overview.body.cases.filter((item: { status: string }) => item.status === "OPEN")).toHaveLength(
            3,
        );
        expect(overview.body.review.annual.distributionPoolMinor).toBe("623000");
        const events = await request("/api/v1/audit-events", { token: auditor });
        expect(
            events.body.events.some(
                (event: { action: string }) => event.action === "FINANCIAL_APPROVAL_INVALIDATED",
            ),
        ).toBe(true);
        expect(events.body.events[0]).toMatchObject({
            resourceType: "financial_review",
            formulaVersion: "sample-distributable-cash-v1",
            policyVersion: "phase1-review-v1",
        });
        const investor = await session("INVESTOR_A");
        expect((await request("/api/v1/audit-events", { token: investor })).status).toBe(403);
        const counts = await pool.query<{ operations: string; outbox: string }>(
            "SELECT (SELECT count(*) FROM financial_operations)::text AS operations, (SELECT count(*) FROM outbox_events)::text AS outbox",
        );
        expect(counts.rows[0]).toEqual({ operations: "6", outbox: "6" });
    });
});
