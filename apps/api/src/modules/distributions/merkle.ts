import { encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from "viem";

export type ClaimLeaf = { index: number; wallet: `0x${string}`; amount: bigint };

export function entitlementLeaf(chainId: number, epochId: Hex, leaf: ClaimLeaf): Hex {
    return keccak256(
        encodeAbiParameters(parseAbiParameters("uint256, bytes32, uint256, address, uint256"), [
            BigInt(chainId),
            epochId,
            BigInt(leaf.index),
            leaf.wallet,
            leaf.amount,
        ]),
    );
}

function parent(left: Hex, right: Hex): Hex {
    return keccak256(
        left.toLowerCase() < right.toLowerCase()
            ? `0x${left.slice(2)}${right.slice(2)}`
            : `0x${right.slice(2)}${left.slice(2)}`,
    );
}

export function buildEntitlementTree(chainId: number, epochId: Hex, claims: ClaimLeaf[]) {
    if (claims.length === 0) throw new Error("An entitlement tree needs at least one claim");
    const leaves = claims.map((claim) => entitlementLeaf(chainId, epochId, claim));
    const levels: Hex[][] = [leaves];
    while (levels.at(-1)!.length > 1) {
        const current = levels.at(-1)!;
        const next: Hex[] = [];
        for (let i = 0; i < current.length; i += 2)
            next.push(current[i + 1] ? parent(current[i]!, current[i + 1]!) : current[i]!);
        levels.push(next);
    }
    const proofs = leaves.map((_, index) => {
        const proof: Hex[] = [];
        let position = index;
        for (const level of levels.slice(0, -1)) {
            const sibling = level[position ^ 1];
            if (sibling) proof.push(sibling);
            position = Math.floor(position / 2);
        }
        return proof;
    });
    return { root: levels.at(-1)![0]!, leaves, proofs };
}

export function verifyEntitlementProof(root: Hex, leaf: Hex, proof: Hex[]): boolean {
    return proof.reduce((node, sibling) => parent(node, sibling), leaf).toLowerCase() === root.toLowerCase();
}
