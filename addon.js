// IPTV Stremio Addon - Ora României Forțată
require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

const ADDON_NAME = "PRO IPTV Romania";
const ADDON_ID = "org.stremio.m3u-epg-ro";

// Configurare globală pentru formatarea orei de România
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
        this.categories = [];
        this.lastUpdate = 0;
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
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 4000 });
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
        if (Date.now() - this.lastUpdate < 3600000 && this.channels.length > 0) return;
        try {
            const catRes = await fetch(`${this.config.xtreamUrl}/player_api.php?username=${this.config.xtreamUsername}&password=${this.config.xtreamPassword}&action=get_live_categories`);
            this.categories = await catRes.json();

            const streamRes = await fetch(`${this.config.xtreamUrl}/player_api.php?username=${this.config.xtreamUsername}&password=${this.config.xtreamPassword}&action=get_live_streams`);
            const streams = await streamRes.json();
            
            this.channels = streams.map(s => ({
                id: `iptv_${s.stream_id}`,
                name: s.name,
                logo: s.stream_icon || "",
                url: `${this.config.xtreamUrl}/live/${this.config.xtreamUsername}/${this.config.xtreamPassword}/${s.stream_id}.ts`,
                category: s.category_id
            }));
            
            this.lastUpdate = Date.now();
        } catch (e) { console.error("Eroare:", e.message); }
    }
}

async function createAddon(config) {
    const addon = new M3UEPGAddon(config);
    await addon.updateData();

    const builder = new addonBuilder({
        id: ADDON_ID,
        version: "3.3.0",
        name: ADDON_NAME,
        resources: ["catalog", "stream", "meta"],
        types: ["tv"],
        catalogs: [
            { 
                type: 'tv', 
                id: 'iptv_all', 
                name: '📺 IPTV Romania', 
                extra: [{ name: 'search' }, { name: 'genre', options: addon.categories.map(c => c.category_name) }] 
            }
        ],
        idPrefixes: ["iptv_"]
    });

    builder.defineCatalogHandler(async (args) => {
        await addon.updateData();
        let results = addon.channels;

        if (args.extra?.genre) {
            const category = addon.categories.find(c => c.category_name === args.extra.genre);
            if (category) results = results.filter(i => i.category === category.category_id);
        }

        if (args.extra?.search) {
            const q = args.extra.search.toLowerCase();
            results = results.filter(i => i.name.toLowerCase().includes(q));
        }

        return { 
            metas: results.slice(0, 500).map(i => ({
                id: i.id,
                type: 'tv',
                name: i.name,
                poster: i.logo || "https://via.placeholder.com/300x300?text=TV",
                posterShape: 'square'
            }))
        };
    });

    builder.defineMetaHandler(async ({ id }) => {
        const item = addon.channels.find(i => i.id === id);
        if (!item) return { meta: null };

        const streamId = id.split('_').pop();
        const epgData = await addon.getXtreamEpg(streamId);
        
        const now = new Date();
        // ORA ROMÂNIEI
        const oraLocala = now.toLocaleTimeString('ro-RO', RO_TIME_OPTS);

        let metaDescription = `🕒 ORA ROMÂNIEI: ${oraLocala}\n`;
        metaDescription += `📺 CANAL: ${item.name.toUpperCase()}\n`;
        metaDescription += `───────────────────────────\n`;

        if (epgData && epgData.length > 0) {
            const currentIdx = epgData.findIndex(p => now >= p.start && now <= p.end);
            const current = currentIdx !== -1 ? epgData[currentIdx] : null;

            if (current) {
                const s = current.start.toLocaleTimeString('ro-RO', RO_TIME_OPTS);
                const e = current.end.toLocaleTimeString('ro-RO', RO_TIME_OPTS);
                
                metaDescription += `🔴 ACUM: ${current.title}\n`;
                metaDescription += `⏰ [${s} - ${e}] (${current.duration} min)\n`;
                metaDescription += `${addon.getProgressBar(current.start, current.end)}\n\n`;
                metaDescription += `📝 ${current.desc || 'Fără descriere.'}\n`;
                
                const nextPrograms = epgData.slice(currentIdx + 1, currentIdx + 6);
                if (nextPrograms.length > 0) {
                    metaDescription += `\n📅 PROGRAM URMĂTOR (Ora RO):\n`;
                    nextPrograms.forEach(p => {
                        const startStr = p.start.toLocaleTimeString('ro-RO', RO_TIME_OPTS);
                        const endStr = p.end.toLocaleTimeString('ro-RO', RO_TIME_OPTS);
                        metaDescription += `🔹 ${startStr} - ${endStr} | ${p.title}\n`;
                    });
                }
            }
        } else {
            metaDescription += `⚠️ EPG indisponibil.`;
        }

        return { 
            meta: { 
                id, 
                type: 'tv', 
                name: item.name, 
                description: metaDescription, 
                poster: item.logo || "",
                background: item.logo || "",
                logo: item.logo || ""
            } 
        };
    });

    builder.defineStreamHandler(async ({ id }) => {
        const item = addon.channels.find(i => i.id === id);
        if (!item) return { streams: [] };
        return { streams: [{ url: item.url, title: item.name }] };
    });

    return builder.getInterface();
}

module.exports = createAddon;
