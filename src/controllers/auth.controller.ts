import { Request, Response, NextFunction } from "express";
import * as authService from "../services/auth.service";

export async function signup(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
        const { email, password, name } = req.body as {
            email: string;
            password: string;
            name?: string;
        };
        const result = await authService.signup({ email, password, name });
        res.status(201).json(result);
    } catch (err) {
        next(err);
    }
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
        const { email, password } = req.body as { email: string; password: string };
        const result = await authService.login({ email, password });
        res.json(result);
    } catch (err) {
        next(err);
    }
}

export async function me(req: Request, res: Response): Promise<void> {
    res.json({ user: req.user });
}

/** POST /auth/send-otp — validate credentials then email a 6-digit OTP */
export async function sendOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
        const { email, password } = req.body as { email: string; password: string };
        const result = await authService.sendLoginOtp(email, password);
        // Return the user's name so the frontend can show "Hi, Rahul"
        res.json({ success: true, name: result.name });
    } catch (err) {
        next(err);
    }
}

/** POST /auth/verify-otp — verify the OTP and return a JWT */
export async function verifyOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
        const { email, otp } = req.body as { email: string; otp: string };
        const result = await authService.verifyLoginOtp(email, otp);
        res.json(result);
    } catch (err) {
        next(err);
    }
}
