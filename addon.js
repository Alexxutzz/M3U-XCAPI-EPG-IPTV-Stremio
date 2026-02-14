// IPTV Stremio Addon - Vercel Optimized Version (TV + Movies + Series)
require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

const ADDON_NAME = "IPTV Xtream Optimized";
const ADDON_ID = "org.stremio.xtream-full-optimized";

class M3UEPGAddon {
    constructor(config = {}) {
        this.config = config;
        this.channels = [];
        this.movies = [];
        this.series = [];
        this.lastUpdate = 0;
    }

    // Progres bar vizual pentru EPG
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
        // Cache 15 minute pentru a evita blocarea IP-ului de către furnizor
        if (Date.now() - this.lastUpdate < 900000) return; 
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
        version: "3.0.0",
        name: ADDON_NAME,
        resources: ["catalog", "stream", "meta"],
        types: ["tv", "movie", "series"],
        catalogs: [
            { type: 'tv', id: 'iptv_channels', name: 'Live TV', extra: [{ name: 'search' }] },
            { type: 'movie', id: 'iptv_movies', name: 'Filme IPTV', extra: [{ name: 'search' }] },
            { type: 'series', id: 'iptv_series', name: 'Seriale IPTV', extra: [{ name: 'search' }] }
        ],
        idPrefixes: ["iptv_"]
    });

    // --- HANDLER CATALOGOAGE ---
    builder.defineCatalogHandler(async (args) => {
        await addon.updateData();
        let results = [];
        
        if (args.type === 'tv') results = addon.channels;
        else if (args.type === 'movie') results = addon.movies;
        else if (args.type === 'series') results = addon.series;

        if (args.extra?.search) {
            const q = args.extra.search.toLowerCase();
            results = results.filter(i => i.name.toLowerCase().includes(q));
        }

        return { 
            metas: results.slice(0, 300).map(i => ({
                id: i.id,
                type: i.type,
                name: i.name,
                poster: i.poster || i.logo || ""
            }))
        };
    });

    // --- HANDLER META (Detalii + EPG + Episoade) ---
    builder.defineMetaHandler(async ({ type, id }) => {
        await addon.updateData();
        let item;
        
        if (type === 'tv') {
            item = addon.channels.find(i => i.id === id);
            if (!item) return { meta: null };

            const streamId = id.split('_').pop();
            const epg = await addon.getXtreamEpg(streamId);
            
            let description = `📺 Canal: ${item.name}\n📂 Categorie: ${item.category || 'Live'}\n`;
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
                description += `📡 EPG indisponibil momentan.`;
            }
            return { meta: { id, type, name: item.name, description, poster: item.logo || "" } };
        } 
        
        if (type === 'movie') {
            item = addon.movies.find(i => i.id === id);
            return { meta: { id, type, name: item?.name, description: item?.description, poster: item?.poster } };
        }

        if (type === 'series') {
            item = addon.series.find(i => i.id === id);
            if (!item) return { meta: null };
            
            const provider = require(`./src/js/providers/xtreamProvider.js`);
            const info = await provider.fetchSeriesInfo(addon, item.series_id);
            
            return { meta: { 
                id, 
                type, 
                name: item.name, 
                description: item.description, 
                poster: item.poster,
                videos: info.videos // Aici se încarcă episoadele
            }};
        }

        return { meta: null };
    });

    // --- HANDLER STREAM ---
    builder.defineStreamHandler(async ({ id }) => {
        // Dacă e episod de serial, URL-ul este deja în obiectul video din Meta
        if (id.startsWith('iptv_series_ep_')) {
            return { streams: [] }; // Stremio preia URL-ul direct din meta.videos
        }

        const item = [...addon.channels, ...addon.movies].find(i => i.id === id);
        if (item && item.url) {
            return { streams: [{ url: item.url, title: item.name }] };
        }
        return { streams: [] };
    });

    return builder.getInterface();
}

module.exports = createAddon;
