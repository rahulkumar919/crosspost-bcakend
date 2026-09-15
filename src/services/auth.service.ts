import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { prisma } from "../config/db";
import { memoryStore } from "../lib/memory-store";
import { env } from "../config/env";
import { AppError } from "../middleware/error-handler.middleware";
import { sendOtpEmail } from "../lib/mailer";
import { logger } from "../lib/logger";

const SALT_ROUNDS = 12;
const OTP_TTL_SECONDS = 300; // 5 minutes
const OTP_LENGTH = 6;

interface SignupInput {
    email: string;
    password: string;
    name?: string;
}

interface LoginInput {
    email: string;
    password: string;
}

interface AuthResult {
    token: string;
    user: { id: string; email: string; name: string | null };
}

export async function signup(input: SignupInput): Promise<AuthResult> {
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
        throw new AppError("An account with this email already exists.", 409, "EMAIL_TAKEN");
    }

    const password_hash = await bcrypt.hash(input.password, SALT_ROUNDS);

    const user = await prisma.user.create({
        data: { email: input.email, password_hash, name: input.name ?? null },
        select: { id: true, email: true, name: true },
    });

    const token = signToken(user.id, user.email);
    return { token, user };
}

/**
 * Google OAuth upsert — finds or creates a user and always ensures the
 * google_oauth password is set. Used by the Next.js refresh-backend-token route
 * so Google-authenticated users can always get a backend JWT regardless of
 * whether they previously signed up via OTP with a different password.
 */
export async function googleUpsert(email: string, name: string | null): Promise<AuthResult> {
    const googlePassword = `google_oauth_${email}_crosspost_ai`;
    const passwordHash = await bcrypt.hash(googlePassword, SALT_ROUNDS);

    // upsert: create if missing, update password_hash if exists
    const user = await prisma.user.upsert({
        where: { email },
        update: { password_hash: passwordHash, name: name ?? undefined },
        create: { email, password_hash: passwordHash, name: name ?? null },
        select: { id: true, email: true, name: true },
    });

    const token = signToken(user.id, user.email);
    return { token, user };
}

export async function login(input: LoginInput): Promise<AuthResult> {
    const user = await prisma.user.findUnique({
        where: { email: input.email },
        select: { id: true, email: true, name: true, password_hash: true },
    });

    // Constant-time comparison even on lookup miss (use dummy hash)
    const dummyHash = "$2b$12$invalidhashfortimingnormalization000000000000000000000";
    const hash = user?.password_hash ?? dummyHash;
    const valid = await bcrypt.compare(input.password, hash);

    if (!user || !valid) {
        throw new AppError("Invalid email or password.", 401, "INVALID_CREDENTIALS");
    }

    const token = signToken(user.id, user.email);
    return { token, user: { id: user.id, email: user.email, name: user.name } };
}

/**
 * Validates credentials and sends a 6-digit OTP to the user's email.
 * OTP is stored in the in-memory store with a 5-minute TTL.
 *
 * Returns { name } of the user (existing or auto-created).
 */
export async function sendLoginOtp(email: string, password: string): Promise<{ name: string | null }> {
    let user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, name: true, password_hash: true },
    });

    if (!user) {
        // Auto-create account on first login (no separate signup needed)
        if (password.length < 8) {
            throw new AppError("Password must be at least 8 characters.", 400, "PASSWORD_TOO_SHORT");
        }
        const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
        // Derive a display name from the email prefix
        const name = email.split("@")[0].replace(/[._\-+]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        user = await prisma.user.create({
            data: { email, password_hash, name },
            select: { id: true, email: true, name: true, password_hash: true },
        });
        logger.info("Auto-created user on first login", { email });
    } else {
        // Existing user — verify password
        const valid = await bcrypt.compare(password, user.password_hash ?? "");
        if (!valid) {
            throw new AppError("Invalid email or password.", 401, "INVALID_CREDENTIALS");
        }
    }

    // Generate OTP and store: key = otp:<email>, value = <otp>:<userId>
    const otp = crypto.randomInt(100000, 999999).toString().padStart(OTP_LENGTH, "0");
    memoryStore.setex(`otp:${email}`, OTP_TTL_SECONDS, `${otp}:${user.id}`);

    // Send email
    await sendOtpEmail(email, otp);
    logger.info("OTP sent", { email });

    return { name: user.name };
}

/**
 * Verifies the OTP and returns a JWT if correct.
 */
export async function verifyLoginOtp(email: string, otp: string): Promise<AuthResult> {
    const otpKey = `otp:${email}`;
    const storedValue = memoryStore.get(otpKey);

    if (!storedValue) {
        throw new AppError("OTP has expired or is invalid. Please request a new one.", 400, "OTP_EXPIRED");
    }

    const [storedOtp, userId] = storedValue.split(":");

    if (storedOtp !== otp) {
        throw new AppError("Incorrect verification code. Please try again.", 400, "OTP_INVALID");
    }

    // Delete OTP — single use
    memoryStore.del(otpKey);

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true },
    });

    if (!user) {
        throw new AppError("User not found.", 404, "USER_NOT_FOUND");
    }

    const token = signToken(user.id, user.email);
    return { token, user };
}

function signToken(userId: string, email: string): string {
    return jwt.sign({ id: userId, email }, env.JWT_SECRET, {
        expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
    });
}
