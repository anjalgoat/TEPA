import { useEffect, useRef, useState } from "react";
import { isAddress } from "viem";
import { fetchPhase2, mutatePhase2, type DemoRole, type Phase2 } from "./api.js";
import type { EthereumProvider } from "./transferCheck.js";
import { chainName } from "./DemoJourney.js";
import { walletErrorMessage } from "./walletFeedback.js";

type WorkflowStage = "offering" | "eligibility" | "subscription" | "issuance";
type HolderRef = "synthetic-holder-a" | "synthetic-holder-b";

declare global {
    interface Window {
        ethereum?: EthereumProvider;
    }
}

const holderName: Record<"synthetic-holder-a" | "synthetic-holder-b", string> = {
    "synthetic-holder-a": "Fictional holder A",
    "synthetic-holder-b": "Fictional holder B",
};
const reason = "Record this fictional restricted issuance action";

export function EligibilityPanel({
    token,
    role,
    issuerVersion,
    onChange,
    stage,
    selectedHolderRef,
    currentRun,
    sessionForRole,
}: {
    token: string | null;
    role: DemoRole;
    issuerVersion: number | null;
    onChange: () => Promise<void>;
    stage: WorkflowStage;
    selectedHolderRef: HolderRef;
    currentRun: Phase2 | null;
    sessionForRole?: (role: DemoRole) => Promise<string>;
}) {
    const [state, setState] = useState<Phase2 | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [pending, setPending] = useState<string | null>(null);
    const [walletFeedback, setWalletFeedback] = useState<{
        holderRef: string;
        message: string;
        error: boolean;
    } | null>(null);
    const [identity, setIdentity] = useState<"PASS" | "FAIL">("PASS");
    const [sanctions, setSanctions] = useState<"CLEAR" | "HIT">("CLEAR");
    const keys = useRef(new Map<string, string>());
    const versionRef = useRef(0);

    useEffect(() => {
        if (!token) {
            setState(null);
            setLoading(false);
            return;
        }
        let active = true;
        setState(null);
        setError(null);
        setNotice(null);
        setWalletFeedback(null);
        setLoading(true);
        fetchPhase2(token)
            .then((data) => {
                if (active) {
                    versionRef.current = data.issuerVersion;
                    setState(data);
                }
            })
            .catch((cause) => {
                if (active)
                    setError(cause instanceof Error ? cause.message : "Could not load eligibility records.");
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => {
            active = false;
        };
    }, [token, role, issuerVersion]);

    useEffect(() => {
        if (currentRun) {
            versionRef.current = currentRun.issuerVersion;
            setState(currentRun);
        }
    }, [currentRun]);

    async function refresh() {
        if (!token) return;
        const updated = await fetchPhase2(token);
        versionRef.current = updated.issuerVersion;
        setState(updated);
        await onChange();
    }
    async function act(key: string, path: string, body: unknown) {
        if (!token || !state) return null;
        const stableKey = `${key}:${versionRef.current}`;
        const idempotencyKey = keys.current.get(stableKey) ?? crypto.randomUUID();
        keys.current.set(stableKey, idempotencyKey);
        setPending(key);
        setError(null);
        setNotice(null);
        try {
            const actionRole: DemoRole = path.endsWith("/terms/publish")
                ? "ISSUER_PREPARER"
                : path.endsWith("/eligibility") || path.endsWith("/revoke")
                  ? "COMPLIANCE_OPERATOR"
                  : path.endsWith("/allocate") || path.endsWith("/issue")
                    ? "REGISTRY_AGENT"
                    : path.includes("synthetic-holder-b")
                      ? "INVESTOR_B"
                      : "INVESTOR_A";
            const actionToken = sessionForRole ? await sessionForRole(actionRole) : token;
            const result = await mutatePhase2(
                actionToken,
                path,
                body,
                versionRef.current,
                reason,
                idempotencyKey,
            );
            keys.current.delete(stableKey);
            versionRef.current = result.resourceVersion;
            await refresh();
            if (result.status === "PENDING")
                setNotice(
                    "Issuance queued. A chain worker must confirm the transaction before the holder register records units.",
                );
            return result;
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "The action could not be recorded.");
            return null;
        } finally {
            setPending(null);
        }
    }
    async function connectAndBind(holderRef: string) {
        const sessionToken = sessionForRole
            ? await sessionForRole(holderRef.endsWith("b") ? "INVESTOR_B" : "INVESTOR_A")
            : token;
        if (!state || !sessionToken) return;
        const currentToken: string = sessionToken;
        setPending(`wallet:${holderRef}`);
        setError(null);
        setWalletFeedback({ holderRef, message: "Opening your wallet…", error: false });
        try {
            const provider = window.ethereum;
            if (!provider)
                throw new Error(
                    "No browser wallet detected. Open this page in the browser with your Ethereum wallet extension, unlock it, and try again.",
                );
            const accounts = await provider.request({ method: "eth_requestAccounts" });
            const walletAddress = Array.isArray(accounts) ? accounts[0] : null;
            if (typeof walletAddress !== "string" || !isAddress(walletAddress))
                throw new Error("Select a wallet account and try again.");
            let chainHex = await provider.request({ method: "eth_chainId" });
            if (Number.parseInt(String(chainHex), 16) !== state.chainId) {
                setWalletFeedback({
                    holderRef,
                    message: `Approve the ${chainName(state.chainId)} network switch in your wallet…`,
                    error: false,
                });
                try {
                    await provider.request({
                        method: "wallet_switchEthereumChain",
                        params: [{ chainId: `0x${state.chainId.toString(16)}` }],
                    });
                } catch {
                    throw new Error(
                        `Switch your wallet to ${chainName(state.chainId)} (chain ${state.chainId}) and try again.`,
                    );
                }
                chainHex = await provider.request({ method: "eth_chainId" });
                if (Number.parseInt(String(chainHex), 16) !== state.chainId)
                    throw new Error(
                        `Your wallet is still on the wrong chain. Select ${chainName(state.chainId)} and try again.`,
                    );
            }
            async function walletAction(key: string, path: string, body: unknown) {
                const stableKey = `${key}:${versionRef.current}`;
                const idempotencyKey = keys.current.get(stableKey) ?? crypto.randomUUID();
                keys.current.set(stableKey, idempotencyKey);
                const result = await mutatePhase2(
                    currentToken,
                    path,
                    body,
                    versionRef.current,
                    reason,
                    idempotencyKey,
                );
                keys.current.delete(stableKey);
                versionRef.current = result.resourceVersion;
                return result;
            }
            setWalletFeedback({ holderRef, message: "Requesting a demo signing challenge…", error: false });
            const challenge = await walletAction(
                `challenge:${holderRef}`,
                `/holders/${holderRef}/challenge`,
                {
                    walletAddress,
                    chainId: state.chainId,
                },
            );
            if (!challenge.challengeId || !challenge.message)
                throw new Error("The API did not return a wallet challenge. Try again.");
            setWalletFeedback({
                holderRef,
                message: "Approve the message signature in your wallet…",
                error: false,
            });
            const signature = await provider.request({
                method: "personal_sign",
                params: [challenge.message, walletAddress],
            });
            if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature))
                throw new Error("Your wallet did not return a valid signature. Try again.");
            setWalletFeedback({ holderRef, message: "Recording the signed wallet…", error: false });
            await walletAction(`bind:${holderRef}`, `/holders/${holderRef}/bind`, {
                challengeId: challenge.challengeId,
                signature,
            });
            await refresh();
            setWalletFeedback({ holderRef, message: "Wallet bound to this fictional holder.", error: false });
        } catch (cause) {
            const message = walletErrorMessage(cause, "Wallet signing failed.");
            setWalletFeedback({
                holderRef,
                message: /Select a simulated role to continue/i.test(message)
                    ? "Demo session expired. Refresh the page, select this holder, and try again."
                    : message,
                error: true,
            });
        } finally {
            setPending(null);
        }
    }
    const isInvestor = role === "INVESTOR_A" || role === "INVESTOR_B";
    const visibleHolders =
        state?.holders.filter((holder) => sessionForRole || holder.holderRef === selectedHolderRef) ?? [];
    const selectedHolder = visibleHolders[0];
    const nextAction = !state?.terms
        ? "Publish the sample terms before holder actions."
        : !selectedHolder
          ? "Holder record unavailable for this session."
          : selectedHolder.subscriptionStatus === "RECORDED"
            ? "Confirmed units reconcile with the holder register."
            : `Holder status: ${selectedHolder.subscriptionStatus.replaceAll("_", " ").toLowerCase()}.`;
    return (
        <section className="eligibility" aria-labelledby="eligibility-heading">
            <div className="section-heading">
                <div>
                    <p className="section-index">Current step / Authorized actions</p>
                    <h2 id="eligibility-heading">Terms, eligibility, subscription and issuance</h2>
                </div>
                <p>Two fictional holders · 1,000 whole units · chain {state?.chainId ?? "pending"}</p>
            </div>
            <p className="phase2-next-action" role="status">
                {nextAction}
            </p>
            <p className="prototype-notice distribution-notice" role="note">
                Prototype only. Fictional issuer and investors. No real securities are offered, no real money
                is accepted, and testnet tokens have no financial value.
            </p>
            {stage === "issuance" && (
                <p className="phase2-intro">
                    The holder acknowledges sample terms, the issuer records simulated eligibility, and the
                    holder binds a demo wallet. A simulated subscription precedes registry allocation and
                    confirmed minting. No real funds or identity documents are collected.
                </p>
            )}
            {loading && <p role="status">Loading prototype terms and holder states…</p>}
            {error && (
                <p className="phase2-error" role="alert">
                    {error}
                </p>
            )}
            {notice && (
                <p className="phase2-notice" role="status">
                    {notice}
                </p>
            )}
            {!loading && !state && (
                <p>Eligibility records are unavailable. Reload the workspace after the API is ready.</p>
            )}
            {state && !state.terms && (
                <div className="phase2-empty">
                    <h3>Prototype terms have not been published</h3>
                    <p>
                        The issuer publishes the versioned fictional terms before holders can acknowledge
                        them.
                    </p>
                    {stage === "issuance" && (sessionForRole || role === "ISSUER_PREPARER") && (
                        <button
                            type="button"
                            disabled={pending !== null}
                            onClick={() => void act("publish", "/terms/publish", {})}
                        >
                            {pending === "publish" ? "Publishing…" : "Publish prototype terms v1"}
                        </button>
                    )}
                </div>
            )}
            {state?.terms && (
                <>
                    {stage === "issuance" ? (
                        <div className="terms-panel">
                            <div>
                                <h3>{state.terms.title}</h3>
                                <p>
                                    Version {state.terms.version} · Published{" "}
                                    {new Date(state.terms.publishedAt).toLocaleDateString("en-GB")} · SHA-256{" "}
                                    <code>{state.terms.sha256}</code>
                                </p>
                                <p>
                                    Initial unit price: $100.00 · 1,000 units · 10% aggregate participation
                                    under defined prototype terms.
                                </p>
                            </div>
                            <ol>
                                {state.terms.disclosures.map((item) => (
                                    <li key={item}>{item}</li>
                                ))}
                            </ol>
                        </div>
                    ) : (
                        <p className="journey-source-label">
                            Published prototype terms v{state.terms.version} · preset 600 / 400 allocation
                        </p>
                    )}
                    {visibleHolders.length === 0 && (
                        <p>
                            This holder is not visible to the current action role. Choose the matching holder
                            role or a staff role.
                        </p>
                    )}
                    <div className="holder-list">
                        {visibleHolders.map((holder) => {
                            const own = sessionForRole
                                ? holder.holderRef === selectedHolderRef
                                : (role === "INVESTOR_A" && holder.holderRef.endsWith("a")) ||
                                  (role === "INVESTOR_B" && holder.holderRef.endsWith("b"));
                            const base = `/holders/${holder.holderRef}`;
                            return (
                                <article className="holder-card" key={holder.holderRef}>
                                    <div className="holder-head">
                                        <h3>{holderName[holder.holderRef]}</h3>
                                        <strong>{holder.plannedUnits} planned units</strong>
                                    </div>
                                    <dl>
                                        <div>
                                            <dt>Terms</dt>
                                            <dd>
                                                {holder.termsVersionAcknowledged === state.terms?.version
                                                    ? `Acknowledged v${state.terms.version}`
                                                    : "Awaiting acknowledgement"}
                                            </dd>
                                        </div>
                                        <div>
                                            <dt>Simulated eligibility</dt>
                                            <dd>
                                                {holder.eligibilityStatus.toLowerCase().replaceAll("_", " ")}
                                                {holder.eligibilityExpiresAt
                                                    ? ` · expires ${new Date(holder.eligibilityExpiresAt).toLocaleDateString("en-GB")}`
                                                    : ""}
                                            </dd>
                                        </div>
                                        <div>
                                            <dt>Wallet</dt>
                                            <dd>{holder.walletAddress ?? "Not bound"}</dd>
                                        </div>
                                        <div>
                                            <dt>Subscription</dt>
                                            <dd>
                                                {holder.subscriptionStatus.toLowerCase().replaceAll("_", " ")}
                                            </dd>
                                        </div>
                                        <div>
                                            <dt>Chain register</dt>
                                            <dd>
                                                {holder.recordedUnits} recorded units
                                                {holder.issuanceTxHash && state.chainId === 84532 ? (
                                                    <>
                                                        {" "}
                                                        ·{" "}
                                                        <a
                                                            href={`https://sepolia.basescan.org/tx/${holder.issuanceTxHash}`}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                        >
                                                            View transaction
                                                        </a>
                                                    </>
                                                ) : null}
                                            </dd>
                                        </div>
                                    </dl>
                                    {stage === "issuance" && own && !holder.termsVersionAcknowledged && (
                                        <button
                                            type="button"
                                            disabled={pending !== null}
                                            onClick={() =>
                                                void act(`ack:${holder.holderRef}`, `${base}/acknowledge`, {
                                                    termsSha256: state.terms!.sha256,
                                                })
                                            }
                                        >
                                            Acknowledge prototype terms and risks
                                        </button>
                                    )}
                                    {stage === "issuance" &&
                                        (sessionForRole || role === "COMPLIANCE_OPERATOR") &&
                                        holder.termsVersionAcknowledged &&
                                        holder.eligibilityStatus === "NOT_STARTED" && (
                                            <div className="holder-actions">
                                                <label>
                                                    Mock identity result{" "}
                                                    <select
                                                        value={identity}
                                                        onChange={(event) =>
                                                            setIdentity(event.target.value as "PASS" | "FAIL")
                                                        }
                                                    >
                                                        <option value="PASS">Pass</option>
                                                        <option value="FAIL">Fail</option>
                                                    </select>
                                                </label>
                                                <label>
                                                    Mock sanctions result{" "}
                                                    <select
                                                        value={sanctions}
                                                        onChange={(event) =>
                                                            setSanctions(
                                                                event.target.value as "CLEAR" | "HIT",
                                                            )
                                                        }
                                                    >
                                                        <option value="CLEAR">Clear</option>
                                                        <option value="HIT">Hit</option>
                                                    </select>
                                                </label>
                                                <button
                                                    type="button"
                                                    disabled={pending !== null}
                                                    onClick={() =>
                                                        void act(
                                                            `eligibility:${holder.holderRef}`,
                                                            `${base}/eligibility`,
                                                            {
                                                                identity,
                                                                sanctions,
                                                                jurisdiction: "US",
                                                                expiresAt: new Date(
                                                                    Date.now() + 7 * 86400_000,
                                                                ).toISOString(),
                                                            },
                                                        )
                                                    }
                                                >
                                                    Record simulated decision
                                                </button>
                                            </div>
                                        )}
                                    {stage === "issuance" &&
                                        (sessionForRole || role === "COMPLIANCE_OPERATOR") &&
                                        holder.eligibilityStatus === "APPROVED" && (
                                            <button
                                                type="button"
                                                disabled={pending !== null}
                                                onClick={() =>
                                                    void act(
                                                        `revoke:${holder.holderRef}`,
                                                        `${base}/revoke`,
                                                        {},
                                                    )
                                                }
                                            >
                                                Revoke simulated eligibility
                                            </button>
                                        )}
                                    {stage === "issuance" &&
                                        own &&
                                        holder.eligibilityStatus === "APPROVED" &&
                                        !holder.walletAddress && (
                                            <button
                                                type="button"
                                                disabled={pending !== null}
                                                onClick={() => void connectAndBind(holder.holderRef)}
                                            >
                                                {pending === `wallet:${holder.holderRef}`
                                                    ? "Waiting for wallet…"
                                                    : "Connect and sign demo wallet"}
                                            </button>
                                        )}
                                    {stage === "issuance" &&
                                        own &&
                                        walletFeedback?.holderRef === holder.holderRef && (
                                            <p
                                                className={
                                                    walletFeedback.error ? "phase2-error" : "phase2-notice"
                                                }
                                                role={walletFeedback.error ? "alert" : "status"}
                                            >
                                                {walletFeedback.message}
                                            </p>
                                        )}
                                    {stage === "issuance" &&
                                        own &&
                                        holder.subscriptionStatus === "ELIGIBLE" &&
                                        holder.walletAddress && (
                                            <button
                                                type="button"
                                                disabled={pending !== null}
                                                onClick={() =>
                                                    void act(
                                                        `commit:${holder.holderRef}`,
                                                        `${base}/commit`,
                                                        {},
                                                    )
                                                }
                                            >
                                                Record simulated subscription
                                            </button>
                                        )}
                                    {stage === "issuance" &&
                                        (sessionForRole || role === "REGISTRY_AGENT") &&
                                        holder.subscriptionStatus === "COMMITTED_SIMULATION" &&
                                        holder.walletAddress && (
                                            <button
                                                type="button"
                                                disabled={pending !== null}
                                                onClick={() =>
                                                    void act(
                                                        `allocate:${holder.holderRef}`,
                                                        `${base}/allocate`,
                                                        {},
                                                    )
                                                }
                                            >
                                                Record {holder.plannedUnits}-unit allocation
                                            </button>
                                        )}
                                    {stage === "issuance" &&
                                        (sessionForRole || role === "REGISTRY_AGENT") &&
                                        holder.subscriptionStatus === "ALLOCATED" && (
                                            <button
                                                type="button"
                                                disabled={pending !== null}
                                                onClick={() =>
                                                    void act(`issue:${holder.holderRef}`, `${base}/issue`, {})
                                                }
                                            >
                                                Queue restricted issuance
                                            </button>
                                        )}
                                    {holder.subscriptionStatus === "RECONCILIATION_REQUIRED" && (
                                        <p className="phase2-error">
                                            A chain or register mismatch needs registry review. No successful
                                            issuance is recorded.
                                        </p>
                                    )}
                                </article>
                            );
                        })}
                    </div>
                    {stage === "issuance" && state.issuanceOperations.length > 0 && !isInvestor && (
                        <details className="issuance-operations">
                            <summary>Issuance operation details</summary>
                            <ul>
                                {state.issuanceOperations.map((item) => (
                                    <li key={item.id}>
                                        {item.action.replace("ISSUE:", "")} · {item.id} ·{" "}
                                        {item.status.toLowerCase().replaceAll("_", " ")}
                                        {typeof item.response.reconciliationReason === "string"
                                            ? ` · ${item.response.reconciliationReason}`
                                            : ""}
                                    </li>
                                ))}
                            </ul>
                        </details>
                    )}
                </>
            )}
        </section>
    );
}
