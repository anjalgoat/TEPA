import { z } from "zod";

const apiBase = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

const moneyLineSchema = z.object({ amountMinor: z.string(), sourceRefs: z.array(z.string()) });
const monthSchema = z.object({
    period: z.string(),
    lines: z.object({
        receipts: moneyLineSchema,
        operating: moneyLineSchema,
        tax: moneyLineSchema,
        debt: moneyLineSchema,
        reserve: moneyLineSchema,
        excluded: moneyLineSchema,
    }),
    definedDistributableCashMinor: z.string(),
    distributionPoolMinor: z.string(),
    customerMetricSourceRef: z.string(),
});

export const overviewSchema = z.object({
    issuer: z.object({
        publicId: z.string(),
        displayName: z.string(),
        fictional: z.literal(true),
        version: z.number(),
    }),
    activeImport: z
        .object({
            id: z.string(),
            fixtureVersion: z.number(),
            inputSha256: z.string(),
            importedBy: z.string(),
            importedAt: z.string(),
        })
        .nullable(),
    sourceRows: z.array(
        z.object({
            sourceRef: z.string(),
            sourceSystem: z.string(),
            period: z.string(),
            category: z.string(),
            amountMinor: z.string(),
            evidenceRef: z.string(),
            relatedParty: z.boolean(),
            rowSha256: z.string(),
        }),
    ),
    metrics: z.array(
        z.object({
            sourceRef: z.string(),
            period: z.string(),
            activeCustomers: z.number(),
            arrMinor: z.string(),
            churnBasisPoints: z.number(),
            evidenceRef: z.string(),
            rowSha256: z.string(),
        }),
    ),
    review: z
        .object({
            formulaVersion: z.string(),
            rounding: z.string(),
            periods: z.array(monthSchema),
            annual: z.object({
                definedDistributableCashMinor: z.string(),
                distributionPoolMinor: z.string(),
            }),
            matches: z.array(
                z.object({
                    period: z.string(),
                    sourceSystem: z.enum(["BANK", "LEDGER"]),
                    processorRef: z.string(),
                    comparedRef: z.string(),
                    deltaMinor: z.string(),
                    status: z.enum(["EXACT", "DIFFERENCE"]),
                }),
            ),
            issues: z.array(z.object({ caseKey: z.string(), kind: z.string(), period: z.string() })),
        })
        .nullable(),
    cases: z.array(
        z.object({
            caseKey: z.string(),
            kind: z.string(),
            period: z.string(),
            sourceRefs: z.array(z.string()),
            deltaMinor: z.string(),
            suggestion: z.string(),
            status: z.enum(["OPEN", "RESOLVED"]),
            resolutionCode: z.string().nullable(),
            reason: z.string().nullable(),
            reviewedBy: z.string().nullable(),
        }),
    ),
    approval: z
        .object({
            id: z.string(),
            status: z.enum(["CURRENT", "INVALIDATED_BY_NEW_IMPORT"]),
            fixtureVersion: z.number(),
            approvedBy: z.string(),
            approvedAt: z.string(),
            formulaVersion: z.string(),
        })
        .nullable(),
});

export type Overview = z.infer<typeof overviewSchema>;
export type DemoRole =
    | "ISSUER_PREPARER"
    | "FINANCE_REVIEWER"
    | "COMPLIANCE_OPERATOR"
    | "REGISTRY_AGENT"
    | "DISTRIBUTION_OPERATOR"
    | "INVESTOR_A"
    | "INVESTOR_B"
    | "AUDITOR";

const sessionSchema = z.object({
    token: z.string(),
    actor: z.object({ actorRef: z.string(), role: z.string() }),
});
const auditSchema = z.object({
    events: z.array(
        z.object({
            id: z.string(),
            actorRef: z.string(),
            actorRole: z.string(),
            action: z.string(),
            resourceType: z.string(),
            resourceId: z.string(),
            reason: z.string(),
            sourceVersion: z.string(),
            beforeHash: z.string().nullable(),
            afterHash: z.string().nullable(),
            formulaVersion: z.string().nullable(),
            policyVersion: z.string().nullable(),
            termsVersion: z.string().nullable(),
            approvalId: z.string().nullable(),
            chainCommandId: z.string().nullable(),
            chainEventId: z.string().nullable(),
            occurredAt: z.string(),
        }),
    ),
});
export type AuditEvent = z.infer<typeof auditSchema>["events"][number];
const operationSchema = z.object({
    operationId: z.string(),
    status: z.literal("CONFIRMED"),
    resourceVersion: z.number(),
});

async function jsonResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    const data: unknown = await response.json();
    if (!response.ok) {
        const error = z.object({ code: z.string(), message: z.string() }).safeParse(data);
        throw new Error(error.success ? error.data.message : `Request failed (${response.status})`);
    }
    return schema.parse(data);
}

