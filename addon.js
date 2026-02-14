require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

const ADDON_NAME = "PRO IPTV RO";
const ADDON_ID = "org.stremio.m3u-epg-ro";

const RO_TIME_OPTS = { 
    hour: '2-digit', 
    minute: '2-digit', 
    timeZone: 'Europe/Bucharest', 
    hour12: false 
};

class M3UEPGAddon {
    constructor(config = {}) {
        this.config = config;
        this.channels = [];
        this.lastUpdate = 0;
        this.isUpdating = false;
    }

    getProgressBar(start, end) {
        const now = new Date();
        const total = end - start;
        const elapsed = now - start;
        const progress = Math.max(0, Math.min(100, Math.round((elapsed / total) * 100)));
        const size = 10;
        const filled = Math.round((progress / 100) * size);
        return `${"🟢".repeat(filled)}${"⚪".repeat(size - filled)} ${progress}%`;
    }

    async getXtreamEpg(streamId) {
        const url = `${this.config.xtreamUrl}/player_api.php?username=${this.config.xtreamUsername}&password=${this.config.xtreamPassword}&action=get_short_epg&stream_id=${streamId}`;
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3000 });
            const data = await res.json();
            if (!data || !data.epg_listings) return null;
            
            const decode = (str) => {
                try { return Buffer.from(str, 'base64').toString('utf-8'); }
                catch(e) { return str; }
            };

            return data.epg_listings.map(p => ({
                title: decode(p.title),
                desc: decode(p.description),
                start: new Date(p.start),
                end: new Date(p.end),
                duration: Math.round((new Date(p.end) - new Date(p.start)) / 60000)
            }));
        } catch (e) { return null; }
    }

    async updateData() {
        if (this.isUpdating) return;
        if (Date.now() - this.lastUpdate < 1800000 && this.channels.length > 0) return;
        
        this.isUpdating = true;
        try {
            const url = `${this.config.xtreamUrl}/player_api.php?username=${this.config.xtreamUsername}&password=${this.config.xtreamPassword}&action=get_live_streams`;
            const res = await fetch(url, { timeout: 10000 }); // Limită 10s
            const streams = await res.json();
            
            if (Array.isArray(streams)) {
                this.channels = streams.map(s => ({
                    id: `iptv_${s.stream_id}`,
                    name: s.name,
                    logo: s.stream_icon || "",
                    url: `${this.config.xtreamUrl}/live/${this.config.xtreamUsername}/${this.config.xtreamPassword}/${s.stream_id}.ts`
                }));
                this.lastUpdate = Date.now();
            }
        } catch (e) {
            console.error("Fetch failed:", e.message);
        } finally {
            this.isUpdating = false;
        }
    }
}

// FUNCȚIA PRINCIPALĂ NU MAI ESTE ASYNC PENTRU MANIFEST (Esențial pentru viteza Vercel)
function createAddon(config) {
    const addon = new M3UEPGAddon(config);

    const builder = new addonBuilder({
        id: ADDON_ID,
        version: "4.1.0",
        name: ADDON_NAME,
        resources: ["catalog", "stream", "meta"],
        types: ["tv"],
        catalogs: [
            { 
                type: 'tv', 
                id: 'iptv_search', 
                name: '📺 Toate Canalele', 
                extra: [{ name: 'search' }] 
            }
        ],
        idPrefixes: ["iptv_"]
    });

    builder.defineCatalogHandler(async (args) => {
        // Pornim update-ul dar nu blocăm totul dacă e prima dată
        await addon.updateData();
        
        let results = addon.channels;
        if (args.extra?.search) {
            const q = args.extra.search.toLowerCase();
            results = results.filter(i => i.name.toLowerCase().includes(q));
        }

        return { metas: results.slice(0, 500).map(i => ({
            id: i.id,
            type: 'tv',
            name: i.name,
            poster: i.logo || "https://via.placeholder.com/300x300?text=TV",
            posterShape: 'square'
        }))};
    });

    builder.defineMetaHandler(async ({ id }) => {
        const item = addon.channels.find(i => i.id === id);
        if (!item) return { meta: null };

        const streamId = id.split('_').pop();
        const epgData = await addon.getXtreamEpg(streamId);
        
        const now = new Date();
        const oraRo = now.toLocaleTimeString('ro-RO', RO_TIME_OPTS);

        let desc = `🕒 ORA ROMÂNIEI: ${oraRo}\n───────────────────────────\n`;

        if (epgData && epgData.length > 0) {
            const current = epgData.find(p => now >= p.start && now <= p.end);
            if (current) {
                desc += `🔴 ACUM: ${current.title}\n⏰ [${current.start.toLocaleTimeString('ro-RO', RO_TIME_OPTS)} - ${current.end.toLocaleTimeString('ro-RO', RO_TIME_OPTS)}]\n${addon.getProgressBar(current.start, current.end)}\n\n📝 ${current.desc || ''}\n`;
                
                const next = epgData.filter(p => p.start > now).slice(0, 4);
                if (next.length > 0) {
                    desc += `───────────────────────────\n📅 URMEAZĂ:\n`;
                    next.forEach(p => {
                        desc += `🔹 ${p.start.toLocaleTimeString('ro-RO', RO_TIME_OPTS)} - ${p.title}\n`;
                    });
                }
            }
        } else {
            desc += `⚠️ EPG indisponibil.`;
        }

        return { meta: { id, type: 'tv', name: item.name, description: desc, poster: item.logo, background: item.logo, logo: item.logo } };
    });

    builder.defineStreamHandler(async ({ id }) => {
        const item = addon.channels.find(i => i.id === id);
        return { streams: item ? [{ url: item.url, title: item.name }] : [] };
    });

    return builder.getInterface();
}

module.exports = createAddon;
