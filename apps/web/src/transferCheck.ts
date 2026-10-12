import { encodeFunctionData, isAddress, parseAbi, toFunctionSelector } from "viem";

export type EthereumProvider = {
    request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

type CheckInput = {
    provider: EthereumProvider | undefined;
    chainId: number;
    tokenAddress: string | null;
    walletAddress: string;
    peerAddress: string | null;
};

export type TransferCheckResult = {
    status: "success" | "error";
    message: string;
};

const transferAbi = parseAbi(["function transfer(address,uint256) returns (bool)"]);
const restrictedTransferSelector = toFunctionSelector("RestrictedTransfer()").toLowerCase();

function errorCode(cause: unknown): number | null {
    if (!cause || typeof cause !== "object" || !("code" in cause)) return null;
    const code = cause.code;
    return typeof code === "number" && Number.isInteger(code) ? code : null;
}

function classifyRevert(cause: unknown): "restricted" | "undecoded" | null {
    const seen = new Set<object>();
    let undecoded = false;
    function visit(value: unknown, depth: number): boolean {
        if (depth > 5) return false;
        if (typeof value === "string") {
            if (
                value.includes("RestrictedTransfer") ||
                value.toLowerCase().startsWith(restrictedTransferSelector)
            )
                return true;
            if (/execution reverted|\bcall reverted\b|\bcontract reverted\b/i.test(value)) undecoded = true;
            return false;
        }
        if (!value || typeof value !== "object" || seen.has(value)) return false;
        seen.add(value);
        const record = value as Record<string, unknown>;
        return ["data", "cause", "error", "originalError", "message", "details", "shortMessage"].some((key) =>
            visit(record[key], depth + 1),
        );
    }
    return visit(cause, 0) ? "restricted" : undecoded ? "undecoded" : null;
}

function walletError(cause: unknown, step: "connection" | "network" | "call"): TransferCheckResult {
    const code = errorCode(cause);
    if (code === 4001)
        return { status: "error", message: "Wallet request declined. Approve it to run the check." };
    if (code === -32002)
        return {
            status: "error",
            message: "A wallet request is already open. Complete it in your wallet, then retry.",
        };
    if (code === 4900 || code === 4901)
        return {
            status: "error",
            message: "Wallet disconnected from the configured chain. Reconnect it, then retry.",
        };
    const label = step === "call" ? "read-only contract call" : `wallet ${step}`;
    return {
        status: "error",
        message: `The ${label} failed${code === null ? "" : ` (RPC code ${code})`}. Check your wallet connection and Base Sepolia RPC, then retry.`,
    };
}

export async function checkDirectTransferRestriction({
    provider,
    chainId,
    tokenAddress,
    walletAddress,
    peerAddress,
}: CheckInput): Promise<TransferCheckResult> {
    if (!provider)
        return {
            status: "error",
            message: "Open this page in a browser with an Ethereum wallet to run this check.",
        };
    if (
        !tokenAddress ||
        !isAddress(tokenAddress) ||
        !isAddress(walletAddress) ||
        !peerAddress ||
        !isAddress(peerAddress)
    )
        return {
            status: "error",
            message: "The demo token or both holder wallets are not configured for this check.",
        };

    let accounts: unknown;
    try {
        accounts = await provider.request({ method: "eth_requestAccounts" });
    } catch (cause) {
        return walletError(cause, "connection");
    }
    if (
        !Array.isArray(accounts) ||
        !accounts.some(
            (account) => typeof account === "string" && account.toLowerCase() === walletAddress.toLowerCase(),
        )
    )
        return {
            status: "error",
            message: "Select this holder's bound wallet account and run the check again.",
        };

    let currentChain: unknown;
    try {
        currentChain = await provider.request({ method: "eth_chainId" });
    } catch (cause) {
        return walletError(cause, "network");
    }
    if (typeof currentChain !== "string" || Number.parseInt(currentChain, 16) !== chainId)
        return {
            status: "error",
            message: `Switch your wallet to ${chainId === 31337 ? "Local Anvil" : chainId === 84532 ? "Base Sepolia" : `chain ${chainId}`} (chain ${chainId}) and try again.`,
        };

    const data = encodeFunctionData({
        abi: transferAbi,
        functionName: "transfer",
        args: [peerAddress as `0x${string}`, 1n],
    });
    try {
        await provider.request({
            method: "eth_call",
            params: [{ from: walletAddress, to: tokenAddress, data }, "latest"],
        });
    } catch (cause) {
        const revert = classifyRevert(cause);
        if (revert === "restricted")
            return {
                status: "success",
                message:
                    "Direct transfer rejected by the token contract (RestrictedTransfer). This read-only check creates no transaction or chain event.",
            };
        if (revert === "undecoded")
            return {
                status: "error",
                message:
                    "The transfer call reverted, but the wallet did not provide the contract error. Rejection was observed; its cause could not be confirmed in this browser.",
            };
        return walletError(cause, "call");
    }
    return {
        status: "error",
        message:
            "The contract unexpectedly accepted the direct transfer check. Stop issuance and investigate.",
    };
}
