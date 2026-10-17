// Augment Express Request to carry the raw body buffer and the authenticated user.
// rawBody: populated by the express.json verify callback in app.ts — used for
//          Meta webhook HMAC-SHA256 signature verification.
// user:    populated by requireAuth middleware after JWT validation.
declare namespace Express {
    interface Request {
        rawBody?: Buffer;
        user?: {
            id: string;
            email: string;
        };
    }
}
