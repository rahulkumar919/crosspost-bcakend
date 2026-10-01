/**
 * Automation Service — CRUD operations for automations.
 *
 * All operations are scoped to the requesting user (multi-tenant security).
 */
import { prisma } from "../config/db";
import type {
    AutomationChannel,
    AutomationTriggerType,
    AutomationConditionOperator,
    AutomationActionType,
    AIMode,
} from "@prisma/client";

// ─── Input Types ──────────────────────────────────────────────────────────────

export interface CreateAutomationInput {
    name: string;
    description?: string;
    channel: AutomationChannel;
    priority?: number;
    ai_mode?: AIMode;
    cooldown_seconds?: number;
    triggers: Array<{
        type: AutomationTriggerType;
        ig_post_id?: string;
    }>;
    conditions: Array<{
        field?: string;
        operator: AutomationConditionOperator;
        value: string;
        case_insensitive?: boolean;
    }>;
    actions: Array<{
        type: AutomationActionType;
        order?: number;
        config: Record<string, unknown>;
    }>;
}

export interface UpdateAutomationInput {
    name?: string;
    description?: string;
    channel?: AutomationChannel;
    priority?: number;
    ai_mode?: AIMode;
    cooldown_seconds?: number;
    triggers?: CreateAutomationInput["triggers"];
    conditions?: CreateAutomationInput["conditions"];
    actions?: CreateAutomationInput["actions"];
}

// ─── Service ──────────────────────────────────────────────────────────────────

