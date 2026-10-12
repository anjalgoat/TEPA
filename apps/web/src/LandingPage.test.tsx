import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LandingPage } from "./LandingPage.js";

describe("public TEPA landing page", () => {
    it("keeps every public action on a real page destination", () => {
        const html = renderToStaticMarkup(<LandingPage />);
        const anchors = [...html.matchAll(/<a[^>]+href="([^"]+)"/g)]
            .map((match) => match[1])
            .filter((href): href is string => Boolean(href));
        const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));

        expect(anchors).not.toContain("/demo");
        expect(anchors).not.toContain("/whitepaper");
        for (const href of anchors) {
            if (href.startsWith("#")) expect(ids.has(href.slice(1))).toBe(true);
        }
        expect(html).toContain("White paper in preparation");
        expect(html).toContain("No live investment offering");
    });
});
