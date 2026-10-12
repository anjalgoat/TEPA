import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import {
    buildFinancialReview,
    financialFixtureSchema,
    offeringSchema,
    type CustomerMetric,
    type FinancialFixture,
    type FinancialRow,
} from "@tepa/domain";

const offeringFile = new URL("../../../../../data/fixtures/issuer/offering.json", import.meta.url);
export const sampleOffering = offeringSchema.parse(JSON.parse(readFileSync(offeringFile, "utf8")) as unknown);

export function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

export function loadFinancialFixture(version: 1 | 2): { fixture: FinancialFixture; inputSha256: string } {
    const file = new URL(
        `../../../../../data/fixtures/financials/reconciliation.v${version}.json`,
        import.meta.url,
    );
    const contents = readFileSync(file, "utf8");
    const fixture = financialFixtureSchema.parse(JSON.parse(contents) as unknown);
    if (fixture.fixtureVersion !== version) throw new Error("Fixture version mismatch");
    const review = buildFinancialReview(
        fixture.rows,
        fixture.metrics,
        sampleOffering.participationBasisPoints,
    );
    if (
        review.annual.definedDistributableCashMinor !== fixture.expectedAnnualDefinedCashMinor ||
        review.annual.distributionPoolMinor !== fixture.expectedAnnualPoolMinor
    ) {
        throw new Error("Fixture calculation mismatch");
    }
    return { fixture, inputSha256: sha256(contents) };
}

export type IssuerRecord = {
    id: string;
    public_id: string;
    display_name: string;
    version: number;
    active_import_id: string | null;
};

export async function findIssuer(client: PoolClient | Pool, forUpdate = false): Promise<IssuerRecord | null> {
    const result = await client.query<IssuerRecord>(
        `SELECT id, public_id, display_name, version, active_import_id FROM issuers
         WHERE public_id = 'example-saas' ${forUpdate ? "FOR UPDATE" : ""}`,
    );
    return result.rows[0] ?? null;
}

type ImportRow = {
    id: string;
    fixture_version: number;
    input_sha256: string;
    imported_by: string;
    imported_at: string;
};

export async function getActiveImport(
    client: PoolClient | Pool,
    issuer: IssuerRecord,
): Promise<ImportRow | null> {
    if (!issuer.active_import_id) return null;
    const result = await client.query<ImportRow>(
        "SELECT id, fixture_version, input_sha256, imported_by, imported_at FROM financial_imports WHERE id = $1",
        [issuer.active_import_id],
    );
    return result.rows[0] ?? null;
}

export async function getIssuerOverview(pool: Pool) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const overview = await readOverview(client);
        await client.query("COMMIT");
        return overview;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

