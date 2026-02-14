// IPTV Stremio Addon Core - Fixed EPG for Xtream Codes
require('dotenv').config();

const { addonBuilder } = require("stremio-addon-sdk");
const crypto = require("crypto");
const LRUCache = require("./lruCache");
const fetch = require('node-fetch');

let redisClient = null;
if (process.env.REDIS_URL) {
    try {
        const { Redis } = require('ioredis');
        redisClient = new Redis(process.env.REDIS_URL, {
            lazyConnect: true,
            maxRetriesPerRequest: 2
        });
        redisClient.on('error', e => console.error('[REDIS] Error:', e.message));
        redisClient.connect().catch(err => console.error('[REDIS] Connect failed:', err.message));
        console.log('[REDIS] Enabled');
    } catch (e) {
        console.warn('[REDIS] ioredis failed, falling back to LRU');
        redisClient = null;
    }
}

const ADDON_NAME = "M3U/EPG TV Addon";
const ADDON_ID = "org.stremio.m3u-epg-addon";

const DEBUG_ENV = (process.env.DEBUG_MODE || '').toLowerCase() === 'true';
function makeLogger(cfgDebug) {
    const enabled = !!cfgDebug || DEBUG_ENV;
    return {
        debug: (...a) => { if (enabled) console.log('[DEBUG]', ...a); },
        info:  (...a) => console.log('[INFO]', ...a),
        warn:  (...a) => console.warn('[WARN]', ...a),
        error: (...a) => console.error('[ERROR]', ...a)
    };
}

const CACHE_ENABLED = (process.env.CACHE_ENABLED || 'true').toLowerCase() !== 'false';
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || (6 * 3600 * 1000).toString(), 10);
const MAX_CACHE_ENTRIES = parseInt(process.env.MAX_CACHE_ENTRIES || '300', 10);

const dataCache = new LRUCache({ max: MAX_CACHE_ENTRIES, ttl: CACHE_TTL_MS });
const buildPromiseCache = new Map();

