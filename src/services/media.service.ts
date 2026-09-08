import { cloudinary } from "../lib/cloudinary";
import { AppError } from "../middleware/error-handler.middleware";
import type { UploadApiResponse } from "cloudinary";

export interface UploadedMedia {
    mediaId: string;      // Cloudinary public_id
    url: string;          // Secure CDN URL
    type: "VIDEO" | "IMAGE";
    thumbnailUrl?: string;
    durationSeconds?: number;
    width?: number;
    height?: number;
    bytes: number;
    format: string;
}

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;   // 50 MB
// Frontend compresses videos to ≤95 MB before uploading.
// 100 MB is the Cloudinary Free plan hard limit for uploads.
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;  // 100 MB

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

export async function uploadMedia(
    fileBuffer: Buffer,
    mimeType: string,
    _originalName: string
): Promise<UploadedMedia> {
    const isImage = ALLOWED_IMAGE_TYPES.has(mimeType);
    const isVideo = ALLOWED_VIDEO_TYPES.has(mimeType);

    if (!isImage && !isVideo) {
        throw new AppError(
            "Unsupported file type. Allowed: JPEG, PNG, WebP, MP4, MOV, WebM.",
            400,
            "UNSUPPORTED_MEDIA_TYPE"
        );
    }

    const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (fileBuffer.length > maxBytes) {
        throw new AppError(
            `File too large. Maximum size is ${isVideo ? "500 MB" : "50 MB"}.`,
            413,
            "FILE_TOO_LARGE"
        );
    }

    const resourceType = isVideo ? "video" : "image";

    const uploadResult = await new Promise<UploadApiResponse>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                resource_type: resourceType,
                folder: "crosspost-ai",
                use_filename: true,
                unique_filename: true,
                // Note: eager transformations are NOT used here because they
                // fail silently on Cloudinary Free plan for files >40 MB.
                // Thumbnails are generated on-demand via URL transformation instead.
            },
            (error, result) => {
                if (error || !result) return reject(error ?? new Error("Cloudinary upload failed"));
                resolve(result);
            }
        );
        stream.end(fileBuffer);
    });

    // Generate thumbnail URL via Cloudinary URL transformation (free, no eager needed).
    // Replace the file extension with .jpg to get the first frame.
    const thumbnailUrl = isVideo
        ? uploadResult.secure_url.replace(/\.[^.]+$/, ".jpg")
        : undefined;

    return {
        mediaId: uploadResult.public_id,
        url: uploadResult.secure_url,
        type: isVideo ? "VIDEO" : "IMAGE",
        thumbnailUrl,
        durationSeconds: uploadResult.duration,
        width: uploadResult.width,
        height: uploadResult.height,
        bytes: uploadResult.bytes,
        format: uploadResult.format,
    };
}