async function readOverview(client: PoolClient) {
    const issuer = await findIssuer(client);
    if (!issuer)
        return {
            issuer: {
                publicId: "example-saas",
                displayName: sampleOffering.issuerName,
                fictional: true,
                version: 0,
            },
            activeImport: null,
            sourceRows: [],
            metrics: [],
            review: null,
            cases: [],
            approval: null,
        };
    const activeImport = await getActiveImport(client, issuer);
    if (!activeImport)
        return {
            issuer: {
                publicId: issuer.public_id,
                displayName: issuer.display_name,
                fictional: true,
                version: issuer.version,
            },
            activeImport: null,
            sourceRows: [],
            metrics: [],
            review: null,
            cases: [],
            approval: null,
        };
    const sourceResult = await client.query<FinancialRow & { rowSha256: string }>(
        `SELECT source_ref AS "sourceRef", source_system AS "sourceSystem", period, category,
                    amount_minor::text AS "amountMinor", evidence_ref AS "evidenceRef",
                    related_party AS "relatedParty", row_sha256 AS "rowSha256"
             FROM financial_source_rows WHERE import_id = $1 ORDER BY period, source_ref`,
        [activeImport.id],
    );
    const metricResult = await client.query<CustomerMetric & { rowSha256: string }>(
        `SELECT source_ref AS "sourceRef", period, active_customers AS "activeCustomers",
                    arr_minor::text AS "arrMinor", churn_basis_points AS "churnBasisPoints",
                    evidence_ref AS "evidenceRef", row_sha256 AS "rowSha256"
             FROM customer_metric_rows WHERE import_id = $1 ORDER BY period`,
        [activeImport.id],
    );
    const caseResult = await client.query<{
        caseKey: string;
        kind: string;
        period: string;
        sourceRefs: string[];
        deltaMinor: string;
        suggestion: string;
        status: string;
        resolutionCode: string | null;
        reason: string | null;
        reviewedBy: string | null;
    }>(
        `SELECT case_key AS "caseKey", kind, period, source_refs AS "sourceRefs",
                    delta_minor::text AS "deltaMinor", suggestion, status,
                    resolution_code AS "resolutionCode", reason, reviewed_by AS "reviewedBy"
             FROM financial_review_cases WHERE import_id = $1 ORDER BY period, case_key`,
        [activeImport.id],
    );
    const approvalResult = await client.query<{
        id: string;
        import_id: string;
        input_sha256: string;
        approved_by: string;
        approved_at: string;
        formula_version: string;
        fixture_version: number;
    }>(
        `SELECT a.id, a.import_id, a.input_sha256, a.approved_by, a.approved_at,
                    a.formula_version, i.fixture_version
             FROM financial_approvals a JOIN financial_imports i ON i.id = a.import_id
             WHERE i.issuer_id = $1 ORDER BY a.approved_at DESC LIMIT 1`,
        [issuer.id],
    );
    const latestApproval = approvalResult.rows[0] ?? null;
    return {
        issuer: {
            publicId: issuer.public_id,
            displayName: issuer.display_name,
            fictional: true,
            version: issuer.version,
        },
        activeImport: {
            id: activeImport.id,
            fixtureVersion: activeImport.fixture_version,
            inputSha256: activeImport.input_sha256,
            importedBy: activeImport.imported_by,
            importedAt: activeImport.imported_at,
        },
        sourceRows: sourceResult.rows,
        metrics: metricResult.rows,
        review: buildFinancialReview(
            sourceResult.rows.map((row) => ({
                sourceRef: row.sourceRef,
                sourceSystem: row.sourceSystem,
                period: row.period,
                category: row.category,
                amountMinor: row.amountMinor,
                evidenceRef: row.evidenceRef,
                relatedParty: row.relatedParty,
            })),
            metricResult.rows.map((row) => ({
                sourceRef: row.sourceRef,
                period: row.period,
                activeCustomers: row.activeCustomers,
                arrMinor: row.arrMinor,
                churnBasisPoints: row.churnBasisPoints,
                evidenceRef: row.evidenceRef,
            })),
            sampleOffering.participationBasisPoints,
        ),
        cases: caseResult.rows,
        approval: latestApproval
            ? {
                  id: latestApproval.id,
                  status:
                      latestApproval.import_id === activeImport.id &&
                      latestApproval.input_sha256 === activeImport.input_sha256
                          ? "CURRENT"
                          : "INVALIDATED_BY_NEW_IMPORT",
                  fixtureVersion: latestApproval.fixture_version,
                  approvedBy: latestApproval.approved_by,
                  approvedAt: latestApproval.approved_at,
                  formulaVersion: latestApproval.formula_version,
              }
            : null,
    };
}

export async function getAuditEvents(pool: Pool) {
    const result = await pool.query<{
        id: string;
        actorRef: string;
        actorRole: string;
        action: string;
        resourceType: string;
        resourceId: string;
        reason: string;
        sourceVersion: string;
        beforeHash: string | null;
        afterHash: string | null;
        formulaVersion: string | null;
        policyVersion: string | null;
        termsVersion: string | null;
        approvalId: string | null;
        chainCommandId: string | null;
        chainEventId: string | null;
        occurredAt: string;
    }>(`SELECT id, actor_ref AS "actorRef", actor_role AS "actorRole", action,
                 resource_type AS "resourceType", resource_id AS "resourceId", reason,
                 source_version AS "sourceVersion", before_hash AS "beforeHash",
                 after_hash AS "afterHash", formula_version AS "formulaVersion",
                 policy_version AS "policyVersion", terms_version AS "termsVersion",
                 approval_id AS "approvalId", chain_command_id AS "chainCommandId",
                 chain_event_id AS "chainEventId", occurred_at AS "occurredAt"
          FROM audit_events ORDER BY occurred_at DESC, id DESC LIMIT 200`);
    return result.rows;
}
