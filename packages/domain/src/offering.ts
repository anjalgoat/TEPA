import { z } from "zod";

import { moneyInputSchema } from "./money.js";

export const offeringSchema = z
    .object({
        schemaVersion: z.literal(1),
        fictional: z.literal(true),
        issuerName: z.string().min(1),
        network: z.literal("base-sepolia"),
        unitCount: z.literal(1_000),
        initialUnitPrice: moneyInputSchema,
        participationBasisPoints: z.literal(1_000),
        secondaryTradingEnabled: z.literal(false),
    })
    .strict()
    .superRefine((value, context) => {
        if (value.initialUnitPrice.currency !== "USD" || value.initialUnitPrice.amountMinor !== "10000") {
            context.addIssue({
                code: "custom",
                message: "Initial demo unit price must be USD 100",
                path: ["initialUnitPrice"],
            });
        }
    });

export type Offering = z.infer<typeof offeringSchema>;
