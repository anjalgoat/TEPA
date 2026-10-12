import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { buildFinancialReview } from "@tepa/domain";

import { ApiError, type Actor } from "../../http.js";
import {
    findIssuer,
    getActiveImport,
    loadFinancialFixture,
    sampleOffering,
    sha256,
    type IssuerRecord,
} from "./data.js";

type MutationInput = Readonly<{
    actor: Actor;
    action: string;
    idempotencyKey: string;
    expectedVersion: number;
    reason: string;
    body: unknown;
}>;

type MutationEvidence = Readonly<{
    eventType: string;
    sourceVersion: string;
    beforeHash: string | null;
    afterHash: string;
    approvalId?: string;
}>;

type OperationResponse = Readonly<{ operationId: string; status: "CONFIRMED"; resourceVersion: number }>;

async function transact(
    pool: Pool,
    input: MutationInput,
    canCreateIssuer: boolean,
    work: (client: PoolClient, issuer: IssuerRecord) => Promise<MutationEvidence>,
): Promise<OperationResponse> {
    const client = await pool.connect();
    const requestSha256 = sha256(
        JSON.stringify({
            action: input.action,
            body: input.body,
            expectedVersion: input.expectedVersion,
            reason: input.reason,
        }),
    );
    try {
        await client.query("BEGIN");
        if (canCreateIssuer) {
            await client.query(
                `INSERT INTO issuers (public_id, display_name, fictional)
                 VALUES ('example-saas', 'Example SaaS, Inc.', true) ON CONFLICT (public_id) DO NOTHING`,
            );
        }
        const issuer = await findIssuer(client, true);
        if (!issuer) throw new ApiError(404, "ISSUER_NOT_FOUND", "Import fictional records first.");
        const priorOperation = await client.query<{ request_sha256: string; response: OperationResponse }>(
            `SELECT request_sha256, response FROM financial_operations
             WHERE actor_ref = $1 AND action = $2 AND idempotency_key = $3`,
            [input.actor.actorRef, input.action, input.idempotencyKey],
        );
        const previous = priorOperation.rows[0];
        if (previous) {
            if (previous.request_sha256 !== requestSha256) {
                throw new ApiError(
                    409,
                    "IDEMPOTENCY_CONFLICT",
                    "This idempotency key was used for a different request.",
                );
            }
            await client.query("COMMIT");
            return previous.response;
        }
        if (issuer.version !== input.expectedVersion) {
            throw new ApiError(
                409,
                "STALE_VERSION",
                `Current issuer version is ${issuer.version}. Refresh before retrying.`,
            );
        }
        const evidence = await work(client, issuer);
        const resourceVersion = issuer.version + 1;
        const operationId = randomUUID();
        const response: OperationResponse = { operationId, status: "CONFIRMED", resourceVersion };
        await client.query("UPDATE issuers SET version = $2, updated_at = now() WHERE id = $1", [
            issuer.id,
            resourceVersion,
        ]);
        await client.query(
            `INSERT INTO financial_operations
             (id, actor_ref, action, idempotency_key, request_sha256, resource_version, status, response)
             VALUES ($1, $2, $3, $4, $5, $6, 'CONFIRMED', $7::jsonb)`,
            [
                operationId,
                input.actor.actorRef,
                input.action,
                input.idempotencyKey,
                requestSha256,
                resourceVersion,
                JSON.stringify(response),
            ],
        );
        await client.query(
            `INSERT INTO audit_events
             (actor_ref, actor_role, action, resource_type, resource_id, source_version,
              before_hash, after_hash, reason, request_id, formula_version, policy_version, approval_id)
             VALUES ($1, $2, $3, 'financial_review', $4, $5, $6, $7, $8, $9,
                     'sample-distributable-cash-v1', 'phase1-review-v1', $10)`,
            [
                input.actor.actorRef,
                input.actor.role,
                evidence.eventType,
                issuer.id,
                evidence.sourceVersion,
                evidence.beforeHash,
                evidence.afterHash,
                input.reason,
                input.idempotencyKey,
                evidence.approvalId ?? null,
            ],
        );
        await client.query(
            `INSERT INTO outbox_events (operation_id, event_type, payload)
             VALUES ($1, $2, $3::jsonb)`,
            [
                operationId,
                evidence.eventType,
                JSON.stringify({ issuerPublicId: issuer.public_id, resourceVersion }),
            ],
        );
        await client.query("COMMIT");
        return response;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function importFinancialFixture(
    pool: Pool,
    input: Omit<MutationInput, "action">,
    fixtureVersion: 1 | 2,
) {
    return transact(
        pool,
        { ...input, action: "FINANCIAL_IMPORT", body: { fixtureVersion } },
        true,
        async (client, issuer) => {
            const prior = await getActiveImport(client, issuer);
            if (prior && fixtureVersion <= prior.fixture_version) {
                throw new ApiError(409, "FIXTURE_NOT_NEWER", "Import a newer fictional fixture version.");
            }
            const { fixture, inputSha256 } = loadFinancialFixture(fixtureVersion);
            const review = buildFinancialReview(
                fixture.rows,
                fixture.metrics,
                sampleOffering.participationBasisPoints,
            );
            const inserted = await client.query<{ id: string }>(
                `INSERT INTO financial_imports (issuer_id, fixture_version, input_sha256, imported_by)
             VALUES ($1, $2, $3, $4) RETURNING id`,
                [issuer.id, fixtureVersion, inputSha256, input.actor.actorRef],
            );
            const importId = inserted.rows[0]!.id;
            for (const row of fixture.rows) {
                await client.query(
                    `INSERT INTO financial_source_rows
                 (import_id, source_ref, source_system, period, category, amount_minor,
                  evidence_ref, related_party, row_sha256)
                 VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9)`,
                    [
                        importId,
                        row.sourceRef,
                        row.sourceSystem,
                        row.period,
                        row.category,
                        row.amountMinor,
                        row.evidenceRef,
                        row.relatedParty,
                        sha256(JSON.stringify(row)),
                    ],
                );
            }
            for (const metric of fixture.metrics) {
                await client.query(
                    `INSERT INTO customer_metric_rows
                 (import_id, source_ref, period, active_customers, arr_minor,
                  churn_basis_points, evidence_ref, row_sha256)
                 VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8)`,
                    [
                        importId,
                        metric.sourceRef,
                        metric.period,
                        metric.activeCustomers,
                        metric.arrMinor,
                        metric.churnBasisPoints,
                        metric.evidenceRef,
                        sha256(JSON.stringify(metric)),
                    ],
                );
            }
            for (const issue of review.issues) {
                await client.query(
                    `INSERT INTO financial_review_cases
                 (import_id, case_key, kind, period, source_refs, delta_minor, suggestion)
                 VALUES ($1, $2, $3, $4, $5, $6::numeric, $7)`,
                    [
                        importId,
                        issue.caseKey,
                        issue.kind,
                        issue.period,
                        issue.sourceRefs,
                        issue.deltaMinor,
                        issue.suggestion,
                    ],
                );
            }
            await client.query("UPDATE issuers SET active_import_id = $2 WHERE id = $1", [
                issuer.id,
                importId,
            ]);
            if (prior) {
                const approved = await client.query<{ id: string }>(
                    "SELECT id FROM financial_approvals WHERE import_id = $1",
                    [prior.id],
                );
                if (approved.rows[0]) {
                    await client.query(
                        `INSERT INTO audit_events
                     (actor_ref, actor_role, action, resource_type, resource_id, source_version,
                      before_hash, after_hash, reason, request_id, formula_version, policy_version, approval_id)
                     VALUES ($1, $2, 'FINANCIAL_APPROVAL_INVALIDATED', 'financial_review', $3, $4,
                             $5, $6, $7, $8, 'sample-distributable-cash-v1', 'phase1-review-v1', $9)`,
                        [
                            input.actor.actorRef,
                            input.actor.role,
                            issuer.id,
                            `fixture-v${fixtureVersion}`,
                            prior.input_sha256,
                            inputSha256,
                            "A revised fictional input superseded the approved import.",
                            input.idempotencyKey,
                            approved.rows[0].id,
                        ],
                    );
                }
            }
            return {
                eventType: "FINANCIAL_IMPORT_CREATED",
                sourceVersion: `fixture-v${fixtureVersion}`,
                beforeHash: prior?.input_sha256 ?? null,
                afterHash: inputSha256,
            };
        },
    );
}

export async function resolveReviewCase(
    pool: Pool,
    input: Omit<MutationInput, "action">,
    caseKey: string,
    resolutionCode: "ACCEPT_PROCESSOR" | "ACKNOWLEDGE_RELATED_PARTY",
) {
    return transact(
        pool,
        { ...input, action: `RESOLVE:${caseKey}`, body: { caseKey, resolutionCode } },
        false,
        async (client, issuer) => {
            const active = await getActiveImport(client, issuer);
            if (!active) throw new ApiError(404, "IMPORT_NOT_FOUND", "Import fictional records first.");
            const existingApproval = await client.query(
                "SELECT id FROM financial_approvals WHERE import_id = $1",
                [active.id],
            );
            if (existingApproval.rowCount)
                throw new ApiError(409, "ALREADY_APPROVED", "Approved review cases cannot be changed.");
            const result = await client.query<{ kind: string; status: string }>(
                "SELECT kind, status FROM financial_review_cases WHERE import_id = $1 AND case_key = $2 FOR UPDATE",
                [active.id, caseKey],
            );
            const reviewCase = result.rows[0];
            if (!reviewCase) throw new ApiError(404, "CASE_NOT_FOUND", "Review case not found.");
            if (reviewCase.status !== "OPEN")
                throw new ApiError(409, "CASE_ALREADY_RESOLVED", "Review case already resolved.");
            const validResolution =
                reviewCase.kind === "RELATED_PARTY"
                    ? resolutionCode === "ACKNOWLEDGE_RELATED_PARTY"
                    : resolutionCode === "ACCEPT_PROCESSOR";
            if (!validResolution)
                throw new ApiError(400, "INVALID_RESOLUTION", "Resolution does not match the review case.");
            await client.query(
                `UPDATE financial_review_cases
             SET status = 'RESOLVED', resolution_code = $3, reason = $4,
                 reviewed_by = $5, reviewed_at = now()
             WHERE import_id = $1 AND case_key = $2`,
                [active.id, caseKey, resolutionCode, input.reason, input.actor.actorRef],
            );
            return {
                eventType: "FINANCIAL_CASE_RESOLVED",
                sourceVersion: `fixture-v${active.fixture_version}`,
                beforeHash: active.input_sha256,
                afterHash: sha256(JSON.stringify({ caseKey, resolutionCode, reason: input.reason })),
            };
        },
    );
}

export async function approveFinancialReview(pool: Pool, input: Omit<MutationInput, "action">) {
    return transact(
        pool,
        { ...input, action: "FINANCIAL_REVIEW_APPROVED", body: {} },
        false,
        async (client, issuer) => {
            const active = await getActiveImport(client, issuer);
            if (!active) throw new ApiError(404, "IMPORT_NOT_FOUND", "Import fictional records first.");
            if (active.imported_by === input.actor.actorRef) {
                throw new ApiError(
                    403,
                    "SELF_APPROVAL_FORBIDDEN",
                    "The preparer cannot approve this import.",
                );
            }
            const cases = await client.query<{
                case_key: string;
                status: string;
                resolution_code: string | null;
                reason: string | null;
                reviewed_by: string | null;
            }>(
                `SELECT case_key, status, resolution_code, reason, reviewed_by
             FROM financial_review_cases WHERE import_id = $1 ORDER BY case_key FOR UPDATE`,
                [active.id],
            );
            if (cases.rows.some((row) => row.status !== "RESOLVED")) {
                throw new ApiError(
                    409,
                    "UNRESOLVED_CASES",
                    "Resolve every flagged difference before approval.",
                );
            }
            const existing = await client.query("SELECT id FROM financial_approvals WHERE import_id = $1", [
                active.id,
            ]);
            if (existing.rowCount)
                throw new ApiError(409, "ALREADY_APPROVED", "This import is already approved.");
            const decisionsSha256 = sha256(
                JSON.stringify(
                    cases.rows.map((row) => ({
                        caseKey: row.case_key,
                        resolutionCode: row.resolution_code,
                        reason: row.reason,
                        reviewedBy: row.reviewed_by,
                    })),
                ),
            );
            const result = await client.query<{ id: string }>(
                `INSERT INTO financial_approvals
             (import_id, input_sha256, decisions_sha256, formula_version, approved_by, reason)
             VALUES ($1, $2, $3, 'sample-distributable-cash-v1', $4, $5) RETURNING id`,
                [active.id, active.input_sha256, decisionsSha256, input.actor.actorRef, input.reason],
            );
            return {
                eventType: "FINANCIAL_REVIEW_APPROVED",
                sourceVersion: `fixture-v${active.fixture_version}`,
                beforeHash: active.input_sha256,
                afterHash: decisionsSha256,
                approvalId: result.rows[0]!.id,
            };
        },
    );
}
