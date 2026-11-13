import { Router, Request, Response } from "express";
import { prisma } from "../config/db";
import { pingCloudinary } from "../lib/cloudinary";
import { getProvider } from "../ai-providers/registry";

const router = Router();

/**
 * GET /health/ping — ultra-lightweight wake-up endpoint.
 * Returns 200 immediately — used by Vercel to wake Render from free-tier sleep
 * without running the expensive DB / Cloudinary / AI checks.
 */
router.get("/ping", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

/**
 * GET /health — full health check (DB, Cloudinary, AI provider).
 *
 * The AI ping is provider-agnostic: getProvider().ping() works for Ollama,
 * Gemini, Mistral, or any future provider without modifying this file.
 * The response key is the active provider name (e.g. "mistral", "gemini").
 */
router.get("/", async (_req: Request, res: Response) => {
    const provider = getProvider();

    const [db, cloudinary, ai] = await Promise.allSettled([
        prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
        pingCloudinary(),
        provider.ping(),
    ]);

    const status = {
        db: db.status === "fulfilled" ? db.value : false,
        cloudinary: cloudinary.status === "fulfilled" ? cloudinary.value : false,
        // Dynamic key = active provider name (e.g. "mistral": true)
        [provider.name]: ai.status === "fulfilled" ? ai.value : false,
    };

    const allHealthy = Object.values(status).every(Boolean);

    res.status(allHealthy ? 200 : 207).json({
        status: allHealthy ? "ok" : "degraded",
        provider: provider.name,
        services: status,
        timestamp: new Date().toISOString(),
    });
});

/**
 * GET /health/webhook-debug — shows connected Instagram accounts + their stored IGIDs.
 * Use this to verify that the IGID in the webhook entry.id matches what's stored.
 * Remove or protect this endpoint before going public.
 */
router.get("/webhook-debug", async (_req: Request, res: Response) => {
    try {
        const accounts = await prisma.connectedAccount.findMany({
            where: { platform: "INSTAGRAM" },
            select: {
                id: true,
                platform_account_id: true,
                platform_account_name: true,
                status: true,
                token_expires_at: true,
                updated_at: true,
            },
        });
        const recentEvents = await prisma.webhookEvent.findMany({
            where: { channel: "INSTAGRAM" },
            orderBy: { id: "desc" },
            take: 10,
        });
        const recentExecutions = await prisma.automationExecution.findMany({
            where: { channel: "INSTAGRAM" },
            orderBy: { executed_at: "desc" },
            take: 5,
            select: {
                id: true,
                automation_id: true,
                success: true,
                error_message: true,
                executed_at: true,
                actions_executed: true,
            },
        });
        res.json({
            instagram_accounts: accounts,
            recent_webhook_events: recentEvents,
            recent_executions: recentExecutions,
            env_check: {
                has_app_id: !!process.env.INSTAGRAM_APP_ID,
                app_id_value: process.env.INSTAGRAM_APP_ID,
                has_app_secret: !!process.env.INSTAGRAM_APP_SECRET,
                has_webhook_secret: !!process.env.INSTAGRAM_WEBHOOK_SECRET,
                node_env: process.env.NODE_ENV,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});

/**
 * POST /health/resubscribe-instagram — manually re-subscribe all connected
 * Instagram accounts to webhooks. Call this if automations stopped working.
 */
router.post("/resubscribe-instagram", async (_req: Request, res: Response) => {
    try {
        const { default: axios } = await import("axios");
        const { decrypt } = await import("../lib/encryption");

        const accounts = await prisma.connectedAccount.findMany({
            where: { platform: "INSTAGRAM", status: "CONNECTED" },
        });

        const results = [];

        for (const account of accounts) {
            try {
                const accessToken = decrypt(account.access_token);
                const igUserId = account.platform_account_id;

                // Check current subscription first
                let currentSubs = null;
                try {
                    const checkRes = await axios.get(
                        `https://graph.instagram.com/v21.0/${igUserId}/subscribed_apps`,
                        { params: { access_token: accessToken }, timeout: 10_000 }
                    );
                    currentSubs = checkRes.data;
                } catch { /* ignore check errors */ }

                // Subscribe/resubscribe
                const subRes = await axios.post(
                    `https://graph.instagram.com/v21.0/${igUserId}/subscribed_apps`,
                    null,
                    {
                        params: {
                            subscribed_fields: "messages,comments,live_comments",
                            access_token: accessToken,
                        },
                        timeout: 10_000,
                    }
                );

                results.push({
                    account_id: account.id,
                    ig_user_id: igUserId,
                    name: account.platform_account_name,
                    before: currentSubs,
                    after: subRes.data,
                    status: "OK",
                });
            } catch (err: unknown) {
                const axErr = err as { response?: { data?: unknown; status?: number }; message?: string };
                results.push({
                    account_id: account.id,
                    ig_user_id: account.platform_account_id,
                    name: account.platform_account_name,
                    error: axErr.message,
                    detail: axErr.response?.data,
                    http_status: axErr.response?.status,
                    status: "FAILED",
                });
            }
        }

        res.json({ accounts_processed: accounts.length, results });
    } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});

/**
 * GET /health/automation-debug — cross-checks automations vs connected accounts.
 * Shows exactly why automations aren't firing.
 */
router.get("/automation-debug", async (_req: Request, res: Response) => {
    try {
        // All connected Instagram accounts with their user_id
        const igAccounts = await prisma.connectedAccount.findMany({
            where: { platform: "INSTAGRAM" },
            select: {
                id: true,
                user_id: true,
                platform_account_id: true,
                platform_account_name: true,
                status: true,
            },
        });

        // All automations with their user_id and status
        const automations = await prisma.automation.findMany({
            select: {
                id: true,
                name: true,
                status: true,
                channel: true,
                user_id: true,
                cooldown_seconds: true,
                triggers: { select: { type: true, ig_post_id: true } },
                conditions: { select: { operator: true, value: true } },
                actions: { select: { type: true, order: true } },
            },
            orderBy: { created_at: "desc" },
        });

        // Cross-check: for each automation, does its user_id match any IG account?
        const checks = automations.map(auto => {
            const matchingAccount = igAccounts.find(a => a.user_id === auto.user_id);
            return {
                automation_id: auto.id,
                automation_name: auto.name,
                automation_status: auto.status,
                automation_channel: auto.channel,
                automation_user_id: auto.user_id,
                has_matching_ig_account: !!matchingAccount,
                matching_account_id: matchingAccount?.id ?? null,
                matching_ig_name: matchingAccount?.platform_account_name ?? null,
                account_status: matchingAccount?.status ?? null,
                triggers: auto.triggers,
                conditions: auto.conditions,
                actions: auto.actions.map(a => a.type),
                issue: !matchingAccount
                    ? "NO_MATCHING_IG_ACCOUNT — user_id mismatch"
                    : auto.status !== "ACTIVE"
                        ? `AUTOMATION_NOT_ACTIVE — status is ${auto.status}`
                        : matchingAccount.status !== "CONNECTED"
                            ? `IG_ACCOUNT_NOT_CONNECTED — status is ${matchingAccount.status}`
                            : "OK",
            };
        });

        // Recent webhook events with user_id
        const recentEvents = await prisma.webhookEvent.findMany({
            where: { channel: "INSTAGRAM" },
            orderBy: { id: "desc" },
            take: 5,
        });

        res.json({
            summary: {
                total_ig_accounts: igAccounts.length,
                total_automations: automations.length,
                active_automations: automations.filter(a => a.status === "ACTIVE").length,
                ok_count: checks.filter(c => c.issue === "OK").length,
                issue_count: checks.filter(c => c.issue !== "OK").length,
            },
            automation_checks: checks,
            ig_account_user_ids: igAccounts.map(a => ({ user_id: a.user_id, platform_account_id: a.platform_account_id, name: a.platform_account_name })),
            recent_webhook_user_ids: recentEvents.map(e => ({ user_id: e.user_id, external_event_id: e.external_event_id, channel: e.channel })),
        });
    } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});

export default router;
