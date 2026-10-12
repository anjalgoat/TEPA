import { encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from "viem";

export type SettlementLeaf = {
    index: number;
    wallet: `0x${string}`;
    units: bigint;
    amount: bigint;
};

export function settlementLeaf(
    chainId: number,
    settlementId: Hex,
    acquisition: boolean,
    leaf: SettlementLeaf,
): Hex {
    return keccak256(
        encodeAbiParameters(
            parseAbiParameters("uint256, bytes32, bool, uint256, address, uint256, uint256"),
            [
                BigInt(chainId),
                settlementId,
                acquisition,
                BigInt(leaf.index),
                leaf.wallet,
                leaf.units,
                leaf.amount,
            ],
        ),
    );
}

function parent(left: Hex, right: Hex): Hex {
    return keccak256(
        left.toLowerCase() < right.toLowerCase()
            ? `0x${left.slice(2)}${right.slice(2)}`
            : `0x${right.slice(2)}${left.slice(2)}`,
    );
}

export function buildSettlementTree(
    chainId: number,
    id: Hex,
    acquisition: boolean,
    claims: SettlementLeaf[],
) {
    if (!claims.length) throw new Error("Settlement needs positive holder outcomes");
    const leaves = claims.map((claim) => settlementLeaf(chainId, id, acquisition, claim));
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
