import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import {
    createPublicClient,
    createWalletClient,
    getAddress,
    http,
    keccak256,
    parseAbi,
    stringToHex,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { StartupConfig } from "../../config.js";
import { chain, rpcUrl } from "../distributions/service.js";
import { settlementHash } from "./service.js";

const BASE_SEPOLIA_TEST_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const assetAbi = parseAbi([
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
]);
const tokenAbi = parseAbi([
    "function BUYBACK_ROLE() view returns (bytes32)",
    "function SETTLEMENT_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function grantRole(bytes32,address)",
    "function totalSupply() view returns (uint256)",
    "function terminalSettlement() view returns (bool)",
]);
const vaultAbi = parseAbi([
    "function asset() view returns (address)",
    "function participationToken() view returns (address)",
    "function settlementId() view returns (bytes32)",
    "function entitlementRoot() view returns (bytes32)",
    "function committedAmount() view returns (uint256)",
    "function committedUnits() view returns (uint256)",
    "function operator() view returns (address)",
    "function deploymentChainId() view returns (uint256)",
    "function acquisition() view returns (bool)",
    "function fundedAmount() view returns (uint256)",
    "function paidAmount() view returns (uint256)",
    "function burnedUnits() view returns (uint256)",
    "function open() view returns (bool)",
    "function finalized() view returns (bool)",
    "function fund(uint256)",
    "function openSettlement()",
    "function finalize()",
]);
type Job = {
    id: string;
    operation_id: string;
    event_type: "SETTLEMENT_FUND_REQUESTED" | "SETTLEMENT_FINALIZE_REQUESTED";
    case_id: string;
    kind: "BUYBACK" | "ACQUISITION";
    state: string;
    entitlement_root: Hex;
    committed_units: number;
    committed_usd_minor: string;
    record_block: string;
    record_block_hash: Hex;
    vault_address: `0x${string}` | null;
};
export type SettlementWorkerSettings = { privateKey: Hex; assetAddress: `0x${string}`; assetCodeHash?: Hex };

async function acquire(pool: Pool): Promise<Job | null> {
    const db = await pool.connect();
    try {
        await db.query("BEGIN");
        const result = await db.query<Job>(
            `SELECT o.id,o.operation_id,o.event_type,(o.payload->>'resourceId') AS case_id,
             c.kind,c.state,c.entitlement_root,c.committed_units,c.committed_usd_minor::text,
             c.record_block::text,c.record_block_hash,c.vault_address
             FROM outbox_events o JOIN phase4_cases c ON c.id=(o.payload->>'resourceId')::uuid
             WHERE o.status='PENDING' AND o.event_type IN ('SETTLEMENT_FUND_REQUESTED','SETTLEMENT_FINALIZE_REQUESTED')
             ORDER BY o.created_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1`,
        );
        const job = result.rows[0] ?? null;
        if (job)
            await db.query(
                "UPDATE outbox_events SET status='PROCESSING',attempts=attempts+1,updated_at=now() WHERE id=$1",
                [job.id],
            );
        await db.query("COMMIT");
        return job;
    } catch (error) {
        await db.query("ROLLBACK");
        throw error;
    } finally {
        db.release();
    }
}

export async function processOneSettlement(
    pool: Pool,
    config: StartupConfig,
    settings: SettlementWorkerSettings,
): Promise<"IDLE" | "CONFIRMED" | "RECONCILIATION_REQUIRED"> {
    const job = await acquire(pool);
    if (!job) return "IDLE";
    let vault = job.vault_address;
    try {
        if (!config.TEPA_TOKEN_ADDRESS) throw new Error("TEPA_TOKEN_ADDRESS is required");
        if (config.APP_ENV === "demo" && !settings.assetCodeHash)
            throw new Error("Demo asset code hash is required");
        const account = privateKeyToAccount(settings.privateKey);
        const publicClient = createPublicClient({ chain: chain(config), transport: http(rpcUrl(config)) });
        const walletClient = createWalletClient({
            account,
            chain: chain(config),
            transport: http(rpcUrl(config)),
        });
        if ((await publicClient.getChainId()) !== config.CHAIN_ID) throw new Error("Wrong RPC chain");
        const asset = getAddress(settings.assetAddress);
        const token = getAddress(config.TEPA_TOKEN_ADDRESS);
        if (config.APP_ENV === "demo" && asset !== getAddress(BASE_SEPOLIA_TEST_USDC))
            throw new Error("Demo must use Circle's Base Sepolia test USDC address");
        const [assetCode, tokenCode] = await Promise.all([
            publicClient.getCode({ address: asset }),
            publicClient.getCode({ address: token }),
        ]);
        if (!assetCode || assetCode === "0x" || !tokenCode || tokenCode === "0x")
            throw new Error("Configured contract code missing");
        if (
            settings.assetCodeHash &&
            keccak256(assetCode).toLowerCase() !== settings.assetCodeHash.toLowerCase()
        )
            throw new Error("Test USDC bytecode hash mismatch");
        if (
            config.TEPA_TOKEN_CODE_HASH &&
            keccak256(tokenCode).toLowerCase() !== config.TEPA_TOKEN_CODE_HASH.toLowerCase()
        )
            throw new Error("Token bytecode hash mismatch");
        if (config.APP_ENV === "demo" && !config.TEPA_TOKEN_CODE_HASH)
            throw new Error("Demo token code hash is required");
        const [decimals, symbol] = await Promise.all([
            publicClient.readContract({ address: asset, abi: assetAbi, functionName: "decimals" }),
            publicClient.readContract({ address: asset, abi: assetAbi, functionName: "symbol" }),
        ]);
        if (decimals !== 6 || symbol !== "USDC") throw new Error("Asset is not six-decimal test USDC");
        const recordBlock = await publicClient.getBlock({ blockNumber: BigInt(job.record_block) });
        if (recordBlock.hash !== job.record_block_hash) throw new Error("Settlement record block reorged");
        const amount = BigInt(job.committed_usd_minor) * 10_000n;
        const units = BigInt(job.committed_units);
        const confirmations = config.CHAIN_ID === 84532 ? 3 : 1;
        const wait = async (
            hash: Hex,
            step: "VAULT_DEPLOY" | "ROLE_GRANT" | "FUND" | "OPEN" | "FINALIZE",
            address: `0x${string}`,
        ) => {
            const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations });
            if (receipt.status !== "success") throw new Error(`${step} transaction reverted`);
            const canonical = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
            if (canonical.hash !== receipt.blockHash) throw new Error(`${step} transaction reorged`);
            const recordedAddress = step === "VAULT_DEPLOY" ? receipt.contractAddress : address;
            if (!recordedAddress) throw new Error("Vault deployment had no address");
            await pool.query(
                `INSERT INTO phase4_chain_steps(case_id,step,chain_id,contract_address,tx_hash,block_number,block_hash)
                 VALUES($1,$2,$3,$4,$5,$6::numeric,$7) ON CONFLICT(case_id,step) DO NOTHING`,
                [
                    job.case_id,
                    step,
                    config.CHAIN_ID,
                    recordedAddress,
                    hash,
                    receipt.blockNumber.toString(),
                    receipt.blockHash,
                ],
            );
            const recorded = await pool.query<{
                chain_id: number;
                contract_address: string;
                tx_hash: string;
                block_number: string;
                block_hash: string;
            }>(
                `SELECT chain_id,contract_address,tx_hash,block_number::text,block_hash
                 FROM phase4_chain_steps WHERE case_id=$1 AND step=$2`,
                [job.case_id, step],
            );
            const evidence = recorded.rows[0];
            if (
                !evidence ||
                evidence.chain_id !== config.CHAIN_ID ||
                evidence.contract_address.toLowerCase() !== recordedAddress.toLowerCase() ||
                evidence.tx_hash.toLowerCase() !== hash.toLowerCase() ||
                evidence.block_number !== receipt.blockNumber.toString() ||
                evidence.block_hash.toLowerCase() !== receipt.blockHash.toLowerCase()
            )
                throw new Error(`${step} conflicts with recorded chain evidence`);
            return receipt;
        };
        if (job.event_type === "SETTLEMENT_FUND_REQUESTED") {
            if (!(
                (job.kind === "BUYBACK" && job.state === "ALLOCATED") ||
                (job.kind === "ACQUISITION" && job.state === "SNAPSHOTTED")
            ))
                throw new Error("Case is not ready for funding");
            if (!vault) {
                const artifact = JSON.parse(
                    readFileSync(
                        new URL(
                            "../../../../../smart-contract/out/SettlementVault.sol/SettlementVault.json",
                            import.meta.url,
                        ),
                        "utf8",
                    ),
                ) as { abi: unknown[]; bytecode: { object: Hex } };
                const tx = await walletClient.deployContract({
                    abi: artifact.abi,
                    bytecode: artifact.bytecode.object,
                    args: [
                        asset,
                        token,
                        settlementHash(job.case_id),
                        job.entitlement_root,
                        amount,
                        units,
                        account.address,
                        BigInt(config.CHAIN_ID),
                        job.kind === "ACQUISITION",
                    ],
                });
                const receipt = await wait(tx, "VAULT_DEPLOY", account.address);
                if (!receipt.contractAddress) throw new Error("Vault deployment had no address");
                vault = receipt.contractAddress;
                await pool.query(
                    "UPDATE phase4_cases SET vault_address=$2,updated_at=now() WHERE id=$1 AND vault_address IS NULL",
                    [job.case_id, vault],
                );
            }
            const [
                vaultAsset,
                vaultToken,
                settlementId,
                root,
                committed,
                committedUnits,
                operator,
                chainId,
                acquisition,
            ] = await Promise.all([
                publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "asset" }),
                publicClient.readContract({
                    address: vault,
                    abi: vaultAbi,
                    functionName: "participationToken",
                }),
                publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "settlementId" }),
                publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "entitlementRoot" }),
                publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "committedAmount" }),
                publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "committedUnits" }),
                publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "operator" }),
                publicClient.readContract({
                    address: vault,
                    abi: vaultAbi,
                    functionName: "deploymentChainId",
                }),
                publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "acquisition" }),
            ]);
            if (
                getAddress(vaultAsset) !== asset ||
                getAddress(vaultToken) !== token ||
                settlementId !== settlementHash(job.case_id) ||
                root !== job.entitlement_root ||
                committed !== amount ||
                committedUnits !== units ||
                getAddress(operator) !== account.address ||
                chainId !== BigInt(config.CHAIN_ID) ||
                acquisition !== (job.kind === "ACQUISITION")
            )
                throw new Error("Vault commitment differs from approved case");
            const role = await publicClient.readContract({
                address: token,
                abi: tokenAbi,
                functionName: job.kind === "ACQUISITION" ? "SETTLEMENT_ROLE" : "BUYBACK_ROLE",
            });
            if (
                !(await publicClient.readContract({
                    address: token,
                    abi: tokenAbi,
                    functionName: "hasRole",
                    args: [role, vault],
                }))
            ) {
                const tx = await walletClient.writeContract({
                    address: token,
                    abi: tokenAbi,
                    functionName: "grantRole",
                    args: [role, vault],
                });
                await wait(tx, "ROLE_GRANT", token);
            }
            const funded = await publicClient.readContract({
                address: vault,
                abi: vaultAbi,
                functionName: "fundedAmount",
            });
            if (funded > amount) throw new Error("Vault overfunded");
            if (funded < amount) {
                const remaining = amount - funded;
                const balance = await publicClient.readContract({
                    address: asset,
                    abi: assetAbi,
                    functionName: "balanceOf",
                    args: [account.address],
                });
                if (balance < remaining) throw new Error("Operator has insufficient test USDC");
                const allowance = await publicClient.readContract({
                    address: asset,
                    abi: assetAbi,
                    functionName: "allowance",
                    args: [account.address, vault],
                });
                if (allowance < remaining) {
                    const approval = await walletClient.writeContract({
                        address: asset,
                        abi: assetAbi,
                        functionName: "approve",
                        args: [vault, remaining],
                    });
                    const approvalReceipt = await publicClient.waitForTransactionReceipt({
                        hash: approval,
                        confirmations,
                    });
                    if (approvalReceipt.status !== "success") throw new Error("Asset approval reverted");
                }
                const funding = await walletClient.writeContract({
                    address: vault,
                    abi: vaultAbi,
                    functionName: "fund",
                    args: [remaining],
                });
                await wait(funding, "FUND", vault);
            }
            if (!(await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "open" }))) {
                const opening = await walletClient.writeContract({
                    address: vault,
                    abi: vaultAbi,
                    functionName: "openSettlement",
                });
                await wait(opening, "OPEN", vault);
            }
            if (
                (await publicClient.readContract({
                    address: vault,
                    abi: vaultAbi,
                    functionName: "fundedAmount",
                })) !== amount ||
                !(await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "open" }))
            )
                throw new Error("Vault did not reach funded open state");
            await pool.query(
                `UPDATE phase4_cases SET state=$2,vault_address=$3,
                funding_tx_hash=(SELECT tx_hash FROM phase4_chain_steps WHERE case_id=$1 AND step='FUND'),
                opening_tx_hash=(SELECT tx_hash FROM phase4_chain_steps WHERE case_id=$1 AND step='OPEN'),
                version=version+1,updated_at=now() WHERE id=$1`,
                [job.case_id, job.kind === "BUYBACK" ? "FUNDED" : "CLAIMABLE", vault],
            );
        } else {
            if (!vault) throw new Error("Vault address missing");
            if (!(
                (job.kind === "BUYBACK" && job.state === "SETTLED") ||
                (job.kind === "ACQUISITION" && job.state === "CLAIMABLE")
            ))
                throw new Error("Case is not ready to finalize");
            const [paid, burned, isFinal] = await Promise.all([
                publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "paidAmount" }),
                publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "burnedUnits" }),
                publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "finalized" }),
            ]);
            if (paid !== amount || burned !== units) throw new Error("Chain holder outcomes are incomplete");
            if (!isFinal) {
                const tx = await walletClient.writeContract({
                    address: vault,
                    abi: vaultAbi,
                    functionName: "finalize",
                });
                await wait(tx, "FINALIZE", vault);
            }
            if (
                job.kind === "ACQUISITION" &&
                ((await publicClient.readContract({
                    address: token,
                    abi: tokenAbi,
                    functionName: "totalSupply",
                })) !== 0n ||
                    !(await publicClient.readContract({
                        address: token,
                        abi: tokenAbi,
                        functionName: "terminalSettlement",
                    })))
            )
                throw new Error("Token terminal state or supply mismatch");
            await pool.query(
                `UPDATE phase4_cases SET state=$2,finalization_tx_hash=(SELECT tx_hash FROM phase4_chain_steps
                WHERE case_id=$1 AND step='FINALIZE'),version=version+1,updated_at=now() WHERE id=$1`,
                [job.case_id, job.kind === "BUYBACK" ? "CLOSED" : "FINALIZED"],
            );
        }
        await pool.query(
            "UPDATE phase4_operations SET status='CONFIRMED',response=jsonb_set(response,'{status}','\"CONFIRMED\"') WHERE id=$1",
            [job.operation_id],
        );
        await pool.query("UPDATE outbox_events SET status='DELIVERED',updated_at=now() WHERE id=$1", [
            job.id,
        ]);
        await pool.query(
            `INSERT INTO audit_events(actor_ref,actor_role,action,resource_type,resource_id,source_version,after_hash,reason,request_id,formula_version,policy_version,chain_command_id,chain_event_id)
             SELECT 'synthetic:settlement-worker','DISTRIBUTION_OPERATOR',$1,'settlement',$2,'phase4-v1',s.tx_hash,
                    'Confirmed chain receipt and vault state',$3,'settlement-v1','sample-only-v1',$3,s.id
             FROM phase4_chain_steps s WHERE s.case_id=$2 AND s.step=$4`,
            [
                job.event_type === "SETTLEMENT_FUND_REQUESTED"
                    ? `${job.kind}_FUNDED`
                    : `${job.kind}_FINALIZED`,
                job.case_id,
                job.operation_id,
                job.event_type === "SETTLEMENT_FUND_REQUESTED" ? "FUND" : "FINALIZE",
            ],
        );
        return "CONFIRMED";
    } catch (error) {
        await pool.query(
            `UPDATE phase4_cases SET state='RECONCILIATION_REQUIRED',version=version+1,updated_at=now()
            WHERE id=$1 AND state<>'RECONCILIATION_REQUIRED'`,
            [job.case_id],
        );
        await pool.query(
            "UPDATE phase4_operations SET status='RECONCILIATION_REQUIRED',response=jsonb_set(response,'{status}','\"RECONCILIATION_REQUIRED\"') WHERE id=$1",
            [job.operation_id],
        );
        await pool.query(
            "UPDATE outbox_events SET status='RECONCILIATION_REQUIRED',updated_at=now() WHERE id=$1",
            [job.id],
        );
        await pool.query(
            `INSERT INTO audit_events(actor_ref,actor_role,action,resource_type,resource_id,source_version,after_hash,reason,request_id)
            VALUES('system:settlement-worker','DISTRIBUTION_OPERATOR','SETTLEMENT_RECONCILIATION_REQUIRED','settlement',$1,
                'phase4-v1',$2,$3,$4)`,
            [
                job.case_id,
                keccak256(stringToHex(job.id)),
                error instanceof Error ? error.message.slice(0, 240) : "Settlement worker failed",
                job.id,
            ],
        );
        return "RECONCILIATION_REQUIRED";
    }
}
