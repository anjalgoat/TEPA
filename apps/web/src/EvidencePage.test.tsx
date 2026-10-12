import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EvidencePage } from "./EvidencePage.js";
import type { Distributions } from "./api.js";

const epoch: Distributions["epochs"][number] = {
    id: "local-run-1",
    importId: "fictional-import-1",
    termsId: "sample-terms-1",
    quarter: "2025-Q1",
    revision: 1,
    state: "SNAPSHOTTED",
    version: 5,
    poolUsdMinor: "102000",
    poolTestUsdcMinor: "1020000000",
    formulaVersion: "distribution-v1",
    cashSnapshot: {
        financialApprovalId: "fictional-approval-1",
        definedCashMinor: "1020000",
        participationBasisPoints: 1000,
        periods: [],
        sourceRows: [],
    },
    cashSnapshotSha256: "a".repeat(64),
    preparedBy: "issuer",
    reviewedBy: "reviewer",
    approvedBy: "reviewer",
    approvedAt: "2026-10-03T10:00:00.000Z",
    recordBlock: "100",
    recordBlockHash: `0x${"b".repeat(64)}`,
    snapshotHash: "c".repeat(64),
    entitlementRoot: `0x${"d".repeat(64)}`,
    vaultAddress: "0x0000000000000000000000000000000000000001",
    fundingTxHash: null,
    openingTxHash: null,
    chainSteps: [],
    epochHash: "e".repeat(64),
    eligibleSupply: "1000",
    reconciliationIncidents: [],
    entitlements: [
        {
            holderRef: "synthetic-holder-a",
            index: 0,
            walletAddress: "0x0000000000000000000000000000000000000002",
            eligibleUnits: 600,
            amountUsdMinor: "61200",
            amountTestUsdcMinor: "612000000",
            remainder: "0",
            roundingUnitAwarded: false,
            proof: [],
            claimTxHash: null,
            claimBlockNumber: null,
            claimBlockHash: null,
            claimLogIndex: null,
        },
    ],
};

function page(selected: Distributions["epochs"][number], requestedEpochId = selected.id) {
    return renderToStaticMarkup(
        <EvidencePage
            overview={null}
            phase2={null}
            distributions={{ issuerVersion: 5, chainId: 31337, epochs: [selected] }}
            requestedEpochId={requestedEpochId}
            requestedHolderRef="synthetic-holder-a"
            loading={false}
            detailError={null}
            onRefresh={() => undefined}
            canRefresh={true}
        />,
    );
}

describe("distribution evidence", () => {
    it("shows an unfunded snapshot without calling it claimable", () => {
        const html = page(epoch);
        expect(html).toContain("vault is not yet confirmed funded");
        expect(html).toContain("Not claimable until the vault is funded");
        expect(html).toContain("600 of 1000 eligible units");
        expect(html).toContain("fictional-import-1");
        expect(html).toContain("Separate historical evidence / Base Sepolia");
    });

    it("distinguishes a recorded claim and local transaction from historical issuance", () => {
        const html = page({
            ...epoch,
            state: "CLAIMABLE",
            fundingTxHash: `0x${"f".repeat(64)}`,
            openingTxHash: `0x${"1".repeat(64)}`,
            chainSteps: [
                {
                    step: "ASSET_APPROVAL",
                    chainId: 31337,
                    contractAddress: epoch.vaultAddress!,
                    txHash: `0x${"e".repeat(64)}`,
                    blockNumber: "101",
                    blockHash: `0x${"6".repeat(64)}`,
                },
                {
                    step: "FUND",
                    chainId: 31337,
                    contractAddress: epoch.vaultAddress!,
                    txHash: `0x${"f".repeat(64)}`,
                    blockNumber: "102",
                    blockHash: `0x${"4".repeat(64)}`,
                },
            ],
            entitlements: [
                {
                    ...epoch.entitlements[0]!,
                    claimTxHash: `0x${"2".repeat(64)}`,
                    claimBlockNumber: "104",
                    claimBlockHash: `0x${"3".repeat(64)}`,
                    claimLogIndex: 2,
                },
            ],
        });
        expect(html).toContain("Already claimed and recorded");
        expect(html).toContain("Local Anvil");
        expect(html).toContain("Confirmed chain step receipts");
        expect(html).toContain("asset approval");
        expect(html).toContain("block 102");
        expect(html).toContain("not evidence of funding or claims in the current Local Anvil distribution");
    });

    it("keeps a recorded claim subject to a later reconciliation incident", () => {
        const html = page({
            ...epoch,
            state: "RECONCILIATION_REQUIRED",
            entitlements: [{ ...epoch.entitlements[0]!, claimTxHash: `0x${"5".repeat(64)}` }],
        });
        expect(html).toContain("Claim receipt recorded; this run now requires reconciliation");
        expect(html).toContain("before this run is treated as payable");
    });

    it("does not substitute another run when the requested ID is missing", () => {
        expect(page(epoch, "unknown-run")).toContain("requested distribution run was not found");
        expect(page(epoch, "unknown-run")).not.toContain("Approved pool:");
    });
});
