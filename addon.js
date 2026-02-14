// IPTV Stremio Addon Core - All Channels & Enhanced EPG
require('dotenv').config();

const { addonBuilder } = require("stremio-addon-sdk");
const LRUCache = require("./lruCache");
const fetch = require('node-fetch');

const dataCache = new LRUCache({ max: 500, ttl: 6 * 3600 * 1000 });

const ADDON_NAME = "M3U/EPG TV Addon";
const ADDON_ID = "org.stremio.m3u-epg-addon";

class M3UEPGAddon {
    constructor(config = {}, manifestRef) {
        this.providerName = config.provider || 'xtream';
        this.config = config;
        this.manifestRef = manifestRef;
        this.channels = [];
        this.movies = [];
        this.series = [];
        this.lastUpdate = 0;
    }

    // --- UTILS PENTRU DESIGN EPG ---
    formatTime(date) {
        return date ? date.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' }) : "--:--";
    }

    getProgressBar(start, end) {
        const now = new Date();
        const total = end - start;
        const elapsed = now - start;
        const progress = Math.max(0, Math.min(100, Math.round((elapsed / total) * 100)));
        const filled = Math.round(progress / 10);
        return `${"█".repeat(filled)}${"░".repeat(10 - filled)} ${progress}%`;
    }

    async getXtreamEpg(streamId) {
        if (this.providerName !== 'xtream') return null;
        const url = `${this.config.xtreamUrl}/player_api.php?username=${this.config.xtreamUsername}&password=${this.config.xtreamPassword}&action=get_short_epg&stream_id=${streamId}`;
        
        try {
            const response = await fetch(url, { headers: { 'User-Agent': 'IPTVSmarters/1.0.3' }, timeout: 4000 });
            const data = await response.json();
            if (data && data.epg_listings && data.epg_listings.length > 0) {
                return data.epg_listings.map(prog => ({
                    title: prog.title ? Buffer.from(prog.title, 'base64').toString('utf-8') : "Program",
                    description: prog.description ? Buffer.from(prog.description, 'base64').toString('utf-8') : "",
                    startTime: new Date(prog.start),
                    stopTime: new Date(prog.end)
                }));
            }
        } catch (e) { console.error('[EPG ERROR]', e.message); }
        return null;
    }

    async updateData(force = false) {
        const now = Date.now();
        if (!force && this.lastUpdate && now - this.lastUpdate < 900000) return;

        try {
            console.log('[INFO] Fetching all channels from provider...');
            const providerModule = require(`./src/js/providers/${this.providerName}Provider.js`);
            await providerModule.fetchData(this);

            this.lastUpdate = Date.now();
            console.log('[INFO] Success. Total channels loaded:', this.channels.length);
        } catch (e) { console.error('[CRITICAL ERROR]', e); }
    }

    generateMetaPreview(item) {
        return {
            id: item.id,
            type: item.type || 'tv',
            name: item.name,
            poster: item.attributes?.['tvg-logo'] || item.logo || `https://via.placeholder.com/300x400/333333/FFFFFF?text=${encodeURIComponent(item.name)}`,
            runtime: 'Live'
        };
    }

    async getDetailedMeta(id) {
        const item = [...this.channels, ...this.movies].find(i => i.id === id);
        if (!item) return null;

        const meta = this.generateMetaPreview(item);
        if (item.type === 'tv' || id.includes('live')) {
            const streamId = id.split('_').pop();
            const epg = await this.getXtreamEpg(streamId);
            
            let desc = `📺 CANAL: ${item.name}\n`;
            if (item.attributes?.['group-title']) desc += `📂 GRUP: ${item.attributes['group-title']}\n`;
            desc += `──────────────────────────\n`;

            if (epg && epg[0]) {
                const cur = epg[0];
                desc += `🔴 ACUM: ${cur.title}\n⏰ ${this.formatTime(cur.startTime)} - ${this.formatTime(cur.stopTime)}\n📊 ${this.getProgressBar(cur.startTime, cur.stopTime)}\n\n📝 ${cur.description}\n`;
                if (epg.length > 1) {
                    desc += `──────────────────────────\n📅 URMEAZĂ:\n`;
                    epg.slice(1, 4).forEach(p => desc += `• ${this.formatTime(p.startTime)} - ${p.title}\n`);
                }
            } else { desc += "📡 Program indisponibil."; }
            meta.description = desc;
        }
        return meta;
    }
}

async function createAddon(config) {
    const manifest = {
        id: ADDON_ID,
        version: "2.1.4",
        name: ADDON_NAME,
        resources: ["catalog", "stream", "meta"],
        types: ["tv", "movie"],
        catalogs: [
            { type: 'tv', id: 'iptv_channels', name: 'IPTV Channels', extra: [{ name: 'search' }] },
            { type: 'movie', id: 'iptv_movies', name: 'IPTV Movies', extra: [{ name: 'search' }] }
        ],
        idPrefixes: ["iptv_"]
    };

    const builder = new addonBuilder(manifest);
    const addonInstance = new M3UEPGAddon(config, manifest);
    await addonInstance.updateData(true);

    builder.defineCatalogHandler(async (args) => {
        let items = args.type === 'tv' ? addonInstance.channels : addonInstance.movies;
        if (args.extra?.search) {
            const q = args.extra.search.toLowerCase();
            items = items.filter(i => i.name.toLowerCase().includes(q));
        }
        // Limităm afișarea la 500 pentru a nu bloca interfața Stremio
        return { metas: items.slice(0, 500).map(i => addonInstance.generateMetaPreview(i)) };
    });

    builder.defineStreamHandler(async ({ id }) => {
        const item = [...addonInstance.channels, ...addonInstance.movies].find(i => i.id === id);
        return { streams: item ? [{ url: item.url, title: item.name }] : [] };
    });

    builder.defineMetaHandler(async ({ id }) => {
        return { meta: await addonInstance.getDetailedMeta(id) };
    });

    return builder.getInterface();
}

module.exports = createAddon;