export async function openDemoSession(role: DemoRole): Promise<string> {
    const response = await fetch(`${apiBase}/demo/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
    });
    return (await jsonResponse(response, sessionSchema)).token;
}

export async function fetchOverview(token: string): Promise<Overview> {
    const response = await fetch(`${apiBase}/api/v1/issuer`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    return jsonResponse(response, overviewSchema);
}

export async function fetchAudit(token: string) {
    const response = await fetch(`${apiBase}/api/v1/audit-events`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    return (await jsonResponse(response, auditSchema)).events;
}

export async function mutate(
    token: string,
    path: string,
    body: unknown,
    expectedVersion: number,
    reason: string,
    idempotencyKey: string,
) {
    const response = await fetch(`${apiBase}/api/v1${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "If-Match": String(expectedVersion),
            "Idempotency-Key": idempotencyKey,
            "X-Action-Reason": reason,
        },
        body: JSON.stringify(body),
    });
    return jsonResponse(response, operationSchema);
}

const phase2Schema = z.object({
    issuerVersion: z.number(),
    chainId: z.number(),
    tokenAddress: z.string().nullable(),
    demoPeerWallet: z.string().nullable(),
    terms: z
        .object({
            id: z.string(),
            version: z.number(),
            sha256: z.string(),
            publishedAt: z.string(),
            title: z.string(),
            unitCount: z.number(),
            initialUnitPriceMinor: z.string(),
            currency: z.string(),
            participationBasisPoints: z.number(),
            disclosures: z.array(z.string()),
        })
        .nullable(),
    holders: z.array(
        z.object({
            holderRef: z.enum(["synthetic-holder-a", "synthetic-holder-b"]),
            plannedUnits: z.number(),
            termsVersionAcknowledged: z.number().nullable(),
            eligibilityStatus: z.string(),
            eligibilityExpiresAt: z.string().nullable(),
            jurisdiction: z.string().nullable(),
            walletAddress: z.string().nullable(),
            subscriptionStatus: z.string(),
            recordedUnits: z.number(),
            issuanceTxHash: z.string().nullable(),
            version: z.number(),
        }),
    ),
    issuanceOperations: z.array(
        z.object({
            id: z.string(),
            status: z.string(),
            action: z.string(),
            response: z.record(z.string(), z.unknown()),
        }),
    ),
});
export type Phase2 = z.infer<typeof phase2Schema>;

export async function fetchPhase2(token: string): Promise<Phase2> {
    const response = await fetch(`${apiBase}/api/v1/phase2`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    return jsonResponse(response, phase2Schema);
}

const phase2OperationSchema = z.object({
    operationId: z.string(),
    status: z.enum(["CONFIRMED", "PENDING", "RECONCILIATION_REQUIRED"]),
    resourceVersion: z.number(),
    challengeId: z.string().optional(),
    message: z.string().optional(),
});
export async function mutatePhase2(
    token: string,
    path: string,
    body: unknown,
    expectedVersion: number,
    reason: string,
    key: string,
) {
    const response = await fetch(`${apiBase}/api/v1/phase2${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "If-Match": String(expectedVersion),
            "Idempotency-Key": key,
            "X-Action-Reason": reason,
        },
        body: JSON.stringify(body),
    });
    return jsonResponse(response, phase2OperationSchema);
}

const entitlementSchema = z.object({
    holderRef: z.string(),
    index: z.number(),
    walletAddress: z.string(),
    eligibleUnits: z.number(),
    amountUsdMinor: z.string(),
    amountTestUsdcMinor: z.string(),
    remainder: z.string(),
    roundingUnitAwarded: z.boolean(),
    proof: z.array(z.string()),
    claimTxHash: z.string().nullable(),
    claimBlockNumber: z.string().nullable(),
    claimBlockHash: z.string().nullable(),
    claimLogIndex: z.number().nullable(),
});
const distributionEpochSchema = z.object({
    id: z.string(),
    importId: z.string(),
    termsId: z.string(),
    quarter: z.string(),
    revision: z.number(),
    state: z.string(),
    version: z.number(),
    poolUsdMinor: z.string(),
    poolTestUsdcMinor: z.string(),
    formulaVersion: z.string(),
    cashSnapshot: z.object({
        financialApprovalId: z.string(),
        definedCashMinor: z.string(),
        participationBasisPoints: z.number(),
        periods: z.array(monthSchema),
        sourceRows: z.array(
            z.object({ sourceRef: z.string(), evidenceRef: z.string(), rowSha256: z.string() }),
        ),
    }),
    cashSnapshotSha256: z.string(),
    preparedBy: z.string(),
    reviewedBy: z.string().nullable(),
    approvedBy: z.string().nullable(),
    approvedAt: z.string().nullable(),
    recordBlock: z.string().nullable(),
    recordBlockHash: z.string().nullable(),
    snapshotHash: z.string().nullable(),
    entitlementRoot: z.string().nullable(),
    vaultAddress: z.string().nullable(),
    fundingTxHash: z.string().nullable(),
    openingTxHash: z.string().nullable(),
    chainSteps: z.array(
        z.object({
            step: z.enum(["VAULT_DEPLOY", "ASSET_APPROVAL", "FUND", "OPEN"]),
            chainId: z.number(),
            contractAddress: z.string(),
            txHash: z.string(),
            blockNumber: z.string(),
            blockHash: z.string(),
        }),
    ),
    epochHash: z.string(),
    eligibleSupply: z.string(),
    reconciliationIncidents: z.array(
        z.object({ code: z.string(), createdAt: z.string(), evidence: z.record(z.string(), z.unknown()) }),
    ),
    entitlements: z.array(entitlementSchema),
});
const distributionsSchema = z.object({
    issuerVersion: z.number(),
    chainId: z.number(),
    epochs: z.array(distributionEpochSchema),
});
export type Distributions = z.infer<typeof distributionsSchema>;
export async function fetchDistributions(token: string): Promise<Distributions> {
    const response = await fetch(`${apiBase}/api/v1/distributions`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    return jsonResponse(response, distributionsSchema);
}
const distributionOperationSchema = z.object({
    operationId: z.string(),
    status: z.enum(["CONFIRMED", "PENDING", "RECONCILIATION_REQUIRED"]),
    resourceVersion: z.number(),
    epochId: z.string().optional(),
});
export async function mutateDistribution(
    token: string,
    path: string,
    body: unknown,
    version: number,
    reason: string,
    key: string,
) {
    const response = await fetch(`${apiBase}/api/v1/distributions${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "If-Match": String(version),
            "Idempotency-Key": key,
            "X-Action-Reason": reason,
        },
        body: JSON.stringify(body),
    });
    return jsonResponse(response, distributionOperationSchema);
}

