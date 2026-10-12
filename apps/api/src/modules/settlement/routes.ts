import type { Express, Request } from "express";
import type { Pool } from "pg";
import { acquisitionWaterfallSchema, appraisalSchema } from "@tepa/domain";
import { z } from "zod";
import type { StartupConfig } from "../../config.js";
import { mutationHeaders, requireRole, type Actor } from "../../http.js";
import {
    advanceAcquisition,
    advanceBuyback,
    allocateBuybackCase,
    approveAppraisal,
    cancelSettlementCase,
    cancelTender,
    expireEmptyBuyback,
    getSettlements,
    prepareAcquisition,
    prepareAppraisal,
    prepareBuyback,
    recordSettlementReceipt,
    requestSettlementStep,
    resumeSettlement,
    snapshotAcquisition,
    submitTender,
} from "./service.js";

type Auth = (request: Request) => Actor;
const id = z.uuid();
const positive = z.string().regex(/^[1-9]\d*$/);
const empty = z.strictObject({});
const buyback = z.strictObject({
    appraisalId: id,
    budgetUsdMinor: positive,
    bindingUnitPriceUsdMinor: positive,
    tenderDeadline: z.iso.datetime({ offset: true }),
});
const txHash = z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .transform((value) => value as `0x${string}`);

function investor(actor: Actor) {
    if (actor.role !== "INVESTOR_A" && actor.role !== "INVESTOR_B") requireRole(actor, "INVESTOR_A");
}

