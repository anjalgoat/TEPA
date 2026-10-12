import cors from "cors";
import express from "express";
import type { Pool } from "pg";
import { z, ZodError } from "zod";
import type { StartupConfig } from "./config.js";
import { ApiError, createDemoSessions, demoRoleSchema, mutationHeaders, requireRole } from "./http.js";
import { registerEligibilityRoutes } from "./modules/eligibility/routes.js";
import { registerDistributionRoutes } from "./modules/distributions/routes.js";
import { registerSettlementRoutes } from "./modules/settlement/routes.js";
import { getAuditEvents, getIssuerOverview } from "./modules/metrics/data.js";
import {
    approveFinancialReview,
    importFinancialFixture,
    resolveReviewCase,
} from "./modules/metrics/mutations.js";

export function createApp(config: StartupConfig, pool: Pool) {
    const app = express();
    const sessions = createDemoSessions();

    app.use(cors({ origin: config.WEB_ORIGIN }));
    app.use(express.json({ limit: "32kb" }));

    app.get("/health", (_request, response) => {
        response.json({ status: "ok", service: "tepa-api" });
    });

    app.post("/demo/session", (request, response) => {
        const peer = request.socket.remoteAddress ?? "";
        const localPeer = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
        const originHost = new URL(config.WEB_ORIGIN).hostname;
        const localOrigin = originHost === "localhost" || originHost === "127.0.0.1";
        if (config.APP_ENV === "demo" && (!localPeer || !localOrigin))
            throw new ApiError(404, "DEMO_LOGIN_UNAVAILABLE", "Local simulated role access only.");
        const body = z.strictObject({ role: demoRoleSchema }).parse(request.body);
        response.json(sessions.issue(body.role));
    });

    app.get("/api/v1/issuer", async (request, response) => {
        sessions.authenticate(request);
        response.json(await getIssuerOverview(pool));
    });

    app.get("/api/v1/audit-events", async (request, response) => {
        const actor = sessions.authenticate(request);
        if (actor.role === "INVESTOR_A" || actor.role === "INVESTOR_B")
            throw new ApiError(403, "ROLE_FORBIDDEN", "The audit explorer requires a reviewer role.");
        response.json({ events: await getAuditEvents(pool) });
    });

    app.get("/api/v1/operations/:operationId", async (request, response) => {
        const actor = sessions.authenticate(request);
        const operationId = z.uuid().parse(request.params.operationId);
        const result = await pool.query<{ response: unknown }>(
            "SELECT response FROM financial_operations WHERE id = $1 AND actor_ref = $2",
            [operationId, actor.actorRef],
        );
        if (result.rows[0]) {
            response.json(result.rows[0].response);
            return;
        }
        const phase2 = await pool.query<{ response: unknown }>(
            "SELECT response FROM phase2_operations WHERE id = $1 AND actor_ref = $2",
            [operationId, actor.actorRef],
        );
        if (phase2.rows[0]) {
            response.json(phase2.rows[0].response);
            return;
        }
        const phase3 = await pool.query<{ response: unknown }>(
            "SELECT response FROM distribution_operations WHERE id = $1 AND actor_ref = $2",
            [operationId, actor.actorRef],
        );
        if (phase3.rows[0]) {
            response.json(phase3.rows[0].response);
            return;
        }
        const phase4 = await pool.query<{ response: unknown }>(
            "SELECT response FROM phase4_operations WHERE id=$1 AND actor_ref=$2",
            [operationId, actor.actorRef],
        );
        if (!phase4.rows[0]) throw new ApiError(404, "OPERATION_NOT_FOUND", "Operation not found.");
        response.json(phase4.rows[0].response);
    });

    app.post("/api/v1/financial-imports", async (request, response) => {
        const actor = sessions.authenticate(request);
        requireRole(actor, "ISSUER_PREPARER");
        const body = z
            .strictObject({ fixtureVersion: z.union([z.literal(1), z.literal(2)]) })
            .parse(request.body);
        const headers = mutationHeaders(request);
        response
            .status(201)
            .json(await importFinancialFixture(pool, { actor, ...headers, body }, body.fixtureVersion));
    });

    app.post("/api/v1/reconciliations/:caseKey/resolve", async (request, response) => {
        const actor = sessions.authenticate(request);
        requireRole(actor, "FINANCE_REVIEWER");
        const caseKey = z.string().min(1).max(120).parse(request.params.caseKey);
        const body = z
            .strictObject({
                resolutionCode: z.enum(["ACCEPT_PROCESSOR", "ACKNOWLEDGE_RELATED_PARTY"]),
            })
            .parse(request.body);
        const headers = mutationHeaders(request);
        response.json(
            await resolveReviewCase(pool, { actor, ...headers, body }, caseKey, body.resolutionCode),
        );
    });

    app.post("/api/v1/reconciliations/approve", async (request, response) => {
        const actor = sessions.authenticate(request);
        requireRole(actor, "FINANCE_REVIEWER");
        z.strictObject({}).parse(request.body);
        const headers = mutationHeaders(request);
        response.json(await approveFinancialReview(pool, { actor, ...headers, body: {} }));
    });

    registerEligibilityRoutes(app, pool, config, sessions.authenticate);
    registerDistributionRoutes(app, pool, config, sessions.authenticate);
    registerSettlementRoutes(app, pool, config, sessions.authenticate);

    app.use(
        (
            error: unknown,
            _request: express.Request,
            response: express.Response,
            _next: express.NextFunction,
        ) => {
            void _next;
            if (error instanceof ApiError) {
                response.status(error.status).json({ code: error.code, message: error.message });
            } else if (error instanceof ZodError) {
                response
                    .status(400)
                    .json({ code: "INVALID_INPUT", message: "Request failed schema validation." });
            } else if (error instanceof SyntaxError) {
                response
                    .status(400)
                    .json({ code: "INVALID_JSON", message: "Request body is not valid JSON." });
            } else {
                response
                    .status(500)
                    .json({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
            }
        },
    );

    return app;
}
