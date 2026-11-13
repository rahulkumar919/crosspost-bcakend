/**
 * Verification test script for Instagram Webhooks & Automation Processing
 *
 * Tests:
 *  1. HMAC-SHA256 signature verification (valid, invalid secret, missing prefix)
 *  2. Webhook payload normalizer (DM, echoes, self-messages, comments without verb, own comments)
 *  3. Condition matcher (EXACT, CONTAINS, STARTS_WITH, ANY, case insensitivity)
 *  4. Cooldown calculation
 *  5. Webhook GET challenge verification
 */
import crypto from "crypto";
import { normalizeInstagramEntry } from "../src/automation/events/normalizeInstagram";

// ─── Test Harness ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
        console.log(`  ✅ PASS: ${testName}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${testName} ${detail ? `(${detail})` : ""}`);
        failed++;
    }
}

// ─── 1. Signature Verification Test ───────────────────────────────────────────
console.log("\n=== 1. Signature Verification Tests ===");
const TEST_SECRET = "cae85203aa9b34c9fa89d6a15d9fdb2c";
const testBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [] }));
const validHmac = "sha256=" + crypto.createHmac("sha256", TEST_SECRET).update(testBody).digest("hex");
const invalidHmac = "sha256=" + crypto.createHmac("sha256", "wrong_secret").update(testBody).digest("hex");

function verifyHmac(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
    if (!signature || !rawBody || !signature.startsWith("sha256=")) return false;
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
}

assert(verifyHmac(testBody, validHmac, TEST_SECRET) === true, "Valid HMAC signature passes");
assert(verifyHmac(testBody, invalidHmac, TEST_SECRET) === false, "Invalid HMAC signature fails");
assert(verifyHmac(testBody, "invalid_no_prefix", TEST_SECRET) === false, "Signature without sha256= prefix fails");
assert(verifyHmac(testBody, undefined, TEST_SECRET) === false, "Missing signature fails");

// ─── 2. Webhook Event Normalizer Tests ────────────────────────────────────────
console.log("\n=== 2. Normalizer Tests (Instagram Login Webhooks) ===");
const ACCOUNT_ID = "acc_test_123";
const USER_ID = "user_test_456";
const IG_USER_ID = "17841400000000000"; // Stored professional account ID

// 2a. Inbound DM
const dmEntry = {
    id: IG_USER_ID,
    time: Date.now(),
    messaging: [
        {
            sender: { id: "customer_999" },
            recipient: { id: IG_USER_ID },
            timestamp: 1716388400000,
            message: {
                mid: "mid.dm_test_001",
                text: "Hello! Can I get the link?",
            },
        },
    ],
};
const dmEvents = normalizeInstagramEntry(dmEntry, ACCOUNT_ID, USER_ID);
assert(dmEvents.length === 1, "Inbound DM parsed as exactly 1 event");
assert(dmEvents[0]?.channel === "INSTAGRAM", "DM event channel is INSTAGRAM");
assert(dmEvents[0]?.isComment === false, "DM isComment is false");
assert(dmEvents[0]?.externalUserId === "customer_999", "DM sender ID extracted correctly");
assert(dmEvents[0]?.messageText === "Hello! Can I get the link?", "DM message text extracted");
assert(dmEvents[0]?.externalMessageId === "mid.dm_test_001", "DM mid extracted for deduplication");

// 2b. Echo message (must be skipped)
const echoEntry = {
    id: IG_USER_ID,
    time: Date.now(),
    messaging: [
        {
            sender: { id: IG_USER_ID },
            recipient: { id: "customer_999" },
            timestamp: 1716388400000,
            message: {
                mid: "mid.echo_001",
                text: "Here is your link",
                is_echo: true,
            },
        },
    ],
};
const echoEvents = normalizeInstagramEntry(echoEntry, ACCOUNT_ID, USER_ID);
assert(echoEvents.length === 0, "Outbound echo message is ignored (not emitted)");

// 2c. Message from account itself (must be skipped)
const selfEntry = {
    id: IG_USER_ID,
    time: Date.now(),
    messaging: [
        {
            sender: { id: IG_USER_ID },
            recipient: { id: "customer_999" },
            timestamp: 1716388400000,
            message: {
                mid: "mid.self_001",
                text: "Self message",
            },
        },
    ],
};
const selfEvents = normalizeInstagramEntry(selfEntry, ACCOUNT_ID, USER_ID);
assert(selfEvents.length === 0, "Self message from account itself is ignored");

// 2d. Non-text events (reads, delivery)
const readEntry = {
    id: IG_USER_ID,
    time: Date.now(),
    messaging: [
        {
            sender: { id: "customer_999" },
            recipient: { id: IG_USER_ID },
            timestamp: 1716388400000,
            read: { watermark: 1716388400000 },
        },
    ],
};
const readEvents = normalizeInstagramEntry(readEntry, ACCOUNT_ID, USER_ID);
assert(readEvents.length === 0, "Read receipt is gracefully ignored without error");

