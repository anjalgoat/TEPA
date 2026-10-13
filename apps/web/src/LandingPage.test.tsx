import { existsSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LandingPage, whitePaperHref } from "./LandingPage.js";

describe("public TEPA landing page", () => {
    const html = renderToStaticMarkup(<LandingPage />);
    const anchors = [...html.matchAll(/<a[^>]+href="([^"]+)"/g)]
        .map((match) => match[1])
        .filter((href): href is string => Boolean(href));

    it("keeps every public action on a real page destination", () => {
        const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
        for (const href of anchors) {
            if (href.startsWith("#")) expect(ids.has(href.slice(1))).toBe(true);
        }
        expect(anchors).toContain("/demo");
        expect(html).toContain("No live investment offering");
    });

    it("links the white paper as an unreviewed draft that ships with the site", () => {
        expect(anchors).toContain(whitePaperHref);
        expect(existsSync(new URL(`../public${whitePaperHref}`, import.meta.url))).toBe(true);
        expect(html).toContain("Draft for review");
        expect(html).toContain("review not yet completed");
        expect(html).not.toContain("White paper in preparation");
    });

    it("links the public GitHub repository", () => {
        expect(anchors).toContain("https://github.com/anjalgoat/TEPA");
    });

    it("uses the prototype's recorded 2025-Q1 sample figures", () => {
        for (const amount of ["$10,200", "$1,020", "$612"]) expect(html).toContain(amount);
        expect(html).not.toContain("$30,000");
    });
});
