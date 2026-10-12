import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DemoJourney, journeySteps } from "./DemoJourney.js";
import type { Phase2 } from "./api.js";

const holder: Phase2["holders"][number] = {
    holderRef: "synthetic-holder-a",
    plannedUnits: 600,
    termsVersionAcknowledged: 1,
    eligibilityStatus: "APPROVED",
    eligibilityExpiresAt: "2026-10-10T00:00:00.000Z",
    jurisdiction: "US",
    walletAddress: "0x0000000000000000000000000000000000000001",
    subscriptionStatus: "RECORDED",
    recordedUnits: 600,
    issuanceTxHash: `0x${"1".repeat(64)}`,
    version: 8,
};

function issuanceHtml(selected: Phase2["holders"][number], operationStatus: string): string {
    const phase2: Phase2 = {
        issuerVersion: 8,
        chainId: 31337,
        tokenAddress: "0x0000000000000000000000000000000000000002",
        demoPeerWallet: null,
        terms: null,
        holders: [selected],
        issuanceOperations: [
            {
                id: "demo-operation",
                action: "ISSUE:synthetic-holder-a",
                status: operationStatus,
                response: {},
            },
        ],
    };
    return renderToStaticMarkup(
        <DemoJourney
            step="issuance"
            perspective="holder-a"
            overview={null}
            phase2={phase2}
            distributions={null}
            loading={false}
            detailError={null}
            actionRoleLabel="Issuer"
            onStepChange={() => undefined}
            onRefresh={() => undefined}
            canRefresh={true}
            controls={<button type="button">Queue restricted issuance</button>}
        />,
    );
}

describe("walkthrough issuance status", () => {
    it("does not call a submitted transaction complete", () => {
        const html = issuanceHtml(holder, "PENDING");
        expect(html).toContain("not yet reconciled");
        expect(html).not.toContain("Complete: chain confirmation and holder register reconciled");
    });

    it("requires matching holder units as well as a confirmed operation", () => {
        const html = issuanceHtml({ ...holder, recordedUnits: 400 }, "CONFIRMED");
        expect(html).not.toContain("Complete: chain confirmation and holder register reconciled");
    });

    it("shows completion only for the reconciled record", () => {
        const html = issuanceHtml(holder, "CONFIRMED");
        expect(html).toContain("Complete: chain confirmation and holder register reconciled");
        expect(html).toContain("Queue restricted issuance");
    });
});

describe("walkthrough story", () => {
    it("follows the complete holder path in order", () => {
        expect(journeySteps.map((item) => item.label)).toEqual([
            "Deal",
            "Issuer data",
            "Issue units",
            "Transfer blocked",
            "Distribution",
            "Buyback",
        ]);
    });

    for (const step of ["distribution", "buyback"] as const) {
        it(`shows ${step} controls in the step without a collapsed workflow wrapper`, () => {
            const html = renderToStaticMarkup(
                <DemoJourney
                    step={step}
                    perspective="holder-a"
                    overview={null}
                    phase2={null}
                    distributions={null}
                    loading={false}
                    detailError={null}
                    actionRoleLabel="Issuer"
                    onStepChange={() => undefined}
                    onRefresh={() => undefined}
                    canRefresh={false}
                    controls={<button type="button">{step} action</button>}
                />,
            );
            expect(html).toContain(`${step} action</button>`);
            expect(html).not.toContain("Concept preview");
            expect(html).not.toContain("journey-optional-workflow");
            const nextButton = 'class="journey-next" type="button">Next step</button>';
            if (step === "buyback") expect(html).not.toContain(nextButton);
            else expect(html).toContain(nextButton);
            expect(html.indexOf(`${step} action</button>`)).toBeLessThan(
                html.indexOf('class="journey-navigation"'),
            );
        });
    }
});
