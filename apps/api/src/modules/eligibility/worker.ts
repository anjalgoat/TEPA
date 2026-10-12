import {
    createPublicClient,
    createWalletClient,
    getAddress,
    http,
    keccak256,
    parseAbi,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, foundry } from "viem/chains";
import type { Pool } from "pg";
import type { StartupConfig } from "../../config.js";
import { caseHash, decisionHash, subjectHash, type HolderRef } from "./service.js";

const abi = parseAbi([
    "function eligibility(address) view returns (bytes32 subject, bytes32 decision, uint64 expiresAt, bool active)",
    "function allocations(bytes32) view returns (address wallet, uint16 units, bytes32 caseId, bool minted)",
    "function balanceOf(address) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function MAX_SUPPLY() view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function deploymentChainId() view returns (uint256)",
    "function COMPLIANCE_ROLE() view returns (bytes32)",
    "function ISSUER_AGENT_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function setEligibility(address,bytes32,bytes32,uint64,bool)",
    "function revokeEligibility(address,bytes32)",
    "function recordAllocation(bytes32,address,uint16,bytes32)",
    "function mint(bytes32,address,uint16,bytes32)",
]);
const settlementVaultAbi = parseAbi(["function settled(uint256) view returns (bool)"]);

type Job = {
    id: string;
    operation_id: string;
    holder_ref: HolderRef;
    subject_hash: Hex;
    planned_units: number;
    wallet_address: string;
    allocation_case_id: string;
    eligibility_decision_id: string;
    eligibility_expires_at: Date;
    eligibility_status: string;
    subscription_status: string;
};

type WorkerSettings = {
    rpcUrl: string;
    tokenAddress: `0x${string}`;
    privateKey: Hex;
    codeHash?: Hex;
};

