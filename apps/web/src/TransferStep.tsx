import { useState } from "react";
import type { Phase2 } from "./api.js";
import { checkDirectTransferRestriction, type TransferCheckResult } from "./transferCheck.js";

export function TransferStep({
    phase2,
    check = checkDirectTransferRestriction,
}: {
    phase2: Phase2 | null;
    check?: typeof checkDirectTransferRestriction;
}) {
    const [result, setResult] = useState<TransferCheckResult | null>(null);
    const [checking, setChecking] = useState(false);
    const holderA = phase2?.holders.find((holder) => holder.holderRef === "synthetic-holder-a");
    const holderB = phase2?.holders.find((holder) => holder.holderRef === "synthetic-holder-b");
    async function run() {
        setChecking(true);
        setResult(null);
        try {
            setResult(
                await check({
                    provider: window.ethereum,
                    chainId: phase2?.chainId ?? 0,
                    tokenAddress: phase2?.tokenAddress ?? null,
                    walletAddress: holderA?.walletAddress ?? "",
                    peerAddress: holderB?.walletAddress ?? phase2?.demoPeerWallet ?? null,
                }),
            );
        } catch (cause) {
            setResult({
                status: "error",
                message: cause instanceof Error ? cause.message : "Transfer check failed.",
            });
        } finally {
            setChecking(false);
        }
    }
    return (
        <section className="transfer-step" aria-labelledby="transfer-step-title">
            <h2 id="transfer-step-title">Holder A to holder B</h2>
            <p>
                This read-only contract call creates no transaction or chain event. Select holder A's bound
                wallet.
            </p>
            <button
                type="button"
                disabled={
                    checking || !holderA?.walletAddress || !(holderB?.walletAddress ?? phase2?.demoPeerWallet)
                }
                onClick={() => void run()}
            >
                {checking ? "Checking transfer…" : "Check direct transfer rejection"}
            </button>
            {!holderA?.walletAddress && (
                <p>Issue and bind holder A's wallet before checking the restriction.</p>
            )}
            {result && <TransferResult result={result} />}
        </section>
    );
}

export function TransferResult({ result }: { result: TransferCheckResult }) {
    return (
        <div
            className={
                result.status === "success" ? "transfer-result transfer-result-success" : "transfer-result"
            }
            role={result.status === "success" ? "status" : "alert"}
        >
            <strong>
                {result.status === "success"
                    ? "RestrictedTransfer"
                    : "Check could not confirm the restriction"}
            </strong>
            <p>{result.message}</p>
        </div>
    );
}
