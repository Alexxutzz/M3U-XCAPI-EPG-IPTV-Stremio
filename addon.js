require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

const ADDON_NAME = "PRO IPTV Search";
const ADDON_ID = "org.stremio.m3u-epg-search";
const RO_TIME = { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bucharest', hour12: false };

class M3UEPGAddon {
    constructor(config = {}) {
        this.config = config;
        this.channels = [];
        this.lastUpdate = 0;
    }

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
            const data = await res.json();
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
        // Cache scurt de 10 min pentru căutări rapide
        if (Date.now() - this.lastUpdate < 600000 && this.channels.length > 0) return;
        try {
            const provider = require(`./src/js/providers/xtreamProvider.js`);
            await provider.fetchData(this);
            this.lastUpdate = Date.now();
        } catch (e) { console.error("Search Fetch Error:", e.message); }
    }
}

async function createAddon(config) {
    const addon = new M3UEPGAddon(config);
    const builder = new addonBuilder({
        id: ADDON_ID,
        version: "6.0.0",
        name: ADDON_NAME,
        resources: ["catalog", "stream", "meta"],
        types: ["tv"],
        catalogs: [
            { 
                type: 'tv', 
                id: 'iptv_dynamic', 
                name: '🔍 Căutare Canale (Scrie nume)', 
                extra: [{ name: 'search', isRequired: false }] 
            }
        ],
        idPrefixes: ["iptv_"]
    });

    builder.defineCatalogHandler(async (args) => {
        // Dacă utilizatorul nu a scris nimic, returnăm o listă goală sau un mesaj
        if (!args.extra?.search) {
            return { metas: [] }; 
        }

        await addon.updateData();
        const q = args.extra.search.toLowerCase();
        
        // Filtrare agresivă și rapidă
        const results = addon.channels.filter(i => i.name.toLowerCase().includes(q));

        return { 
            metas: results.map(i => ({
                id: i.id,
                type: 'tv',
                name: i.name,
                poster: i.attributes?.['tvg-logo'] || i.logo || "",
                posterShape: 'square'
            }))
        };
    });

    builder.defineMetaHandler(async ({ id }) => {
        const item = addon.channels.find(i => i.id === id);
        if (!item) return { meta: null };

        const streamId = id.split('_').pop();
        const epg = await addon.getXtreamEpg(streamId);
        const now = new Date();
        const oraRO = now.toLocaleTimeString('ro-RO', RO_TIME);

        let description = `🕒 ORA RO: ${oraRO}\n📺 Canal: ${item.name}\n──────────────────────────\n`;

        if (epg && epg.length > 0) {
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
            description += `📡 EPG indisponibil.`;
        }

        const logo = item.attributes?.['tvg-logo'] || item.logo || "";
        return { 
            meta: { id, type: 'tv', name: item.name, description, poster: logo, background: logo, logo: logo } 
        };
    });

    builder.defineStreamHandler(async ({ id }) => {
        const item = addon.channels.find(i => i.id === id);
        return { streams: item ? [{ url: item.url, title: item.name }] : [] };
    });

    return builder.getInterface();
}

module.exports = createAddon;
