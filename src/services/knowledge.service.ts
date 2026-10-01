/**
 * Knowledge Base Service — CRUD for the creator's AI knowledge.
 *
 * One KnowledgeBase per user. All fields are editable.
 */
import { prisma } from "../config/db";

export interface KnowledgeBaseInput {
    creator_name?: string;
    about?: string;
    topics?: string[];
    services?: Array<{ name: string; description: string }>;
    courses?: Array<{ name: string; url?: string; description?: string }>;
    resources?: Array<{ name: string; url: string; description?: string }>;
    faqs?: Array<{ question: string; answer: string }>;
    links?: Array<{ label: string; url: string }>;
    contact?: Record<string, string>;
    policies?: string;
    ai_system_prompt?: string;
}

export const knowledgeService = {
    async get(userId: string) {
        return prisma.knowledgeBase.findUnique({
            where: { user_id: userId },
        });
    },

    async upsert(userId: string, input: KnowledgeBaseInput) {
        return prisma.knowledgeBase.upsert({
            where: { user_id: userId },
            update: {
                ...(input.creator_name !== undefined && { creator_name: input.creator_name }),
                ...(input.about !== undefined && { about: input.about }),
                ...(input.topics !== undefined && { topics: input.topics }),
                ...(input.services !== undefined && { services: input.services as object }),
                ...(input.courses !== undefined && { courses: input.courses as object }),
                ...(input.resources !== undefined && { resources: input.resources as object }),
                ...(input.faqs !== undefined && { faqs: input.faqs as object }),
                ...(input.links !== undefined && { links: input.links as object }),
                ...(input.contact !== undefined && { contact: input.contact as object }),
                ...(input.policies !== undefined && { policies: input.policies }),
                ...(input.ai_system_prompt !== undefined && { ai_system_prompt: input.ai_system_prompt }),
            },
            create: {
                user_id: userId,
                creator_name: input.creator_name ?? "",
                about: input.about ?? "",
                topics: input.topics ?? [],
                services: (input.services ?? []) as object,
                courses: (input.courses ?? []) as object,
                resources: (input.resources ?? []) as object,
                faqs: (input.faqs ?? []) as object,
                links: (input.links ?? []) as object,
                contact: (input.contact ?? {}) as object,
                policies: input.policies ?? "",
                ai_system_prompt: input.ai_system_prompt,
            },
        });
    },

    async delete(userId: string) {
        return prisma.knowledgeBase.delete({
            where: { user_id: userId },
        }).catch(() => null);
    },
};
