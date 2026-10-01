/**
 * ActionExecutor — executes the resolved automation actions.
 *
 * Actions are executed in their defined order (AutomationAction.order).
 * Supports:
 *   - SEND_MESSAGE         → DM / WhatsApp text message
 *   - SEND_PUBLIC_REPLY    → Instagram comment reply (public)
 *   - SEND_PRIVATE_REPLY   → Instagram DM triggered by comment
 *   - SEND_LINK            → message with embedded URL
 *   - AI_REPLY             → route to ConversationAIService
 *   - ASSIGN_HUMAN         → set conversation.mode = HUMAN
 *   - TAG_CONVERSATION     → create/attach tag
 *   - PAUSE_AUTOMATION     → set conversation.mode = PAUSED
 */
import { prisma } from "../config/db";
import { logger } from "../lib/logger";
import { sendInstagramDM, sendInstagramCommentReply } from "../adapters/instagram-messaging";
import { sendWhatsAppMessage } from "../adapters/whatsapp.adapter";
import { getConversationAIReply } from "./ConversationAIService";
import type { NormalizedMessageEvent } from "./events/NormalizedEvent";
import type {
    Automation,
    AutomationAction,
    AutomationTrigger,
    AutomationCondition,
    Conversation,
} from "@prisma/client";

type FullAutomation = Automation & {
    triggers: AutomationTrigger[];
    conditions: AutomationCondition[];
    actions: AutomationAction[];
};

export interface ExecutionResult {
    success: boolean;
    errorMessage?: string;
    actionsExecuted: ActionLog[];
}

interface ActionLog {
    type: string;
    success: boolean;
    error?: string;
    sentText?: string;
}

// Action config shapes
interface SendMessageConfig { message: string }
interface SendLinkConfig { message: string; buttonText: string; url: string }
interface TagConfig { tagName: string; color?: string }

// ─── Main Executor ────────────────────────────────────────────────────────────