export const automationService = {
    async list(userId: string) {
        return prisma.automation.findMany({
            where: { user_id: userId },
            include: {
                triggers: true,
                conditions: true,
                actions: { orderBy: { order: "asc" } },
                _count: { select: { executions: true } },
            },
            orderBy: { created_at: "desc" },
        });
    },

    async getById(userId: string, automationId: string) {
        const automation = await prisma.automation.findUnique({
            where: { id: automationId },
            include: {
                triggers: true,
                conditions: true,
                actions: { orderBy: { order: "asc" } },
                executions: {
                    orderBy: { executed_at: "desc" },
                    take: 20,
                },
            },
        });
        if (!automation || automation.user_id !== userId) return null;
        return automation;
    },

    async create(userId: string, input: CreateAutomationInput) {
        return prisma.automation.create({
            data: {
                user_id: userId,
                name: input.name,
                description: input.description,
                channel: input.channel,
                priority: input.priority ?? 10,
                ai_mode: input.ai_mode ?? "FIXED_ONLY",
                cooldown_seconds: input.cooldown_seconds ?? 0,
                status: "DRAFT",
                triggers: {
                    create: input.triggers.map((t) => ({
                        type: t.type,
                        ig_post_id: t.ig_post_id,
                    })),
                },
                conditions: {
                    create: input.conditions.map((c) => ({
                        field: c.field ?? "message_text",
                        operator: c.operator,
                        value: c.value,
                        case_insensitive: c.case_insensitive ?? true,
                    })),
                },
                actions: {
                    create: input.actions.map((a, i) => ({
                        type: a.type,
                        order: a.order ?? i,
                        config: a.config as object,
                    })),
                },
            },
            include: {
                triggers: true,
                conditions: true,
                actions: { orderBy: { order: "asc" } },
            },
        });
    },

    async update(userId: string, automationId: string, input: UpdateAutomationInput) {
        const existing = await prisma.automation.findUnique({ where: { id: automationId } });
        if (!existing || existing.user_id !== userId) return null;

        // If triggers/conditions/actions provided, delete old ones first and recreate
        return prisma.$transaction(async (tx) => {
            if (input.triggers) {
                await tx.automationTrigger.deleteMany({ where: { automation_id: automationId } });
            }
            if (input.conditions) {
                await tx.automationCondition.deleteMany({ where: { automation_id: automationId } });
            }
            if (input.actions) {
                await tx.automationAction.deleteMany({ where: { automation_id: automationId } });
            }

            return tx.automation.update({
                where: { id: automationId },
                data: {
                    ...(input.name !== undefined && { name: input.name }),
                    ...(input.description !== undefined && { description: input.description }),
                    ...(input.channel !== undefined && { channel: input.channel }),
                    ...(input.priority !== undefined && { priority: input.priority }),
                    ...(input.ai_mode !== undefined && { ai_mode: input.ai_mode }),
                    ...(input.cooldown_seconds !== undefined && { cooldown_seconds: input.cooldown_seconds }),
                    ...(input.triggers && {
                        triggers: {
                            create: input.triggers.map((t) => ({
                                type: t.type,
                                ig_post_id: t.ig_post_id,
                            })),
                        },
                    }),
                    ...(input.conditions && {
                        conditions: {
                            create: input.conditions.map((c) => ({
                                field: c.field ?? "message_text",
                                operator: c.operator,
                                value: c.value,
                                case_insensitive: c.case_insensitive ?? true,
                            })),
                        },
                    }),
                    ...(input.actions && {
                        actions: {
                            create: input.actions.map((a, i) => ({
                                type: a.type,
                                order: a.order ?? i,
                                config: a.config as object,
                            })),
                        },
                    }),
                },
                include: {
                    triggers: true,
                    conditions: true,
                    actions: { orderBy: { order: "asc" } },
                },
            });
        });
    },

    async delete(userId: string, automationId: string) {
        const existing = await prisma.automation.findUnique({ where: { id: automationId } });
        if (!existing || existing.user_id !== userId) return false;
        await prisma.automation.delete({ where: { id: automationId } });
        return true;
    },

    async activate(userId: string, automationId: string) {
        const existing = await prisma.automation.findUnique({ where: { id: automationId } });
        if (!existing || existing.user_id !== userId) return null;
        return prisma.automation.update({
            where: { id: automationId },
            data: { status: "ACTIVE" },
        });
    },

    async pause(userId: string, automationId: string) {
        const existing = await prisma.automation.findUnique({ where: { id: automationId } });
        if (!existing || existing.user_id !== userId) return null;
        return prisma.automation.update({
            where: { id: automationId },
            data: { status: "PAUSED" },
        });
    },

    async getLogs(userId: string, automationId: string, limit = 50) {
        const existing = await prisma.automation.findUnique({ where: { id: automationId } });
        if (!existing || existing.user_id !== userId) return null;
        return prisma.automationExecution.findMany({
            where: { automation_id: automationId },
            orderBy: { executed_at: "desc" },
            take: limit,
        });
    },

    async getStats(userId: string) {
        const [total, active, paused] = await Promise.all([
            prisma.automation.count({ where: { user_id: userId } }),
            prisma.automation.count({ where: { user_id: userId, status: "ACTIVE" } }),
            prisma.automation.count({ where: { user_id: userId, status: "PAUSED" } }),
        ]);

        const [totalExecs, successExecs, aiReplies] = await Promise.all([
            prisma.automationExecution.count({
                where: { automation: { user_id: userId } },
            }),
            prisma.automationExecution.count({
                where: { automation: { user_id: userId }, success: true },
            }),
            // Count executions that have AI_REPLY actions — uses JSON array filtering
            prisma.automationExecution.count({
                where: {
                    automation: { user_id: userId },
                    actions_executed: {
                        array_contains: [{ type: "AI_REPLY" }],
                    },
                },
            }),
        ]);

        const [igConversations, waConversations] = await Promise.all([
            prisma.conversation.count({ where: { user_id: userId, channel: "INSTAGRAM" } }),
            prisma.conversation.count({ where: { user_id: userId, channel: "WHATSAPP" } }),
        ]);

        return {
            total,
            active,
            paused,
            totalExecs,
            successExecs,
            failedExecs: totalExecs - successExecs,
            aiReplies,
            igConversations,
            waConversations,
        };
    },
};
