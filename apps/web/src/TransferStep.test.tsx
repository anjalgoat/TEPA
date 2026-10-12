import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TransferResult } from "./TransferStep.js";

const mockedRevert = {
    status: "success" as const,
    message:
        "Direct transfer rejected by the token contract (RestrictedTransfer). This read-only check creates no transaction or chain event.",
};

describe("blocked transfer evidence", () => {
    it("makes the decoded contract rejection prominent", () => {
        const html = renderToStaticMarkup(<TransferResult result={mockedRevert} />);
        expect(html).toContain("<strong>RestrictedTransfer</strong>");
        expect(html).toContain('role="status"');
        expect(html).toContain("read-only check creates no transaction");
    });
});
