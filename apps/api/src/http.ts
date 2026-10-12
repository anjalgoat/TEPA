import { randomBytes } from "node:crypto";
import type { Request } from "express";
import { z } from "zod";

export class ApiError extends Error {
    constructor(
        public status: number,
        public code: string,
        message: string,
    ) {
        super(message);
    }
}

export const demoRoleSchema = z.enum([
    "ISSUER_PREPARER",
    "FINANCE_REVIEWER",
    "COMPLIANCE_OPERATOR",
    "REGISTRY_AGENT",
    "DISTRIBUTION_OPERATOR",
    "INVESTOR_A",
    "INVESTOR_B",
    "AUDITOR",
]);
export type DemoRole = z.infer<typeof demoRoleSchema>;
export type Actor = Readonly<{ actorRef: string; role: DemoRole }>;

const actorByRole: Record<DemoRole, string> = {
    ISSUER_PREPARER: "synthetic:issuer-preparer",
    FINANCE_REVIEWER: "synthetic:finance-reviewer",
    COMPLIANCE_OPERATOR: "synthetic:compliance-operator",
    REGISTRY_AGENT: "synthetic:registry-agent",
    DISTRIBUTION_OPERATOR: "synthetic:distribution-operator",
    INVESTOR_A: "synthetic:holder-a",
    INVESTOR_B: "synthetic:holder-b",
    AUDITOR: "synthetic:auditor",
};

export function createDemoSessions() {
    const sessions = new Map<string, { actor: Actor; expiresAt: number }>();
    return {
        issue(role: DemoRole) {
            const token = randomBytes(32).toString("hex");
            const actor = { actorRef: actorByRole[role], role };
            sessions.set(token, { actor, expiresAt: Date.now() + 30 * 60_000 });
            return { token, actor, expiresInSeconds: 1800 };
        },
        authenticate(request: Request): Actor {
            const header = request.header("Authorization");
            const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
            const session = sessions.get(token);
            if (!session || session.expiresAt <= Date.now()) {
                if (session) sessions.delete(token);
                throw new ApiError(401, "SESSION_REQUIRED", "Select a simulated role to continue.");
            }
            return session.actor;
        },
    };
}

export function requireRole(actor: Actor, role: DemoRole): void {
    if (actor.role !== role) throw new ApiError(403, "ROLE_FORBIDDEN", `Requires ${role}.`);
}

export function mutationHeaders(request: Request) {
    const idempotencyKey = z.uuid().safeParse(request.header("Idempotency-Key"));
    const expectedVersion = z.coerce.number().int().nonnegative().safeParse(request.header("If-Match"));
    const reason = z.string().trim().min(8).max(240).safeParse(request.header("X-Action-Reason"));
    if (!idempotencyKey.success || !expectedVersion.success || !reason.success) {
        throw new ApiError(
            400,
            "MUTATION_HEADERS_REQUIRED",
            "Idempotency-Key, If-Match, and a reason of at least 8 characters are required.",
        );
    }
    return {
        idempotencyKey: idempotencyKey.data,
        expectedVersion: expectedVersion.data,
        reason: reason.data,
    };
}
