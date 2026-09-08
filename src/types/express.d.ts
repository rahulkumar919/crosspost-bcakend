// Augment Express Request to carry the authenticated user after JWT verification
import "express";

declare module "express" {
    interface Request {
        user?: {
            id: string;
            email: string;
        };
    }
}