async function acquireJob(pool: Pool): Promise<Job | null> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const found = await client.query<Job>(
            `SELECT o.id, o.operation_id, h.holder_ref, h.subject_hash, h.planned_units,
                    h.wallet_address, h.allocation_case_id, h.eligibility_decision_id,
                    h.eligibility_expires_at, h.eligibility_status, h.subscription_status
             FROM outbox_events o
             JOIN phase2_operations p ON p.id=o.operation_id
             JOIN phase2_holders h ON h.holder_ref=split_part(p.action, ':', 2)
             WHERE o.event_type='DEMO_ISSUANCE_REQUESTED'
               AND (o.status='PENDING'
                    OR (o.status='PROCESSING' AND o.updated_at < now() - interval '5 minutes'))
             ORDER BY o.created_at, o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,
        );
        const job = found.rows[0] ?? null;
        if (job)
            await client.query(
                "UPDATE outbox_events SET status='PROCESSING', attempts=attempts+1, updated_at=now() WHERE id=$1",
                [job.id],
            );
        await client.query("COMMIT");
        return job;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

async function assertCurrentApproval(pool: Pool, job: Job): Promise<void> {
    const result = await pool.query<{
        eligibility_status: string;
        eligibility_expires_at: Date;
        wallet_address: string;
        allocation_case_id: string;
        subscription_status: string;
    }>(
        `SELECT eligibility_status,eligibility_expires_at,wallet_address,allocation_case_id,subscription_status
         FROM phase2_holders WHERE holder_ref=$1`,
        [job.holder_ref],
    );
    const current = result.rows[0];
    if (
        !current ||
        current.eligibility_status !== "APPROVED" ||
        current.eligibility_expires_at.getTime() <= Date.now() ||
        current.wallet_address !== job.wallet_address ||
        current.allocation_case_id !== job.allocation_case_id ||
        !["ALLOCATED", "MINTED", "RECONCILIATION_REQUIRED"].includes(current.subscription_status)
    )
        throw new Error("Off-chain approval or allocation changed during issuance");
}

export async function processOneIssuance(
    pool: Pool,
    config: StartupConfig,
    settings: WorkerSettings,
): Promise<"IDLE" | "CONFIRMED" | "RECONCILIATION_REQUIRED"> {
    const job = await acquireJob(pool);
    if (!job) return "IDLE";
    try {
        if (
            !job.wallet_address ||
            !job.allocation_case_id ||
            !job.eligibility_decision_id ||
            job.eligibility_status !== "APPROVED" ||
            job.eligibility_expires_at.getTime() <= Date.now() ||
            !["ALLOCATED", "MINTED", "RECONCILIATION_REQUIRED"].includes(job.subscription_status)
        )
            throw new Error("Off-chain issuance conditions are no longer current");
        const chain = config.CHAIN_ID === 84532 ? baseSepolia : foundry;
        const client = createPublicClient({ chain, transport: http(settings.rpcUrl) });
        if ((await client.getChainId()) !== config.CHAIN_ID)
            throw new Error("RPC chain ID does not match configuration");
        const address = getAddress(settings.tokenAddress);
        const code = await client.getCode({ address });
        if (!code) throw new Error("Token contract is not deployed at configured address");
        if (settings.codeHash && keccak256(code) !== settings.codeHash)
            throw new Error("Token bytecode hash does not match deployment record");
        if (
            (await client.readContract({ address, abi, functionName: "MAX_SUPPLY" })) !== 1_000n ||
            (await client.readContract({ address, abi, functionName: "decimals" })) !== 0 ||
            (await client.readContract({ address, abi, functionName: "deploymentChainId" })) !==
                BigInt(config.CHAIN_ID)
        )
            throw new Error("Token configuration does not match Phase 2 policy");
        const account = privateKeyToAccount(settings.privateKey);
        for (const roleFunction of ["COMPLIANCE_ROLE", "ISSUER_AGENT_ROLE"] as const) {
            const role = await client.readContract({ address, abi, functionName: roleFunction });
            if (
                !(await client.readContract({
                    address,
                    abi,
                    functionName: "hasRole",
                    args: [role, account.address],
                }))
            )
                throw new Error(`Issuance signer lacks ${roleFunction}`);
        }
        const wallet = createWalletClient({ account, chain, transport: http(settings.rpcUrl) });
        const holderWallet = getAddress(job.wallet_address);
        const subject = subjectHash(job.holder_ref);
        if (subject !== job.subject_hash) throw new Error("Subject commitment mismatch");
        const decision = decisionHash(job.eligibility_decision_id);
        const caseId = caseHash(job.allocation_case_id);
        const expiry = BigInt(Math.floor(job.eligibility_expires_at.getTime() / 1000));
        await assertCurrentApproval(pool, job);
        const read = <T extends "eligibility" | "allocations" | "balanceOf" | "totalSupply" | "MAX_SUPPLY">(
            functionName: T,
            args?: readonly unknown[],
        ) =>
            client.readContract({ address, abi, functionName, args } as Parameters<
                typeof client.readContract
            >[0]);
        const existingEligibility = (await read("eligibility", [holderWallet])) as readonly [
            Hex,
            Hex,
            number,
            boolean,
        ];
        if (
            existingEligibility[0] !== subject ||
            existingEligibility[1] !== decision ||
            !existingEligibility[3] ||
            BigInt(existingEligibility[2]) !== expiry
        ) {
            if (existingEligibility[0] !== `0x${"0".repeat(64)}` && existingEligibility[0] !== subject)
                throw new Error("Wallet already represents a different subject");
            await assertCurrentApproval(pool, job);
            const tx = await wallet.writeContract({
                address,
                abi,
                functionName: "setEligibility",
                args: [holderWallet, subject, decision, expiry, true],
            });
            await recordReceipt(
                pool,
                (txHash, confirmations) => client.waitForTransactionReceipt({ hash: txHash, confirmations }),
                (txHash) => client.getTransactionReceipt({ hash: txHash }),
                (blockNumber) => client.getBlock({ blockNumber }),
                job,
                "ELIGIBILITY",
                config.CHAIN_ID,
                address,
                tx,
            );
        }
        const currentAllocation = (await read("allocations", [subject])) as readonly [
            `0x${string}`,
            number,
            Hex,
            boolean,
        ];
        if (currentAllocation[0] === `0x${"0".repeat(40)}`) {
            await assertCurrentApproval(pool, job);
            const tx = await wallet.writeContract({
                address,
                abi,
                functionName: "recordAllocation",
                args: [subject, holderWallet, job.planned_units, caseId],
            });
            await recordReceipt(
                pool,
                (txHash, confirmations) => client.waitForTransactionReceipt({ hash: txHash, confirmations }),
                (txHash) => client.getTransactionReceipt({ hash: txHash }),
                (blockNumber) => client.getBlock({ blockNumber }),
                job,
                "ALLOCATION",
                config.CHAIN_ID,
                address,
                tx,
            );
        } else if (
            getAddress(currentAllocation[0]) !== holderWallet ||
            currentAllocation[1] !== job.planned_units ||
            currentAllocation[2] !== caseId
        ) {
            throw new Error("On-chain allocation conflicts with off-chain allocation");
        }
        const allocation = (await read("allocations", [subject])) as readonly [
            `0x${string}`,
            number,
            Hex,
            boolean,
        ];
        let mintHash: Hex | null = null;
        if (!allocation[3]) {
            await assertCurrentApproval(pool, job);
            const tx = await wallet.writeContract({
                address,
                abi,
                functionName: "mint",
                args: [subject, holderWallet, job.planned_units, caseId],
            });
            mintHash = tx;
            await recordReceipt(
                pool,
                (txHash, confirmations) => client.waitForTransactionReceipt({ hash: txHash, confirmations }),
                (txHash) => client.getTransactionReceipt({ hash: txHash }),
                (blockNumber) => client.getBlock({ blockNumber }),
                job,
                "MINT",
                config.CHAIN_ID,
                address,
                tx,
            );
        } else {
            const prior = await pool.query<{ tx_hash: Hex }>(
                "SELECT tx_hash FROM phase2_chain_steps WHERE operation_id=$1 AND step='MINT'",
                [job.operation_id],
            );
            if (!prior.rows[0])
                throw new Error(
                    "Minted allocation lacks a recorded transaction; manual reconciliation required",
                );
            mintHash = prior.rows[0].tx_hash;
        }
        await pool.query(
            "UPDATE phase2_holders SET subscription_status='MINTED',version=version+1,updated_at=now() WHERE holder_ref=$1 AND subscription_status <> 'MINTED'",
            [job.holder_ref],
        );
        const balance = (await read("balanceOf", [holderWallet])) as bigint;
        const supply = (await read("totalSupply")) as bigint;
        const cap = (await read("MAX_SUPPLY")) as bigint;
        const otherRecorded = await pool.query<{ units: string }>(
            "SELECT COALESCE(SUM(recorded_units),0)::text AS units FROM phase2_holders WHERE holder_ref <> $1",
            [job.holder_ref],
        );
        const expectedSupply = BigInt(otherRecorded.rows[0]?.units ?? "0") + BigInt(job.planned_units);
        if (balance !== BigInt(job.planned_units) || supply !== expectedSupply || supply > cap)
            throw new Error("Chain balance or supply did not reconcile with holder register");
        await assertCurrentApproval(pool, job);
        const db = await pool.connect();
        try {
            await db.query("BEGIN");
            const updated = await db.query(
                `UPDATE phase2_holders SET subscription_status='RECORDED',recorded_units=$2,issuance_tx_hash=$3,version=version+1,updated_at=now()
                 WHERE holder_ref=$1 AND eligibility_status='APPROVED' AND eligibility_expires_at > now() AND allocation_case_id=$4 RETURNING id`,
                [job.holder_ref, job.planned_units, mintHash, job.allocation_case_id],
            );
            if (!updated.rowCount) throw new Error("Approval changed before holder recording");
            await db.query("UPDATE outbox_events SET status='DELIVERED',updated_at=now() WHERE id=$1", [
                job.id,
            ]);
            await db.query(
                "UPDATE phase2_operations SET status='CONFIRMED',response=response || $2::jsonb WHERE id=$1",
                [
                    job.operation_id,
                    JSON.stringify({
                        status: "CONFIRMED",
                        issuanceTxHash: mintHash,
                        recordedUnits: job.planned_units,
                    }),
                ],
            );
            await db.query(
                `INSERT INTO audit_events (actor_ref,actor_role,action,resource_type,resource_id,source_version,after_hash,reason,request_id,policy_version,chain_command_id,chain_event_id)
                            SELECT 'synthetic:issuance-worker','REGISTRY_AGENT','DEMO_ISSUANCE_RECONCILED','phase2',h.id,'phase2-v1',$2,'Confirmed chain balance equals recorded allocation',p.id,'restricted-issuance-v1',p.id,s.id
                            FROM phase2_holders h JOIN phase2_operations p ON p.id=$1
                            JOIN phase2_chain_steps s ON s.operation_id=p.id AND s.step='MINT'
                            WHERE h.holder_ref=$3`,
                [job.operation_id, mintHash, job.holder_ref],
            );
            await db.query("COMMIT");
        } catch (error) {
            await db.query("ROLLBACK");
            throw error;
        } finally {
            db.release();
        }
        return "CONFIRMED";
    } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 240) : "Unknown issuance error";
        const db = await pool.connect();
        try {
            await db.query("BEGIN");
            await db.query(
                "UPDATE phase2_holders SET subscription_status='RECONCILIATION_REQUIRED',version=version+1,updated_at=now() WHERE holder_ref=$1",
                [job.holder_ref],
            );
            await db.query(
                "UPDATE outbox_events SET status='RECONCILIATION_REQUIRED',updated_at=now(),payload=payload || $2::jsonb WHERE id=$1",
                [job.id, JSON.stringify({ lastError: reason })],
            );
            await db.query(
                "UPDATE phase2_operations SET status='RECONCILIATION_REQUIRED',response=response || $2::jsonb WHERE id=$1",
                [
                    job.operation_id,
                    JSON.stringify({ status: "RECONCILIATION_REQUIRED", reconciliationReason: reason }),
                ],
            );
            await db.query("COMMIT");
        } catch (dbError) {
            await db.query("ROLLBACK");
            throw dbError;
        } finally {
            db.release();
        }
        return "RECONCILIATION_REQUIRED";
    }
}

async function recordReceipt(
    pool: Pool,
    waitForReceipt: (
        hash: Hex,
        confirmations: number,
    ) => Promise<{ status: string; blockNumber: bigint; blockHash: Hex }>,
    getReceipt: (hash: Hex) => Promise<{ status: string; blockNumber: bigint; blockHash: Hex }>,
    getBlock: (blockNumber: bigint) => Promise<{ hash: Hex | null }>,
    job: { operation_id: string },
    step: "ELIGIBILITY" | "ALLOCATION" | "MINT",
    chainId: number,
    address: `0x${string}`,
    hash: Hex,
) {
    const waited = await waitForReceipt(hash, chainId === 84532 ? 3 : 1);
    if (waited.status !== "success") throw new Error(`${step} transaction reverted`);
    let receipt: Awaited<ReturnType<typeof getReceipt>> | null = null;
    for (let attempt = 0; attempt < 12; attempt++) {
        const current = await getReceipt(hash);
        const block = await getBlock(current.blockNumber);
        if (
            current.status === "success" &&
            current.blockNumber === waited.blockNumber &&
            current.blockHash !== `0x${"0".repeat(64)}` &&
            current.blockHash === block.hash
        ) {
            receipt = current;
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!receipt) throw new Error(`${step} receipt has no canonical block hash`);
    await pool.query(
        `INSERT INTO phase2_chain_steps (operation_id,step,chain_id,contract_address,tx_hash,block_number,block_hash)
         VALUES ($1,$2,$3,$4,$5,$6::numeric,$7)`,
        [job.operation_id, step, chainId, address, hash, receipt.blockNumber.toString(), receipt.blockHash],
    );
}

export async function processOneRevocation(
    pool: Pool,
    config: StartupConfig,
    settings: WorkerSettings,
): Promise<"IDLE" | "CONFIRMED" | "RECONCILIATION_REQUIRED"> {
    const db = await pool.connect();
    let job: {
        id: string;
        operation_id: string;
        holder_ref: HolderRef;
        wallet_address: string | null;
    } | null = null;
    try {
        await db.query("BEGIN");
        const result = await db.query<{
            id: string;
            operation_id: string;
            holder_ref: HolderRef;
            wallet_address: string | null;
        }>(
            `SELECT o.id,o.operation_id,h.holder_ref,h.wallet_address FROM outbox_events o
             JOIN phase2_operations p ON p.id=o.operation_id
             JOIN phase2_holders h ON h.holder_ref=split_part(p.action, ':', 2)
             WHERE o.event_type='SIMULATED_ELIGIBILITY_REVOKED'
               AND (o.status='PENDING' OR (o.status='PROCESSING' AND o.updated_at < now()-interval '5 minutes'))
             ORDER BY o.created_at LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,
        );
        job = result.rows[0] ?? null;
        if (job)
            await db.query(
                "UPDATE outbox_events SET status='PROCESSING',attempts=attempts+1,updated_at=now() WHERE id=$1",
                [job.id],
            );
        await db.query("COMMIT");
    } catch (error) {
        await db.query("ROLLBACK");
        throw error;
    } finally {
        db.release();
    }
    if (!job) return "IDLE";
    try {
        if (job.wallet_address) {
            const chain = config.CHAIN_ID === 84532 ? baseSepolia : foundry;
            const client = createPublicClient({ chain, transport: http(settings.rpcUrl) });
            if ((await client.getChainId()) !== config.CHAIN_ID)
                throw new Error("RPC chain ID mismatch during revocation");
            const address = getAddress(settings.tokenAddress);
            const code = await client.getCode({ address });
            if (!code || (settings.codeHash && keccak256(code) !== settings.codeHash))
                throw new Error("Token bytecode is missing or changed during revocation");
            const walletAddress = getAddress(job.wallet_address);
            const record = await client.readContract({
                address,
                abi,
                functionName: "eligibility",
                args: [walletAddress],
            });
            if (record[3]) {
                const account = privateKeyToAccount(settings.privateKey);
                const role = await client.readContract({ address, abi, functionName: "COMPLIANCE_ROLE" });
                if (
                    !(await client.readContract({
                        address,
                        abi,
                        functionName: "hasRole",
                        args: [role, account.address],
                    }))
                )
                    throw new Error("Revocation signer lacks COMPLIANCE_ROLE");
                const wallet = createWalletClient({ account, chain, transport: http(settings.rpcUrl) });
                const decision = decisionHash(job.operation_id);
                const tx = await wallet.writeContract({
                    address,
                    abi,
                    functionName: "revokeEligibility",
                    args: [walletAddress, decision],
                });
                await recordReceipt(
                    pool,
                    (txHash, confirmations) =>
                        client.waitForTransactionReceipt({ hash: txHash, confirmations }),
                    (txHash) => client.getTransactionReceipt({ hash: txHash }),
                    (blockNumber) => client.getBlock({ blockNumber }),
                    job,
                    "ELIGIBILITY",
                    config.CHAIN_ID,
                    address,
                    tx,
                );
            }
            const current = await client.readContract({
                address,
                abi,
                functionName: "eligibility",
                args: [walletAddress],
            });
            if (current[3]) throw new Error("Wallet remains active after revocation");
        }
        await pool.query("UPDATE outbox_events SET status='DELIVERED',updated_at=now() WHERE id=$1", [
            job.id,
        ]);
        await pool.query(
            "UPDATE phase2_operations SET status='CONFIRMED',response=response || '{\"status\":\"CONFIRMED\"}'::jsonb WHERE id=$1",
            [job.operation_id],
        );
        return "CONFIRMED";
    } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 240) : "Unknown revocation error";
        await pool.query(
            "UPDATE outbox_events SET status='RECONCILIATION_REQUIRED',updated_at=now(),payload=payload || $2::jsonb WHERE id=$1",
            [job.id, JSON.stringify({ lastError: reason })],
        );
        await pool.query(
            "UPDATE phase2_operations SET status='RECONCILIATION_REQUIRED',response=response || $2::jsonb WHERE id=$1",
            [
                job.operation_id,
                JSON.stringify({ status: "RECONCILIATION_REQUIRED", reconciliationReason: reason }),
            ],
        );
        return "RECONCILIATION_REQUIRED";
    }
}

