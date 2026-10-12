import { z } from "zod";

export const prototypeTermsSchema = z.strictObject({
    version: z.literal(1),
    fictional: z.literal(true),
    title: z.string().trim().min(1),
    unitCount: z.literal(1_000),
    initialUnitPriceMinor: z.literal("10000"),
    currency: z.literal("USD"),
    participationBasisPoints: z.literal(1_000),
    disclosures: z.array(z.string().trim().min(20)).min(5),
});
export type PrototypeTerms = z.infer<typeof prototypeTermsSchema>;
