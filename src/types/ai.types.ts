export interface GenerateContentRequest {
    rawCaption: string;
    mediaType: "video" | "image";
    platforms: string[];
}

export interface EnhanceContentRequest {
    title: string;
    description: string;
    hashtags: string[];
    platforms: string[];
}

export interface AIContentResult {
    title: string;
    description: string;
    hashtags: string[];
}
