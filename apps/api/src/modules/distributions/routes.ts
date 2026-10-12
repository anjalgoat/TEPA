import type { Express, Request } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import type { StartupConfig } from "../../config.js";
import { mutationHeaders, requireRole, type Actor } from "../../http.js";
import {
    advanceDistribution,
    cancelDistribution,
    getDistributions,
    prepareDistribution,
    recordClaim,
    requestChainStep,
    snapshotDistribution,
} from "./service.js";

type Auth = (request: Request) => Actor;
const idSchema = z.uuid();
const quarterSchema = z.string().regex(/^20\d{2}-Q[1-4]$/);
const empty = z.strictObject({});
const txHashSchema = z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .transform((value) => value as `0x${string}`);

export function registerDistributionRoutes(
    app: Express,
    pool: Pool,
    config: StartupConfig,
    authenticate: Auth,
) {
    app.get("/api/v1/distributions", async (request, response) => {
        response.json(await getDistributions(pool, authenticate(request), config.CHAIN_ID));
    });
    app.post("/api/v1/distributions", async (request, response) => {
        const actor = authenticate(request);
        requireRole(actor, "ISSUER_PREPARER");
        const body = z.strictObject({ quarter: quarterSchema }).parse(request.body);
        const headers = mutationHeaders(request);
        response.status(201).json(
            await prepareDistribution(
                pool,
                {
                    actor,
                    action: `PREPARE:${body.quarter}`,
                    key: headers.idempotencyKey,
                    expectedVersion: headers.expectedVersion,
                    reason: headers.reason,
                    body,
                },
                body.quarter,
            ),
        );
    });
    app.post("/api/v1/distributions/:epochId/cancel", async (request, response) => {
        const actor = authenticate(request);
        requireRole(actor, "ISSUER_PREPARER");
        const id = idSchema.parse(request.params.epochId);
        empty.parse(request.body);
        const headers = mutationHeaders(request);
        response.json(
            await cancelDistribution(
                pool,
                {
                    actor,
                    action: `CANCEL:${id}`,
                    key: headers.idempotencyKey,
                    expectedVersion: headers.expectedVersion,
                    reason: headers.reason,
                    body: {},
                },
                id,
            ),
        );
    });
    for (const [segment, role, target] of [
        ["reconcile", "ISSUER_PREPARER", "RECONCILED"],
        ["review", "FINANCE_REVIEWER", "REVIEWED"],
        ["approve", "FINANCE_REVIEWER", "APPROVED"],
    ] as const) {
        app.post(`/api/v1/distributions/:epochId/${segment}`, async (request, response) => {
            const actor = authenticate(request);
            requireRole(actor, role);
            const id = idSchema.parse(request.params.epochId);
            empty.parse(request.body);
            const headers = mutationHeaders(request);
            response.json(
                await advanceDistribution(
                    pool,
                    {
                        actor,
                        action: `${target}:${id}`,
                        key: headers.idempotencyKey,
                        expectedVersion: headers.expectedVersion,
                        reason: headers.reason,
                        body: {},
                    },
                    id,
                    target,
                ),
            );
        });
    }
    app.post("/api/v1/distributions/:epochId/snapshot", async (request, response) => {
        const actor = authenticate(request);
        requireRole(actor, "DISTRIBUTION_OPERATOR");
        const id = idSchema.parse(request.params.epochId);
        empty.parse(request.body);
        const headers = mutationHeaders(request);
        response.json(
            await snapshotDistribution(
                pool,
                config,
                {
                    actor,
                    action: `SNAPSHOT:${id}`,
                    key: headers.idempotencyKey,
                    expectedVersion: headers.expectedVersion,
                    reason: headers.reason,
                    body: {},
                },
                id,
            ),
        );
    });
    for (const step of ["FUND", "OPEN"] as const) {
        app.post(`/api/v1/distributions/:epochId/${step.toLowerCase()}`, async (request, response) => {
            const actor = authenticate(request);
            requireRole(actor, "DISTRIBUTION_OPERATOR");
            const id = idSchema.parse(request.params.epochId);
            empty.parse(request.body);
            const headers = mutationHeaders(request);
            response.json(
                await requestChainStep(
                    pool,
                    {
                        actor,
                        action: `${step}:${id}`,
                        key: headers.idempotencyKey,
                        expectedVersion: headers.expectedVersion,
                        reason: headers.reason,
                        body: {},
                    },
                    id,
                    step,
                ),
            );
        });
    }
    app.post("/api/v1/distributions/:epochId/claim-receipts", async (request, response) => {
        const actor = authenticate(request);
        if (actor.role !== "INVESTOR_A" && actor.role !== "INVESTOR_B") requireRole(actor, "INVESTOR_A");
        const id = idSchema.parse(request.params.epochId);
        const body = z.strictObject({ txHash: txHashSchema }).parse(request.body);
        const headers = mutationHeaders(request);
        response.json(
            await recordClaim(
                pool,
                config,
                {
                    actor,
                    action: `CLAIM:${id}`,
                    key: headers.idempotencyKey,
                    expectedVersion: headers.expectedVersion,
                    reason: headers.reason,
                    body,
                },
                id,
                body.txHash,
            ),
        );
    });
}
