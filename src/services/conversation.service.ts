/**
 * Conversation Service — Unified Inbox CRUD.
 *
 * All operations scoped by userId (multi-tenant).
 */
import { prisma } from "../config/db";
import type { ConversationChannel, ConversationMode } from "@prisma/client";

export interface ConversationFilter {
    channel?: ConversationChannel;
    mode?: ConversationMode;
    search?: string;
    unreadOnly?: boolean;
    isArchived?: boolean;
}

export const conversationService = {
    async list(userId: string, filter: ConversationFilter = {}, page = 1, limit = 30) {
        const where: Record<string, unknown> = { user_id: userId };
        if (filter.channel) where.channel = filter.channel;
        if (filter.mode) where.mode = filter.mode;
        if (filter.unreadOnly) where.unread_count = { gt: 0 };
        if (filter.isArchived !== undefined) where.is_archived = filter.isArchived;
        else where.is_archived = false; // default: show non-archived
        if (filter.search) {
            where.OR = [
                { display_name: { contains: filter.search, mode: "insensitive" } },
                { external_user_id: { contains: filter.search, mode: "insensitive" } },
            ];
        }

        const [conversations, total] = await Promise.all([
            prisma.conversation.findMany({
                where,
                include: {
                    messages: {
                        orderBy: { created_at: "desc" },
                        take: 1,
                        select: { content: true, sender_type: true, created_at: true },
                    },
                    tags: {
                        include: { tag: true },
                    },
                },
                orderBy: { last_message_at: "desc" },
                skip: (page - 1) * limit,
                take: limit,
            }),
            prisma.conversation.count({ where }),
        ]);

        return { conversations, total, page, limit, pages: Math.ceil(total / limit) };
    },

    async getById(userId: string, conversationId: string) {
        const conversation = await prisma.conversation.findUnique({
            where: { id: conversationId },
            include: {
                tags: { include: { tag: true } },
            },
        });
        if (!conversation || conversation.user_id !== userId) return null;
        return conversation;
    },

    async getMessages(userId: string, conversationId: string, page = 1, limit = 50) {
        const conversation = await prisma.conversation.findUnique({
            where: { id: conversationId },
        });
        if (!conversation || conversation.user_id !== userId) return null;

        const [messages, total] = await Promise.all([
            prisma.conversationMessage.findMany({
                where: { conversation_id: conversationId },
                orderBy: { created_at: "desc" },
                skip: (page - 1) * limit,
                take: limit,
            }),
            prisma.conversationMessage.count({ where: { conversation_id: conversationId } }),
        ]);

        // Mark as read
        if (conversation.unread_count > 0) {
            await prisma.conversation.update({
                where: { id: conversationId },
                data: { unread_count: 0 },
            });
        }

        return { messages: messages.reverse(), total, page, limit };
    },

    async takeover(userId: string, conversationId: string) {
        const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
        if (!conversation || conversation.user_id !== userId) return null;
        return prisma.conversation.update({
            where: { id: conversationId },
            data: { mode: "HUMAN" },
        });
    },

    async resumeBot(userId: string, conversationId: string) {
        const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
        if (!conversation || conversation.user_id !== userId) return null;
        return prisma.conversation.update({
            where: { id: conversationId },
            data: { mode: "BOT" },
        });
    },

    async sendManualReply(userId: string, conversationId: string, content: string) {
        const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
        if (!conversation || conversation.user_id !== userId) return null;

        // Store the outbound message
        const message = await prisma.conversationMessage.create({
            data: {
                conversation_id: conversationId,
                direction: "OUTBOUND",
                sender_type: "HUMAN_AGENT",
                content,
                status: "SENT",
            },
        });

        // Actually send via platform adapter
        try {
            if (conversation.channel === "INSTAGRAM") {
                const { sendInstagramDM } = await import("../adapters/instagram-messaging");
                const account = await prisma.connectedAccount.findUnique({
                    where: { id: conversation.channel_account_id },
                });
                if (account) {
                    await sendInstagramDM(account, conversation.external_user_id, content);
                }
            } else if (conversation.channel === "WHATSAPP") {
                const { sendWhatsAppMessage } = await import("../adapters/whatsapp.adapter");
                const waAccount = await prisma.whatsAppAccount.findUnique({
                    where: { id: conversation.channel_account_id },
                });
                if (waAccount) {
                    await sendWhatsAppMessage(waAccount, conversation.external_user_id, content);
                }
            }

            await prisma.conversationMessage.update({
                where: { id: message.id },
                data: { status: "DELIVERED" },
            });
        } catch (err) {
            await prisma.conversationMessage.update({
                where: { id: message.id },
                data: { status: "FAILED" },
            });
            throw err;
        }

        // Update conversation timestamps
        await prisma.conversation.update({
            where: { id: conversationId },
            data: {
                last_message_at: new Date(),
                last_outbound_at: new Date(),
            },
        });

        return message;
    },

    async getInboxStats(userId: string) {
        const [total, unread, humanMode, igCount, waCount] = await Promise.all([
            prisma.conversation.count({ where: { user_id: userId, is_archived: false } }),
            prisma.conversation.count({ where: { user_id: userId, unread_count: { gt: 0 } } }),
            prisma.conversation.count({ where: { user_id: userId, mode: "HUMAN" } }),
            prisma.conversation.count({ where: { user_id: userId, channel: "INSTAGRAM" } }),
            prisma.conversation.count({ where: { user_id: userId, channel: "WHATSAPP" } }),
        ]);
        return { total, unread, humanMode, igCount, waCount };
    },
};
