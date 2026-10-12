import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
    allocateBuyback,
    calculateAcquisition,
    calculateIndicativeValue,
    usdCentsToTestUsdcUnits,
    type AcquisitionWaterfall,
    type Appraisal,
} from "@tepa/domain";
import { createPublicClient, getAddress, http, keccak256, parseAbi, stringToHex, type Hex } from "viem";
import type { StartupConfig } from "../../config.js";
import { ApiError, type Actor } from "../../http.js";
import { findIssuer, sampleOffering } from "../metrics/data.js";
import { chain, rpcUrl } from "../distributions/service.js";
import { buildSettlementTree } from "./merkle.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const settlementHash = (id: string): Hex => keccak256(stringToHex(`tepa-settlement:${id}`));
const tokenAbi = parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function deploymentChainId() view returns (uint256)",
    "function terminalSettlement() view returns (bool)",
]);
type Mutation = {
    actor: Actor;
    action: string;
    key: string;
    expectedVersion: number;
    reason: string;
    body: unknown;
};
type Change = {
    event: string;
    resourceId: string;
    before: string | null;
    after: string;
    result?: Record<string, unknown>;
    status?: "PENDING";
    termsVersion?: string;
    approvalId?: string | undefined;
    chainEventId?: string;
};
type Case = {
    id: string;
    issuer_id: string;
    kind: "BUYBACK" | "ACQUISITION";
    state: string;
    version: number;
    appraisal_id: string | null;
    terms_id: string;
    input: Record<string, unknown>;
    input_sha256: string;
    budget_usd_minor: string | null;
    binding_unit_price_usd_minor: string | null;
    tender_deadline: Date | null;
    prepared_by: string;
    approved_by: string | null;
    record_block: string | null;
    record_block_hash: Hex | null;
    snapshot_hash: string | null;
    entitlement_root: Hex | null;
    committed_units: number | null;
    committed_usd_minor: string | null;
    vault_address: `0x${string}` | null;
};
type Holder = {
    id: string;
    holder_ref: string;
    wallet_address: string | null;
    recorded_units: number;
    eligibility_status: string;
    eligibility_expires_at: Date | null;
    subscription_status: string;
    terms_id: string | null;
    paid_units: string;
};

