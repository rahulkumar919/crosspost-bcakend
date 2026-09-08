import { Request, Response, NextFunction } from "express";
import * as accountsService from "../services/accounts.service";
import { Platform } from "@prisma/client";
import { AppError } from "../middleware/error-handler.middleware";
import { env } from "../config/env";
import { logger } from "../lib/logger";


function parsePlatform(raw: string): Platform {
    const p = raw.toUpperCase() as Platform;
    if (!["YOUTUBE", "INSTAGRAM", "LINKEDIN"].includes(p)) {
        throw new AppError(`Unsupported platform: ${raw}`, 400, "INVALID_PLATFORM");
    }
    return p;
}

export async function getAccounts(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const accounts = await accountsService.getConnectedAccounts(req.user!.id);
        res.json({ accounts });
    } catch (err) {
        next(err);
    }
}

export async function connectPlatform(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const platform = parsePlatform(req.params.platform);
        const redirectUrl = await accountsService.getOAuthRedirectUrl(req.user!.id, platform);

        // API clients (axios) send X-Requested-With: XMLHttpRequest.
        // Browsers following a plain link do not.
        if (req.headers["x-requested-with"] === "XMLHttpRequest") {
            res.json({ redirectUrl });
        } else {
            res.redirect(redirectUrl);
        }
    } catch (err) {
        next(err);
    }
}

export async function oauthCallback(
    req: Request,
    res: Response,
    _next: NextFunction
): Promise<void> {
    const platform = req.params.platform?.toLowerCase() ?? "unknown";

    try {
        const parsedPlatform = parsePlatform(req.params.platform);
        const { code, state, error: oauthError, error_description } = req.query as Record<string, string>;

        logger.info(`OAuth callback received for ${platform}`, { query: req.query });

        if (oauthError) {
            let userMessage = oauthError;
            if (error_description) {
                userMessage = `${oauthError}: ${error_description}`;
            }
            if (oauthError === "unauthorized_scope_error" && error_description?.includes("openid")) {
                userMessage = "LinkedIn App is missing the 'Sign In with LinkedIn using OpenID Connect' product. In LinkedIn Developer Portal, go to your app -> Products tab -> click 'Request access' on 'Sign In with LinkedIn using OpenID Connect'.";
            }
            logger.warn(`OAuth provider returned error for ${platform}`, { oauthError, error_description });
            return res.redirect(
                `${env.FRONTEND_URL}/accounts?error=${encodeURIComponent(userMessage)}`
            ) as unknown as void;
        }

        if (!code || !state) {
            return res.redirect(
                `${env.FRONTEND_URL}/accounts?error=${encodeURIComponent("Missing OAuth code or state. Please try connecting again.")}`
            ) as unknown as void;
        }

        await accountsService.handleOAuthCallback(code, state, parsedPlatform);
        res.redirect(`${env.FRONTEND_URL}/accounts?connected=${platform}`);
    } catch (err: any) {
        // OAuth callbacks are browser redirects — return a redirect, not a JSON 500
        const message: string =
            err?.message ??
            `Failed to connect ${platform}. Please try again.`;
        logger.error(`OAuth callback failed for ${platform}`, { error: err?.message, stack: err?.stack });
        res.redirect(
            `${env.FRONTEND_URL}/accounts?error=${encodeURIComponent(message)}`
        );
    }
}

export async function disconnectAccount(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const platform = parsePlatform(req.params.platform);
        await accountsService.disconnectAccount(req.user!.id, platform);
        res.json({ message: `${platform} disconnected successfully.` });
    } catch (err) {
        next(err);
    }
}
