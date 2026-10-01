/**
 * AutomationEngine — channel-agnostic core processor.
 *
 * Receives a NormalizedMessageEvent and:
 *   1. Checks for duplicate events (idempotency)
 *   2. Skips echo messages (bot loop prevention)
 *   3. Looks up or creates the Conversation
 *   4. Checks conversation.mode — skips if HUMAN
 *   5. Finds all ACTIVE automations matching the event's channel + trigger
 *   6. Evaluates conditions for each automation
 *   7. Sorts by priority (highest wins)
 *   8. Executes the highest-priority matching automation's actions
 *   9. Logs execution result
 *
 * Priority: EXACT > CONTAINS > STARTS_WITH > ANY
 * One automation fires per event (no duplicate responses).
 */
import { prisma } from "../config/db";
import { logger } from "../lib/logger";
import { executeAutomationActions } from "./ActionExecutor";
import type { NormalizedMessageEvent } from "./events/NormalizedEvent";
import type {
    Automation,
    AutomationAction,
    AutomationCondition,
    AutomationTrigger,
} from "@prisma/client";

type FullAutomation = Automation & {
    triggers: AutomationTrigger[];
    conditions: AutomationCondition[];
    actions: AutomationAction[];
};

// ─── Main Entry Point ────────────────────────────────────────────────────────

