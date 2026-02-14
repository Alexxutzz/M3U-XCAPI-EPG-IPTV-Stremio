// IPTV Stremio Addon - Combined & Optimized Version
require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

const ADDON_NAME = "PRO IPTV RO";
const ADDON_ID = "org.stremio.m3u-epg-ro";

// Configurare Ora României
const RO_TIME = { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bucharest', hour12: false };

class M3UEPGAddon {
    constructor(config = {}) {
        this.config = config;
        this.channels = [];
        this.lastUpdate = 0;
    }

    // Design Progres Bara
    getProgressBar(start, end) {
        const now = new Date();
        const progress = Math.max(0, Math.min(100, Math.round(((now - start) / (end - start)) * 100)));
        const filled = Math.round(progress / 10);
        return `${"🟢".repeat(filled)}${"⚪".repeat(10 - filled)} ${progress}%`;
    }

    async getXtreamEpg(streamId) {
        const url = `${this.config.xtreamUrl}/player_api.php?username=${this.config.xtreamUsername}&password=${this.config.xtreamPassword}&action=get_short_epg&stream_id=${streamId}`;
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3000 });
            const text = await res.text();
            if (text.includes('<html')) return null;
            const data = JSON.parse(text);
            
            const decode = (str) => {
                try { return Buffer.from(str, 'base64').toString('utf-8'); }
                catch(e) { return str; }
            };

            return data?.epg_listings?.map(p => ({
                title: p.title ? decode(p.title) : "Program",
                desc: p.description ? decode(p.description) : "",
                start: new Date(p.start),
                end: new Date(p.end)
            })) || null;
        } catch (e) { return null; }
    }

    async updateData() {
        // Păstrăm logica ta originală de import
        if (Date.now() - this.lastUpdate < 1200000) return; 
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
        version: "4.2.0",
        name: ADDON_NAME,
        resources: ["catalog", "stream", "meta"],
        types: ["tv"],
        catalogs: [
            { type: 'tv', id: 'iptv_channels', name: 'IPTV Romania', extra: [{ name: 'search' }] }
        ],
        idPrefixes: ["iptv_"]
    });

    // CATALOG HANDLER
    builder.defineCatalogHandler(async (args) => {
        await addon.updateData();
        let results = addon.channels;
        
        if (args.extra?.search) {
            const q = args.extra.search.toLowerCase();
            results = results.filter(i => i.name.toLowerCase().includes(q));
        }

        return { 
            // Am mărit slice la 1000 pentru a vedea mai multe canale deodată
            metas: results.slice(0, 1000).map(i => ({
                id: i.id,
                type: 'tv',
                name: i.name,
                poster: i.attributes?.['tvg-logo'] || i.logo || "https://via.placeholder.com/300x300?text=TV",
                posterShape: 'square'
            }))
        };
    });

    // META HANDLER (EPG + Ora RO + Logo)
    builder.defineMetaHandler(async ({ id }) => {
        const item = addon.channels.find(i => i.id === id);
        if (!item) return { meta: null };

        const streamId = id.split('_').pop();
        const epg = await addon.getXtreamEpg(streamId);
        
        const now = new Date();
        const oraRO = now.toLocaleTimeString('ro-RO', RO_TIME);

        let description = `🕒 ORA RO: ${oraRO}\n`;
        description += `📺 Canal: ${item.name}\n`;
        description += `📂 Grup: ${item.attributes?.['group-title'] || 'Generic'}\n`;
        description += `──────────────────────────\n`;

        if (epg && epg.length > 0) {
            // Căutăm emisiunea curentă (nu doar prima din listă)
            const current = epg.find(p => now >= p.start && now <= p.end) || epg[0];
            
            const s = current.start.toLocaleTimeString('ro-RO', RO_TIME);
            const e = current.end.toLocaleTimeString('ro-RO', RO_TIME);
            
            description += `🔴 ACUM: ${current.title}\n⏰ ${s} - ${e}\n📊 ${addon.getProgressBar(current.start, current.end)}\n\n📝 ${current.desc}\n`;
            
            const next = epg.filter(p => p.start > now).slice(0, 4);
            if (next.length > 0) {
                description += `──────────────────────────\n📅 URMEAZĂ:\n`;
                next.forEach(p => {
                    description += `• ${p.start.toLocaleTimeString('ro-RO', RO_TIME)} - ${p.title}\n`;
                });
            }
        } else {
            description += `📡 EPG momentan indisponibil.`;
        }

        const logo = item.attributes?.['tvg-logo'] || item.logo || "";
        return { 
            meta: { 
                id, 
                type: 'tv', 
                name: item.name, 
                description, 
                poster: logo,
                background: logo,
                logo: logo 
            } 
        };
    });

    builder.defineStreamHandler(async ({ id }) => {
        const item = addon.channels.find(i => i.id === id);
        return { streams: item ? [{ url: item.url, title: item.name }] : [] };
    });

    return builder.getInterface();
}

module.exports = createAddon;