export function registerSettlementRoutes(
    app: Express,
    pool: Pool,
    config: StartupConfig,
    authenticate: Auth,
) {
    app.get("/api/v1/settlements", async (request, response) => {
        response.json({ ...(await getSettlements(pool, authenticate(request))), chainId: config.CHAIN_ID });
    });
    app.post("/api/v1/appraisals", async (request, response) => {
        const actor = authenticate(request);
        requireRole(actor, "ISSUER_PREPARER");
        const body = appraisalSchema.parse(request.body);
        const headers = mutationHeaders(request);
        response.status(201).json(
            await prepareAppraisal(
                pool,
                {
                    actor,
                    action: "APPRAISAL_PREPARE",
                    key: headers.idempotencyKey,
                    expectedVersion: headers.expectedVersion,
                    reason: headers.reason,
                    body,
                },
                body,
            ),
        );
    });
    app.post("/api/v1/appraisals/:appraisalId/approve", async (request, response) => {
        const actor = authenticate(request);
        requireRole(actor, "FINANCE_REVIEWER");
        const appraisalId = id.parse(request.params.appraisalId);
        empty.parse(request.body);
        const headers = mutationHeaders(request);
        response.json(
            await approveAppraisal(
                pool,
                {
                    actor,
                    action: `APPRAISAL_APPROVE:${appraisalId}`,
                    key: headers.idempotencyKey,
                    expectedVersion: headers.expectedVersion,
                    reason: headers.reason,
                    body: {},
                },
                appraisalId,
            ),
        );
    });
    app.post("/api/v1/buybacks", async (request, response) => {
        const actor = authenticate(request);
        requireRole(actor, "ISSUER_PREPARER");
        const body = buyback.parse(request.body);
        const headers = mutationHeaders(request);
        response.status(201).json(
            await prepareBuyback(
                pool,
                {
                    actor,
                    action: "BUYBACK_PREPARE",
                    key: headers.idempotencyKey,
                    expectedVersion: headers.expectedVersion,
                    reason: headers.reason,
                    body,
                },
                body,
            ),
        );
    });
    for (const [segment, role, target] of [
        ["approve", "FINANCE_REVIEWER", "APPROVED"],
        ["open", "ISSUER_PREPARER", "OPEN"],
        ["close-tenders", "DISTRIBUTION_OPERATOR", "TENDER_CLOSED"],
    ] as const) {
        app.post(`/api/v1/buybacks/:caseId/${segment}`, async (request, response) => {
            const actor = authenticate(request);
            requireRole(actor, role);
            const caseId = id.parse(request.params.caseId);
            empty.parse(request.body);
            const headers = mutationHeaders(request);
            response.json(
                await advanceBuyback(
                    pool,
                    {
                        actor,
                        action: `BUYBACK_${target}:${caseId}`,
                        key: headers.idempotencyKey,
                        expectedVersion: headers.expectedVersion,
                        reason: headers.reason,
                        body: {},
                    },
                    caseId,
                    target,
                ),
            );
        });
    }
    app.post("/api/v1/buybacks/:caseId/tenders", async (request, response) => {
        const actor = authenticate(request);
        investor(actor);
        const caseId = id.parse(request.params.caseId);
        const body = z.strictObject({ units: z.number().int().positive().max(1000) }).parse(request.body);
        const headers = mutationHeaders(request);
        response.status(201).json(
            await submitTender(
                pool,
                {
                    actor,
                    action: `TENDER:${caseId}`,
                    key: headers.idempotencyKey,
                    expectedVersion: headers.expectedVersion,
                    reason: headers.reason,
                    body,
                },
                caseId,
                body.units,
            ),
        );
    });
    app.post("/api/v1/buybacks/:caseId/tenders/:tenderId/cancel", async (request, response) => {
        const actor = authenticate(request);
        investor(actor);
        const caseId = id.parse(request.params.caseId);
        const tenderId = id.parse(request.params.tenderId);
        empty.parse(request.body);
        const headers = mutationHeaders(request);
        response.json(
            await cancelTender(
                pool,
                {
                    actor,
                    action: `TENDER_CANCEL:${tenderId}`,
                    key: headers.idempotencyKey,
                    expectedVersion: headers.expectedVersion,
                    reason: headers.reason,
                    body: {},
                },
                caseId,
                tenderId,
            ),
        );
    });
    app.post("/api/v1/buybacks/:caseId/allocate", async (request, response) => {
        const actor = authenticate(request);
        requireRole(actor, "DISTRIBUTION_OPERATOR");
        const caseId = id.parse(request.params.caseId);
        empty.parse(request.body);
        const headers = mutationHeaders(request);
        response.json(
            await allocateBuybackCase(
                pool,
                config,
                {
                    actor,
                    action: `BUYBACK_ALLOCATE:${caseId}`,
                    key: headers.idempotencyKey,
                    expectedVersion: headers.expectedVersion,
                    reason: headers.reason,
                    body: {},
                },
                caseId,
            ),
        );
    });
    app.post("/api/v1/acquisitions", async (request, response) => {
        const actor = authenticate(request);
        requireRole(actor, "ISSUER_PREPARER");
        const body = acquisitionWaterfallSchema.parse(request.body);
        const headers = mutationHeaders(request);
        response.status(201).json(
            await prepareAcquisition(
                pool,
                {
                    actor,
                    action: "ACQUISITION_PREPARE",
                    key: headers.idempotencyKey,
                    expectedVersion: headers.expectedVersion,
                    reason: headers.reason,
                    body,
                },
                body,
            ),
        );
    });
    for (const [segment, role, target] of [
        ["review", "FINANCE_REVIEWER", "EVIDENCE_REVIEW"],
        ["approve", "FINANCE_REVIEWER", "APPROVED"],
    ] as const) {
        app.post(`/api/v1/acquisitions/:caseId/${segment}`, async (request, response) => {
            const actor = authenticate(request);
            requireRole(actor, role);
            const caseId = id.parse(request.params.caseId);
            empty.parse(request.body);
            const headers = mutationHeaders(request);
            response.json(
                await advanceAcquisition(
                    pool,
                    {
                        actor,
                        action: `ACQUISITION_${target}:${caseId}`,
                        key: headers.idempotencyKey,
                        expectedVersion: headers.expectedVersion,
                        reason: headers.reason,
                        body: {},
                    },
                    caseId,
                    target,
                ),
            );
        });
    }
    app.post("/api/v1/acquisitions/:caseId/snapshot", async (request, response) => {
        const actor = authenticate(request);
        requireRole(actor, "DISTRIBUTION_OPERATOR");
        const caseId = id.parse(request.params.caseId);
        empty.parse(request.body);
        const headers = mutationHeaders(request);
        response.json(
            await snapshotAcquisition(
                pool,
                config,
                {
                    actor,
                    action: `ACQUISITION_SNAPSHOT:${caseId}`,
                    key: headers.idempotencyKey,
                    expectedVersion: headers.expectedVersion,
                    reason: headers.reason,
                    body: {},
                },
                caseId,
            ),
        );
    });
    for (const kind of ["buybacks", "acquisitions"] as const) {
        app.post(`/api/v1/${kind}/:caseId/cancel`, async (request, response) => {
            const actor = authenticate(request);
            requireRole(actor, "ISSUER_PREPARER");
            const caseId = id.parse(request.params.caseId);
            empty.parse(request.body);
            const headers = mutationHeaders(request);
            response.json(
                await cancelSettlementCase(
                    pool,
                    {
                        actor,
                        action: `SETTLEMENT_CANCEL:${caseId}`,
                        key: headers.idempotencyKey,
                        expectedVersion: headers.expectedVersion,
                        reason: headers.reason,
                        body: {},
                    },
                    caseId,
                ),
            );
        });
        app.post(`/api/v1/${kind}/:caseId/resume`, async (request, response) => {
            const actor = authenticate(request);
            requireRole(actor, "DISTRIBUTION_OPERATOR");
            const caseId = id.parse(request.params.caseId);
            empty.parse(request.body);
            const headers = mutationHeaders(request);
            response.json(
                await resumeSettlement(
                    pool,
                    {
                        actor,
                        action: `SETTLEMENT_RESUME:${caseId}`,
                        key: headers.idempotencyKey,
                        expectedVersion: headers.expectedVersion,
                        reason: headers.reason,
                        body: {},
                    },
                    caseId,
                ),
            );
        });
        for (const step of ["FUND", "FINALIZE"] as const) {
            app.post(`/api/v1/${kind}/:caseId/${step.toLowerCase()}`, async (request, response) => {
                const actor = authenticate(request);
                requireRole(actor, "DISTRIBUTION_OPERATOR");
                const caseId = id.parse(request.params.caseId);
                empty.parse(request.body);
                const headers = mutationHeaders(request);
                response.json(
                    await requestSettlementStep(
                        pool,
                        {
                            actor,
                            action: `SETTLEMENT_${step}:${caseId}`,
                            key: headers.idempotencyKey,
                            expectedVersion: headers.expectedVersion,
                            reason: headers.reason,
                            body: {},
                        },
                        caseId,
                        step,
                    ),
                );
            });
        }
        app.post(`/api/v1/${kind}/:caseId/receipts`, async (request, response) => {
            const actor = authenticate(request);
            investor(actor);
            const caseId = id.parse(request.params.caseId);
            const body = z.strictObject({ txHash }).parse(request.body);
            const headers = mutationHeaders(request);
            response.json(
                await recordSettlementReceipt(
                    pool,
                    config,
                    {
                        actor,
                        action: `SETTLEMENT_RECEIPT:${caseId}`,
                        key: headers.idempotencyKey,
                        expectedVersion: headers.expectedVersion,
                        reason: headers.reason,
                        body,
                    },
                    caseId,
                    body.txHash,
                ),
            );
        });
    }
    app.post("/api/v1/buybacks/:caseId/expire-empty", async (request, response) => {
        const actor = authenticate(request);
        requireRole(actor, "DISTRIBUTION_OPERATOR");
        const caseId = id.parse(request.params.caseId);
        empty.parse(request.body);
        const headers = mutationHeaders(request);
        response.json(
            await expireEmptyBuyback(
                pool,
                {
                    actor,
                    action: `BUYBACK_EXPIRE_EMPTY:${caseId}`,
                    key: headers.idempotencyKey,
                    expectedVersion: headers.expectedVersion,
                    reason: headers.reason,
                    body: {},
                },
                caseId,
            ),
        );
    });
}
