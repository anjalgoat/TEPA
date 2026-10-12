export const workflowTransitions = {
    offering: {
        DRAFT: ["REVIEW", "CANCELLED"],
        REVIEW: ["DRAFT", "DEMO_PUBLISHED", "CANCELLED"],
        DEMO_PUBLISHED: ["SUBSCRIPTION_OPEN", "CANCELLED", "EXPIRED"],
        SUBSCRIPTION_OPEN: ["FUNDED_SIMULATION", "CANCELLED", "EXPIRED"],
        FUNDED_SIMULATION: ["CLOSED", "CANCELLED"],
        CLOSED: [],
        CANCELLED: [],
        EXPIRED: [],
    },
    eligibility: {
        NOT_STARTED: ["PENDING"],
        PENDING: ["APPROVED", "REJECTED", "MANUAL_REVIEW"],
        MANUAL_REVIEW: ["APPROVED", "REJECTED"],
        APPROVED: ["EXPIRED", "REVOKED"],
        REJECTED: [],
        EXPIRED: [],
        REVOKED: [],
    },
    subscription: {
        DRAFT: ["ACKNOWLEDGED", "CANCELLED"],
        ACKNOWLEDGED: ["ELIGIBLE", "REJECTED", "CANCELLED", "EXPIRED"],
        ELIGIBLE: ["COMMITTED_SIMULATION", "REJECTED", "CANCELLED", "EXPIRED"],
        COMMITTED_SIMULATION: ["ALLOCATED", "RECONCILIATION_REQUIRED"],
        ALLOCATED: ["MINTED", "RECONCILIATION_REQUIRED"],
        MINTED: ["RECORDED", "RECONCILIATION_REQUIRED"],
        RECONCILIATION_REQUIRED: ["ALLOCATED", "MINTED", "RECORDED"],
        RECORDED: [],
        REJECTED: [],
        CANCELLED: [],
        EXPIRED: [],
    },
    distribution: {
        DRAFT: ["RECONCILED", "CANCELLED"],
        RECONCILED: ["REVIEWED", "CANCELLED"],
        REVIEWED: ["APPROVED", "CANCELLED"],
        APPROVED: ["SNAPSHOTTED", "CANCELLED"],
        SNAPSHOTTED: ["FUNDED", "RECONCILIATION_REQUIRED"],
        FUNDED: ["CLAIMABLE", "RECONCILIATION_REQUIRED"],
        CLAIMABLE: ["CLOSED", "RECONCILIATION_REQUIRED"],
        RECONCILIATION_REQUIRED: ["FUNDED", "CLAIMABLE"],
        CLOSED: [],
        CANCELLED: [],
    },
    buyback: {
        DRAFT: ["APPRAISED", "CANCELLED"],
        APPRAISED: ["APPROVED", "CANCELLED"],
        APPROVED: ["OPEN", "CANCELLED", "EXPIRED"],
        OPEN: ["TENDER_CLOSED", "CANCELLED", "EXPIRED"],
        TENDER_CLOSED: ["ALLOCATED", "CANCELLED"],
        ALLOCATED: ["FUNDED", "CANCELLED"],
        FUNDED: ["SETTLED", "RECONCILIATION_REQUIRED"],
        SETTLED: ["CLOSED", "RECONCILIATION_REQUIRED"],
        RECONCILIATION_REQUIRED: ["SETTLED"],
        CLOSED: [],
        CANCELLED: [],
        EXPIRED: [],
    },
    acquisition: {
        DRAFT: ["EVIDENCE_REVIEW", "CANCELLED"],
        EVIDENCE_REVIEW: ["APPROVED", "CANCELLED"],
        APPROVED: ["SNAPSHOTTED", "CANCELLED"],
        SNAPSHOTTED: ["FUNDED", "RECONCILIATION_REQUIRED"],
        FUNDED: ["CLAIMABLE", "RECONCILIATION_REQUIRED"],
        CLAIMABLE: ["FINALIZED", "RECONCILIATION_REQUIRED"],
        RECONCILIATION_REQUIRED: ["FUNDED", "CLAIMABLE"],
        FINALIZED: [],
        CANCELLED: [],
    },
} as const;

export type Workflow = keyof typeof workflowTransitions;
export type WorkflowState<T extends Workflow> = keyof (typeof workflowTransitions)[T] & string;

export function canTransition<T extends Workflow>(
    workflow: T,
    from: WorkflowState<T>,
    to: WorkflowState<T>,
): boolean {
    const allowed = workflowTransitions[workflow][from] as readonly string[];
    return allowed.includes(to);
}

export function assertTransition<T extends Workflow>(
    workflow: T,
    from: WorkflowState<T>,
    to: WorkflowState<T>,
): void {
    if (!canTransition(workflow, from, to)) {
        throw new Error(`Invalid ${workflow} transition: ${from} -> ${to}`);
    }
}
