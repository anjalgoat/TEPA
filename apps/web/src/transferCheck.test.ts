import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";
import { checkDirectTransferRestriction, type EthereumProvider } from "./transferCheck.js";

const walletAddress = "0x19e5ff32E9B32496D2da42cb3EC67720FD3E6F66";
const peerAddress = "0x8EDd7a5E40aa6eFBf9fB19B2b3Cf6e1557E5Ff03";
const tokenAddress = "0xD4685cF0aeC08A86C5aB9Dc86cd177FC4775B663";

function input(provider: EthereumProvider | undefined) {
    return { provider, chainId: 84532, tokenAddress, walletAddress, peerAddress };
}

function providerWithCall(call: () => Promise<unknown>): EthereumProvider {
    return {
        async request({ method }) {
            if (method === "eth_requestAccounts") return [walletAddress];
            if (method === "eth_chainId") return "0x14a34";
            if (method === "eth_call") return call();
            throw new Error("Unexpected wallet method");
        },
    };
}

describe("direct transfer restriction check", () => {
    it("recognizes RestrictedTransfer data nested in a wallet RPC error", async () => {
        const selector = toFunctionSelector("RestrictedTransfer()");
        const result = await checkDirectTransferRestriction(
            input(
                providerWithCall(async () => {
                    throw {
                        code: -32603,
                        message: "Internal JSON-RPC error",
                        data: { originalError: { data: selector } },
                    };
                }),
            ),
        );
        expect(result.status).toBe("success");
        expect(result.message).toContain("RestrictedTransfer");
    });

    it("stops when the connected account differs from the bound holder", async () => {
        let calledContract = false;
        const provider: EthereumProvider = {
            async request({ method }) {
                if (method === "eth_requestAccounts") return [peerAddress];
                if (method === "eth_call") calledContract = true;
                return null;
            },
        };
        const result = await checkDirectTransferRestriction(input(provider));
        expect(result.status).toBe("error");
        expect(result.message).toContain("bound wallet account");
        expect(calledContract).toBe(false);
    });

    it("reports wrong network before the contract call", async () => {
        const provider: EthereumProvider = {
            async request({ method }) {
                if (method === "eth_requestAccounts") return [walletAddress];
                if (method === "eth_chainId") return "0x1";
                throw new Error("Contract call should not run");
            },
        };
        const result = await checkDirectTransferRestriction(input(provider));
        expect(result.status).toBe("error");
        expect(result.message).toContain("Base Sepolia");
    });

    it("names local Anvil for the presentation chain", async () => {
        const provider: EthereumProvider = {
            async request({ method }) {
                if (method === "eth_requestAccounts") return [walletAddress];
                if (method === "eth_chainId") return "0x1";
                throw new Error("Contract call should not run");
            },
        };
        const result = await checkDirectTransferRestriction({ ...input(provider), chainId: 31337 });
        expect(result.message).toContain("Local Anvil (chain 31337)");
    });

    it("does not treat an unknown RPC failure as contract rejection or expose its URL", async () => {
        const result = await checkDirectTransferRestriction(
            input(
                providerWithCall(async () => {
                    throw { code: -32603, message: "https://provider.example/secret-key failed" };
                }),
            ),
        );
        expect(result.status).toBe("error");
        expect(result.message).toContain("RPC code -32603");
        expect(result.message).not.toContain("secret-key");
    });

    it("reports an undecoded revert without claiming RestrictedTransfer", async () => {
        const result = await checkDirectTransferRestriction(
            input(
                providerWithCall(async () => {
                    throw { code: -32603, message: "execution reverted" };
                }),
            ),
        );
        expect(result.status).toBe("error");
        expect(result.message).toContain("Rejection was observed");
        expect(result.message).not.toContain("RestrictedTransfer");
    });

    it("flags a call that unexpectedly succeeds", async () => {
        const result = await checkDirectTransferRestriction(input(providerWithCall(async () => "0x")));
        expect(result.status).toBe("error");
        expect(result.message).toContain("unexpectedly accepted");
    });

    it("explains when the browser has no wallet", async () => {
        const result = await checkDirectTransferRestriction(input(undefined));
        expect(result.status).toBe("error");
        expect(result.message).toContain("Ethereum wallet");
    });
});
