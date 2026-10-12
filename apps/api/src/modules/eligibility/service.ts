import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { prototypeTermsSchema } from "@tepa/domain";
import { getAddress, isAddress, keccak256, stringToHex, verifyMessage } from "viem";
import { ApiError, type Actor } from "../../http.js";
import { findIssuer } from "../metrics/data.js";
import { mockEligibilityProvider } from "./provider.js";

const termsContents = readFileSync(
    new URL("../../../../../data/fixtures/issuer/terms.v1.json", import.meta.url),
    "utf8",
);
const terms = prototypeTermsSchema.parse(JSON.parse(termsContents) as unknown);
const termsHash = createHash("sha256").update(termsContents).digest("hex");
const allocations = [
    { holderRef: "synthetic-holder-a", units: 600 },
    { holderRef: "synthetic-holder-b", units: 400 },
] as const;
export type HolderRef = (typeof allocations)[number]["holderRef"];
export const holderRefs = allocations.map((item) => item.holderRef);
export const subjectHash = (holderRef: HolderRef) => keccak256(stringToHex(`tepa-demo:${holderRef}`));
export const caseHash = (caseId: string) => keccak256(stringToHex(`tepa-allocation:${caseId}`));
export const decisionHash = (decisionId: string) => keccak256(stringToHex(`tepa-eligibility:${decisionId}`));

type HolderRow = {
    id: string;
    holder_ref: HolderRef;
    subject_hash: `0x${string}`;
    planned_units: number;
    terms_id: string | null;
    terms_acknowledged_at: Date | null;
    eligibility_status: string;
    eligibility_decision_id: string | null;
    eligibility_evidence_ref: string | null;
    eligibility_expires_at: Date | null;
    jurisdiction: string | null;
    wallet_address: string | null;
    wallet_bound_at: Date | null;
    subscription_status: string;
    allocation_case_id: string | null;
    issuance_tx_hash: string | null;
    recorded_units: number;
    version: number;
};

type Mutation = {
    actor: Actor;
    action: string;
    key: string;
    expectedVersion: number;
    reason: string;
    body: unknown;
};
type Result = Record<string, unknown>;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function investorRef(actor: Actor): HolderRef {
    if (actor.role === "INVESTOR_A") return "synthetic-holder-a";
    if (actor.role === "INVESTOR_B") return "synthetic-holder-b";
    throw new ApiError(403, "ROLE_FORBIDDEN", "Requires the matching fictional investor role.");
}
function assertOwner(actor: Actor, holderRef: HolderRef) {
    if (investorRef(actor) !== holderRef)
        throw new ApiError(403, "HOLDER_FORBIDDEN", "This holder belongs to another fictional investor.");
}
async function getHolder(client: PoolClient, holderRef: HolderRef): Promise<HolderRow> {
    const result = await client.query<HolderRow>(
        "SELECT * FROM phase2_holders WHERE holder_ref = $1 FOR UPDATE",
        [holderRef],
    );
    if (!result.rows[0]) throw new ApiError(404, "HOLDER_NOT_FOUND", "Publish prototype terms first.");
    return result.rows[0];
}

