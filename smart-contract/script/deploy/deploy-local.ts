import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    createPublicClient,
    createWalletClient,
    formatUnits,
    getAddress,
    http,
    keccak256,
    parseAbi,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const tokenAbi = parseAbi([
    "function grantRole(bytes32,address)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function COMPLIANCE_ROLE() view returns (bytes32)",
    "function ISSUER_AGENT_ROLE() view returns (bytes32)",
    "function PAUSER_ROLE() view returns (bytes32)",
    "function RECOVERY_ROLE() view returns (bytes32)",
    "function MAX_SUPPLY() view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function deploymentChainId() view returns (uint256)",
]);
const assetAbi = parseAbi([
    "function mint(address,uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
]);

function key(name: string): Hex {
    const value = process.env[name];
    if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} must be a local test key`);
    return value as Hex;
}

async function main() {
    const rpc = process.env.CHAIN_RPC_URL;
    if (!rpc) throw new Error("CHAIN_RPC_URL is required");
    const url = new URL(rpc);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname))
        throw new Error("Local deployment requires a loopback HTTP RPC");
    const settlement = privateKeyToAccount(key("SETTLEMENT_PRIVATE_KEY"));
    const issuance = privateKeyToAccount(key("ISSUANCE_PRIVATE_KEY"));
    const distribution = privateKeyToAccount(key("DISTRIBUTION_PRIVATE_KEY"));
    const transport = http(url.toString());
    const client = createPublicClient({ chain: foundry, transport });
    if ((await client.getChainId()) !== 31337) throw new Error("Local deployment requires chain 31337");
    const wallet = createWalletClient({ account: settlement, chain: foundry, transport });
    const deploy = async (contract: string, args: readonly unknown[]) => {
        const artifact = JSON.parse(
            readFileSync(
                fileURLToPath(new URL(`../../out/${contract}.sol/${contract}.json`, import.meta.url)),
                "utf8",
            ),
        ) as { abi: unknown[]; bytecode: { object: Hex } };
        if (!artifact.bytecode.object || artifact.bytecode.object === "0x")
            throw new Error(`${contract} artifact has no bytecode; run forge build first`);
        const tx = await wallet.deployContract({
            abi: artifact.abi,
            bytecode: artifact.bytecode.object,
            args,
        });
        const receipt = await client.waitForTransactionReceipt({ hash: tx });
        if (receipt.status !== "success" || !receipt.contractAddress)
            throw new Error(`${contract} deployment failed`);
        return getAddress(receipt.contractAddress);
    };
    const token = await deploy("TepaToken", [settlement.address, 31337n]);
    for (const [roleName, account] of [
        ["COMPLIANCE_ROLE", issuance.address],
        ["ISSUER_AGENT_ROLE", issuance.address],
        ["PAUSER_ROLE", settlement.address],
        ["RECOVERY_ROLE", settlement.address],
    ] as const) {
        const role = await client.readContract({ address: token, abi: tokenAbi, functionName: roleName });
        const tx = await wallet.writeContract({
            address: token,
            abi: tokenAbi,
            functionName: "grantRole",
            args: [role, account],
        });
        if ((await client.waitForTransactionReceipt({ hash: tx })).status !== "success")
            throw new Error(`${roleName} grant failed`);
        if (
            !(await client.readContract({
                address: token,
                abi: tokenAbi,
                functionName: "hasRole",
                args: [role, account],
            }))
        )
            throw new Error(`${roleName} grant did not take effect`);
    }
    if (
        (await client.readContract({ address: token, abi: tokenAbi, functionName: "MAX_SUPPLY" })) !==
            1_000n ||
        (await client.readContract({ address: token, abi: tokenAbi, functionName: "decimals" })) !== 0 ||
        (await client.readContract({ address: token, abi: tokenAbi, functionName: "deploymentChainId" })) !==
            31337n
    )
        throw new Error("Token configuration mismatch");
    const asset = await deploy("TestUsdc", []);
    for (const [recipient, amount] of [
        [distribution.address, 1_020_000_000n],
        [settlement.address, 130_000_000_000n],
    ] as const) {
        const tx = await wallet.writeContract({
            address: asset,
            abi: assetAbi,
            functionName: "mint",
            args: [recipient, amount],
        });
        if ((await client.waitForTransactionReceipt({ hash: tx })).status !== "success")
            throw new Error("Mock asset mint failed");
    }
    const distributionBalance = await client.readContract({
        address: asset,
        abi: assetAbi,
        functionName: "balanceOf",
        args: [distribution.address],
    });
    if (
        (await client.readContract({ address: asset, abi: assetAbi, functionName: "symbol" })) !== "USDC" ||
        (await client.readContract({ address: asset, abi: assetAbi, functionName: "decimals" })) !== 6 ||
        distributionBalance < 1_020_000_000n ||
        (await client.readContract({
            address: asset,
            abi: assetAbi,
            functionName: "balanceOf",
            args: [settlement.address],
        })) < 130_000_000_000n
    )
        throw new Error("Mock asset balance mismatch");
    const tokenCode = await client.getCode({ address: token });
    const assetCode = await client.getCode({ address: asset });
    if (!tokenCode || !assetCode) throw new Error("Deployed bytecode unavailable");
    const deployed = {
        TEPA_TOKEN_ADDRESS: token,
        TEPA_TOKEN_CODE_HASH: keccak256(tokenCode),
        TEST_USDC_ADDRESS: asset,
        TEST_USDC_CODE_HASH: keccak256(assetCode),
    };
    for (const [name, value] of Object.entries(deployed)) console.log(`${name}=${value}`);
    console.log(`DISTRIBUTION_SIGNER_ADDRESS=${distribution.address}`);
    console.log(`DISTRIBUTION_SIGNER_TEST_USDC_BALANCE=${formatUnits(distributionBalance, 6)}`);
    const exported = Object.entries(deployed).map(([name, value]) => ({
        value,
        configured: process.env[name],
    }));
    const configStatus = exported.every(({ configured }) => !configured)
        ? "unset"
        : exported.some(({ configured }) => !configured)
          ? "incomplete"
          : exported.every(({ value, configured }) => value.toLowerCase() === configured!.toLowerCase())
            ? "match"
            : "mismatch";
    console.log(`EXPORTED_CONTRACT_CONFIG=${configStatus}`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
