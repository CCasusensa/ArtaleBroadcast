require("dotenv").config();

const WebSocket = require("ws");
const axios = require("axios");

const {
    DISCORD_WEBHOOK_URL,
    WS_URL,
    NEXON_MSW_PROFILE_API_BASE
} = process.env;

if (!DISCORD_WEBHOOK_URL) {
    console.error("錯誤：請在 .env 設定 DISCORD_WEBHOOK_URL");
    process.exit(1);
}
if (!WS_URL) {
    console.error("錯誤：請在 .env 設定 WS_URL");
    process.exit(1);
}

const profileCache = new Map();

class WebhookQueue {
    constructor() {
        this.queue = [];
        this.sending = false;
        this.retryDelay = 2000;
    }

    enqueue(payload) {
        this.queue.push(payload);
        this.process();
    }

    async process() {
        if (this.sending || this.queue.length === 0)
            return;
        this.sending = true;
        while (this.queue.length) {
            const payload = this.queue.shift();
            try {
                await axios.post(DISCORD_WEBHOOK_URL, payload);
                await new Promise(res => setTimeout(res, this.retryDelay));
            } catch (err) {
                const status = err.response?.status;
                if (status === 429) {
                    const retryAfter = parseFloat(err.response.headers["retry-after"] || 3);
                    console.warn(`Rate limited: retry in ${retryAfter}s`);
                    await new Promise(res => setTimeout(res, retryAfter * 1000));
                    this.queue.unshift(payload);
                } else {
                    console.error("Webhook 發送失敗：", err.message);
                    this.queue.unshift(payload);
                    await new Promise(res => setTimeout(res, this.retryDelay));
                }
            }
        }

        this.sending = false;
    }
}

const webhookQueue = new WebhookQueue();
const axiosClient = axios.create({
    timeout: 5000
});

async function getProfile(profileCode) {
    const now = Date.now();
    const cached = profileCache.get(profileCode);
    if (cached && cached.expiresAt > now) {
        return cached.data;
    }

    try {
        const {
            data: res
        } = await axiosClient.get(`${NEXON_MSW_PROFILE_API_BASE}/${profileCode}`);
        const profile = res.data;
        profileCache.set(profileCode, {
            data: profile,
            expiresAt: now + 600000
        });
        return profile;
    } catch (err) {
        console.error(`取得 Profile ${profileCode} 錯誤：`, err.message);
        return null;
    }
}

let reconnectDelay = 1000;
const MAX_DELAY = 30000;
let ws;

function connect() {
    ws = new WebSocket(WS_URL);

    ws.on("open", () => {
        console.log("WebSocket 已連線");
        reconnectDelay = 1000;
    });

    ws.on("message", async raw => {
        try {
            const msg = JSON.parse(raw.toString());
            const {
                ProfileCode,
                Nickname,
                Text,
                Channel,
                timestamp
            } = msg;
            if (!ProfileCode || !Nickname || !Text)
                return;

            const profile = await getProfile(ProfileCode);
            const avatarUrl = profile?.profileImageUrl;

            const content = `頻道: ${Channel || "未知"}\n內容: ${Text}\n時間: ${timestamp || new Date().toISOString()}`;
            webhookQueue.enqueue({
                username: `${Nickname}#${ProfileCode}`,
                avatar_url: avatarUrl,
                content
            });
        } catch (err) {
            console.error(err.message);
        }
    });

    ws.on("close", () => {
        console.warn(`連線關閉，${reconnectDelay / 1000}s 後重連...`);
        setTimeout(() => {
            reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
            connect();
        }, reconnectDelay);
    });

    ws.on("error", err => {
        console.error("WebSocket 錯誤：", err.message);
        ws.close();
    });
}

process.on("SIGINT", () => {
    ws.close();
    process.exit();
});

connect();