async function mutate(
    pool: Pool,
    input: Mutation,
    work: (db: PoolClient, issuerId: string) => Promise<Change>,
) {
    const db = await pool.connect();
    const requestHash = sha256(
        JSON.stringify({
            action: input.action,
            body: input.body,
            expectedVersion: input.expectedVersion,
            reason: input.reason,
        }),
    );
    try {
        await db.query("BEGIN");
        const issuer = await findIssuer(db, true);
        if (!issuer) throw new ApiError(404, "ISSUER_NOT_FOUND", "Import fictional issuer records first.");
        const previous = await db.query<{ request_sha256: string; response: Record<string, unknown> }>(
            "SELECT request_sha256,response FROM phase4_operations WHERE actor_ref=$1 AND action=$2 AND idempotency_key=$3",
            [input.actor.actorRef, input.action, input.key],
        );
        if (previous.rows[0]) {
            if (previous.rows[0].request_sha256 !== requestHash)
                throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Key was used for a different request.");
            await db.query("COMMIT");
            return previous.rows[0].response;
        }
        if (issuer.version !== input.expectedVersion)
            throw new ApiError(
                409,
                "STALE_VERSION",
                `Current issuer version is ${issuer.version}. Refresh before retrying.`,
            );
        const change = await work(db, issuer.id);
        const version = issuer.version + 1;
        const operationId = randomUUID();
        const response = {
            operationId,
            status: change.status ?? "CONFIRMED",
            resourceVersion: version,
            ...change.result,
        };
        await db.query("UPDATE issuers SET version=$2,updated_at=now() WHERE id=$1", [issuer.id, version]);
        await db.query(
            `INSERT INTO phase4_operations(id,actor_ref,action,idempotency_key,request_sha256,resource_version,status,response)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
            [
                operationId,
                input.actor.actorRef,
                input.action,
                input.key,
                requestHash,
                version,
                response.status,
                JSON.stringify(response),
            ],
        );
        await db.query(
            `INSERT INTO audit_events(actor_ref,actor_role,action,resource_type,resource_id,source_version,before_hash,after_hash,reason,request_id,formula_version,policy_version,terms_version,approval_id,chain_command_id,chain_event_id)
             VALUES($1,$2,$3,'settlement',$4,'phase4-v1',$5,$6,$7,$8,'settlement-v1','sample-only-v1',$9,$10,$11,$12)`,
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
                change.approvalId ?? null,
                change.chainEventId ? operationId : null,
                change.chainEventId ?? null,
            ],
        );
        await db.query("INSERT INTO outbox_events(operation_id,event_type,payload) VALUES($1,$2,$3::jsonb)", [
            operationId,
            change.event,
            JSON.stringify({ resourceId: change.resourceId, resourceVersion: version }),
        ]);
        await db.query("COMMIT");
        return response;
    } catch (error) {
        await db.query("ROLLBACK");
        throw error;
    } finally {
        db.release();
    }
}

async function getCase(db: PoolClient, id: string): Promise<Case> {
    const result = await db.query<Case>("SELECT * FROM phase4_cases WHERE id=$1 FOR UPDATE", [id]);
    if (!result.rows[0]) throw new ApiError(404, "CASE_NOT_FOUND", "Settlement case not found.");
    return result.rows[0];
}
function requireState(value: Case, kind: Case["kind"], state: string) {
    if (value.kind !== kind || value.state !== state)
        throw new ApiError(409, "INVALID_CASE_STATE", `${kind} case must be ${state}.`);
}
async function currentTerms(db: PoolClient, issuerId: string) {
    const result = await db.query<{ id: string; version: number }>(
        "SELECT id,version FROM prototype_terms WHERE issuer_id=$1 ORDER BY version DESC LIMIT 1",
        [issuerId],
    );
    if (!result.rows[0]) throw new ApiError(409, "TERMS_REQUIRED", "Published prototype terms are required.");
    return result.rows[0];
}
async function assertNoTerminal(db: PoolClient, issuerId: string) {
    const terminal = await db.query(
        "SELECT 1 FROM phase4_cases WHERE issuer_id=$1 AND kind='ACQUISITION' AND state='FINALIZED' LIMIT 1",
        [issuerId],
    );
    if (terminal.rowCount)
        throw new ApiError(409, "TERMINAL_SETTLEMENT", "The acquisition settlement is final.");
}
async function holderRows(db: PoolClient, issuerId: string): Promise<Holder[]> {
    const result = await db.query<Holder>(
        `SELECT h.id,h.holder_ref,h.wallet_address,h.recorded_units,h.eligibility_status,h.eligibility_expires_at,
                h.subscription_status,h.terms_id,COALESCE(p.paid_units,0)::text AS paid_units
         FROM phase2_holders h LEFT JOIN LATERAL (
             SELECT SUM(a.accepted_units) AS paid_units FROM phase4_allocations a
             JOIN phase4_receipts r ON r.allocation_id=a.id WHERE a.holder_id=h.id
         ) p ON true
         WHERE h.issuer_id=$1 ORDER BY h.holder_ref FOR UPDATE OF h`,
        [issuerId],
    );
    return result.rows;
}
function outstanding(row: Holder): bigint {
    return BigInt(row.recorded_units) - BigInt(row.paid_units);
}
function requireEligible(row: Holder, termsId: string) {
    if (
        row.subscription_status !== "RECORDED" ||
        row.eligibility_status !== "APPROVED" ||
        !row.eligibility_expires_at ||
        row.eligibility_expires_at <= new Date() ||
        !row.wallet_address ||
        row.terms_id !== termsId
    )
        throw new ApiError(
            409,
            "HOLDER_NOT_ELIGIBLE",
            "Recorded holder, current terms, and simulated eligibility are required.",
        );
}

export async function getSettlements(pool: Pool, actor: Actor) {
    const db = await pool.connect();
    try {
        await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const issuer = await findIssuer(db);
        if (!issuer) {
            await db.query("COMMIT");
            return { issuerVersion: 0, appraisals: [], cases: [] };
        }
        const appraisals = await db.query(
            "SELECT * FROM phase4_appraisals WHERE issuer_id=$1 ORDER BY created_at,id",
            [issuer.id],
        );
        const cases = await db.query("SELECT * FROM phase4_cases WHERE issuer_id=$1 ORDER BY created_at,id", [
            issuer.id,
        ]);
        const results = [];
        for (const row of cases.rows as Case[]) {
            const tenders = await db.query(
                "SELECT t.id,h.holder_ref,t.tendered_units,t.status,t.submitted_at,t.cancelled_at FROM phase4_tenders t JOIN phase2_holders h ON h.id=t.holder_id WHERE t.case_id=$1 ORDER BY t.submitted_at,t.id",
                [row.id],
            );
            const allocations = await db.query(
                `SELECT a.id,a.leaf_index,h.holder_ref,a.wallet_address,a.snapshot_units,a.accepted_units,
                a.amount_usd_minor::text,a.amount_test_usdc_minor::text,a.remainder::text,a.proof,
                r.tx_hash,r.block_number::text,r.block_hash,r.log_index
                FROM phase4_allocations a JOIN phase2_holders h ON h.id=a.holder_id
                LEFT JOIN phase4_receipts r ON r.allocation_id=a.id WHERE a.case_id=$1 ORDER BY a.leaf_index`,
                [row.id],
            );
            const ownRef =
                actor.role === "INVESTOR_A"
                    ? "synthetic-holder-a"
                    : actor.role === "INVESTOR_B"
                      ? "synthetic-holder-b"
                      : null;
            results.push({
                ...row,
                budget_usd_minor: row.budget_usd_minor?.toString() ?? null,
                binding_unit_price_usd_minor: row.binding_unit_price_usd_minor?.toString() ?? null,
                committed_usd_minor: row.committed_usd_minor?.toString() ?? null,
                record_block: row.record_block?.toString() ?? null,
                priceStatus:
                    row.kind === "BUYBACK"
                        ? ["FUNDED", "SETTLED", "CLOSED"].includes(row.state)
                            ? "FUNDED_BINDING"
                            : "FUNDING_PENDING"
                        : null,
                tenders: tenders.rows.filter((tender) => !ownRef || tender.holder_ref === ownRef),
                allocations: allocations.rows.map((allocation) => ({
                    ...allocation,
                    proof: ownRef && allocation.holder_ref !== ownRef ? [] : allocation.proof,
                })),
            });
        }
        await db.query("COMMIT");
        return { issuerVersion: issuer.version, appraisals: appraisals.rows, cases: results };
    } catch (error) {
        await db.query("ROLLBACK");
        throw error;
    } finally {
        db.release();
    }
}

export async function prepareAppraisal(pool: Pool, input: Mutation, appraisal: Appraisal) {
    const result = calculateIndicativeValue(appraisal);
    return mutate(pool, input, async (db, issuerId) => {
        await assertNoTerminal(db, issuerId);
        const holders = await holderRows(db, issuerId);
        const total = holders.reduce((sum, row) => sum + outstanding(row), 0n);
        if (total !== BigInt(appraisal.outstandingEligibleUnits))
            throw new ApiError(
                409,
                "APPRAISAL_UNITS_STALE",
                "Appraisal units must match the recorded remaining supply.",
            );
        if (appraisal.participationBasisPoints !== sampleOffering.participationBasisPoints)
            throw new ApiError(
                409,
                "TERMS_MISMATCH",
                "Sample participation rate differs from the published offering.",
            );
        const digest = sha256(JSON.stringify(appraisal));
        const inserted = await db.query<{ id: string }>(
            `INSERT INTO phase4_appraisals(issuer_id,input,input_sha256,pool_usd_minor,indicative_unit_usd_minor,prepared_by)
             VALUES($1,$2::jsonb,$3,$4::numeric,$5::numeric,$6) RETURNING id`,
            [
                issuerId,
                JSON.stringify(appraisal),
                digest,
                result.poolUsdMinor,
                result.indicativeUnitUsdMinor,
                input.actor.actorRef,
            ],
        );
        return {
            event: "APPRAISAL_PREPARED",
            resourceId: inserted.rows[0]!.id,
            before: null,
            after: digest,
            result: { appraisalId: inserted.rows[0]!.id, indicative: result },
        };
    });
}

export async function approveAppraisal(pool: Pool, input: Mutation, id: string) {
    return mutate(pool, input, async (db, issuerId) => {
        await assertNoTerminal(db, issuerId);
        const result = await db.query<{
            id: string;
            state: string;
            prepared_by: string;
            input_sha256: string;
        }>(
            "SELECT id,state,prepared_by,input_sha256 FROM phase4_appraisals WHERE id=$1 AND issuer_id=$2 FOR UPDATE",
            [id, issuerId],
        );
        const appraisal = result.rows[0];
        if (!appraisal) throw new ApiError(404, "APPRAISAL_NOT_FOUND", "Sample appraisal not found.");
        if (appraisal.state !== "DRAFT")
            throw new ApiError(409, "INVALID_APPRAISAL_STATE", "Appraisal is not a draft.");
        if (appraisal.prepared_by === input.actor.actorRef)
            throw new ApiError(403, "SEPARATION_REQUIRED", "The preparer cannot approve this appraisal.");
        await db.query(
            "UPDATE phase4_appraisals SET state='APPROVED',approved_by=$2,approved_at=now() WHERE id=$1",
            [id, input.actor.actorRef],
        );
        return {
            event: "APPRAISAL_APPROVED",
            resourceId: id,
            before: appraisal.input_sha256,
            after: sha256(`${appraisal.input_sha256}:APPROVED`),
            approvalId: id,
        };
    });
}

export async function prepareBuyback(
    pool: Pool,
    input: Mutation,
    details: {
        appraisalId: string;
        budgetUsdMinor: string;
        bindingUnitPriceUsdMinor: string;
        tenderDeadline: string;
    },
) {
    return mutate(pool, input, async (db, issuerId) => {
        await assertNoTerminal(db, issuerId);
        const active = await db.query(
            "SELECT 1 FROM phase4_cases WHERE issuer_id=$1 AND kind='BUYBACK' AND state NOT IN ('CLOSED','CANCELLED','EXPIRED') LIMIT 1",
            [issuerId],
        );
        if (active.rowCount)
            throw new ApiError(409, "BUYBACK_ACTIVE", "Close or cancel the current buyback first.");
        const appraisalResult = await db.query<{ state: string; input: Appraisal; approved_by: string }>(
            "SELECT state,input,approved_by FROM phase4_appraisals WHERE id=$1 AND issuer_id=$2",
            [details.appraisalId, issuerId],
        );
        const appraisal = appraisalResult.rows[0];
        if (!appraisal || appraisal.state !== "APPROVED")
            throw new ApiError(
                409,
                "APPRAISAL_REQUIRED",
                "An approved independent sample appraisal is required.",
            );
        const holders = await holderRows(db, issuerId);
        const total = holders.reduce((sum, row) => sum + outstanding(row), 0n);
        if (total !== BigInt(appraisal.input.outstandingEligibleUnits))
            throw new ApiError(409, "APPRAISAL_UNITS_STALE", "Remaining units changed after the appraisal.");
        const terms = await currentTerms(db, issuerId);
        const digest = sha256(JSON.stringify(details));
        const row = await db.query<{ id: string }>(
            `INSERT INTO phase4_cases(issuer_id,kind,state,appraisal_id,terms_id,input,input_sha256,budget_usd_minor,
             binding_unit_price_usd_minor,tender_deadline,prepared_by)
             VALUES($1,'BUYBACK','DRAFT',$2,$3,$4::jsonb,$5,$6::numeric,$7::numeric,$8::timestamptz,$9) RETURNING id`,
            [
                issuerId,
                details.appraisalId,
                terms.id,
                JSON.stringify(details),
                digest,
                details.budgetUsdMinor,
                details.bindingUnitPriceUsdMinor,
                details.tenderDeadline,
                input.actor.actorRef,
            ],
        );
        return {
            event: "BUYBACK_PREPARED",
            resourceId: row.rows[0]!.id,
            before: null,
            after: digest,
            result: { caseId: row.rows[0]!.id },
            approvalId: details.appraisalId,
            termsVersion: String(terms.version),
        };
    });
}

export async function advanceBuyback(
    pool: Pool,
    input: Mutation,
    id: string,
    target: "APPROVED" | "OPEN" | "TENDER_CLOSED",
) {
    const previous = { APPROVED: "DRAFT", OPEN: "APPROVED", TENDER_CLOSED: "OPEN" }[target];
    return mutate(pool, input, async (db, issuerId) => {
        await assertNoTerminal(db, issuerId);
        const value = await getCase(db, id);
        if (value.issuer_id !== issuerId)
            throw new ApiError(404, "CASE_NOT_FOUND", "Settlement case not found.");
        requireState(value, "BUYBACK", previous);
        if (target === "APPROVED" && value.prepared_by === input.actor.actorRef)
            throw new ApiError(403, "SEPARATION_REQUIRED", "The preparer cannot approve this buyback.");
        if (target === "OPEN" && value.tender_deadline! <= new Date())
            throw new ApiError(409, "DEADLINE_PASSED", "The tender deadline has passed.");
        if (target === "TENDER_CLOSED" && value.tender_deadline! > new Date())
            throw new ApiError(409, "DEADLINE_NOT_REACHED", "Tenders remain open until the stated deadline.");
        const terms = await currentTerms(db, issuerId);
        if (terms.id !== value.terms_id) throw new ApiError(409, "TERMS_CHANGED", "Published terms changed.");
        await db.query(
            `UPDATE phase4_cases SET state=$2,version=version+1,updated_at=now(),
            approved_by=CASE WHEN $2='APPROVED' THEN $3 ELSE approved_by END,
            approved_at=CASE WHEN $2='APPROVED' THEN now() ELSE approved_at END WHERE id=$1`,
            [id, target, input.actor.actorRef],
        );
        return {
            event: `BUYBACK_${target}`,
            resourceId: id,
            before: sha256(`${value.state}:${value.input_sha256}`),
            after: sha256(`${target}:${value.input_sha256}`),
            approvalId: value.appraisal_id ?? undefined,
            termsVersion: String(terms.version),
        };
    });
}

export async function submitTender(pool: Pool, input: Mutation, id: string, units: number) {
    return mutate(pool, input, async (db, issuerId) => {
        const value = await getCase(db, id);
        if (value.issuer_id !== issuerId)
            throw new ApiError(404, "CASE_NOT_FOUND", "Settlement case not found.");
        requireState(value, "BUYBACK", "OPEN");
        if (value.tender_deadline! <= new Date())
            throw new ApiError(409, "TENDER_EXPIRED", "Tender deadline has passed.");
        const ref = input.actor.role === "INVESTOR_A" ? "synthetic-holder-a" : "synthetic-holder-b";
        const holder = (await holderRows(db, issuerId)).find((row) => row.holder_ref === ref);
        if (!holder) throw new ApiError(404, "HOLDER_NOT_FOUND", "Fictional holder not found.");
        requireEligible(holder, value.terms_id);
        const holding = outstanding(holder);
        if (BigInt(units) > holding)
            throw new ApiError(409, "TENDER_EXCEEDS_HOLDING", "Tender exceeds remaining units.");
        const active = await db.query(
            "SELECT 1 FROM phase4_tenders WHERE case_id=$1 AND holder_id=$2 AND status='ACTIVE'",
            [id, holder.id],
        );
        if (active.rowCount)
            throw new ApiError(409, "TENDER_EXISTS", "Cancel the active tender before submitting another.");
        const inserted = await db.query<{ id: string }>(
            `INSERT INTO phase4_tenders(case_id,holder_id,wallet_address,tendered_units,holding_units_at_submission)
             VALUES($1,$2,$3,$4,$5) RETURNING id`,
            [id, holder.id, holder.wallet_address, units, Number(holding)],
        );
        return {
            event: "BUYBACK_TENDER_SUBMITTED",
            resourceId: id,
            before: value.input_sha256,
            after: sha256(`${value.input_sha256}:${inserted.rows[0]!.id}:${units}`),
            result: { tenderId: inserted.rows[0]!.id },
            approvalId: value.appraisal_id ?? undefined,
        };
    });
}

export async function cancelTender(pool: Pool, input: Mutation, id: string, tenderId: string) {
    return mutate(pool, input, async (db, issuerId) => {
        const value = await getCase(db, id);
        if (value.issuer_id !== issuerId)
            throw new ApiError(404, "CASE_NOT_FOUND", "Settlement case not found.");
        requireState(value, "BUYBACK", "OPEN");
        if (value.tender_deadline! <= new Date())
            throw new ApiError(409, "TENDER_EXPIRED", "Cancellation deadline has passed.");
        const ref = input.actor.role === "INVESTOR_A" ? "synthetic-holder-a" : "synthetic-holder-b";
        const tender = await db.query<{ id: string; status: string; holder_ref: string }>(
            `SELECT t.id,t.status,h.holder_ref FROM phase4_tenders t JOIN phase2_holders h ON h.id=t.holder_id
             WHERE t.id=$1 AND t.case_id=$2 FOR UPDATE OF t`,
            [tenderId, id],
        );
        if (!tender.rows[0] || tender.rows[0].holder_ref !== ref)
            throw new ApiError(404, "TENDER_NOT_FOUND", "Tender not found for this holder.");
        if (tender.rows[0].status !== "ACTIVE")
            throw new ApiError(409, "TENDER_INACTIVE", "Tender is already cancelled.");
        await db.query("UPDATE phase4_tenders SET status='CANCELLED',cancelled_at=now() WHERE id=$1", [
            tenderId,
        ]);
        return {
            event: "BUYBACK_TENDER_CANCELLED",
            resourceId: id,
            before: sha256(tenderId),
            after: sha256(`${tenderId}:CANCELLED`),
            result: { tenderId },
        };
    });
}

async function chainSnapshot(pool: Pool, config: StartupConfig) {
    if (!config.TEPA_TOKEN_ADDRESS)
        throw new ApiError(409, "TOKEN_CONFIG_REQUIRED", "Configure the issued token first.");
    const client = createPublicClient({ chain: chain(config), transport: http(rpcUrl(config)) });
    if ((await client.getChainId()) !== config.CHAIN_ID)
        throw new ApiError(409, "WRONG_CHAIN", "Configured RPC is on the wrong chain.");
    const latest = await client.getBlockNumber();
    if (config.CHAIN_ID === 84532 && latest < 3n)
        throw new ApiError(409, "CHAIN_NOT_FINAL", "Wait for three record-date confirmations.");
    const blockNumber = config.CHAIN_ID === 84532 ? latest - 3n : latest;
    const block = await client.getBlock({ blockNumber });
    const token = getAddress(config.TEPA_TOKEN_ADDRESS);
    const code = await client.getCode({ address: token, blockNumber });
    if (!code || code === "0x")
        throw new ApiError(409, "TOKEN_NOT_DEPLOYED", "Issued token code is missing.");
    if (config.APP_ENV === "demo" && !config.TEPA_TOKEN_CODE_HASH)
        throw new ApiError(409, "TOKEN_HASH_REQUIRED", "Record the verified demo token bytecode hash.");
    if (
        config.TEPA_TOKEN_CODE_HASH &&
        keccak256(code).toLowerCase() !== config.TEPA_TOKEN_CODE_HASH.toLowerCase()
    )
        throw new ApiError(409, "TOKEN_CODE_MISMATCH", "Issued token bytecode changed.");
    const issuer = await findIssuer(pool);
    if (!issuer) throw new ApiError(404, "ISSUER_NOT_FOUND", "Fictional issuer not found.");
    const holders = await pool.query<Holder>(
        `SELECT h.id,h.holder_ref,h.wallet_address,h.recorded_units,h.eligibility_status,h.eligibility_expires_at,
                h.subscription_status,h.terms_id,COALESCE(p.paid_units,0)::text AS paid_units
         FROM phase2_holders h LEFT JOIN LATERAL (
             SELECT SUM(a.accepted_units) AS paid_units FROM phase4_allocations a
             JOIN phase4_receipts r ON r.allocation_id=a.id WHERE a.holder_id=h.id
         ) p ON true WHERE h.issuer_id=$1 ORDER BY h.holder_ref`,
        [issuer.id],
    );
    if (holders.rows.length !== 2 || holders.rows.some((holder) => !holder.wallet_address))
        throw new ApiError(409, "HOLDER_REGISTER_NOT_READY", "Both fictional holders need recorded wallets.");
    const [chainId, terminal, supply, ...balances] = await Promise.all([
        client.readContract({
            address: token,
            abi: tokenAbi,
            functionName: "deploymentChainId",
            blockNumber,
        }),
        client.readContract({
            address: token,
            abi: tokenAbi,
            functionName: "terminalSettlement",
            blockNumber,
        }),
        client.readContract({ address: token, abi: tokenAbi, functionName: "totalSupply", blockNumber }),
        ...holders.rows.map((holder) =>
            client.readContract({
                address: token,
                abi: tokenAbi,
                functionName: "balanceOf",
                args: [getAddress(holder.wallet_address!)],
                blockNumber,
            }),
        ),
    ]);
    if (
        chainId !== BigInt(config.CHAIN_ID) ||
        terminal ||
        balances.some((balance, index) => balance !== outstanding(holders.rows[index]!)) ||
        balances.reduce((sum, value) => sum + value, 0n) !== supply
    )
        throw new ApiError(
            409,
            "REGISTER_MISMATCH",
            "Remaining holder units do not match the confirmed chain snapshot.",
        );
    const checkBlock = await client.getBlock({ blockNumber });
    if (checkBlock.hash !== block.hash)
        throw new ApiError(409, "CHAIN_REORG", "Record block changed during snapshot.");
    return { holders: holders.rows, blockNumber, blockHash: block.hash, supply, token };
}

export async function allocateBuybackCase(pool: Pool, config: StartupConfig, input: Mutation, id: string) {
    const snapshot = await chainSnapshot(pool, config);
    return mutate(pool, input, async (db, issuerId) => {
        const value = await getCase(db, id);
        if (value.issuer_id !== issuerId)
            throw new ApiError(404, "CASE_NOT_FOUND", "Settlement case not found.");
        requireState(value, "BUYBACK", "TENDER_CLOSED");
        const holders = await holderRows(db, issuerId);
        if (
            holders.some(
                (row, index) =>
                    row.id !== snapshot.holders[index]?.id ||
                    outstanding(row) !== outstanding(snapshot.holders[index]!),
            )
        )
            throw new ApiError(409, "REGISTER_CHANGED", "Holder register changed during allocation.");
        const tenders = await db.query<{
            id: string;
            holder_id: string;
            holder_ref: string;
            wallet_address: string;
            tendered_units: number;
        }>(
            `SELECT t.id,t.holder_id,h.holder_ref,t.wallet_address,t.tendered_units FROM phase4_tenders t
             JOIN phase2_holders h ON h.id=t.holder_id WHERE t.case_id=$1 AND t.status='ACTIVE' ORDER BY t.id`,
            [id],
        );
        const byRef = new Map(holders.map((holder) => [holder.holder_ref, holder]));
        for (const tender of tenders.rows) {
            const holder = byRef.get(tender.holder_ref);
            if (!holder) throw new ApiError(409, "HOLDER_MISSING", "Tender holder is missing.");
            requireEligible(holder, value.terms_id);
            if (
                holder.wallet_address?.toLowerCase() !== tender.wallet_address.toLowerCase() ||
                BigInt(tender.tendered_units) > outstanding(holder)
            )
                throw new ApiError(409, "TENDER_STALE", "Tender wallet or remaining holdings changed.");
        }
        const allocation = allocateBuyback(
            BigInt(value.budget_usd_minor!),
            BigInt(value.binding_unit_price_usd_minor!),
            tenders.rows.map((tender) => ({
                submissionId: tender.id,
                holderRef: tender.holder_ref,
                tenderedUnits: String(tender.tendered_units),
                holdingUnits: outstanding(byRef.get(tender.holder_ref)!).toString(),
            })),
        );
        const accepted = allocation.allocations.filter((row) => BigInt(row.acceptedUnits) > 0n);
        if (!accepted.length)
            throw new ApiError(409, "NO_ACCEPTED_TENDERS", "No valid tender units fit the funded budget.");
        const claims = accepted.map((row, index) => ({
            index,
            wallet: getAddress(byRef.get(row.holderRef)!.wallet_address!),
            units: BigInt(row.acceptedUnits),
            amount: usdCentsToTestUsdcUnits(
                BigInt(row.acceptedUnits) * BigInt(value.binding_unit_price_usd_minor!),
            ),
        }));
        const tree = buildSettlementTree(config.CHAIN_ID, settlementHash(id), false, claims);
        const record = {
            blockNumber: snapshot.blockNumber.toString(),
            blockHash: snapshot.blockHash,
            token: snapshot.token,
            allocation,
            root: tree.root,
        };
        const digest = sha256(JSON.stringify(record));
        for (const [index, row] of accepted.entries()) {
            const holder = byRef.get(row.holderRef)!;
            await db.query(
                `INSERT INTO phase4_allocations(case_id,holder_id,tender_id,leaf_index,wallet_address,snapshot_units,accepted_units,
                 amount_usd_minor,amount_test_usdc_minor,remainder,proof,leaf_hash)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9::numeric,$10::numeric,$11::jsonb,$12)`,
                [
                    id,
                    holder.id,
                    row.submissionId,
                    index,
                    claims[index]!.wallet,
                    Number(outstanding(holder)),
                    Number(row.acceptedUnits),
                    (BigInt(row.acceptedUnits) * BigInt(value.binding_unit_price_usd_minor!)).toString(),
                    claims[index]!.amount.toString(),
                    row.remainder,
                    JSON.stringify(tree.proofs[index]),
                    tree.leaves[index],
                ],
            );
        }
        await db.query(
            `UPDATE phase4_cases SET state='ALLOCATED',version=version+1,record_block=$2::numeric,
            record_block_hash=$3,snapshot_hash=$4,entitlement_root=$5,committed_units=$6,committed_usd_minor=$7::numeric,
            updated_at=now() WHERE id=$1`,
            [
                id,
                snapshot.blockNumber.toString(),
                snapshot.blockHash,
                digest,
                tree.root,
                Number(allocation.acceptedUnits),
                allocation.payableUsdMinor,
            ],
        );
        return {
            event: "BUYBACK_ALLOCATED",
            resourceId: id,
            before: value.input_sha256,
            after: digest,
            result: { entitlementRoot: tree.root, allocation },
            approvalId: value.appraisal_id ?? undefined,
        };
    });
}

export async function prepareAcquisition(pool: Pool, input: Mutation, waterfall: AcquisitionWaterfall) {
    if (waterfall.participationBasisPoints !== sampleOffering.participationBasisPoints)
        throw new ApiError(
            409,
            "TERMS_MISMATCH",
            "Sample participation rate differs from the published offering.",
        );
    return mutate(pool, input, async (db, issuerId) => {
        await assertNoTerminal(db, issuerId);
        const active = await db.query(
            "SELECT 1 FROM phase4_cases WHERE issuer_id=$1 AND kind='BUYBACK' AND state NOT IN ('CLOSED','CANCELLED','EXPIRED') LIMIT 1",
            [issuerId],
        );
        if (active.rowCount)
            throw new ApiError(409, "BUYBACK_OPEN", "Close the buyback and record holder outcomes first.");
        const existing = await db.query(
            "SELECT 1 FROM phase4_cases WHERE issuer_id=$1 AND kind='ACQUISITION' AND state <> 'CANCELLED' LIMIT 1",
            [issuerId],
        );
        if (existing.rowCount)
            throw new ApiError(409, "ACQUISITION_EXISTS", "An acquisition case already exists.");
        const terms = await currentTerms(db, issuerId);
        const holders = await holderRows(db, issuerId);
        const remainingHolders = holders.filter((row) => outstanding(row) > 0n);
        if (remainingHolders.length === 0)
            throw new ApiError(409, "NO_REMAINING_UNITS", "No remaining units to settle.");
        const preview = calculateAcquisition(
            waterfall,
            remainingHolders.map((row) => ({
                holderRef: row.holder_ref,
                walletAddress: getAddress(row.wallet_address!),
                eligibleUnits: outstanding(row).toString(),
            })),
        );
        if (BigInt(preview.settlementPoolUsdMinor) <= 0n)
            throw new ApiError(
                409,
                "ZERO_SETTLEMENT",
                "A zero-proceeds case needs a reviewed rights outcome before closure.",
            );
        const digest = sha256(JSON.stringify(waterfall));
        const row = await db.query<{ id: string }>(
            `INSERT INTO phase4_cases(issuer_id,kind,state,terms_id,input,input_sha256,prepared_by)
             VALUES($1,'ACQUISITION','DRAFT',$2,$3::jsonb,$4,$5) RETURNING id`,
            [issuerId, terms.id, JSON.stringify(waterfall), digest, input.actor.actorRef],
        );
        return {
            event: "ACQUISITION_PREPARED",
            resourceId: row.rows[0]!.id,
            before: null,
            after: digest,
            result: { caseId: row.rows[0]!.id, waterfall: preview },
            termsVersion: String(terms.version),
        };
    });
}

export async function advanceAcquisition(
    pool: Pool,
    input: Mutation,
    id: string,
    target: "EVIDENCE_REVIEW" | "APPROVED",
) {
    return mutate(pool, input, async (db, issuerId) => {
        const value = await getCase(db, id);
        if (value.issuer_id !== issuerId)
            throw new ApiError(404, "CASE_NOT_FOUND", "Settlement case not found.");
        requireState(value, "ACQUISITION", target === "EVIDENCE_REVIEW" ? "DRAFT" : "EVIDENCE_REVIEW");
        if (target === "APPROVED" && value.prepared_by === input.actor.actorRef)
            throw new ApiError(403, "SEPARATION_REQUIRED", "The preparer cannot approve acquisition terms.");
        const terms = await currentTerms(db, issuerId);
        if (terms.id !== value.terms_id) throw new ApiError(409, "TERMS_CHANGED", "Published terms changed.");
        await db.query(
            `UPDATE phase4_cases SET state=$2,version=version+1,updated_at=now(),
            approved_by=CASE WHEN $2='APPROVED' THEN $3 ELSE approved_by END,
            approved_at=CASE WHEN $2='APPROVED' THEN now() ELSE approved_at END WHERE id=$1`,
            [id, target, input.actor.actorRef],
        );
        return {
            event: `ACQUISITION_${target}`,
            resourceId: id,
            before: sha256(`${value.state}:${value.input_sha256}`),
            after: sha256(`${target}:${value.input_sha256}`),
            approvalId: target === "APPROVED" ? id : undefined,
            termsVersion: String(terms.version),
        };
    });
}

export async function snapshotAcquisition(pool: Pool, config: StartupConfig, input: Mutation, id: string) {
    const snapshot = await chainSnapshot(pool, config);
    return mutate(pool, input, async (db, issuerId) => {
        const value = await getCase(db, id);
        if (value.issuer_id !== issuerId)
            throw new ApiError(404, "CASE_NOT_FOUND", "Settlement case not found.");
        requireState(value, "ACQUISITION", "APPROVED");
        const holders = await holderRows(db, issuerId);
        if (
            holders.some(
                (row, index) =>
                    row.id !== snapshot.holders[index]?.id ||
                    outstanding(row) !== outstanding(snapshot.holders[index]!),
            )
        )
            throw new ApiError(409, "REGISTER_CHANGED", "Holder register changed during snapshot.");
        if (snapshot.supply === 0n)
            throw new ApiError(409, "NO_REMAINING_UNITS", "No remaining units to settle.");
        const remainingHolders = holders.filter((row) => outstanding(row) > 0n);
        for (const holder of remainingHolders) requireEligible(holder, value.terms_id);
        const result = calculateAcquisition(
            value.input as AcquisitionWaterfall,
            remainingHolders.map((row) => ({
                holderRef: row.holder_ref,
                walletAddress: getAddress(row.wallet_address!),
                eligibleUnits: outstanding(row).toString(),
            })),
        );
        if (
            result.allocation.entitlements.some(
                (row) => BigInt(row.amountMinor) === 0n || BigInt(row.eligibleUnits) === 0n,
            )
        )
            throw new ApiError(
                409,
                "ZERO_HOLDER_OUTCOME",
                "Each remaining holder needs a positive, funded outcome.",
            );
        const claims = result.allocation.entitlements.map((row, index) => ({
            index,
            wallet: getAddress(row.walletAddress),
            units: BigInt(row.eligibleUnits),
            amount: usdCentsToTestUsdcUnits(BigInt(row.amountMinor)),
        }));
        const tree = buildSettlementTree(config.CHAIN_ID, settlementHash(id), true, claims);
        const record = {
            blockNumber: snapshot.blockNumber.toString(),
            blockHash: snapshot.blockHash,
            token: snapshot.token,
            waterfall: result,
            root: tree.root,
        };
        const digest = sha256(JSON.stringify(record));
        for (const [index, row] of result.allocation.entitlements.entries()) {
            const holder = holders.find((item) => item.holder_ref === row.holderRef)!;
            await db.query(
                `INSERT INTO phase4_allocations(case_id,holder_id,leaf_index,wallet_address,snapshot_units,accepted_units,
                 amount_usd_minor,amount_test_usdc_minor,remainder,proof,leaf_hash)
                 VALUES($1,$2,$3,$4,$5,$6,$7::numeric,$8::numeric,$9::numeric,$10::jsonb,$11)`,
                [
                    id,
                    holder.id,
                    index,
                    claims[index]!.wallet,
                    Number(row.eligibleUnits),
                    Number(row.eligibleUnits),
                    row.amountMinor,
                    claims[index]!.amount.toString(),
                    row.remainder,
                    JSON.stringify(tree.proofs[index]),
                    tree.leaves[index],
                ],
            );
        }
        await db.query(
            `UPDATE phase4_cases SET state='SNAPSHOTTED',version=version+1,record_block=$2::numeric,
            record_block_hash=$3,snapshot_hash=$4,entitlement_root=$5,committed_units=$6,committed_usd_minor=$7::numeric,
            updated_at=now() WHERE id=$1`,
            [
                id,
                snapshot.blockNumber.toString(),
                snapshot.blockHash,
                digest,
                tree.root,
                Number(snapshot.supply),
                result.settlementPoolUsdMinor,
            ],
        );
        return {
            event: "ACQUISITION_SNAPSHOTTED",
            resourceId: id,
            before: value.input_sha256,
            after: digest,
            result: { entitlementRoot: tree.root, waterfall: result },
            approvalId: id,
        };
    });
}

export async function requestSettlementStep(
    pool: Pool,
    input: Mutation,
    id: string,
    step: "FUND" | "FINALIZE",
) {
    return mutate(pool, input, async (db, issuerId) => {
        const value = await getCase(db, id);
        if (value.issuer_id !== issuerId)
            throw new ApiError(404, "CASE_NOT_FOUND", "Settlement case not found.");
        if (
            step === "FUND" &&
            !(
                (value.kind === "BUYBACK" && value.state === "ALLOCATED") ||
                (value.kind === "ACQUISITION" && value.state === "SNAPSHOTTED")
            )
        )
            throw new ApiError(409, "INVALID_CASE_STATE", "Allocate or snapshot before funding.");
        if (
            step === "FINALIZE" &&
            !(
                (value.kind === "BUYBACK" && value.state === "SETTLED") ||
                (value.kind === "ACQUISITION" && value.state === "CLAIMABLE")
            )
        )
            throw new ApiError(
                409,
                "INVALID_CASE_STATE",
                "All holder outcomes must be recorded before closure.",
            );
        if (step === "FINALIZE") {
            const counts = await db.query<{ expected: string; recorded: string }>(
                `SELECT COUNT(*)::text AS expected,COUNT(r.id)::text AS recorded FROM phase4_allocations a
                 LEFT JOIN phase4_receipts r ON r.allocation_id=a.id WHERE a.case_id=$1`,
                [id],
            );
            if (counts.rows[0]?.expected === "0" || counts.rows[0]?.expected !== counts.rows[0]?.recorded)
                throw new ApiError(409, "OUTCOMES_INCOMPLETE", "Record every paid holder outcome first.");
            if (value.kind === "ACQUISITION") {
                const unpaid = await db.query(
                    `SELECT 1 FROM distribution_entitlements e JOIN distribution_epochs d ON d.id=e.epoch_id
                     LEFT JOIN distribution_claims c ON c.entitlement_id=e.id
                     WHERE d.issuer_id=$1 AND d.state NOT IN ('CANCELLED') AND c.id IS NULL LIMIT 1`,
                    [issuerId],
                );
                if (unpaid.rowCount)
                    throw new ApiError(
                        409,
                        "DISTRIBUTION_CLAIMS_OPEN",
                        "Record prior distribution outcomes before terminal settlement.",
                    );
            }
        }
        const pending = await db.query(
            "SELECT 1 FROM outbox_events WHERE event_type=$1 AND payload->>'resourceId'=$2 AND status IN ('PENDING','PROCESSING') LIMIT 1",
            [`SETTLEMENT_${step}_REQUESTED`, id],
        );
        if (pending.rowCount)
            throw new ApiError(409, "ACTION_PENDING", "This chain action is already pending.");
        return {
            event: `SETTLEMENT_${step}_REQUESTED`,
            resourceId: id,
            before: value.snapshot_hash,
            after: sha256(`${value.snapshot_hash}:${step}`),
            status: "PENDING",
            approvalId: value.appraisal_id ?? undefined,
        };
    });
}

export async function recordSettlementReceipt(
    pool: Pool,
    config: StartupConfig,
    input: Mutation,
    id: string,
    txHash: Hex,
) {
    const chainClient = createPublicClient({ chain: chain(config), transport: http(rpcUrl(config)) });
    if ((await chainClient.getChainId()) !== config.CHAIN_ID)
        throw new ApiError(409, "WRONG_CHAIN", "Configured RPC is on the wrong chain.");
    const receipt = await chainClient.getTransactionReceipt({ hash: txHash }).catch(() => null);
    if (!receipt || receipt.status !== "success")
        throw new ApiError(409, "SETTLEMENT_UNCONFIRMED", "Payment transaction is not confirmed.");
    const block = await chainClient.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash)
        throw new ApiError(409, "CHAIN_REORG", "Payment block is no longer canonical.");
    if (config.CHAIN_ID === 84532 && (await chainClient.getBlockNumber()) < receipt.blockNumber + 3n)
        throw new ApiError(409, "SETTLEMENT_UNFINALIZED", "Wait for three chain confirmations.");
    return mutate(pool, input, async (db, issuerId) => {
        const value = await getCase(db, id);
        if (value.issuer_id !== issuerId)
            throw new ApiError(404, "CASE_NOT_FOUND", "Settlement case not found.");
        if (
            (value.kind === "BUYBACK" && value.state !== "FUNDED") ||
            (value.kind === "ACQUISITION" && value.state !== "CLAIMABLE")
        )
            throw new ApiError(409, "INVALID_CASE_STATE", "Settlement is not open.");
        if (!value.vault_address)
            throw new ApiError(409, "VAULT_MISSING", "Funded vault evidence is missing.");
        const holderRef = input.actor.role === "INVESTOR_A" ? "synthetic-holder-a" : "synthetic-holder-b";
        const result = await db.query<{
            id: string;
            leaf_index: number;
            wallet_address: string;
            accepted_units: number;
            amount_test_usdc_minor: string;
        }>(
            `SELECT a.id,a.leaf_index,a.wallet_address,a.accepted_units,a.amount_test_usdc_minor::text
             FROM phase4_allocations a JOIN phase2_holders h ON h.id=a.holder_id
             WHERE a.case_id=$1 AND h.holder_ref=$2`,
            [id, holderRef],
        );
        const allocation = result.rows[0];
        if (!allocation)
            throw new ApiError(404, "ALLOCATION_NOT_FOUND", "No accepted settlement for this holder.");
        const already = await db.query("SELECT 1 FROM phase4_receipts WHERE allocation_id=$1", [
            allocation.id,
        ]);
        if (already.rowCount)
            throw new ApiError(409, "ALREADY_SETTLED", "This holder outcome was already recorded.");
        const topic = keccak256(stringToHex("PaidAndBurned(bytes32,uint256,address,uint256,uint256)"));
        const log = receipt.logs.find(
            (item) =>
                item.address.toLowerCase() === value.vault_address!.toLowerCase() &&
                item.topics[0] === topic &&
                item.topics[1] === settlementHash(id) &&
                BigInt(item.topics[2] ?? "0x0") === BigInt(allocation.leaf_index) &&
                getAddress(`0x${(item.topics[3] ?? "").slice(-40)}`) ===
                    getAddress(allocation.wallet_address) &&
                BigInt(`0x${item.data.slice(2, 66)}`) === BigInt(allocation.accepted_units) &&
                BigInt(`0x${item.data.slice(66, 130)}`) === BigInt(allocation.amount_test_usdc_minor),
        );
        if (!log)
            throw new ApiError(
                409,
                "SETTLEMENT_EVENT_MISMATCH",
                "Transaction has no matching paid-and-burned event.",
            );
        const recorded = await db.query<{ id: string }>(
            `INSERT INTO phase4_receipts(allocation_id,chain_id,tx_hash,block_number,block_hash,log_index)
            VALUES($1,$2,$3,$4::numeric,$5,$6) RETURNING id`,
            [
                allocation.id,
                config.CHAIN_ID,
                txHash,
                receipt.blockNumber.toString(),
                receipt.blockHash,
                log.logIndex,
            ],
        );
        if (value.kind === "BUYBACK") {
            const remaining = await db.query(
                `SELECT 1 FROM phase4_allocations a LEFT JOIN phase4_receipts r ON r.allocation_id=a.id
                 WHERE a.case_id=$1 AND r.id IS NULL LIMIT 1`,
                [id],
            );
            if (!remaining.rowCount)
                await db.query(
                    "UPDATE phase4_cases SET state='SETTLED',version=version+1,updated_at=now() WHERE id=$1",
                    [id],
                );
        }
        return {
            event: `${value.kind}_PAYMENT_RECORDED`,
            resourceId: id,
            before: value.snapshot_hash,
            after: sha256(`${value.snapshot_hash}:${allocation.id}:${txHash}`),
            result: { txHash, holderRef },
            approvalId: value.appraisal_id ?? undefined,
            chainEventId: recorded.rows[0]!.id,
        };
    });
}

export async function cancelSettlementCase(pool: Pool, input: Mutation, id: string) {
    return mutate(pool, input, async (db, issuerId) => {
        const value = await getCase(db, id);
        if (value.issuer_id !== issuerId)
            throw new ApiError(404, "CASE_NOT_FOUND", "Settlement case not found.");
        const allowed =
            value.kind === "BUYBACK"
                ? ["DRAFT", "APPROVED", "OPEN", "TENDER_CLOSED"]
                : ["DRAFT", "EVIDENCE_REVIEW", "APPROVED"];
        if (!allowed.includes(value.state))
            throw new ApiError(
                409,
                "CANCELLATION_FORBIDDEN",
                "A snapshotted or funded case cannot be cancelled.",
            );
        if (value.kind === "BUYBACK")
            await db.query(
                "UPDATE phase4_tenders SET status='CANCELLED',cancelled_at=now() WHERE case_id=$1 AND status='ACTIVE'",
                [id],
            );
        await db.query(
            "UPDATE phase4_cases SET state='CANCELLED',version=version+1,updated_at=now() WHERE id=$1",
            [id],
        );
        return {
            event: `${value.kind}_CANCELLED`,
            resourceId: id,
            before: sha256(`${value.state}:${value.input_sha256}`),
            after: sha256(`CANCELLED:${value.input_sha256}`),
        };
    });
}

export async function expireEmptyBuyback(pool: Pool, input: Mutation, id: string) {
    return mutate(pool, input, async (db, issuerId) => {
        const value = await getCase(db, id);
        if (value.issuer_id !== issuerId)
            throw new ApiError(404, "CASE_NOT_FOUND", "Settlement case not found.");
        requireState(value, "BUYBACK", "TENDER_CLOSED");
        const active = await db.query(
            "SELECT 1 FROM phase4_tenders WHERE case_id=$1 AND status='ACTIVE' LIMIT 1",
            [id],
        );
        if (active.rowCount)
            throw new ApiError(409, "ACTIVE_TENDERS", "Allocate the active tenders before closure.");
        await db.query(
            "UPDATE phase4_cases SET state='EXPIRED',version=version+1,updated_at=now() WHERE id=$1",
            [id],
        );
        return {
            event: "BUYBACK_EXPIRED_EMPTY",
            resourceId: id,
            before: sha256(`TENDER_CLOSED:${value.input_sha256}`),
            after: sha256(`EXPIRED:${value.input_sha256}`),
        };
    });
}

export async function resumeSettlement(pool: Pool, input: Mutation, id: string) {
    return mutate(pool, input, async (db, issuerId) => {
        const value = await getCase(db, id);
        if (value.issuer_id !== issuerId)
            throw new ApiError(404, "CASE_NOT_FOUND", "Settlement case not found.");
        if (value.state !== "RECONCILIATION_REQUIRED")
            throw new ApiError(409, "NO_RECONCILIATION", "This case has no failed chain step to review.");
        const failed = await db.query<{ id: string; event_type: string }>(
            `SELECT id,event_type FROM outbox_events WHERE payload->>'resourceId'=$1
             AND event_type IN ('SETTLEMENT_FUND_REQUESTED','SETTLEMENT_FINALIZE_REQUESTED')
             AND status='RECONCILIATION_REQUIRED' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
            [id],
        );
        const job = failed.rows[0];
        if (!job) throw new ApiError(409, "FAILED_STEP_MISSING", "No failed chain step was found.");
        const restored =
            job.event_type === "SETTLEMENT_FUND_REQUESTED"
                ? value.kind === "BUYBACK"
                    ? "ALLOCATED"
                    : "SNAPSHOTTED"
                : value.kind === "BUYBACK"
                  ? "SETTLED"
                  : "CLAIMABLE";
        await db.query("UPDATE phase4_cases SET state=$2,version=version+1,updated_at=now() WHERE id=$1", [
            id,
            restored,
        ]);
        await db.query("UPDATE outbox_events SET status='PENDING',updated_at=now() WHERE id=$1", [job.id]);
        return {
            event: "SETTLEMENT_RECONCILIATION_RETRY",
            resourceId: id,
            before: sha256(`RECONCILIATION_REQUIRED:${value.snapshot_hash}`),
            after: sha256(`${restored}:${value.snapshot_hash}:${job.id}`),
            result: { retriedStep: job.event_type },
        };
    });
}