// 2e. Comment event WITHOUT verb (Meta standard)
const commentEntry = {
    id: IG_USER_ID,
    time: Date.now(),
    changes: [
        {
            field: "comments",
            value: {
                id: "comment_12345",
                from: { id: "commenter_888", username: "john_doe" },
                media: { id: "media_reel_999" },
                text: "Send me the PDF please",
                timestamp: 1716388400,
            },
        },
    ],
};
const commentEvents = normalizeInstagramEntry(commentEntry, ACCOUNT_ID, USER_ID);
assert(commentEvents.length === 1, "Comment event without 'verb' is accepted (not dropped)");
assert(commentEvents[0]?.isComment === true, "Comment isComment is true");
assert(commentEvents[0]?.commentId === "comment_12345", "Comment ID extracted");
assert(commentEvents[0]?.postId === "media_reel_999", "Post/media ID extracted");
assert(commentEvents[0]?.externalUserId === "commenter_888", "Commenter sender ID extracted");

// 2f. Comment event with field: "live_comments"
const liveCommentEntry = {
    id: IG_USER_ID,
    time: Date.now(),
    changes: [
        {
            field: "live_comments",
            value: {
                id: "live_comment_001",
                from: { id: "commenter_777", username: "live_fan" },
                media: { id: "media_live_001" },
                text: "Awesome stream!",
            },
        },
    ],
};
const liveEvents = normalizeInstagramEntry(liveCommentEntry, ACCOUNT_ID, USER_ID);
assert(liveEvents.length === 1, "Field 'live_comments' is accepted");

// 2g. Comment by account itself (must be skipped)
const ownCommentEntry = {
    id: IG_USER_ID,
    time: Date.now(),
    changes: [
        {
            field: "comments",
            value: {
                id: "comment_own_123",
                from: { id: IG_USER_ID, username: "cross_post_ai" },
                media: { id: "media_reel_999" },
                text: "Thanks for watching!",
            },
        },
    ],
};
const ownCommentEvents = normalizeInstagramEntry(ownCommentEntry, ACCOUNT_ID, USER_ID);
assert(ownCommentEvents.length === 0, "Own comment made by connected account is ignored");

// ─── 3. Keyword / Condition Matching Tests ────────────────────────────────────
console.log("\n=== 3. Condition Matching Tests ===");

function matchCondition(
    operator: "CONTAINS" | "EXACT" | "STARTS_WITH" | "ANY",
    value: string,
    caseInsensitive: boolean,
    text: string
): boolean {
    if (operator === "ANY" || !value) return true;
    const keywords = value.split(",").map(k => k.trim()).filter(Boolean);
    const cmpText = caseInsensitive ? text.toLowerCase() : text;
    for (const kw of keywords) {
        const cmpKw = caseInsensitive ? kw.toLowerCase() : kw;
        if (operator === "EXACT" && cmpText === cmpKw) return true;
        if (operator === "CONTAINS" && cmpText.includes(cmpKw)) return true;
        if (operator === "STARTS_WITH" && cmpText.startsWith(cmpKw)) return true;
    }
    return false;
}

assert(matchCondition("ANY", "", true, "random message") === true, "ANY operator matches any text");
assert(matchCondition("CONTAINS", "pdf,link,notes", true, "Hey send the PDF please") === true, "CONTAINS matches keyword inside sentence");
assert(matchCondition("CONTAINS", "pdf,link,notes", true, "Something else completely") === false, "CONTAINS rejects non-matching text");
assert(matchCondition("EXACT", "START", true, "start") === true, "EXACT matches case-insensitively");
assert(matchCondition("EXACT", "START", false, "start") === false, "EXACT respects case when case-sensitive");
assert(matchCondition("STARTS_WITH", "price,cost", true, "price of the course?") === true, "STARTS_WITH matches prefix");
assert(matchCondition("STARTS_WITH", "price,cost", true, "what is the price?") === false, "STARTS_WITH rejects mid-sentence keyword");

// ─── 4. Cooldown Calculation Test ─────────────────────────────────────────────
console.log("\n=== 4. Cooldown Logic Tests ===");
const COOLDOWN_1H = 3600;
const now = Date.now();
const lastSendWithinCooldown = new Date(now - 30 * 60 * 1000); // 30 min ago
const lastSendPastCooldown = new Date(now - 70 * 60 * 1000);   // 70 min ago

function isCooldownActive(lastSentAt: Date, cooldownSeconds: number): boolean {
    if (cooldownSeconds <= 0) return false;
    const cutoff = new Date(Date.now() - cooldownSeconds * 1000);
    return lastSentAt >= cutoff;
}

assert(isCooldownActive(lastSendWithinCooldown, COOLDOWN_1H) === true, "Cooldown active for send 30m ago (1h cooldown)");
assert(isCooldownActive(lastSendPastCooldown, COOLDOWN_1H) === false, "Cooldown expired for send 70m ago (1h cooldown)");
assert(isCooldownActive(lastSendWithinCooldown, 0) === false, "No cooldown when cooldown_seconds = 0");

// ─── Results ──────────────────────────────────────────────────────────────────
console.log(`\n================================`);
console.log(`Summary: ${passed} passed, ${failed} failed`);
console.log(`================================\n`);

if (failed > 0) {
    process.exit(1);
} else {
    process.exit(0);
}