async function redisGetJSON(key) {
    if (!redisClient) return null;
    try {
        const raw = await redisClient.get(key);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}
async function redisSetJSON(key, value, ttl) {
    if (!redisClient) return;
    try {
        await redisClient.set(key, JSON.stringify(value), 'PX', ttl);
    } catch { /* ignore */ }
}

function createCacheKey(config) {
    const minimal = {
        provider: config.provider,
        xtreamUrl: config.xtreamUrl,
        xtreamUsername: config.xtreamUsername,
        epgOffsetHours: config.epgOffsetHours
    };
    return crypto.createHash('md5').update(JSON.stringify(minimal)).digest('hex');
}

class M3UEPGAddon {
    constructor(config = {}, manifestRef) {
        this.providerName = config.provider === 'xtream' ? 'xtream' : 'direct';
        this.config = config;
        this.manifestRef = manifestRef;
        this.cacheKey = createCacheKey(config);
        this.updateInterval = 3600000;
        this.channels = [];
        this.movies = [];
        this.series = [];
        this.seriesInfoCache = new Map();
        this.epgData = {};
        this.lastUpdate = 0;
        this.log = makeLogger(config.debug);

        this.config.epgOffsetHours = parseFloat(this.config.epgOffsetHours) || 0;
    }

    async loadFromCache() {
        if (!CACHE_ENABLED) return;
        const cacheKey = 'addon:data:' + this.cacheKey;
        let cached = dataCache.get(cacheKey);
        if (!cached && redisClient) {
            cached = await redisGetJSON(cacheKey);
            if (cached) dataCache.set(cacheKey, cached);
        }
        if (cached) {
            this.channels = cached.channels || [];
            this.movies = cached.movies || [];
            this.series = cached.series || [];
            this.epgData = cached.epgData || {};
            this.lastUpdate = cached.lastUpdate || 0;
        }
    }

    async saveToCache() {
        if (!CACHE_ENABLED) return;
        const cacheKey = 'addon:data:' + this.cacheKey;
        const entry = { channels: this.channels, movies: this.movies, series: this.series, epgData: this.epgData, lastUpdate: this.lastUpdate };
        dataCache.set(cacheKey, entry);
        await redisSetJSON(cacheKey, entry, CACHE_TTL_MS);
    }

    // --- XTREAM EPG FETCH LOGIC ---
    async getXtreamEpg(streamId) {
        if (this.providerName !== 'xtream') return null;
        const url = `${this.config.xtreamUrl}/player_api.php?username=${this.config.xtreamUsername}&password=${this.config.xtreamPassword}&action=get_short_epg&stream_id=${streamId}`;
        
        try {
            const response = await fetch(url);
            const data = await response.json();
            if (data && data.epg_listings && data.epg_listings.length > 0) {
                return data.epg_listings.map(prog => ({
                    title: Buffer.from(prog.title, 'base64').toString('utf-8'),
                    description: Buffer.from(prog.description, 'base64').toString('utf-8'),
                    startTime: new Date(prog.start),
                    stopTime: new Date(prog.end)
                }));
            }
        } catch (e) {
            this.log.error('Xtream EPG Fetch Failed', e.message);
        }
        return null;
    }

    getCurrentProgram(channelId) {
        if (!channelId || !this.epgData[channelId]) return null;
        const now = new Date();
        for (const p of this.epgData[channelId]) {
            const start = new Date(p.start);
            const stop = new Date(p.stop);
            if (now >= start && now <= stop) return { title: p.title, description: p.desc, startTime: start, stopTime: stop };
        }
        return null;
    }

    async updateData(force = false) {
        const now = Date.now();
        if (!force && this.lastUpdate && now - this.lastUpdate < 900000) return;
        try {
            const providerModule = require(`./src/js/providers/${this.providerName}Provider.js`);
            await providerModule.fetchData(this);
            this.lastUpdate = Date.now();
            if (CACHE_ENABLED) await this.saveToCache();
        } catch (e) {
            this.log.error('[UPDATE] Failed:', e.message);
        }
    }

    deriveFallbackLogoUrl(item) {
        return item.attributes?.['tvg-logo'] || `https://via.placeholder.com/300x400/333333/FFFFFF?text=${encodeURIComponent(item.name)}`;
    }

    generateMetaPreview(item) {
        const meta = { id: item.id, type: item.type, name: item.name };
        meta.poster = this.deriveFallbackLogoUrl(item);
        meta.runtime = 'Live';
        return meta;
    }

    async getDetailedMeta(id) {
        const all = [...this.channels, ...this.movies];
        const item = all.find(i => i.id === id);
        if (!item) return null;

        if (item.type === 'tv') {
            const epgId = item.attributes?.['tvg-id'] || item.attributes?.['tvg-name'];
            let current = this.getCurrentProgram(epgId);
            let upcoming = [];

            if (!current && this.providerName === 'xtream') {
                const streamId = id.split('_').pop();
                const xtreamPrograms = await this.getXtreamEpg(streamId);
                if (xtreamPrograms) {
                    current = xtreamPrograms[0];
                    upcoming = xtreamPrograms.slice(1, 4);
                }
            }

            let description = `📺 CHANNEL: ${item.name}`;
            if (current) {
                const s = current.startTime?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const e = current.stopTime?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                description += `\n\n🔴 ACUM: ${current.title} (${s} - ${e})\n${current.description || ''}`;
            }
            if (upcoming.length) {
                description += '\n\n📅 URMEAZĂ:\n' + upcoming.map(p => `${p.startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${p.title}`).join('\n');
            }

            return { id: item.id, type: 'tv', name: item.name, poster: this.deriveFallbackLogoUrl(item), description, runtime: 'Live' };
        }
        return this.generateMetaPreview(item);
    }

    getStream(id) {
        const all = [...this.channels, ...this.movies];
        const item = all.find(i => i.id === id);
        if (!item) return null;
        return { url: item.url, title: item.name, behaviorHints: { notWebReady: true } };
    }
}

async function createAddon(config) {
    const manifest = {
        id: ADDON_ID,
        version: "2.1.0",
        name: ADDON_NAME,
        resources: ["catalog", "stream", "meta"],
        types: ["tv", "movie", "series"],
        catalogs: [{ type: 'tv', id: 'iptv_channels', name: 'IPTV Channels', extra: [{ name: 'search' }] }],
        idPrefixes: ["iptv_"]
    };

    const buildPromise = (async () => {
        const builder = new addonBuilder(manifest);
        const addonInstance = new M3UEPGAddon(config, manifest);
        await addonInstance.loadFromCache();
        await addonInstance.updateData(true);

        builder.defineCatalogHandler(async (args) => {
            const items = args.type === 'tv' ? addonInstance.channels : [];
            return { metas: items.slice(0, 100).map(i => addonInstance.generateMetaPreview(i)) };
        });

        builder.defineStreamHandler(async ({ id }) => {
            const stream = addonInstance.getStream(id);
            return { streams: stream ? [stream] : [] };
        });

        builder.defineMetaHandler(async ({ id }) => {
            const meta = await addonInstance.getDetailedMeta(id);
            return { meta };
        });

        return builder.getInterface();
    })();

    return await buildPromise;
}

module.exports = createAddon;
