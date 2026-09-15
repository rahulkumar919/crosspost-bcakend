/**
 * Nodemailer transporter for sending OTP emails via Gmail.
 * Requires SMTP_USER (Gmail address) and SMTP_PASS (Gmail App Password).
 *
 * To create a Gmail App Password:
 * myaccount.google.com → Security → 2-Step Verification → App Passwords
 */
import nodemailer from "nodemailer";
import { env } from "../config/env";
import { logger } from "./logger";

function createTransporter() {
    if (!env.SMTP_USER || !env.SMTP_PASS) {
        logger.warn("SMTP_USER or SMTP_PASS not set — email sending will be disabled.");
        return null;
    }
    return nodemailer.createTransport({
        service: "gmail",
        auth: {
            user: env.SMTP_USER,
            pass: env.SMTP_PASS,
        },
    });
}

const transporter = createTransporter();

export async function sendOtpEmail(to: string, otp: string): Promise<void> {
    if (!transporter) {
        // SMTP not configured — log OTP to console (dev fallback)
        logger.info(`[DEV] OTP for ${to}: ${otp}`);
        return;
    }

    try {
        await transporter.sendMail({
            from: `"CrossPost AI" <${env.SMTP_USER}>`,
            to,
            subject: "Your CrossPost AI verification code",
            html: `
                <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#f8f7ff;border-radius:16px;">
                    <div style="text-align:center;margin-bottom:24px;">
                        <div style="display:inline-block;background:#5b4fe9;border-radius:12px;padding:12px 16px;">
                            <span style="color:white;font-size:20px;font-weight:bold;">CrossPost AI</span>
                        </div>
                    </div>
                    <h2 style="color:#1a1825;font-size:22px;margin:0 0 8px;">Your verification code</h2>
                    <p style="color:#6b6882;font-size:14px;margin:0 0 24px;">
                        Enter this code to sign in. It expires in <strong>5 minutes</strong>.
                    </p>
                    <div style="background:white;border:2px solid #e5e3f5;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;">
                        <span style="font-size:40px;font-weight:900;letter-spacing:12px;color:#5b4fe9;font-family:monospace;">${otp}</span>
                    </div>
                    <p style="color:#9896b0;font-size:12px;text-align:center;margin:0;">
                        If you didn't request this, you can safely ignore this email.
                    </p>
                </div>
            `,
        });
    } catch (err) {
        // Email delivery failed — fall back to console so login still works
        logger.warn("Failed to send OTP email — falling back to console log.", {
            error: (err as Error).message,
            hint: "Check SMTP_USER and SMTP_PASS in .env. Use a Gmail App Password, not your regular password.",
        });
        logger.info(`[FALLBACK] OTP for ${to}: ${otp}`);
    }
}
