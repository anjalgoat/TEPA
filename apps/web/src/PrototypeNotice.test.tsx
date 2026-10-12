import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import { DistributionPanel } from "./DistributionPanel.js";
import { EligibilityPanel } from "./EligibilityPanel.js";
import { LandingPage } from "./LandingPage.js";
import { SettlementPanel } from "./SettlementPanel.js";

const notice =
    "Prototype only. Fictional issuer and investors. No real securities are offered, no real money is accepted, and testnet tokens have no financial value.";
const onChange = async () => undefined;

describe("prototype notices", () => {
    it("appears on the public offering page", () => {
        const html = renderToStaticMarkup(<LandingPage />);
        expect(html).toContain(notice);
        expect(html.indexOf("tepa-public-notice")).toBeLessThan(html.indexOf('<main id="main-content"'));
    });

    for (const stage of ["offering", "eligibility", "subscription", "issuance"] as const) {
        it(`appears during ${stage}, including while records load`, () => {
            const html = renderToStaticMarkup(
                <EligibilityPanel
                    token={null}
                    role="INVESTOR_A"
                    issuerVersion={null}
                    onChange={onChange}
                    stage={stage}
                    selectedHolderRef="synthetic-holder-a"
                    currentRun={null}
                />,
            );
            expect(html).toContain(notice);
            expect(html).toContain("Loading prototype terms and holder states");
        });
    }

    it("appears during distribution loading", () => {
        const html = renderToStaticMarkup(
            <DistributionPanel
                token={null}
                role="INVESTOR_A"
                issuerVersion={null}
                onChange={onChange}
                currentRun={null}
            />,
        );
        expect(html).toContain(notice);
        expect(html).toContain("Loading distribution epochs");
    });

    it("appears during buyback and acquisition loading", () => {
        const html = renderToStaticMarkup(
            <SettlementPanel token={null} role="INVESTOR_A" issuerVersion={null} onChange={onChange} />,
        );
        expect(html).toContain(notice);
        expect(html).toContain("Loading appraisal and settlement evidence");
    });

    it("stays in the demo shell for any step", () => {
        const previousWindow = globalThis.window;
        globalThis.window = { location: { search: "", pathname: "/demo" } } as Window & typeof globalThis;
        try {
            const html = renderToStaticMarkup(<App />);
            expect(html).toContain(notice);
            expect(html).toContain("demo-prototype-notice");
        } finally {
            globalThis.window = previousWindow;
        }
    });
});
