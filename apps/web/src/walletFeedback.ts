export function walletErrorMessage(cause: unknown, fallback: string): string {
    const code =
        cause && typeof cause === "object" && "code" in cause
            ? Number((cause as { code: unknown }).code)
            : null;
    if (code === 4001)
        return "Wallet request declined. No transaction or signature was submitted. Review the step and try again.";
    if (code === -32002)
        return "A wallet request is already open. Complete or dismiss it in your wallet before retrying.";
    if (code === 4900 || code === 4901)
        return "Wallet disconnected from the demo network. Reconnect it before retrying.";
    return cause instanceof Error ? cause.message : fallback;
}
