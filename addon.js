// IPTV Stremio Addon Core - Enhanced EPG with Progress Bar & Time
require('dotenv').config();

const { addonBuilder } = require("stremio-addon-sdk");
const crypto = require("crypto");
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
        this.epgData = {};
        this.lastUpdate = 0;
    }

    // --- FUNCTII AJUTATOARE PENTRU TIMP SI DESIGN ---
    formatTime(date) {
        if (!date) return "--:--";
        return date.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit', hour12: false });
    }

    getProgressBar(start, end) {
        const now = new Date();
        if (now < start) return "░░░░░░░░░░ 0%";
        if (now > end) return "██████████ 100%";
        
        const total = end - start;
        const elapsed = now - start;
        const percent = Math.floor((elapsed / total) * 100);
        
        const dots = 10;
        const filled = Math.round((percent / 100) * dots);
        const empty = dots - filled;
        
        return `${"█".repeat(filled)}${"░".repeat(empty)} ${percent}%`;
    }

    async getXtreamEpg(streamId) {
        if (this.providerName !== 'xtream') return null;
        
        const url = `${this.config.xtreamUrl}/player_api.php?username=${this.config.xtreamUsername}&password=${this.config.xtreamPassword}&action=get_short_epg&stream_id=${streamId}`;
        
        try {
            const response = await fetch(url, {
                headers: { 'User-Agent': 'IPTVSmarters/1.0.3' },
                timeout: 5000 
            });

            const data = await response.json();
            
            if (!data || !data.epg_listings || data.epg_listings.length === 0) {
                return null;
            }

            return data.epg_listings.map(prog => ({
                title: prog.title ? Buffer.from(prog.title, 'base64').toString('utf-8') : "Program TV",
                description: prog.description ? Buffer.from(prog.description, 'base64').toString('utf-8') : "",
                startTime: prog.start ? new Date(prog.start) : null,
                stopTime: prog.end ? new Date(prog.end) : null
            }));
        } catch (e) {
            console.error('[EPG ERROR]', e.message);
            return null;
        }
    }

    async updateData(force = false) {
        const now = Date.now();
        if (!force && this.lastUpdate && now - this.lastUpdate < 900000) return;

        try {
            const providerModule = require(`./src/js/providers/${this.providerName}Provider.js`);
            await providerModule.fetchData(this);
            this.lastUpdate = Date.now();
        } catch (e) {
            console.error('[CRITICAL UPDATE ERROR]', e);
        }
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
        const all = [...this.channels, ...this.movies, ...this.series];
        const item = all.find(i => i.id === id);
        
        if (!item) return null;

        const meta = this.generateMetaPreview(item);

        if (item.type === 'tv' || id.includes('live')) {
            const streamId = id.split('_').pop();
            const xtreamPrograms = await this.getXtreamEpg(streamId);
            
            let description = `📺 CANAL: ${item.name}\n`;
            description += `──────────────────────────\n`;

            if (xtreamPrograms && xtreamPrograms.length > 0) {
                const current = xtreamPrograms[0];
                const start = this.formatTime(current.startTime);
                const end = this.formatTime(current.stopTime);
                const progress = this.getProgressBar(current.startTime, current.stopTime);

                description += `🔴 ACUM: ${current.title}\n`;
                description += `⏰ ORA: ${start} - ${end}\n`;
                description += `📊 PROGRES: ${progress}\n\n`;
                description += `📝 INFO: ${current.description || 'Fără descriere'}\n`;
                
                if (xtreamPrograms.length > 1) {
                    description += `──────────────────────────\n`;
                    description += `📅 URMEAZĂ:\n`;
                    xtreamPrograms.slice(1, 5).forEach(p => {
                        const s = this.formatTime(p.startTime);
                        description += `• ${s} - ${p.title}\n`;
                    });
                }
            } else {
                description += `📡 Informații program indisponibile.`;
            }
            
            meta.description = description;
        }

        return meta;
    }
}

async function createAddon(config) {
    const manifest = {
        id: ADDON_ID,
        version: "2.1.2",
        name: ADDON_NAME,
        resources: ["catalog", "stream", "meta"],
        types: ["tv", "movie", "series"],
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
        addonInstance.updateData().catch(() => {});
        
        let items = [];
        if (args.type === 'tv') items = addonInstance.channels;
        if (args.type === 'movie') items = addonInstance.movies;

        if (args.extra && args.extra.search) {
            const q = args.extra.search.toLowerCase();
            items = items.filter(i => i.name.toLowerCase().includes(q));
        }

        return { metas: items.slice(0, 100).map(i => addonInstance.generateMetaPreview(i)) };
    });

    builder.defineStreamHandler(async ({ id }) => {
        const all = [...addonInstance.channels, ...addonInstance.movies, ...addonInstance.series];
        const item = all.find(i => i.id === id);
        if (!item) return { streams: [] };

        return { 
            streams: [{ 
                url: item.url, 
                title: item.name,
                behaviorHints: { notWebReady: true }
            }] 
        };
    });

    builder.defineMetaHandler(async ({ id }) => {
        const meta = await addonInstance.getDetailedMeta(id);
        return { meta };
    });

    return builder.getInterface();
}

module.exports = createAddon;
