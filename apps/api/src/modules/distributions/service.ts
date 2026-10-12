import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
    allocateDistribution,
    buildFinancialReview,
    multiplyBasisPointsFloor,
    usdCentsToTestUsdcUnits,
    type CustomerMetric,
    type FinancialRow,
} from "@tepa/domain";
import { createPublicClient, getAddress, http, keccak256, parseAbi, stringToHex, type Hex } from "viem";
import { baseSepolia, foundry } from "viem/chains";
import type { StartupConfig } from "../../config.js";
import { ApiError, type Actor } from "../../http.js";
import { findIssuer, sampleOffering } from "../metrics/data.js";
import { buildEntitlementTree } from "./merkle.js";

const tokenAbi = parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function MAX_SUPPLY() view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function deploymentChainId() view returns (uint256)",
]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const epochHash = (id: string): Hex => keccak256(stringToHex(`tepa-distribution:${id}`));
export const rpcUrl = (config: StartupConfig) =>
    config.CHAIN_ID === 31337
        ? (config.CHAIN_RPC_URL ?? "http://127.0.0.1:8545")
        : config.BASE_SEPOLIA_RPC_URL!;
export const chain = (config: StartupConfig) => (config.CHAIN_ID === 31337 ? foundry : baseSepolia);

type Epoch = {
    id: string;
    issuer_id: string;
    quarter: string;
    revision: number;
    state: string;
    version: number;
    import_id: string;
    financial_approval_id: string;
    terms_id: string;
    cash_snapshot: Record<string, unknown>;
    cash_snapshot_sha256: string;
    pool_usd_minor: string;
    pool_test_usdc_minor: string;
    formula_version: string;
    prepared_by: string;
    reviewed_by: string | null;
    approved_by: string | null;
    approved_at: Date | null;
    record_block: string | null;
    record_block_hash: Hex | null;
    snapshot_hash: string | null;
    entitlement_root: Hex | null;
    vault_address: `0x${string}` | null;
    funding_tx_hash: Hex | null;
    opening_tx_hash: Hex | null;
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

async function epochRow(client: PoolClient, id: string): Promise<Epoch> {
    const result = await client.query<Epoch>("SELECT * FROM distribution_epochs WHERE id=$1 FOR UPDATE", [
        id,
    ]);
    if (!result.rows[0]) throw new ApiError(404, "EPOCH_NOT_FOUND", "Distribution epoch not found.");
    return result.rows[0];
}

function requireState(epoch: Epoch, state: string) {
    if (epoch.state !== state) throw new ApiError(409, "INVALID_EPOCH_STATE", `Epoch must be ${state}.`);
}

async function mutate(
    pool: Pool,
    input: Mutation,
    work: (
        client: PoolClient,
        issuerId: string,
    ) => Promise<{
        event: string;
        resourceId: string;
        before: string | null;
        after: string;
        status?: "PENDING";
        result?: Result;
        approvalId?: string;
        termsVersion?: string;
        chainEventId?: string;
    }>,
) {
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
            "SELECT request_sha256,response FROM distribution_operations WHERE actor_ref=$1 AND action=$2 AND idempotency_key=$3",
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
        const change = await work(client, issuer.id);
        const version = issuer.version + 1;
        const operationId = randomUUID();
        const response = {
            operationId,
            status: change.status ?? "CONFIRMED",
            resourceVersion: version,
            ...change.result,
        };
        await client.query("UPDATE issuers SET version=$2,updated_at=now() WHERE id=$1", [
            issuer.id,
            version,
        ]);
        await client.query(
            `INSERT INTO distribution_operations(id,actor_ref,action,idempotency_key,request_sha256,resource_version,status,response)
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
        await client.query(
            `INSERT INTO audit_events(actor_ref,actor_role,action,resource_type,resource_id,source_version,before_hash,after_hash,reason,request_id,formula_version,policy_version,terms_version,approval_id,chain_command_id,chain_event_id)
             VALUES($1,$2,$3,'distribution',$4,'phase3-v1',$5,$6,$7,$8,'distribution-largest-remainder-v1','sample-claims-v1',$9,$10,$11,$12)`,
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
        await client.query(
            "INSERT INTO outbox_events(operation_id,event_type,payload) VALUES($1,$2,$3::jsonb)",
            [
                operationId,
                change.event,
                JSON.stringify({ resourceId: change.resourceId, resourceVersion: version }),
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

async function approvedQuarter(client: PoolClient, issuerId: string, quarter: string) {
    const active = await client.query<{ active_import_id: string | null }>(
        "SELECT active_import_id FROM issuers WHERE id=$1",
        [issuerId],
    );
    const importId = active.rows[0]?.active_import_id;
    if (!importId) throw new ApiError(409, "IMPORT_REQUIRED", "A financial import is required.");
    const approval = await client.query<{ id: string; input_sha256: string; approved_by: string }>(
        "SELECT id,input_sha256,approved_by FROM financial_approvals WHERE import_id=$1",
        [importId],
    );
    const imported = await client.query<{ input_sha256: string }>(
        "SELECT input_sha256 FROM financial_imports WHERE id=$1",
        [importId],
    );
    if (!approval.rows[0] || approval.rows[0].input_sha256 !== imported.rows[0]?.input_sha256)
        throw new ApiError(409, "FINANCIAL_APPROVAL_REQUIRED", "Approve the current financial import first.");
    const open = await client.query(
        "SELECT 1 FROM financial_review_cases WHERE import_id=$1 AND status='OPEN' LIMIT 1",
        [importId],
    );
    if (open.rowCount)
        throw new ApiError(409, "OPEN_REVIEW_CASES", "Resolve financial differences before distribution.");
    const terms = await client.query<{ id: string; version: number }>(
        "SELECT id,version FROM prototype_terms WHERE issuer_id=$1 ORDER BY version DESC LIMIT 1",
        [issuerId],
    );
    if (!terms.rows[0]) throw new ApiError(409, "TERMS_REQUIRED", "Published prototype terms are required.");
    const source = await client.query<FinancialRow & { rowSha256: string }>(
        `SELECT source_ref AS "sourceRef",source_system AS "sourceSystem",period,category,
                amount_minor::text AS "amountMinor",evidence_ref AS "evidenceRef",related_party AS "relatedParty",row_sha256 AS "rowSha256"
         FROM financial_source_rows WHERE import_id=$1 ORDER BY period,source_ref`,
        [importId],
    );
    const metrics = await client.query<CustomerMetric>(
        `SELECT source_ref AS "sourceRef",period,active_customers AS "activeCustomers",arr_minor::text AS "arrMinor",
                churn_basis_points AS "churnBasisPoints",evidence_ref AS "evidenceRef"
         FROM customer_metric_rows WHERE import_id=$1 ORDER BY period`,
        [importId],
    );
    const review = buildFinancialReview(
        source.rows.map((row) => ({
            sourceRef: row.sourceRef,
            sourceSystem: row.sourceSystem,
            period: row.period,
            category: row.category,
            amountMinor: row.amountMinor,
            evidenceRef: row.evidenceRef,
            relatedParty: row.relatedParty,
        })),
        metrics.rows,
        sampleOffering.participationBasisPoints,
    );
    const [year, quarterNumber] = quarter.split("-Q");
    const start = (Number(quarterNumber) - 1) * 3 + 1;
    const periods = review.periods.filter(
        (row) =>
            row.period >= `${year}-${String(start).padStart(2, "0")}` &&
            row.period <= `${year}-${String(start + 2).padStart(2, "0")}`,
    );
    if (periods.length !== 3)
        throw new ApiError(409, "QUARTER_INCOMPLETE", "The selected quarter needs three source months.");
    const definedCash = periods.reduce((sum, row) => sum + BigInt(row.definedDistributableCashMinor), 0n);
    const poolUsd = multiplyBasisPointsFloor(
        definedCash > 0n ? definedCash : 0n,
        sampleOffering.participationBasisPoints,
    );
    if (poolUsd === 0n)
        throw new ApiError(
            409,
            "ZERO_DISTRIBUTION",
            "This quarter has no positive sample distribution pool.",
        );
    const refs = new Set(
        periods.flatMap((period) => Object.values(period.lines).flatMap((line) => line.sourceRefs)),
    );
    const snapshot = {
        quarter,
        importId,
        financialApprovalId: approval.rows[0].id,
        termsId: terms.rows[0].id,
        formulaVersion: "sample-distributable-cash-v1",
        participationBasisPoints: sampleOffering.participationBasisPoints,
        definedCashMinor: definedCash.toString(),
        poolUsdMinor: poolUsd.toString(),
        periods,
        sourceRows: source.rows.filter((row) => refs.has(row.sourceRef)),
    };
    return {
        importId,
        approvalId: approval.rows[0].id,
        terms: terms.rows[0],
        poolUsd,
        snapshot,
        snapshotHash: hash(JSON.stringify(snapshot)),
    };
}

export async function getDistributions(pool: Pool, actor: Actor, chainId: number) {
    const issuer = await findIssuer(pool);
    if (!issuer) return { issuerVersion: 0, chainId, epochs: [] };
    const epochs = await pool.query<Epoch>(
        "SELECT * FROM distribution_epochs WHERE issuer_id=$1 ORDER BY quarter DESC,revision DESC",
        [issuer.id],
    );
    const investorRef =
        actor.role === "INVESTOR_A"
            ? "synthetic-holder-a"
            : actor.role === "INVESTOR_B"
              ? "synthetic-holder-b"
              : null;
    const list = [];
    for (const epoch of epochs.rows) {
        const incidents = await pool.query<{
            code: string;
            created_at: Date;
            evidence: Record<string, unknown>;
        }>(
            "SELECT code,created_at,evidence FROM distribution_reconciliation_incidents WHERE epoch_id=$1 ORDER BY created_at DESC LIMIT 5",
            [epoch.id],
        );
        const chainSteps = await pool.query<{
            step: string;
            chain_id: number;
            contract_address: string;
            tx_hash: string;
            block_number: string;
            block_hash: string;
        }>(
            `SELECT step,chain_id,contract_address,tx_hash,block_number::text,block_hash
             FROM distribution_chain_steps WHERE epoch_id=$1
             ORDER BY CASE step WHEN 'VAULT_DEPLOY' THEN 0 WHEN 'FUND' THEN 1 ELSE 2 END`,
            [epoch.id],
        );
        const entitlements = await pool.query<{
            holder_ref: string;
            leaf_index: number;
            wallet_address: string;
            eligible_units: number;
            amount_usd_minor: string;
            amount_test_usdc_minor: string;
            remainder: string;
            rounding_unit_awarded: boolean;
            proof: Hex[];
            tx_hash: Hex | null;
            block_number: string | null;
            block_hash: Hex | null;
            log_index: number | null;
        }>(
            `SELECT h.holder_ref,e.leaf_index,e.wallet_address,e.eligible_units,e.amount_usd_minor::text,
                    e.amount_test_usdc_minor::text,e.remainder::text,e.rounding_unit_awarded,e.proof,c.tx_hash,
                    c.block_number::text,c.block_hash,c.log_index
             FROM distribution_entitlements e JOIN phase2_holders h ON h.id=e.holder_id
             LEFT JOIN distribution_claims c ON c.entitlement_id=e.id WHERE e.epoch_id=$1 ORDER BY e.leaf_index`,
            [epoch.id],
        );
        list.push({
            id: epoch.id,
            importId: epoch.import_id,
            termsId: epoch.terms_id,
            quarter: epoch.quarter,
            revision: epoch.revision,
            state: epoch.state,
            version: epoch.version,
            poolUsdMinor: epoch.pool_usd_minor,
            poolTestUsdcMinor: epoch.pool_test_usdc_minor,
            formulaVersion: epoch.formula_version,
            cashSnapshot: epoch.cash_snapshot,
            cashSnapshotSha256: epoch.cash_snapshot_sha256,
            preparedBy: epoch.prepared_by,
            reviewedBy: epoch.reviewed_by,
            approvedBy: epoch.approved_by,
            approvedAt: epoch.approved_at,
            recordBlock: epoch.record_block,
            recordBlockHash: epoch.record_block_hash,
            snapshotHash: epoch.snapshot_hash,
            entitlementRoot: epoch.entitlement_root,
            vaultAddress: epoch.vault_address,
            fundingTxHash: epoch.funding_tx_hash,
            openingTxHash: epoch.opening_tx_hash,
            chainSteps: chainSteps.rows.map((item) => ({
                step: item.step,
                chainId: item.chain_id,
                contractAddress: item.contract_address,
                txHash: item.tx_hash,
                blockNumber: item.block_number,
                blockHash: item.block_hash,
            })),
            reconciliationIncidents: incidents.rows.map((item) => ({
                code: item.code,
                createdAt: item.created_at,
                evidence: item.evidence,
            })),
            epochHash: epochHash(epoch.id),
            eligibleSupply: entitlements.rows
                .reduce((sum, row) => sum + BigInt(row.eligible_units), 0n)
                .toString(),
            entitlements: entitlements.rows
                .filter((row) => !investorRef || row.holder_ref === investorRef)
                .map((row) => ({
                    holderRef: row.holder_ref,
                    index: row.leaf_index,
                    walletAddress: row.wallet_address,
                    eligibleUnits: row.eligible_units,
                    amountUsdMinor: row.amount_usd_minor,
                    amountTestUsdcMinor: row.amount_test_usdc_minor,
                    remainder: row.remainder,
                    roundingUnitAwarded: row.rounding_unit_awarded,
                    proof: row.proof,
                    claimTxHash: row.tx_hash,
                    claimBlockNumber: row.block_number,
                    claimBlockHash: row.block_hash,
                    claimLogIndex: row.log_index,
                })),
        });
    }
    return { issuerVersion: issuer.version, chainId, epochs: list };
}

export async function prepareDistribution(pool: Pool, input: Mutation, quarter: string) {
    return mutate(pool, input, async (client, issuerId) => {
        const terminal = await client.query(
            "SELECT 1 FROM phase4_cases WHERE issuer_id=$1 AND kind='ACQUISITION' AND state='FINALIZED' LIMIT 1",
            [issuerId],
        );
        if (terminal.rowCount)
            throw new ApiError(
                409,
                "TERMINAL_SETTLEMENT",
                "No new distribution follows final acquisition settlement.",
            );
        const approved = await approvedQuarter(client, issuerId, quarter);
        const previous = await client.query<{ state: string; revision: number }>(
            "SELECT state,revision FROM distribution_epochs WHERE issuer_id=$1 AND quarter=$2 ORDER BY revision DESC LIMIT 1 FOR UPDATE",
            [issuerId, quarter],
        );
        if (previous.rows[0] && previous.rows[0].state !== "CANCELLED")
            throw new ApiError(
                409,
                "EPOCH_EXISTS",
                "Cancel the previous pre-snapshot revision before preparing another.",
            );
        const revision = (previous.rows[0]?.revision ?? 0) + 1;
        const inserted = await client.query<{ id: string }>(
            `INSERT INTO distribution_epochs(issuer_id,quarter,revision,import_id,financial_approval_id,terms_id,cash_snapshot,cash_snapshot_sha256,pool_usd_minor,pool_test_usdc_minor,formula_version,prepared_by)
             VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::numeric,$10::numeric,'sample-distributable-cash-v1',$11) RETURNING id`,
            [
                issuerId,
                quarter,
                revision,
                approved.importId,
                approved.approvalId,
                approved.terms.id,
                JSON.stringify(approved.snapshot),
                approved.snapshotHash,
                approved.poolUsd.toString(),
                usdCentsToTestUsdcUnits(approved.poolUsd).toString(),
                input.actor.actorRef,
            ],
        );
        return {
            event: "DISTRIBUTION_PREPARED",
            resourceId: inserted.rows[0]!.id,
            before: null,
            after: approved.snapshotHash,
            result: { epochId: inserted.rows[0]!.id, revision },
            approvalId: approved.approvalId,
            termsVersion: String(approved.terms.version),
        };
    });
}

export async function cancelDistribution(pool: Pool, input: Mutation, id: string) {
    return mutate(pool, input, async (client, issuerId) => {
        const epoch = await epochRow(client, id);
        if (epoch.issuer_id !== issuerId)
            throw new ApiError(404, "EPOCH_NOT_FOUND", "Distribution epoch not found.");
        if (!["DRAFT", "RECONCILED", "REVIEWED", "APPROVED"].includes(epoch.state))
            throw new ApiError(
                409,
                "CANCELLATION_FORBIDDEN",
                "A snapshotted or funded epoch cannot be cancelled.",
            );
        await client.query(
            "UPDATE distribution_epochs SET state='CANCELLED',version=version+1,updated_at=now() WHERE id=$1",
            [id],
        );
        return {
            event: "DISTRIBUTION_CANCELLED",
            resourceId: id,
            before: hash(epoch.state + epoch.cash_snapshot_sha256),
            after: hash("CANCELLED" + epoch.cash_snapshot_sha256),
            approvalId: epoch.financial_approval_id,
        };
    });
}

export async function advanceDistribution(
    pool: Pool,
    input: Mutation,
    id: string,
    target: "RECONCILED" | "REVIEWED" | "APPROVED",
) {
    const from = { RECONCILED: "DRAFT", REVIEWED: "RECONCILED", APPROVED: "REVIEWED" }[target];
    return mutate(pool, input, async (client, issuerId) => {
        const epoch = await epochRow(client, id);
        if (epoch.issuer_id !== issuerId)
            throw new ApiError(404, "EPOCH_NOT_FOUND", "Distribution epoch not found.");
        requireState(epoch, from);
        if (target === "REVIEWED" && epoch.prepared_by === input.actor.actorRef)
            throw new ApiError(403, "SEPARATION_REQUIRED", "The preparer cannot review this epoch.");
        if (target !== "REVIEWED") {
            const current = await approvedQuarter(client, issuerId, epoch.quarter);
            if (
                current.snapshotHash !== epoch.cash_snapshot_sha256 ||
                current.approvalId !== epoch.financial_approval_id
            )
                throw new ApiError(
                    409,
                    "SOURCE_CHANGED",
                    "Financial inputs changed; this epoch cannot advance.",
                );
        }
        await client.query(
            `UPDATE distribution_epochs SET state=$2,version=version+1,updated_at=now(),
            reviewed_by=CASE WHEN $2='REVIEWED' THEN $3 ELSE reviewed_by END,
            approved_by=CASE WHEN $2='APPROVED' THEN $3 ELSE approved_by END,
            approved_at=CASE WHEN $2='APPROVED' THEN now() ELSE approved_at END WHERE id=$1`,
            [id, target, input.actor.actorRef],
        );
        return {
            event: `DISTRIBUTION_${target}`,
            resourceId: id,
            before: hash(from + epoch.cash_snapshot_sha256),
            after: hash(target + epoch.cash_snapshot_sha256),
            approvalId: epoch.financial_approval_id,
        };
    });
}

export async function snapshotDistribution(pool: Pool, config: StartupConfig, input: Mutation, id: string) {
    if (!config.TEPA_TOKEN_ADDRESS)
        throw new ApiError(409, "TOKEN_CONFIG_REQUIRED", "Configure the issued token first.");
    const publicClient = createPublicClient({ chain: chain(config), transport: http(rpcUrl(config)) });
    if ((await publicClient.getChainId()) !== config.CHAIN_ID)
        throw new ApiError(409, "WRONG_CHAIN", "Configured RPC is on the wrong chain.");
    const latest = await publicClient.getBlockNumber();
    if (config.CHAIN_ID === 84532 && latest < 3n)
        throw new ApiError(409, "CHAIN_NOT_FINAL", "Wait for three record-date confirmations.");
    const blockNumber = config.CHAIN_ID === 84532 ? latest - 3n : latest;
    const block = await publicClient.getBlock({ blockNumber });
    const code = await publicClient.getCode({ address: getAddress(config.TEPA_TOKEN_ADDRESS), blockNumber });
    if (!code || code === "0x")
        throw new ApiError(409, "TOKEN_NOT_DEPLOYED", "No issued token code at the configured address.");
    if (config.APP_ENV === "demo" && !config.TEPA_TOKEN_CODE_HASH)
        throw new ApiError(409, "TOKEN_HASH_REQUIRED", "Record the verified demo token bytecode hash.");
    if (
        config.TEPA_TOKEN_CODE_HASH &&
        keccak256(code).toLowerCase() !== config.TEPA_TOKEN_CODE_HASH.toLowerCase()
    )
        throw new ApiError(409, "TOKEN_CODE_MISMATCH", "Configured token bytecode changed.");
    const [cap, decimals, tokenChain] = await Promise.all([
        publicClient.readContract({
            address: getAddress(config.TEPA_TOKEN_ADDRESS),
            abi: tokenAbi,
            functionName: "MAX_SUPPLY",
            blockNumber,
        }),
        publicClient.readContract({
            address: getAddress(config.TEPA_TOKEN_ADDRESS),
            abi: tokenAbi,
            functionName: "decimals",
            blockNumber,
        }),
        publicClient.readContract({
            address: getAddress(config.TEPA_TOKEN_ADDRESS),
            abi: tokenAbi,
            functionName: "deploymentChainId",
            blockNumber,
        }),
    ]);
    if (cap !== 1000n || decimals !== 0 || tokenChain !== BigInt(config.CHAIN_ID))
        throw new ApiError(
            409,
            "TOKEN_CONFIG_MISMATCH",
            "Configured token does not match the demo issuance rules.",
        );
    const db = await pool.query<{
        holder_ref: string;
        wallet_address: string;
        recorded_units: number;
        eligibility_status: string;
        eligibility_expires_at: Date;
        subscription_status: string;
    }>(
        "SELECT holder_ref,wallet_address,recorded_units,eligibility_status,eligibility_expires_at,subscription_status FROM phase2_holders ORDER BY holder_ref",
    );
    if (
        db.rows.length !== 2 ||
        db.rows.some(
            (row) =>
                row.subscription_status !== "RECORDED" ||
                row.eligibility_status !== "APPROVED" ||
                !row.wallet_address ||
                row.eligibility_expires_at <= new Date(),
        )
    )
        throw new ApiError(
            409,
            "HOLDER_REGISTER_NOT_READY",
            "Both holders must be issued, reconciled, and eligible.",
        );
    const balances = await Promise.all(
        db.rows.map((row) =>
            publicClient.readContract({
                address: getAddress(config.TEPA_TOKEN_ADDRESS!),
                abi: tokenAbi,
                functionName: "balanceOf",
                args: [getAddress(row.wallet_address)],
                blockNumber,
            }),
        ),
    );
    const supply = await publicClient.readContract({
        address: getAddress(config.TEPA_TOKEN_ADDRESS),
        abi: tokenAbi,
        functionName: "totalSupply",
        blockNumber,
    });
    if (
        balances.some((balance, index) => balance !== BigInt(db.rows[index]!.recorded_units)) ||
        balances.reduce((sum, value) => sum + value, 0n) !== supply ||
        supply !== 1000n
    )
        throw new ApiError(
            409,
            "REGISTER_MISMATCH",
            "Recorded units do not match the finalized chain balances.",
        );
    const blockAfter = await publicClient.getBlock({ blockNumber });
    if (block.hash !== blockAfter.hash)
        throw new ApiError(409, "CHAIN_REORG", "Record block changed during snapshot.");
    return mutate(pool, input, async (client, issuerId) => {
        const epoch = await epochRow(client, id);
        if (epoch.issuer_id !== issuerId)
            throw new ApiError(404, "EPOCH_NOT_FOUND", "Distribution epoch not found.");
        requireState(epoch, "APPROVED");
        const current = await approvedQuarter(client, issuerId, epoch.quarter);
        if (
            current.snapshotHash !== epoch.cash_snapshot_sha256 ||
            current.approvalId !== epoch.financial_approval_id
        )
            throw new ApiError(409, "SOURCE_CHANGED", "Approved financial inputs changed.");
        const holders = await client.query<{
            id: string;
            holder_ref: string;
            wallet_address: string;
            recorded_units: number;
            eligibility_status: string;
            eligibility_expires_at: Date;
            subscription_status: string;
            terms_id: string;
        }>(
            "SELECT id,holder_ref,wallet_address,recorded_units,eligibility_status,eligibility_expires_at,subscription_status,terms_id FROM phase2_holders WHERE issuer_id=$1 ORDER BY holder_ref FOR UPDATE",
            [issuerId],
        );
        if (
            holders.rows.length !== db.rows.length ||
            holders.rows.some(
                (row, index) =>
                    row.holder_ref !== db.rows[index]?.holder_ref ||
                    row.wallet_address?.toLowerCase() !== db.rows[index]?.wallet_address?.toLowerCase() ||
                    row.recorded_units !== db.rows[index]?.recorded_units ||
                    row.eligibility_status !== "APPROVED" ||
                    row.eligibility_expires_at <= new Date() ||
                    row.subscription_status !== "RECORDED" ||
                    row.terms_id !== epoch.terms_id,
            )
        )
            throw new ApiError(409, "HOLDER_REGISTER_CHANGED", "Holder register changed during snapshot.");
        const allocation = allocateDistribution(
            BigInt(epoch.pool_usd_minor),
            holders.rows.map((row) => ({
                holderRef: row.holder_ref,
                walletAddress: getAddress(row.wallet_address),
                eligibleUnits: String(row.recorded_units),
            })),
        );
        const claims = allocation.entitlements.map((row, index) => ({
            index,
            wallet: getAddress(row.walletAddress),
            amount: usdCentsToTestUsdcUnits(BigInt(row.amountMinor)),
        }));
        const tree = buildEntitlementTree(config.CHAIN_ID, epochHash(id), claims);
        const snapshot = {
            chainId: config.CHAIN_ID,
            tokenAddress: getAddress(config.TEPA_TOKEN_ADDRESS!),
            recordBlock: blockNumber.toString(),
            recordBlockHash: block.hash,
            root: tree.root,
            allocation,
            holders: holders.rows.map((row) => ({
                holderRef: row.holder_ref,
                walletAddress: row.wallet_address,
                recordedUnits: row.recorded_units,
            })),
        };
        const snapshotHash = hash(JSON.stringify(snapshot));
        for (const [index, row] of allocation.entitlements.entries()) {
            await client.query(
                `INSERT INTO distribution_entitlements(epoch_id,holder_id,leaf_index,wallet_address,eligible_units,
                amount_usd_minor,amount_test_usdc_minor,remainder,rounding_unit_awarded,proof,leaf_hash)
                VALUES($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::numeric,$9,$10::jsonb,$11)`,
                [
                    id,
                    holders.rows[index]!.id,
                    index,
                    row.walletAddress,
                    Number(row.eligibleUnits),
                    row.amountMinor,
                    claims[index]!.amount.toString(),
                    row.remainder,
                    row.roundingUnitAwarded,
                    JSON.stringify(tree.proofs[index]),
                    tree.leaves[index],
                ],
            );
        }
        await client.query(
            `UPDATE distribution_epochs SET state='SNAPSHOTTED',version=version+1,record_block=$2::numeric,
            record_block_hash=$3,snapshot_hash=$4,entitlement_root=$5,updated_at=now() WHERE id=$1`,
            [id, blockNumber.toString(), block.hash, snapshotHash, tree.root],
        );
        return {
            event: "DISTRIBUTION_SNAPSHOTTED",
            resourceId: id,
            before: epoch.cash_snapshot_sha256,
            after: snapshotHash,
            result: { entitlementRoot: tree.root, recordBlock: blockNumber.toString() },
            approvalId: epoch.financial_approval_id,
        };
    });
}

export async function requestChainStep(pool: Pool, input: Mutation, id: string, step: "FUND" | "OPEN") {
    return mutate(pool, input, async (client, issuerId) => {
        const epoch = await epochRow(client, id);
        if (epoch.issuer_id !== issuerId)
            throw new ApiError(404, "EPOCH_NOT_FOUND", "Distribution epoch not found.");
        requireState(epoch, step === "FUND" ? "SNAPSHOTTED" : "FUNDED");
        if (step === "OPEN" && !epoch.vault_address)
            throw new ApiError(409, "VAULT_MISSING", "Vault deployment is not recorded.");
        const pending = await client.query(
            "SELECT 1 FROM outbox_events WHERE event_type=$1 AND payload->>'resourceId'=$2 AND status IN ('PENDING','PROCESSING') LIMIT 1",
            [`DISTRIBUTION_${step}_REQUESTED`, id],
        );
        if (pending.rowCount)
            throw new ApiError(409, "ACTION_PENDING", "This chain action is already pending.");
        return {
            event: `DISTRIBUTION_${step}_REQUESTED`,
            resourceId: id,
            before: epoch.snapshot_hash,
            after: hash(`${epoch.snapshot_hash}:${step}`),
            status: "PENDING",
        };
    });
}

export async function recordClaim(
    pool: Pool,
    config: StartupConfig,
    input: Mutation,
    id: string,
    txHash: Hex,
) {
    if (!config.TEPA_TOKEN_ADDRESS)
        throw new ApiError(409, "TOKEN_CONFIG_REQUIRED", "Configure the issued token first.");
    const client = createPublicClient({ chain: chain(config), transport: http(rpcUrl(config)) });
    if ((await client.getChainId()) !== config.CHAIN_ID)
        throw new ApiError(409, "WRONG_CHAIN", "Configured RPC is on the wrong chain.");
    const receipt = await client.getTransactionReceipt({ hash: txHash }).catch(() => null);
    if (!receipt || receipt.status !== "success")
        throw new ApiError(409, "CLAIM_UNCONFIRMED", "The claim transaction is not confirmed.");
    const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (canonical.hash !== receipt.blockHash)
        throw new ApiError(409, "CHAIN_REORG", "Claim block is no longer canonical.");
    const latest = await client.getBlockNumber();
    if (config.CHAIN_ID === 84532 && latest < receipt.blockNumber + 3n)
        throw new ApiError(409, "CLAIM_UNFINALIZED", "Wait for three chain confirmations.");
    return mutate(pool, input, async (db, issuerId) => {
        const epoch = await epochRow(db, id);
        if (epoch.issuer_id !== issuerId)
            throw new ApiError(404, "EPOCH_NOT_FOUND", "Distribution epoch not found.");
        requireState(epoch, "CLAIMABLE");
        const holderRef = input.actor.role === "INVESTOR_A" ? "synthetic-holder-a" : "synthetic-holder-b";
        const row = await db.query<{
            id: string;
            leaf_index: number;
            wallet_address: string;
            amount_test_usdc_minor: string;
        }>(
            `SELECT e.id,e.leaf_index,e.wallet_address,e.amount_test_usdc_minor::text FROM distribution_entitlements e
             JOIN phase2_holders h ON h.id=e.holder_id WHERE e.epoch_id=$1 AND h.holder_ref=$2`,
            [id, holderRef],
        );
        const entitlement = row.rows[0];
        if (!entitlement || !epoch.vault_address)
            throw new ApiError(404, "ENTITLEMENT_NOT_FOUND", "No claimable entitlement for this holder.");
        const existing = await db.query("SELECT 1 FROM distribution_claims WHERE entitlement_id=$1", [
            entitlement.id,
        ]);
        if (existing.rowCount)
            throw new ApiError(409, "ALREADY_CLAIMED", "This entitlement was already recorded.");
        const eventSignature = keccak256(stringToHex("Claimed(bytes32,uint256,address,uint256)"));
        const log = receipt.logs.find(
            (item) =>
                item.address.toLowerCase() === epoch.vault_address!.toLowerCase() &&
                item.topics[0] === eventSignature &&
                item.topics[1] === epochHash(id) &&
                BigInt(item.topics[2] ?? "0x0") === BigInt(entitlement.leaf_index) &&
                getAddress(`0x${(item.topics[3] ?? "").slice(-40)}`) ===
                    getAddress(entitlement.wallet_address) &&
                BigInt(item.data) === BigInt(entitlement.amount_test_usdc_minor),
        );
        if (!log)
            throw new ApiError(409, "CLAIM_EVENT_MISMATCH", "Transaction has no matching vault claim event.");
        const recorded = await db.query<{ id: string }>(
            `INSERT INTO distribution_claims(entitlement_id,chain_id,tx_hash,block_number,block_hash,log_index)
            VALUES($1,$2,$3,$4::numeric,$5,$6) RETURNING id`,
            [
                entitlement.id,
                config.CHAIN_ID,
                txHash,
                receipt.blockNumber.toString(),
                receipt.blockHash,
                log.logIndex,
            ],
        );
        return {
            event: "DISTRIBUTION_CLAIM_RECORDED",
            resourceId: id,
            before: epoch.snapshot_hash,
            after: hash(`${epoch.snapshot_hash}:${entitlement.id}:${txHash}`),
            result: { claimTxHash: txHash },
            approvalId: epoch.financial_approval_id,
            chainEventId: recorded.rows[0]!.id,
        };
    });
}