const settlementAllocationSchema = z.object({
    id: z.string(),
    leaf_index: z.number(),
    holder_ref: z.string(),
    wallet_address: z.string(),
    snapshot_units: z.number(),
    accepted_units: z.number(),
    amount_usd_minor: z.string(),
    amount_test_usdc_minor: z.string(),
    remainder: z.string(),
    proof: z.array(z.string()),
    tx_hash: z.string().nullable(),
    block_number: z.string().nullable(),
    block_hash: z.string().nullable(),
    log_index: z.number().nullable(),
});
const settlementCaseSchema = z.object({
    id: z.string(),
    kind: z.enum(["BUYBACK", "ACQUISITION"]),
    state: z.string(),
    version: z.number(),
    input: z.record(z.string(), z.unknown()),
    budget_usd_minor: z.string().nullable(),
    binding_unit_price_usd_minor: z.string().nullable(),
    tender_deadline: z.string().nullable(),
    approved_by: z.string().nullable(),
    record_block: z.string().nullable(),
    record_block_hash: z.string().nullable(),
    snapshot_hash: z.string().nullable(),
    entitlement_root: z.string().nullable(),
    committed_units: z.number().nullable(),
    committed_usd_minor: z.string().nullable(),
    vault_address: z.string().nullable(),
    funding_tx_hash: z.string().nullable(),
    opening_tx_hash: z.string().nullable(),
    finalization_tx_hash: z.string().nullable(),
    priceStatus: z.enum(["FUNDING_PENDING", "FUNDED_BINDING"]).nullable(),
    tenders: z.array(
        z.object({
            id: z.string(),
            holder_ref: z.string(),
            tendered_units: z.number(),
            status: z.string(),
            submitted_at: z.string(),
            cancelled_at: z.string().nullable(),
        }),
    ),
    allocations: z.array(settlementAllocationSchema),
});
const settlementsSchema = z.object({
    issuerVersion: z.number(),
    chainId: z.number(),
    appraisals: z.array(
        z.object({
            id: z.string(),
            state: z.string(),
            input: z.object({
                appraisedEquityUsdMinor: z.string(),
                participationBasisPoints: z.number(),
                outstandingEligibleUnits: z.string(),
                valuationDate: z.string(),
                methodology: z.string(),
                evidenceRef: z.string(),
                assumptions: z.object({
                    cashAndDebt: z.string(),
                    dilution: z.string(),
                    pastDistributions: z.string(),
                    tepaObligation: z.string(),
                }),
            }),
            pool_usd_minor: z.string(),
            indicative_unit_usd_minor: z.string(),
            prepared_by: z.string(),
            approved_by: z.string().nullable(),
        }),
    ),
    cases: z.array(settlementCaseSchema),
});
export type Settlements = z.infer<typeof settlementsSchema>;
export async function fetchSettlements(token: string): Promise<Settlements> {
    const response = await fetch(`${apiBase}/api/v1/settlements`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    return jsonResponse(response, settlementsSchema);
}
const settlementOperationSchema = z.object({
    operationId: z.string(),
    status: z.enum(["CONFIRMED", "PENDING", "RECONCILIATION_REQUIRED"]),
    resourceVersion: z.number(),
    caseId: z.string().optional(),
    appraisalId: z.string().optional(),
});
export async function mutateSettlement(
    token: string,
    path: string,
    body: unknown,
    version: number,
    reason: string,
    key: string,
) {
    const response = await fetch(`${apiBase}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "If-Match": String(version),
            "Idempotency-Key": key,
            "X-Action-Reason": reason,
        },
        body: JSON.stringify(body),
    });
    return jsonResponse(response, settlementOperationSchema);
}
