import { z } from "zod";

const environmentSchema = z
    .object({
        APP_ENV: z.enum(["local", "test", "demo"]).default("local"),
        PORT: z.coerce.number().int().min(1).max(65535).default(3000),
        DATABASE_URL: z.url().startsWith("postgresql://").default("postgresql://localhost:5432/tepa"),
        WEB_ORIGIN: z.url().default("http://localhost:5173"),
        CHAIN_ID: z.coerce.number().int().default(31337),
        BASE_SEPOLIA_RPC_URL: z.string().optional(),
        CHAIN_RPC_URL: z.url().optional(),
        TEST_USDC_ADDRESS: z.preprocess(
            (value) => (value === "" ? undefined : value),
            z
                .string()
                .regex(/^0x[0-9a-fA-F]{40}$/)
                .optional(),
        ),
        TEST_USDC_CODE_HASH: z.preprocess(
            (value) => (value === "" ? undefined : value),
            z
                .string()
                .regex(/^0x[0-9a-fA-F]{64}$/)
                .optional(),
        ),
        TEPA_TOKEN_ADDRESS: z.preprocess(
            (value) => (value === "" ? undefined : value),
            z
                .string()
                .regex(/^0x[0-9a-fA-F]{40}$/)
                .optional(),
        ),
        TEPA_TOKEN_CODE_HASH: z.preprocess(
            (value) => (value === "" ? undefined : value),
            z
                .string()
                .regex(/^0x[0-9a-fA-F]{64}$/)
                .optional(),
        ),
        DEMO_HOLDER_A_ADDRESS: z.preprocess(
            (value) => (value === "" ? undefined : value),
            z
                .string()
                .regex(/^0x[0-9a-fA-F]{40}$/)
                .optional(),
        ),
        DEMO_HOLDER_B_ADDRESS: z.preprocess(
            (value) => (value === "" ? undefined : value),
            z
                .string()
                .regex(/^0x[0-9a-fA-F]{40}$/)
                .optional(),
        ),
        MOCK_IDENTITY_PROVIDER: z.enum(["true"]).default("true"),
        MOCK_INTERMEDIARY: z.enum(["true"]).default("true"),
        REAL_MONEY_ENABLED: z.enum(["false"]).default("false"),
        SECONDARY_TRANSFERS_ENABLED: z.enum(["false"]).default("false"),
    })
    .superRefine((value, context) => {
        if (
            (value.DEMO_HOLDER_A_ADDRESS && !value.DEMO_HOLDER_B_ADDRESS) ||
            (!value.DEMO_HOLDER_A_ADDRESS && value.DEMO_HOLDER_B_ADDRESS) ||
            (value.DEMO_HOLDER_A_ADDRESS &&
                value.DEMO_HOLDER_B_ADDRESS &&
                value.DEMO_HOLDER_A_ADDRESS.toLowerCase() === value.DEMO_HOLDER_B_ADDRESS.toLowerCase())
        ) {
            context.addIssue({
                code: "custom",
                message: "Configure two distinct fictional holder wallets together",
                path: ["DEMO_HOLDER_A_ADDRESS"],
            });
        }
        if (value.APP_ENV === "demo") {
            if (value.CHAIN_ID !== 84532) {
                context.addIssue({
                    code: "custom",
                    message: "Demo requires Base Sepolia chain ID 84532",
                    path: ["CHAIN_ID"],
                });
            }
            if (!value.BASE_SEPOLIA_RPC_URL || !/^https?:\/\//.test(value.BASE_SEPOLIA_RPC_URL)) {
                context.addIssue({
                    code: "custom",
                    message: "Demo requires a Base Sepolia RPC URL",
                    path: ["BASE_SEPOLIA_RPC_URL"],
                });
            }
            if (value.TEPA_TOKEN_ADDRESS && !value.DEMO_HOLDER_A_ADDRESS) {
                context.addIssue({
                    code: "custom",
                    message: "Demo issuance requires the two configured holder wallets",
                    path: ["DEMO_HOLDER_A_ADDRESS"],
                });
            }
        } else if (value.CHAIN_ID !== 31337) {
            context.addIssue({
                code: "custom",
                message: "Local and test environments require Anvil chain ID 31337",
                path: ["CHAIN_ID"],
            });
        }
    });

export type StartupConfig = z.infer<typeof environmentSchema>;

export function parseStartupConfig(environment: NodeJS.ProcessEnv): StartupConfig {
    return environmentSchema.parse(environment);
}