export async function recheckRecordedIssuances(
    pool: Pool,
    config: StartupConfig,
    settings: Pick<WorkerSettings, "rpcUrl" | "tokenAddress" | "codeHash">,
): Promise<number> {
    const chain = config.CHAIN_ID === 84532 ? baseSepolia : foundry;
    const client = createPublicClient({ chain, transport: http(settings.rpcUrl) });
    if ((await client.getChainId()) !== config.CHAIN_ID)
        throw new Error("RPC chain ID mismatch during reconciliation");
    const address = getAddress(settings.tokenAddress);
    const code = await client.getCode({ address });
    const codeValid = Boolean(code && (!settings.codeHash || keccak256(code) === settings.codeHash));
    const recorded = await pool.query<{
        holder_ref: HolderRef;
        wallet_address: string;
        recorded_units: number;
        issuance_tx_hash: Hex;
        operation_id: string;
        chain_step_id: string;
        block_hash: Hex;
        paid_units: string;
    }>(
        `SELECT h.holder_ref,h.wallet_address,h.recorded_units,h.issuance_tx_hash,p.id AS operation_id,s.id AS chain_step_id,s.block_hash,
                COALESCE(b.paid_units,0)::text AS paid_units
         FROM phase2_holders h JOIN phase2_operations p ON p.action='ISSUE:' || h.holder_ref
         JOIN phase2_chain_steps s ON s.operation_id=p.id AND s.step='MINT'
         LEFT JOIN LATERAL (
             SELECT SUM(a.accepted_units) FILTER (WHERE r.id IS NOT NULL) AS paid_units
             FROM phase4_allocations a
             LEFT JOIN phase4_receipts r ON r.allocation_id=a.id WHERE a.holder_id=h.id
         ) b ON true
         WHERE h.subscription_status='RECORDED'`,
    );
    let mismatches = 0;
    for (const holder of recorded.rows) {
        let issue: string | null = codeValid ? null : "Token bytecode is missing or changed";
        try {
            if (!issue) {
                let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>> | null = null;
                for (let attempt = 0; attempt < 12; attempt++) {
                    const current = await client.getTransactionReceipt({ hash: holder.issuance_tx_hash });
                    const block = await client.getBlock({ blockNumber: current.blockNumber });
                    if (current.blockHash !== `0x${"0".repeat(64)}` && current.blockHash === block.hash) {
                        receipt = current;
                        break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }
                if (!receipt) throw new Error("Mint receipt has no canonical block hash");
                const currentBlock = await client.getBlockNumber();
                const balance = await client.readContract({
                    address,
                    abi,
                    functionName: "balanceOf",
                    args: [getAddress(holder.wallet_address)],
                    blockNumber: currentBlock,
                });
                const pending = await pool.query<{
                    vault_address: string;
                    leaf_index: number;
                    accepted_units: number;
                }>(
                    `SELECT c.vault_address,a.leaf_index,a.accepted_units
                     FROM phase4_allocations a JOIN phase4_cases c ON c.id=a.case_id
                     JOIN phase2_holders h ON h.id=a.holder_id
                     LEFT JOIN phase4_receipts r ON r.allocation_id=a.id
                     WHERE h.holder_ref=$1 AND r.id IS NULL AND c.vault_address IS NOT NULL`,
                    [holder.holder_ref],
                );
                let settledButUnrecorded = 0n;
                for (const allocation of pending.rows) {
                    if (
                        await client.readContract({
                            address: getAddress(allocation.vault_address),
                            abi: settlementVaultAbi,
                            functionName: "settled",
                            args: [BigInt(allocation.leaf_index)],
                            blockNumber: currentBlock,
                        })
                    )
                        settledButUnrecorded += BigInt(allocation.accepted_units);
                }
                const expected = BigInt(holder.recorded_units) - BigInt(holder.paid_units);
                if (
                    receipt.status !== "success" ||
                    receipt.blockHash !== holder.block_hash ||
                    currentBlock - receipt.blockNumber < BigInt(config.CHAIN_ID === 84532 ? 2 : 0) ||
                    // settle() pays and burns atomically, so the balance is exact, never a range.
                    balance !== expected - settledButUnrecorded
                )
                    issue = "Mint receipt or holder balance changed after recording";
            }
        } catch {
            issue = "Mint receipt or token balance is unavailable";
        }
        if (!issue) continue;
        const db = await pool.connect();
        try {
            await db.query("BEGIN");
            const updated = await db.query<{ id: string }>(
                `UPDATE phase2_holders SET subscription_status='RECONCILIATION_REQUIRED',version=version+1,updated_at=now()
                 WHERE holder_ref=$1 AND subscription_status='RECORDED' RETURNING id`,
                [holder.holder_ref],
            );
            if (updated.rows[0]) {
                await db.query(
                    "UPDATE phase2_operations SET status='RECONCILIATION_REQUIRED',response=response || $2::jsonb WHERE id=$1",
                    [
                        holder.operation_id,
                        JSON.stringify({ status: "RECONCILIATION_REQUIRED", reconciliationReason: issue }),
                    ],
                );
                await db.query(
                    "UPDATE outbox_events SET status='RECONCILIATION_REQUIRED',updated_at=now(),payload=payload || $2::jsonb WHERE operation_id=$1 AND event_type='DEMO_ISSUANCE_REQUESTED'",
                    [holder.operation_id, JSON.stringify({ lastError: issue })],
                );
                await db.query(
                    `INSERT INTO audit_events (actor_ref,actor_role,action,resource_type,resource_id,source_version,after_hash,reason,request_id,policy_version,chain_command_id,chain_event_id)
                                VALUES ('synthetic:issuance-worker','REGISTRY_AGENT','CHAIN_RECONCILIATION_REQUIRED','phase2',$1,'phase2-v1',$2,$3,$4,'restricted-issuance-v1',$4,$5)`,
                    [
                        updated.rows[0].id,
                        holder.issuance_tx_hash.slice(2),
                        issue,
                        holder.operation_id,
                        holder.chain_step_id,
                    ],
                );
                mismatches++;
            }
            await db.query("COMMIT");
        } catch (error) {
            await db.query("ROLLBACK");
            throw error;
        } finally {
            db.release();
        }
    }
    return mismatches;
}
