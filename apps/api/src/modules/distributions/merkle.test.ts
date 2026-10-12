import { describe, expect, it } from "vitest";
import { buildEntitlementTree, verifyEntitlementProof } from "./merkle.js";

describe("entitlement commitment", () => {
    it("proves each leaf and rejects an altered amount", () => {
        const epoch = `0x${"ab".repeat(32)}` as const;
        const claims = [
            { index: 0, wallet: "0x0000000000000000000000000000000000000001" as const, amount: 3n },
            { index: 1, wallet: "0x0000000000000000000000000000000000000002" as const, amount: 2n },
            { index: 2, wallet: "0x0000000000000000000000000000000000000003" as const, amount: 1n },
        ];
        const tree = buildEntitlementTree(31337, epoch, claims);
        tree.leaves.forEach((leaf, index) =>
            expect(verifyEntitlementProof(tree.root, leaf, tree.proofs[index]!)).toBe(true),
        );
        expect(verifyEntitlementProof(tree.root, `0x${"00".repeat(32)}`, tree.proofs[0]!)).toBe(false);
    });
});
