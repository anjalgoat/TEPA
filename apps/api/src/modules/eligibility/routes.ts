import type { Express } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import type { StartupConfig } from "../../config.js";
import { mutationHeaders, requireRole, type Actor } from "../../http.js";
import {
    acknowledgeTerms,
    allocate,
    bindWallet,
    commitSubscription,
    createChallenge,
    decideEligibility,
    getPhase2,
    holderRefs,
    publishTerms,
    queueIssuance,
    revokeEligibility,
    type HolderRef,
} from "./service.js";

const refSchema = z.enum(holderRefs as [HolderRef, ...HolderRef[]]);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const sigSchema = z
    .string()
    .regex(/^0x[0-9a-fA-F]{130}$/)
    .transform((value) => value as `0x${string}`);
const emptySchema = z.strictObject({});

type Auth = (request: import("express").Request) => Actor;
export function registerEligibilityRoutes(
    app: Express,
    pool: Pool,
    config: StartupConfig,
    authenticate: Auth,
) {
    app.get("/api/v1/phase2", async (request, response) => {
        response.json(
            await getPhase2(pool, authenticate(request), config.CHAIN_ID, config.TEPA_TOKEN_ADDRESS ?? null),
        );
    });
    app.post("/api/v1/phase2/terms/publish", async (request, response) => {
        const actor = authenticate(request);
        requireRole(actor, "ISSUER_PREPARER");
        emptySchema.parse(request.body);
        const headers = mutationHeaders(request);
        response.status(201).json(
            await publishTerms(pool, {
                actor,
                action: "TERMS_PUBLISH",
                key: headers.idempotencyKey,
                expectedVersion: headers.expectedVersion,
                reason: headers.reason,
                body: {},
            }),
        );
    });
    app.post("/api/v1/phase2/holders/:holderRef/acknowledge", async (request, response) => {
        const actor = authenticate(request);
        const holderRef = refSchema.parse(request.params.holderRef);
        const body = z.strictObject({ termsSha256: hashSchema }).parse(request.body);
        const headers = mutationHeaders(request);
        response.json(
            await acknowledgeTerms(
                pool,
                {
                    actor,
                    action: `ACK:${holderRef}`,
                    key: headers.idempotencyKey,
                    expectedVersion: headers.expectedVersion,
                    reason: headers.reason,
                    body,
                },
                holderRef,
                body.termsSha256,
            ),
        );
    });
    app.post("/api/v1/phase2/holders/:holderRef/eligibility", async (request, response) => {
        const actor = authenticate(request);
        requireRole(actor, "COMPLIANCE_OPERATOR");
        const holderRef = refSchema.parse(request.params.holderRef);
        const body = z
            .strictObject({
                identity: z.enum(["PASS", "FAIL"]),
                sanctions: z.enum(["CLEAR", "HIT"]),
                expiresAt: z.iso.datetime({ offset: true }),
                jurisdiction: z.literal("US"),
            })
            .parse(request.body);
        const headers = mutationHeaders(request);
        response.json(
            await decideEligibility(
                pool,
                {
                    actor,
                    action: `ELIGIBILITY:${holderRef}`,
                    key: headers.idempotencyKey,
                    expectedVersion: headers.expectedVersion,
                    reason: headers.reason,
                    body,
                },
                holderRef,
                body,
            ),
        );
    });
    app.post("/api/v1/phase2/holders/:holderRef/revoke", async (request, response) => {
        const actor = authenticate(request);
        requireRole(actor, "COMPLIANCE_OPERATOR");
        const holderRef = refSchema.parse(request.params.holderRef);
        emptySchema.parse(request.body);
        const headers = mutationHeaders(request);
        response.json(
            await revokeEligibility(
                pool,
                {
                    actor,
                    action: `REVOKE:${holderRef}`,
                    key: headers.idempotencyKey,
                    expectedVersion: headers.expectedVersion,
                    reason: headers.reason,
                    body: {},
                },
                holderRef,
            ),
        );
    });
    app.post("/api/v1/phase2/holders/:holderRef/challenge", async (request, response) => {
        const actor = authenticate(request);
        const holderRef = refSchema.parse(request.params.holderRef);
        const body = z
            .strictObject({ walletAddress: addressSchema, chainId: z.number().int() })
            .parse(request.body);
        const headers = mutationHeaders(request);
        response.json(
            await createChallenge(
                pool,
                {
                    actor,
                    action: `CHALLENGE:${holderRef}`,
                    key: headers.idempotencyKey,
                    expectedVersion: headers.expectedVersion,
                    reason: headers.reason,
                    body,
                },
                holderRef,
                body.walletAddress,
                body.chainId,
                config.CHAIN_ID,
                holderRef === "synthetic-holder-a"
                    ? config.DEMO_HOLDER_A_ADDRESS
                    : config.DEMO_HOLDER_B_ADDRESS,
            ),
        );
    });
    app.post("/api/v1/phase2/holders/:holderRef/bind", async (request, response) => {
        const actor = authenticate(request);
        const holderRef = refSchema.parse(request.params.holderRef);
        const body = z.strictObject({ challengeId: z.uuid(), signature: sigSchema }).parse(request.body);
        const headers = mutationHeaders(request);
        response.json(
            await bindWallet(
                pool,
                {
                    actor,
                    action: `BIND:${holderRef}`,
                    key: headers.idempotencyKey,
                    expectedVersion: headers.expectedVersion,
                    reason: headers.reason,
                    body,
                },
                holderRef,
                body.challengeId,
                body.signature,
                config.CHAIN_ID,
            ),
        );
    });
    app.post("/api/v1/phase2/holders/:holderRef/commit", async (request, response) => {
        const actor = authenticate(request);
        const holderRef = refSchema.parse(request.params.holderRef);
        emptySchema.parse(request.body);
        const headers = mutationHeaders(request);
        response.json(
            await commitSubscription(
                pool,
                {
                    actor,
                    action: `COMMIT:${holderRef}`,
                    key: headers.idempotencyKey,
                    expectedVersion: headers.expectedVersion,
                    reason: headers.reason,
                    body: {},
                },
                holderRef,
            ),
        );
    });
    app.post("/api/v1/phase2/holders/:holderRef/allocate", async (request, response) => {
        const actor = authenticate(request);
        requireRole(actor, "REGISTRY_AGENT");
        const holderRef = refSchema.parse(request.params.holderRef);
        emptySchema.parse(request.body);
        const headers = mutationHeaders(request);
        response.json(
            await allocate(
                pool,
                {
                    actor,
                    action: `ALLOCATE:${holderRef}`,
                    key: headers.idempotencyKey,
                    expectedVersion: headers.expectedVersion,
                    reason: headers.reason,
                    body: {},
                },
                holderRef,
            ),
        );
    });
    app.post("/api/v1/phase2/holders/:holderRef/issue", async (request, response) => {
        const actor = authenticate(request);
        requireRole(actor, "REGISTRY_AGENT");
        const holderRef = refSchema.parse(request.params.holderRef);
        emptySchema.parse(request.body);
        const headers = mutationHeaders(request);
        response.status(202).json(
            await queueIssuance(
                pool,
                {
                    actor,
                    action: `ISSUE:${holderRef}`,
                    key: headers.idempotencyKey,
                    expectedVersion: headers.expectedVersion,
                    reason: headers.reason,
                    body: {},
                },
                holderRef,
            ),
        );
    });
}
