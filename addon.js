// IPTV Stremio Addon - NO SORTING - FULL EPG - 50k+ SUPPORT
require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

const ADDON_NAME = "IPTV Streamer Pro";
const ADDON_ID = "org.stremio.iptv-raw.optimized";

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
            return data?.epg_listings?.map(p => ({
                title: p.title ? Buffer.from(p.title, 'base64').toString('utf-8') : "Program",
                desc: p.description ? Buffer.from(p.description, 'base64').toString('utf-8') : "",
                start: new Date(p.start),
                end: new Date(p.end)
            })) || null;
        } catch (e) { return null; }
    }

    async updateData() {
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
        version: "3.2.0",
        name: ADDON_NAME,
        resources: ["catalog", "stream", "meta"],
        types: ["tv"],
        catalogs: [{ type: 'tv', id: 'iptv_channels', name: 'Toate Canalele', extra: [{ name: 'search' }] }],
        idPrefixes: ["iptv_"]
    });

    builder.defineCatalogHandler(async (args) => {
        await addon.updateData();
        let results = addon.channels;

        if (args.extra?.search) {
            const q = args.extra.search.toLowerCase();
            results = results.filter(i => i.name.toLowerCase().includes(q));
        }

        // Returnăm tot fără sortare suplimentară
        return { 
            metas: results.map(i => ({
                id: i.id,
                type: 'tv',
                name: i.name,
                poster: i.logo || ""
            }))
        };
    });

    builder.defineMetaHandler(async ({ id }) => {
        await addon.updateData();
        const item = addon.channels.find(i => i.id === id);
        if (!item) return { meta: null };

        const streamId = id.split('_').pop();
        const epg = await addon.getXtreamEpg(streamId);
        
        let description = `📺 Canal: ${item.name}\n📂 Categorie: ${item.category}\n`;
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
            description += `📡 Ghid TV (EPG) momentan indisponibil.`;
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
