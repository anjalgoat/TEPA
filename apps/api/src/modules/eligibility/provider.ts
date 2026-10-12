export type MockScreeningInput = Readonly<{
    identity: "PASS" | "FAIL";
    sanctions: "CLEAR" | "HIT";
    jurisdiction: "US";
}>;
export type MockScreeningResult = Readonly<{
    status: "APPROVED" | "REJECTED";
    evidenceRef: string;
    policyVersion: "mock-eligibility-v1";
}>;
export interface EligibilityProvider {
    assess(input: MockScreeningInput): Promise<MockScreeningResult>;
}

export const mockEligibilityProvider: EligibilityProvider = {
    async assess(input) {
        return {
            status: input.identity === "PASS" && input.sanctions === "CLEAR" ? "APPROVED" : "REJECTED",
            evidenceRef: `synthetic:mock-identity-sanctions:${input.identity}:${input.sanctions}`,
            policyVersion: "mock-eligibility-v1",
        };
    },
};
