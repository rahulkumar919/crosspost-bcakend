/**
 * WhatsApp Config API routes
 *
 * Allows creators to securely configure their WhatsApp Business account.
 * Tokens are encrypted before storage.
 */
import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import { prisma } from "../config/db";
import { encrypt } from "../lib/encryption";

const router = Router();

router.use(requireAuth);

// GET /whatsapp/config — get current WhatsApp config (masked)
router.get("/config", async (req: Request, res: Response) => {
    try {
        const wa = await prisma.whatsAppAccount.findUnique({
            where: { user_id: req.user!.id },
        });
        if (!wa) {
            res.json({ connected: false });
            return;
        }
        res.json({
            connected: true,
            phone_number_id: wa.phone_number_id,
            waba_id: wa.waba_id,
            display_phone: wa.display_phone,
            status: wa.status,
            // NEVER expose access_token to frontend
        });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to get WhatsApp config";
        res.status(500).json({ error: msg });
    }
});

// POST /whatsapp/config — save WhatsApp config
router.post("/config", async (req: Request, res: Response) => {
    try {
        const { phone_number_id, waba_id, display_phone, access_token } = req.body;

        if (!phone_number_id || !waba_id || !access_token) {
            res.status(400).json({
                error: "phone_number_id, waba_id, and access_token are required",
            });
            return;
        }

        const encryptedToken = encrypt(access_token);

        const wa = await prisma.whatsAppAccount.upsert({
            where: { user_id: req.user!.id },
            update: {
                phone_number_id,
                waba_id,
                display_phone: display_phone || "",
                access_token: encryptedToken,
                status: "CONNECTED",
            },
            create: {
                user_id: req.user!.id,
                phone_number_id,
                waba_id,
                display_phone: display_phone || "",
                access_token: encryptedToken,
                status: "CONNECTED",
            },
        });

        res.json({
            connected: true,
            phone_number_id: wa.phone_number_id,
            waba_id: wa.waba_id,
            display_phone: wa.display_phone,
            status: wa.status,
        });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to save WhatsApp config";
        res.status(500).json({ error: msg });
    }
});

// DELETE /whatsapp/config — disconnect WhatsApp
router.delete("/config", async (req: Request, res: Response) => {
    try {
        await prisma.whatsAppAccount.delete({
            where: { user_id: req.user!.id },
        }).catch(() => null);
        res.json({ connected: false });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to disconnect WhatsApp";
        res.status(500).json({ error: msg });
    }
});

export default router;
