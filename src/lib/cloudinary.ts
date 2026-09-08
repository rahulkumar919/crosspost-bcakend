import { v2 as cloudinary } from "cloudinary";
import { env } from "../config/env";

cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
});

export { cloudinary };

/** Ping Cloudinary to verify credentials — used by /health */
export async function pingCloudinary(): Promise<boolean> {
    try {
        await cloudinary.api.ping();
        return true;
    } catch {
        return false;
    }
}
