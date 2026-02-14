// IPTV Stremio Addon - Vercel Optimized Version
require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

const ADDON_NAME = "M3U/EPG TV Addon";
const ADDON_ID = "org.stremio.m3u-epg-addon";

class M3UEPGAddon {
    constructor(config = {}) {
        this.config = config;
        this.channels = [];
        this.lastUpdate = 0;
    }

    // Helper Design EPG
    getProgressBar(start, end) {
        const now = new Date();
        const progress = Math.max(0, Math.min(100, Math.round(((now - start) / (end - start)) * 100)));
        const filled = Math.round(progress / 10);
        return `${"█".repeat(filled)}${"░".repeat(10 - filled)} ${progress}%`;
    }

    async getXtreamEpg(streamId) {
        const url = `${this.config.xtreamUrl}/player_api.php?username=${this.config.xtreamUsername}&password=${this.config.xtreamPassword}&action=get_short_epg&stream_id=${streamId}`;
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3000 });
            const text = await res.text();
            if (text.includes('<html')) return null; // Ignorăm erorile HTML de la server
            const data = JSON.parse(text);
            return data?.epg_listings?.map(p => ({
                title: p.title ? Buffer.from(p.title, 'base64').toString('utf-8') : "Program",
                desc: p.description ? Buffer.from(p.description, 'base64').toString('utf-8') : "",
                start: new Date(p.start),
                end: new Date(p.end)
            })) || null;
        } catch (e) { return null; }
    }

    async updateData() {
        if (Date.now() - this.lastUpdate < 1200000) return; // Cache intern 20 min
        try {
            const provider = require(`./src/js/providers/xtreamProvider.js`);
            await provider.fetchData(this);
            this.lastUpdate = Date.now();
        } catch (e) { console.error("Fetch Error:", e.message); }
    }
}

async function createAddon(config) {
    const addon = new M3UEPGAddon(config);
    const builder = new addonBuilder({
        id: ADDON_ID,
        version: "2.1.6",
        name: ADDON_NAME,
        resources: ["catalog", "stream", "meta"],
        types: ["tv", "movie"],
        catalogs: [
            { type: 'tv', id: 'iptv_channels', name: 'IPTV Channels', extra: [{ name: 'search' }] }
        ],
        idPrefixes: ["iptv_"]
    });

    // Handler Cataloage (Limitat la 300 canale pentru viteza pe Vercel)
    builder.defineCatalogHandler(async (args) => {
        await addon.updateData();
        let results = addon.channels;
        if (args.extra?.search) {
            const q = args.extra.search.toLowerCase();
            results = results.filter(i => i.name.toLowerCase().includes(q));
        }
        return { 
            metas: results.slice(0, 300).map(i => ({
                id: i.id,
                type: 'tv',
                name: i.name,
                poster: i.attributes?.['tvg-logo'] || i.logo || ""
            }))
        };
    });

    // Handler Meta cu EPG Complex
    builder.defineMetaHandler(async ({ id }) => {
        const item = addon.channels.find(i => i.id === id);
        if (!item) return { meta: null };

        const streamId = id.split('_').pop();
        const epg = await addon.getXtreamEpg(streamId);
        
        let description = `📺 Canal: ${item.name}\n📂 Grup: ${item.attributes?.['group-title'] || 'Generic'}\n`;
        description += `──────────────────────────\n`;

        if (epg && epg[0]) {
            const cur = epg[0];
            const s = cur.start.toLocaleTimeString('ro-RO', {hour:'2-digit', minute:'2-digit'});
            const e = cur.end.toLocaleTimeString('ro-RO', {hour:'2-digit', minute:'2-digit'});
            description += `🔴 ACUM: ${cur.title}\n⏰ ${s} - ${e}\n📊 ${addon.getProgressBar(cur.start, cur.end)}\n\n📝 ${cur.desc}\n`;
            
            if (epg.length > 1) {
                description += `──────────────────────────\n📅 URMEAZĂ:\n`;
                epg.slice(1, 4).forEach(p => {
                    description += `• ${p.start.toLocaleTimeString('ro-RO', {hour:'2-digit', minute:'2-digit'})} - ${p.title}\n`;
                });
            }
        } else {
            description += `📡 EPG momentan indisponibil pe acest server.`;
        }

        return { meta: { id, type: 'tv', name: item.name, description, poster: item.logo || "" } };
    });

    builder.defineStreamHandler(async ({ id }) => {
        const item = addon.channels.find(i => i.id === id);
        return { streams: item ? [{ url: item.url, title: item.name }] : [] };
    });

    return builder.getInterface();
}

module.exports = createAddon;
