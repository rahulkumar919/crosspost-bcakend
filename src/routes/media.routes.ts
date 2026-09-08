import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../middleware/auth.middleware";
import * as mediaController from "../controllers/media.controller";

const router = Router();

// Keep files in memory — we stream directly to Cloudinary
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB hard limit at multer level
    fileFilter: (_req, file, cb) => {
        const allowed = [
            "image/jpeg", "image/png", "image/webp",
            "video/mp4", "video/quicktime", "video/webm",
        ];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error("Unsupported file type."));
        }
    },
});

// POST /media/upload
router.post(
    "/upload",
    requireAuth,
    upload.single("file"),
    mediaController.upload
);

export default router;