export async function processEvent(event: NormalizedMessageEvent): Promise<void> {
    const logCtx = {
        channel: event.channel,
        userId: event.userId,
        externalMessageId: event.externalMessageId,
        isEcho: event.isEcho,
        isComment: event.isComment,
    };

    logger.info("AutomationEngine: processing event", logCtx);

    // ── 1. Bot loop prevention — skip our own outbound echoes ────────────────
    if (event.isEcho) {
        logger.debug("AutomationEngine: skipping echo message", logCtx);
        return;
    }

    // ── 2. Idempotency — skip already processed events ───────────────────────
    try {
        await prisma.webhookEvent.create({
            data: {
                channel: event.channel,
                external_event_id: event.externalMessageId,
                user_id: event.userId,
            },
        });
    } catch {
        // Unique constraint violation = duplicate event
        logger.info("AutomationEngine: duplicate event ignored", logCtx);
        return;
    }

    // ── 3. Upsert conversation ────────────────────────────────────────────────
    let conversation;
    try {
        conversation = await upsertConversation(event);
    } catch (err) {
        logger.error("AutomationEngine: failed to upsert conversation", {
            ...logCtx,
            error: err instanceof Error ? err.message : String(err),
        });
        return;
    }

    // ── 4. Store inbound message ──────────────────────────────────────────────
    try {
        await prisma.conversationMessage.create({
            data: {
                conversation_id: conversation.id,
                external_message_id: event.externalMessageId,
                direction: "INBOUND",
                sender_type: "USER",
                content: event.messageText || `[${event.messageType}]`,
                status: "DELIVERED",
            },
        });

        await prisma.conversation.update({
            where: { id: conversation.id },
            data: {
                last_message_at: new Date(event.timestamp),
                last_inbound_at: new Date(event.timestamp),
                unread_count: { increment: 1 },
            },
        });
    } catch (err) {
        logger.warn("AutomationEngine: failed to store inbound message", {
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // ── 5. Skip if conversation is in HUMAN mode ──────────────────────────────
    if (conversation.mode === "HUMAN") {
        logger.info("AutomationEngine: conversation in HUMAN mode — skipping automation", {
            conversationId: conversation.id,
        });
        return;
    }

    // ── 6. Skip if conversation is PAUSED ────────────────────────────────────
    if (conversation.mode === "PAUSED") {
        logger.info("AutomationEngine: conversation PAUSED — skipping automation", {
            conversationId: conversation.id,
        });
        return;
    }

    // ── 7. Load matching active automations ───────────────────────────────────
    const channelFilter = {
        in: [event.channel as "INSTAGRAM" | "WHATSAPP", "BOTH" as const],
    };

    const automations = await prisma.automation.findMany({
        where: {
            user_id: event.userId,
            status: "ACTIVE",
            channel: channelFilter,
        },
        include: {
            triggers: true,
            conditions: true,
            actions: { orderBy: { order: "asc" } },
        },
        orderBy: { priority: "desc" },
    }) as FullAutomation[];

    if (automations.length === 0) {
        logger.debug("AutomationEngine: no active automations found", logCtx);
        return;
    }

    // ── 8. Find best matching automation ─────────────────────────────────────
    const matched = findBestMatch(automations, event);

    if (!matched) {
        logger.debug("AutomationEngine: no automation matched conditions", logCtx);
        return;
    }

    logger.info("AutomationEngine: matched automation", {
        automationId: matched.id,
        automationName: matched.name,
        conversationId: conversation.id,
    });

    // ── 9. Check cooldown ─────────────────────────────────────────────────────
    if (matched.cooldown_seconds > 0) {
        const cooldownCutoff = new Date(Date.now() - matched.cooldown_seconds * 1000);
        const recentExecution = await prisma.automationExecution.findFirst({
            where: {
                automation_id: matched.id,
                conversation_id: conversation.id,
                executed_at: { gte: cooldownCutoff },
                success: true,
            },
        });
        if (recentExecution) {
            logger.info("AutomationEngine: cooldown active — skipping", {
                automationId: matched.id,
                conversationId: conversation.id,
                cooldownSeconds: matched.cooldown_seconds,
            });
            return;
        }
    }

    // ── 10. Execute actions ────────────────────────────────────────────────────
    const startMs = Date.now();
    let success = false;
    let errorMessage: string | undefined;
    const actionsExecuted: Array<{ type: string; success: boolean; error?: string; sentText?: string }> = [];

    try {
        const result = await executeAutomationActions(
            matched,
            event,
            conversation,
        );
        success = result.success;
        errorMessage = result.errorMessage;
        actionsExecuted.push(...result.actionsExecuted);
    } catch (err) {
        success = false;
        errorMessage = err instanceof Error ? err.message : String(err);
        logger.error("AutomationEngine: action execution threw", {
            automationId: matched.id,
            error: errorMessage,
        });
    }

    // ── 11. Log execution ─────────────────────────────────────────────────────
    try {
        await prisma.automationExecution.create({
            data: {
                automation_id: matched.id,
                conversation_id: conversation.id,
                external_message_id: event.externalMessageId,
                channel: event.channel,
                success,
                error_message: errorMessage ?? null,
                // Serialize to plain JSON to satisfy Prisma's InputJsonValue constraint
                actions_executed: JSON.parse(JSON.stringify(actionsExecuted)),
            },
        });
    } catch (err) {
        logger.warn("AutomationEngine: failed to log execution", {
            error: err instanceof Error ? err.message : String(err),
        });
    }

    logger.info("AutomationEngine: execution complete", {
        automationId: matched.id,
        success,
        durationMs: Date.now() - startMs,
    });
}

// ─── Condition Matching ───────────────────────────────────────────────────────

function triggerMatchesEvent(trigger: AutomationTrigger, event: NormalizedMessageEvent): boolean {
    const t = trigger.type;

    if (event.isComment) {
        if (t !== "INSTAGRAM_COMMENT" && t !== "INSTAGRAM_COMMENT_KEYWORD") return false;
        // Optional: restrict to specific post
        if (trigger.ig_post_id && trigger.ig_post_id !== event.postId) return false;
        return true;
    }

    // DM / direct message
    if (event.channel === "INSTAGRAM") {
        return t === "INSTAGRAM_DM" || t === "INSTAGRAM_DM_KEYWORD";
    }
    if (event.channel === "WHATSAPP") {
        return t === "WHATSAPP_MESSAGE" || t === "WHATSAPP_KEYWORD";
    }
    return false;
}

function conditionsMatch(
    conditions: AutomationCondition[],
    event: NormalizedMessageEvent
): { matched: boolean; score: number } {
    // No conditions = match anything (generic trigger)
    if (conditions.length === 0) {
        return { matched: true, score: 0 };
    }

    const text = event.messageText?.trim() ?? "";

    for (const cond of conditions) {
        const keywords = cond.value
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean);

        const compareText = cond.case_insensitive ? text.toLowerCase() : text;

        for (const keyword of keywords) {
            const compareKw = cond.case_insensitive ? keyword.toLowerCase() : keyword;

            switch (cond.operator) {
                case "EXACT":
                    if (compareText === compareKw) return { matched: true, score: 100 };
                    break;
                case "STARTS_WITH":
                    if (compareText.startsWith(compareKw)) return { matched: true, score: 75 };
                    break;
                case "CONTAINS":
                    if (compareText.includes(compareKw)) return { matched: true, score: 50 };
                    break;
                case "ANY":
                    return { matched: true, score: 0 };
            }
        }
    }

    return { matched: false, score: -1 };
}

function findBestMatch(
    automations: FullAutomation[],
    event: NormalizedMessageEvent
): FullAutomation | null {
    let bestAutomation: FullAutomation | null = null;
    let bestScore = -Infinity;

    for (const automation of automations) {
        // At least one trigger must match the event type
        const triggerMatches = automation.triggers.some((t) => triggerMatchesEvent(t, event));
        if (!triggerMatches) continue;

        // All conditions must be satisfied
        const { matched, score } = conditionsMatch(automation.conditions, event);
        if (!matched) continue;

        // Combined score: condition quality + priority
        const totalScore = score + automation.priority;
        if (totalScore > bestScore) {
            bestScore = totalScore;
            bestAutomation = automation;
        }
    }

    return bestAutomation;
}

// ─── Conversation Upsert ─────────────────────────────────────────────────────

async function upsertConversation(event: NormalizedMessageEvent) {
    return prisma.conversation.upsert({
        where: {
            user_id_channel_channel_account_id_external_user_id: {
                user_id: event.userId,
                channel: event.channel,
                channel_account_id: event.accountId,
                external_user_id: event.externalUserId,
            },
        },
        update: {
            display_name: event.senderName,
            updated_at: new Date(),
        },
        create: {
            user_id: event.userId,
            channel: event.channel,
            channel_account_id: event.accountId,
            external_conversation_id: event.externalConversationId,
            external_user_id: event.externalUserId,
            display_name: event.senderName ?? null,
            profile_picture_url: event.senderPicture ?? null,
            mode: "BOT",
        },
    });
}