export async function executeAutomationActions(
    automation: FullAutomation,
    event: NormalizedMessageEvent,
    conversation: Conversation,
): Promise<ExecutionResult> {
    const logs: ActionLog[] = [];
    let overallSuccess = true;
    let overallError: string | undefined;

    for (const action of automation.actions) {
        const config = action.config as Record<string, unknown>;
        let actionLog: ActionLog = { type: action.type, success: false };

        try {
            switch (action.type) {

                // ── Send text message ─────────────────────────────────────
                case "SEND_MESSAGE": {
                    const { message } = config as unknown as SendMessageConfig;
                    const sentText = await sendOutbound(event, conversation, message, automation.id);
                    actionLog = { type: action.type, success: true, sentText };
                    break;
                }

                // ── Public comment reply (Instagram only) ─────────────────
                case "SEND_PUBLIC_REPLY": {
                    if (event.channel !== "INSTAGRAM" || !event.commentId) {
                        actionLog = { type: action.type, success: false, error: "Not an Instagram comment event" };
                        break;
                    }
                    const { message } = config as unknown as SendMessageConfig;
                    const account = await getInstagramAccount(event.accountId);
                    if (!account) throw new Error("Instagram account not found");
                    await sendInstagramCommentReply(account, event.commentId, message);
                    await storeOutboundMessage(conversation, message, automation.id);
                    actionLog = { type: action.type, success: true, sentText: message };
                    break;
                }

                // ── Private reply to a comment (sends DM) ────────────────
                case "SEND_PRIVATE_REPLY": {
                    const { message } = config as unknown as SendMessageConfig;
                    const sentText = await sendOutbound(event, conversation, message, automation.id);
                    actionLog = { type: action.type, success: true, sentText };
                    break;
                }

                // ── Send link (text + URL, no fake buttons) ───────────────
                case "SEND_LINK": {
                    const { message, buttonText, url } = config as unknown as SendLinkConfig;
                    // Validate URL — only https/http
                    if (!/^https?:\/\//i.test(url ?? "")) {
                        throw new Error(`Invalid URL in SEND_LINK action: ${url}`);
                    }
                    const linkText = `${message}\n\n${buttonText}: ${url}`.trim();
                    const sentText = await sendOutbound(event, conversation, linkText, automation.id);
                    actionLog = { type: action.type, success: true, sentText };
                    break;
                }

                // ── AI reply ──────────────────────────────────────────────
                case "AI_REPLY": {
                    const aiText = await getConversationAIReply(event, conversation);
                    if (aiText) {
                        const sentText = await sendOutbound(event, conversation, aiText, automation.id);
                        actionLog = { type: action.type, success: true, sentText };
                    } else {
                        actionLog = { type: action.type, success: false, error: "AI returned empty response" };
                    }
                    break;
                }

                // ── Human takeover ────────────────────────────────────────
                case "ASSIGN_HUMAN": {
                    await prisma.conversation.update({
                        where: { id: conversation.id },
                        data: { mode: "HUMAN" },
                    });
                    actionLog = { type: action.type, success: true };
                    break;
                }

                // ── Tag conversation ──────────────────────────────────────
                case "TAG_CONVERSATION": {
                    const { tagName, color } = config as unknown as TagConfig;
                    await attachTag(conversation.id, event.userId, tagName, color);
                    actionLog = { type: action.type, success: true };
                    break;
                }

                // ── Pause automation for this conversation ────────────────
                case "PAUSE_AUTOMATION": {
                    await prisma.conversation.update({
                        where: { id: conversation.id },
                        data: { mode: "PAUSED" },
                    });
                    actionLog = { type: action.type, success: true };
                    break;
                }

                default:
                    actionLog = { type: action.type, success: false, error: `Unknown action type: ${action.type}` };
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            actionLog = { type: action.type, success: false, error: errMsg };
            overallSuccess = false;
            overallError = errMsg;
            logger.error("ActionExecutor: action failed", {
                actionType: action.type,
                automationId: automation.id,
                error: errMsg,
            });
        }

        logs.push(actionLog);

        // Stop executing if human takeover was triggered
        if (action.type === "ASSIGN_HUMAN" || action.type === "PAUSE_AUTOMATION") break;
    }

    return { success: overallSuccess, errorMessage: overallError, actionsExecuted: logs };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function sendOutbound(
    event: NormalizedMessageEvent,
    conversation: Conversation,
    text: string,
    automationId: string
): Promise<string> {
    if (event.channel === "INSTAGRAM") {
        const account = await getInstagramAccount(event.accountId);
        if (!account) throw new Error("Instagram account not found or expired");
        await sendInstagramDM(account, event.externalUserId, text);
    } else if (event.channel === "WHATSAPP") {
        const waAccount = await prisma.whatsAppAccount.findUnique({
            where: { id: event.accountId },
        });
        if (!waAccount) throw new Error("WhatsApp account not found");
        await sendWhatsAppMessage(waAccount, event.externalUserId, text);
    }

    await storeOutboundMessage(conversation, text, automationId);

    await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
            last_message_at: new Date(),
            last_outbound_at: new Date(),
        },
    });

    return text;
}

async function storeOutboundMessage(
    conversation: Conversation,
    content: string,
    automationId: string
): Promise<void> {
    await prisma.conversationMessage.create({
        data: {
            conversation_id: conversation.id,
            direction: "OUTBOUND",
            sender_type: "BOT",
            content,
            automation_id: automationId,
            status: "SENT",
        },
    });
}

async function getInstagramAccount(accountId: string) {
    return prisma.connectedAccount.findUnique({
        where: { id: accountId },
    });
}

async function attachTag(
    conversationId: string,
    userId: string,
    tagName: string,
    color = "#6C5CE7"
): Promise<void> {
    const tag = await prisma.conversationTag.upsert({
        where: { user_id_name: { user_id: userId, name: tagName } },
        update: {},
        create: { user_id: userId, name: tagName, color },
    });

    await prisma.conversationTagLink.upsert({
        where: {
            conversation_id_tag_id: { conversation_id: conversationId, tag_id: tag.id },
        },
        update: {},
        create: { conversation_id: conversationId, tag_id: tag.id },
    });
}