async function mutate(
    pool: Pool,
    input: Mutation,
    work: (
        client: PoolClient,
        issuerId: string,
        version: number,
    ) => Promise<{
        result?: Result;
        status?: "PENDING";
        event: string;
        resourceId: string;
        before: string | null;
        after: string;
        termsVersion?: string;
    }>,
): Promise<Result> {
    const client = await pool.connect();
    const requestHash = hash(
        JSON.stringify({
            action: input.action,
            body: input.body,
            expectedVersion: input.expectedVersion,
            reason: input.reason,
        }),
    );
    try {
        await client.query("BEGIN");
        const issuer = await findIssuer(client, true);
        if (!issuer) throw new ApiError(404, "ISSUER_NOT_FOUND", "Import fictional issuer records first.");
        const prior = await client.query<{ request_sha256: string; response: Result }>(
            "SELECT request_sha256, response FROM phase2_operations WHERE actor_ref = $1 AND action = $2 AND idempotency_key = $3",
            [input.actor.actorRef, input.action, input.key],
        );
        if (prior.rows[0]) {
            if (prior.rows[0].request_sha256 !== requestHash)
                throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Key used for a different request.");
            await client.query("COMMIT");
            return prior.rows[0].response;
        }
        if (issuer.version !== input.expectedVersion)
            throw new ApiError(
                409,
                "STALE_VERSION",
                `Current issuer version is ${issuer.version}. Refresh before retrying.`,
            );
        const change = await work(client, issuer.id, issuer.version);
        const operationId = randomUUID();
        const resourceVersion = issuer.version + 1;
        const response = {
            operationId,
            status: change.status ?? "CONFIRMED",
            resourceVersion,
            ...change.result,
        };
        await client.query("UPDATE issuers SET version = $2, updated_at = now() WHERE id = $1", [
            issuer.id,
            resourceVersion,
        ]);
        await client.query(
            `INSERT INTO phase2_operations (id, actor_ref, action, idempotency_key, request_sha256, resource_version, status, response)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
            [
                operationId,
                input.actor.actorRef,
                input.action,
                input.key,
                requestHash,
                resourceVersion,
                response.status,
                JSON.stringify(response),
            ],
        );
        await client.query(
            `INSERT INTO audit_events (actor_ref,actor_role,action,resource_type,resource_id,source_version,before_hash,after_hash,reason,request_id,policy_version,terms_version)
             VALUES ($1,$2,$3,'phase2',$4,'phase2-v1',$5,$6,$7,$8,'restricted-issuance-v1',$9)`,
            [
                input.actor.actorRef,
                input.actor.role,
                change.event,
                change.resourceId,
                change.before,
                change.after,
                input.reason,
                input.key,
                change.termsVersion ?? null,
            ],
        );
        await client.query(
            `INSERT INTO outbox_events (operation_id,event_type,payload) VALUES ($1,$2,$3::jsonb)`,
            [operationId, change.event, JSON.stringify({ resourceId: change.resourceId, resourceVersion })],
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

export async function getPhase2(pool: Pool, actor: Actor, chainId: number, tokenAddress: string | null) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const issuer = await findIssuer(client);
        const termRows = issuer
            ? await client.query<{
                  id: string;
                  version: number;
                  sha256: string;
                  published_at: Date;
                  terms: typeof terms;
              }>(
                  "SELECT id,version,sha256,published_at,terms FROM prototype_terms WHERE issuer_id=$1 ORDER BY version DESC LIMIT 1",
                  [issuer.id],
              )
            : null;
        const latest = termRows?.rows[0] ?? null;
        const holders = issuer
            ? await client.query<HolderRow>(
                  "SELECT * FROM phase2_holders WHERE issuer_id=$1 ORDER BY holder_ref",
                  [issuer.id],
              )
            : null;
        const operations = issuer
            ? await client.query<{ id: string; status: string; action: string; response: Result }>(
                  "SELECT id,status,action,response FROM phase2_operations WHERE action LIKE 'ISSUE:%' AND ($1::text IS NULL OR action = 'ISSUE:' || $1) ORDER BY created_at DESC",
                  [actor.role === "INVESTOR_A" || actor.role === "INVESTOR_B" ? investorRef(actor) : null],
              )
            : null;
        await client.query("COMMIT");
        return {
            issuerVersion: issuer?.version ?? 0,
            chainId,
            tokenAddress,
            demoPeerWallet:
                actor.role === "INVESTOR_A"
                    ? (holders?.rows.find((holder) => holder.holder_ref === "synthetic-holder-b")
                          ?.wallet_address ?? null)
                    : actor.role === "INVESTOR_B"
                      ? (holders?.rows.find((holder) => holder.holder_ref === "synthetic-holder-a")
                            ?.wallet_address ?? null)
                      : null,
            terms: latest
                ? {
                      id: latest.id,
                      ...latest.terms,
                      version: latest.version,
                      sha256: latest.sha256,
                      publishedAt: latest.published_at.toISOString(),
                  }
                : null,
            holders: (holders?.rows ?? [])
                .filter(
                    (holder) =>
                        (actor.role !== "INVESTOR_A" && actor.role !== "INVESTOR_B") ||
                        holder.holder_ref === investorRef(actor),
                )
                .map((holder) => ({
                    holderRef: holder.holder_ref,
                    plannedUnits: holder.planned_units,
                    termsVersionAcknowledged: holder.terms_id
                        ? latest?.id === holder.terms_id
                            ? latest.version
                            : null
                        : null,
                    eligibilityStatus:
                        holder.eligibility_status === "APPROVED" &&
                        holder.eligibility_expires_at &&
                        holder.eligibility_expires_at.getTime() <= Date.now()
                            ? "EXPIRED"
                            : holder.eligibility_status,
                    eligibilityExpiresAt: holder.eligibility_expires_at?.toISOString() ?? null,
                    jurisdiction: holder.jurisdiction,
                    walletAddress: holder.wallet_address,
                    subscriptionStatus: holder.subscription_status,
                    recordedUnits: holder.recorded_units,
                    issuanceTxHash: holder.issuance_tx_hash,
                    version: holder.version,
                })),
            issuanceOperations: operations?.rows ?? [],
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function publishTerms(pool: Pool, input: Mutation) {
    return mutate(pool, input, async (client, issuerId) => {
        const existing = await client.query(
            "SELECT id FROM prototype_terms WHERE issuer_id=$1 AND version=1",
            [issuerId],
        );
        if (existing.rowCount)
            throw new ApiError(409, "TERMS_ALREADY_PUBLISHED", "Prototype terms v1 are already published.");
        const result = await client.query<{ id: string }>(
            "INSERT INTO prototype_terms (issuer_id,version,terms,sha256,published_by) VALUES ($1,1,$2::jsonb,$3,$4) RETURNING id",
            [issuerId, JSON.stringify(terms), termsHash, input.actor.actorRef],
        );
        for (const allocation of allocations) {
            await client.query(
                `INSERT INTO phase2_holders (issuer_id,holder_ref,subject_hash,planned_units) VALUES ($1,$2,$3,$4)`,
                [issuerId, allocation.holderRef, subjectHash(allocation.holderRef), allocation.units],
            );
        }
        return {
            result: { termsVersion: 1 },
            event: "PROTOTYPE_TERMS_PUBLISHED",
            resourceId: result.rows[0]!.id,
            before: null,
            after: termsHash,
            termsVersion: "1",
        };
    });
}

export async function acknowledgeTerms(
    pool: Pool,
    input: Mutation,
    holderRef: HolderRef,
    termsHashInput: string,
) {
    assertOwner(input.actor, holderRef);
    return mutate(pool, input, async (client, issuerId) => {
        const holder = await getHolder(client, holderRef);
        const latest = await client.query<{ id: string; sha256: string }>(
            "SELECT id,sha256 FROM prototype_terms WHERE issuer_id=$1 ORDER BY version DESC LIMIT 1",
            [issuerId],
        );
        if (!latest.rows[0] || latest.rows[0].sha256 !== termsHashInput)
            throw new ApiError(409, "TERMS_STALE", "Read the current prototype terms.");
        if (holder.terms_id === latest.rows[0].id)
            throw new ApiError(409, "ALREADY_ACKNOWLEDGED", "Terms already acknowledged.");
        await client.query(
            "UPDATE phase2_holders SET terms_id=$2,terms_acknowledged_at=now(),subscription_status='ACKNOWLEDGED',version=version+1,updated_at=now() WHERE id=$1",
            [holder.id, latest.rows[0].id],
        );
        return {
            event: "TERMS_ACKNOWLEDGED",
            resourceId: holder.id,
            before: holder.terms_id,
            after: termsHashInput,
            termsVersion: "1",
        };
    });
}

export async function decideEligibility(
    pool: Pool,
    input: Mutation,
    holderRef: HolderRef,
    body: { identity: "PASS" | "FAIL"; sanctions: "CLEAR" | "HIT"; expiresAt: string; jurisdiction: "US" },
) {
    return mutate(pool, input, async (client) => {
        const holder = await getHolder(client, holderRef);
        if (holder.eligibility_status !== "NOT_STARTED")
            throw new ApiError(409, "DECISION_EXISTS", "Use revocation for an existing decision.");
        if (!holder.terms_id)
            throw new ApiError(409, "TERMS_REQUIRED", "The holder must acknowledge published terms.");
        const expiry = new Date(body.expiresAt);
        if (expiry.getTime() <= Date.now() || expiry.getTime() > Date.now() + 30 * 86400_000)
            throw new ApiError(400, "INVALID_EXPIRY", "Mock eligibility must expire within 30 days.");
        const screening = await mockEligibilityProvider.assess(body);
        const id = randomUUID();
        const status = screening.status;
        await client.query(
            `UPDATE phase2_holders SET eligibility_status=$2,eligibility_decision_id=$3,eligibility_evidence_ref=$4,
             eligibility_expires_at=$5,jurisdiction=$6,subscription_status=$7,version=version+1,updated_at=now() WHERE id=$1`,
            [
                holder.id,
                status,
                id,
                screening.evidenceRef,
                expiry.toISOString(),
                body.jurisdiction,
                status === "APPROVED" ? "ELIGIBLE" : "REJECTED",
            ],
        );
        return {
            result: { decisionId: id, eligibilityStatus: status },
            event: "SIMULATED_ELIGIBILITY_DECIDED",
            resourceId: holder.id,
            before: hash(holder.eligibility_status),
            after: decisionHash(id),
            termsVersion: "1",
        };
    });
}

export async function revokeEligibility(pool: Pool, input: Mutation, holderRef: HolderRef) {
    return mutate(pool, input, async (client) => {
        const holder = await getHolder(client, holderRef);
        if (holder.eligibility_status !== "APPROVED")
            throw new ApiError(409, "NOT_APPROVED", "Only an approval can be revoked.");
        await client.query(
            "UPDATE phase2_holders SET eligibility_status='REVOKED',version=version+1,updated_at=now() WHERE id=$1",
            [holder.id],
        );
        return {
            status: "PENDING",
            event: "SIMULATED_ELIGIBILITY_REVOKED",
            resourceId: holder.id,
            before: decisionHash(holder.eligibility_decision_id!),
            after: hash("REVOKED"),
            termsVersion: "1",
        };
    });
}

export async function createChallenge(
    pool: Pool,
    input: Mutation,
    holderRef: HolderRef,
    wallet: string,
    chainId: number,
    configuredChainId: number,
    expectedWallet?: string,
) {
    assertOwner(input.actor, holderRef);
    if (!isAddress(wallet) || chainId !== configuredChainId)
        throw new ApiError(400, "WRONG_CHAIN_OR_WALLET", "Use the configured demo chain and a valid wallet.");
    const address = getAddress(wallet);
    if (expectedWallet && address.toLowerCase() !== expectedWallet.toLowerCase())
        throw new ApiError(
            409,
            "UNEXPECTED_DEMO_WALLET",
            `Select ${getAddress(expectedWallet)} in your wallet for this fictional holder.`,
        );
    return mutate(pool, input, async (client) => {
        const holder = await getHolder(client, holderRef);
        if (
            holder.eligibility_status !== "APPROVED" ||
            !holder.eligibility_expires_at ||
            holder.eligibility_expires_at.getTime() <= Date.now()
        )
            throw new ApiError(409, "NOT_ELIGIBLE", "Current simulated eligibility is required.");
        if (holder.wallet_address)
            throw new ApiError(409, "WALLET_ALREADY_BOUND", "A wallet is already bound.");
        const nonce = randomBytes(24).toString("hex");
        const expiresAt = new Date(Date.now() + 5 * 60_000);
        const message = `TEPA prototype wallet binding\nDomain: tepa.local\nHolder: ${holderRef}\nAddress: ${address}\nChain ID: ${chainId}\nPurpose: bind demo wallet\nNonce: ${nonce}\nExpires: ${expiresAt.toISOString()}`;
        const result = await client.query<{ id: string }>(
            "INSERT INTO wallet_challenges (holder_id,wallet_address,chain_id,nonce,message,expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
            [holder.id, address, chainId, nonce, message, expiresAt.toISOString()],
        );
        return {
            result: { challengeId: result.rows[0]!.id, message, expiresAt: expiresAt.toISOString() },
            event: "WALLET_CHALLENGE_CREATED",
            resourceId: holder.id,
            before: null,
            after: hash(message),
            termsVersion: "1",
        };
    });
}

export async function bindWallet(
    pool: Pool,
    input: Mutation,
    holderRef: HolderRef,
    challengeId: string,
    signature: `0x${string}`,
    configuredChainId: number,
) {
    assertOwner(input.actor, holderRef);
    return mutate(pool, input, async (client) => {
        const holder = await getHolder(client, holderRef);
        if (holder.wallet_address)
            throw new ApiError(409, "WALLET_ALREADY_BOUND", "A wallet is already bound.");
        if (
            holder.eligibility_status !== "APPROVED" ||
            !holder.eligibility_expires_at ||
            holder.eligibility_expires_at.getTime() <= Date.now()
        )
            throw new ApiError(409, "NOT_ELIGIBLE", "Current simulated eligibility is required.");
        const challenge = await client.query<{
            wallet_address: `0x${string}`;
            chain_id: number;
            message: string;
            expires_at: Date;
            consumed_at: Date | null;
        }>(
            "SELECT wallet_address,chain_id,message,expires_at,consumed_at FROM wallet_challenges WHERE id=$1 AND holder_id=$2 FOR UPDATE",
            [challengeId, holder.id],
        );
        const entry = challenge.rows[0];
        if (
            !entry ||
            entry.consumed_at ||
            entry.expires_at.getTime() <= Date.now() ||
            entry.chain_id !== configuredChainId
        )
            throw new ApiError(409, "CHALLENGE_INVALID", "Challenge expired, used, or for another chain.");
        const valid = await verifyMessage({
            address: entry.wallet_address,
            message: entry.message,
            signature,
        });
        if (!valid)
            throw new ApiError(400, "SIGNATURE_INVALID", "Wallet signature did not match the challenge.");
        await client.query("UPDATE wallet_challenges SET consumed_at=now() WHERE id=$1", [challengeId]);
        await client.query(
            "UPDATE phase2_holders SET wallet_address=$2,wallet_bound_at=now(),version=version+1,updated_at=now() WHERE id=$1",
            [holder.id, entry.wallet_address],
        );
        return {
            result: { walletAddress: entry.wallet_address },
            event: "DEMO_WALLET_BOUND",
            resourceId: holder.id,
            before: null,
            after: hash(entry.wallet_address.toLowerCase()),
            termsVersion: "1",
        };
    });
}

export async function commitSubscription(pool: Pool, input: Mutation, holderRef: HolderRef) {
    assertOwner(input.actor, holderRef);
    return mutate(pool, input, async (client) => {
        const holder = await getHolder(client, holderRef);
        if (
            holder.subscription_status !== "ELIGIBLE" ||
            !holder.terms_id ||
            !holder.wallet_address ||
            holder.eligibility_status !== "APPROVED" ||
            !holder.eligibility_expires_at ||
            holder.eligibility_expires_at.getTime() <= Date.now()
        ) {
            throw new ApiError(
                409,
                "SUBSCRIPTION_NOT_READY",
                "Current terms, eligibility, and a bound wallet are required.",
            );
        }
        await client.query(
            "UPDATE phase2_holders SET subscription_status='COMMITTED_SIMULATION',version=version+1,updated_at=now() WHERE id=$1",
            [holder.id],
        );
        return {
            event: "SIMULATED_SUBSCRIPTION_COMMITTED",
            resourceId: holder.id,
            before: hash("ELIGIBLE"),
            after: hash("COMMITTED_SIMULATION"),
            termsVersion: "1",
        };
    });
}

export async function allocate(pool: Pool, input: Mutation, holderRef: HolderRef) {
    return mutate(pool, input, async (client) => {
        const terminal = await client.query(
            "SELECT 1 FROM phase4_cases WHERE kind='ACQUISITION' AND state='FINALIZED' LIMIT 1",
        );
        if (terminal.rowCount)
            throw new ApiError(
                409,
                "TERMINAL_SETTLEMENT",
                "No allocation follows final acquisition settlement.",
            );
        const holder = await getHolder(client, holderRef);
        if (
            holder.subscription_status !== "COMMITTED_SIMULATION" ||
            !holder.wallet_address ||
            holder.eligibility_status !== "APPROVED" ||
            !holder.eligibility_expires_at ||
            holder.eligibility_expires_at.getTime() <= Date.now()
        )
            throw new ApiError(
                409,
                "ALLOCATION_NOT_READY",
                "Current eligibility, acknowledgement, and a bound wallet are required.",
            );
        const caseId = randomUUID();
        await client.query(
            "UPDATE phase2_holders SET allocation_case_id=$2,subscription_status='ALLOCATED',version=version+1,updated_at=now() WHERE id=$1",
            [holder.id, caseId],
        );
        return {
            result: { allocationCaseId: caseId },
            event: "DEMO_ALLOCATION_RECORDED",
            resourceId: holder.id,
            before: null,
            after: caseHash(caseId),
            termsVersion: "1",
        };
    });
}

export async function queueIssuance(pool: Pool, input: Mutation, holderRef: HolderRef) {
    return mutate(pool, input, async (client) => {
        const terminal = await client.query(
            "SELECT 1 FROM phase4_cases WHERE kind='ACQUISITION' AND state='FINALIZED' LIMIT 1",
        );
        if (terminal.rowCount)
            throw new ApiError(
                409,
                "TERMINAL_SETTLEMENT",
                "No issuance follows final acquisition settlement.",
            );
        const holder = await getHolder(client, holderRef);
        if (
            holder.subscription_status !== "ALLOCATED" ||
            !holder.wallet_address ||
            !holder.allocation_case_id ||
            holder.eligibility_status !== "APPROVED" ||
            !holder.eligibility_expires_at ||
            holder.eligibility_expires_at.getTime() <= Date.now()
        )
            throw new ApiError(
                409,
                "ISSUANCE_NOT_READY",
                "A current approved allocation and bound wallet are required.",
            );
        const alreadyQueued = await client.query(
            "SELECT id FROM phase2_operations WHERE action=$1 AND status IN ('PENDING','CONFIRMED')",
            [`ISSUE:${holderRef}`],
        );
        if (alreadyQueued.rowCount)
            throw new ApiError(409, "ISSUANCE_ALREADY_QUEUED", "Issuance was already requested.");
        return {
            result: { holderRef },
            status: "PENDING",
            event: "DEMO_ISSUANCE_REQUESTED",
            resourceId: holder.id,
            before: caseHash(holder.allocation_case_id),
            after: hash(`PENDING:${holder.id}`),
            termsVersion: "1",
        };
    });
}
