// IPTV Stremio Addon - Complete Vercel Optimized Version
require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

const ADDON_NAME = "PRO IPTV & EPG Plus";
const ADDON_ID = "org.stremio.m3u-epg-pro";

class M3UEPGAddon {
    constructor(config = {}) {
        this.config = config;
        this.channels = [];
        this.lastUpdate = 0;
    }

    // Progres vizual îmbunătățit cu emoji
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
        if (Date.now() - this.lastUpdate < 1800000) return; // Cache 30 min
        try {
            // Aici ar trebui să fie logica ta de fetch din xtreamProvider.js
            // Exemplu simplu de integrare dacă metoda e internă:
            const response = await fetch(`${this.config.xtreamUrl}/player_api.php?username=${this.config.xtreamUsername}&password=${this.config.xtreamPassword}&action=get_live_streams`);
            const streams = await response.json();
            
            this.channels = streams.map(s => ({
                id: `iptv_${s.stream_id}`,
                name: s.name,
                logo: s.stream_icon || "",
                url: `${this.config.xtreamUrl}/live/${this.config.xtreamUsername}/${this.config.xtreamPassword}/${s.stream_id}.m3u8`,
                group: s.category_id
            }));
            
            this.lastUpdate = Date.now();
        } catch (e) { console.error("Update Error:", e.message); }
    }
}

async function createAddon(config) {
    const addon = new M3UEPGAddon(config);
    const builder = new addonBuilder({
        id: ADDON_ID,
        version: "3.1.0",
        name: ADDON_NAME,
        resources: ["catalog", "stream", "meta"],
        types: ["tv"],
        catalogs: [
            { 
                type: 'tv', 
                id: 'iptv_channels', 
                name: '📺 Toate Canalele', 
                extra: [{ name: 'search' }] 
            }
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
            metas: results.slice(0, 500).map(i => ({
                id: i.id,
                type: 'tv',
                name: i.name,
                poster: i.logo || "https://via.placeholder.com/300x450?text=Fara+Logo",
                posterShape: 'square'
            }))
        };
    });

    // META HANDLER (EPG COMPLEX + ORA)
    builder.defineMetaHandler(async ({ id }) => {
        const item = addon.channels.find(i => i.id === id);
        if (!item) return { meta: null };

        const streamId = id.split('_').pop();
        const epgData = await addon.getXtreamEpg(streamId);
        
        const now = new Date();
        const oraLocala = now.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });

        let metaDescription = `🕒 ORA ACTUALĂ: ${oraLocala}\n`;
        metaDescription += `📺 CANAL: ${item.name.toUpperCase()}\n`;
        metaDescription += `───────────────────────────\n`;

        if (epgData && epgData.length > 0) {
            const currentIdx = epgData.findIndex(p => now >= p.start && now <= p.end);
            const current = currentIdx !== -1 ? epgData[currentIdx] : null;

            if (current) {
                const s = current.start.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
                const e = current.end.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
                
                metaDescription += `🔴 ACUM:\n🏷️ ${current.title}\n`;
                metaDescription += `⏰ [${s} - ${e}] (${current.duration} min)\n`;
                metaDescription += `${addon.getProgressBar(current.start, current.end)}\n\n`;
                metaDescription += `📝 ${current.desc || 'Fără descriere.'}\n`;
                
                const nextPrograms = epgData.slice(currentIdx + 1, currentIdx + 6);
                if (nextPrograms.length > 0) {
                    metaDescription += `\n📅 PROGRAM URMĂTOR:\n`;
                    nextPrograms.forEach(p => {
                        const start = p.start.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
                        const end = p.end.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
                        metaDescription += `🔹 ${start} - ${end} | ${p.title}\n`;
                    });
                }
            } else {
                const nextUp = epgData.find(p => p.start > now);
                if (nextUp) {
                    const s = nextUp.start.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
                    metaDescription += `⏭️ URMĂTORUL PROGRAM:\n🏷️ ${nextUp.title} la ora ${s}\n`;
                }
            }
        } else {
            metaDescription += `⚠️ EPG momentan indisponibil.`;
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

    // STREAM HANDLER
    builder.defineStreamHandler(async ({ id }) => {
        const item = addon.channels.find(i => i.id === id);
        if (!item) return { streams: [] };
        
        return { 
            streams: [{ 
                url: item.url, 
                title: `Stream Direct: ${item.name}`,
                behaviorHints: { notWebReady: true }
            }] 
        };
    });

    return builder.getInterface();
}

module.exports = createAddon;
