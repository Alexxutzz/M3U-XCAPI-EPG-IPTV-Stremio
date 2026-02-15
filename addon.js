require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

// --- CONFIGURAȚIE ȘI CONSTANTE ---
const ADDON_NAME = "IPTV Stremio";
const ADDON_ID = "org.stremio.iptv.stremio.v280";
const VERSION = "2.8.0";
const RO_TIME = { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bucharest', hour12: false };

let channelHistory = []; 

// --- UTILS: OPTIMIZARE STRING-URI ȘI FILTRARE ---

// Cache pentru fingerprints pentru a evita procesarea repetitivă
const fingerprintCache = new Map();

const getChannelFingerprint = (name) => {
    if (!name) return "";
    if (fingerprintCache.has(name)) return fingerprintCache.get(name);

    const fprint = name.toLowerCase()
        .replace(/ᵁᴴᴰ|ᴴᴰ/g, '')
        .replace(/^.*?([|:\]\-])\s*/, '')
        .replace(/fhd|fullhd|full hd|hd|sd|4k|uhd|1080p|720p|hevc|h265|raw|backup|alt|sports/gi, '')
        .replace(/[^a-z0-9]/g, '')
        .trim();
    
    fingerprintCache.set(name, fprint);
    return fprint;
};

const cleanDisplayNames = (name) => {
    if (!name) return { baseName: "Canal TV", quality: "", icon: "⚪", rank: 0 };
    
    const upper = name.toUpperCase().replace(/ᵁ\s*ᴴ\s*ᴰ/g, 'UHD').replace(/ᴴ\s*ᴰ/g, 'HD');
    let quality = "SD", icon = "⚪", rank = 1;

    // Logica de ranguri (Prioritate: 4K > FHD > HD > SD)
    if (upper.match(/4K|UHD/)) { quality = "4K UHD"; icon = "🟢"; rank = 4; }
    else if (upper.match(/FHD|1080|FULLHD|FULL HD/)) { quality = "Full HD"; icon = "🔵"; rank = 3; }
    else if (upper.match(/HD|720/)) { quality = "HD"; icon = "🟡"; rank = 2; }

    const clean = name
        .replace(/^.*?([|:\]\-])\s*/, '') 
        .replace(/FHD|FULLHD|FULL HD|HD|SD|1080P|720P|4K|UHD|H\.265|HEVC|RAW|BACKUP|ALT/gi, '')
        .replace(/\[.*?\]|\(.*\)/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return { baseName: clean || name, quality, icon, rank };
};

const getSmartLogo = (item) => {
    const logo = item.attributes?.['tvg-logo'] || item.logo;
    if (logo?.startsWith('http')) return logo;
    const name = cleanDisplayNames(item.name).baseName;
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=0D8ABC&color=fff&size=512`; 
};

// --- CLASA DE GESTIUNE DATE (Singleton-ish) ---

class IPTVManager {
    constructor(config) {
        this.config = config;
        this.channels = [];
        this.lastUpdate = 0;
        this.updating = false;
    }

    async refresh() {
        if (this.updating || (Date.now() - this.lastUpdate < 900000 && this.channels.length > 0)) return;
        this.updating = true;
        try {
            const provider = require(`./src/js/providers/xtreamProvider.js`);
            await provider.fetchData(this);
            this.lastUpdate = Date.now();
            fingerprintCache.clear(); // Curățăm cache-ul la refresh de date
        } catch (e) {
            console.error("Fetch Error:", e.message);
        } finally {
            this.updating = false;
        }
    }

    async getEPG(streamId) {
        const { xtreamUrl: url, xtreamUsername: user, xtreamPassword: pass } = this.config;
        const epgUrl = `${url}/player_api.php?username=${user}&password=${pass}&action=get_short_epg&stream_id=${streamId}`;
        try {
            const res = await fetch(epgUrl, { timeout: 4000 });
            const data = await res.json();
            const decode = (s) => Buffer.from(s, 'base64').toString('utf-8');
            return data?.epg_listings?.map(p => ({
                title: p.title ? decode(p.title) : "Program TV",
                start: new Date(p.start),
                end: new Date(p.end)
            })) || null;
        } catch { return null; }
    }
}

// --- CONSTRUCȚIE ADDON ---

async function createAddon(config) {
    const manager = new IPTVManager(config);
    const builder = new addonBuilder({
        id: ADDON_ID,
        version: VERSION,
        name: ADDON_NAME,
        resources: ["catalog", "stream", "meta"],
        types: ["tv"],
        catalogs: [{ 
            type: 'tv', id: 'iptv_stremio', name: '📺 IPTV STREMIO', 
            extra: [{ name: 'search' }, { name: 'genre', options: [] }] 
        }],
        idPrefixes: ["group_"]
    });

    // CATALOG: Căutare și Filtrare
    builder.defineCatalogHandler(async ({ extra }) => {
        await manager.refresh();
        
        // Update categorii dinamice
        if (builder.manifest.catalogs[0]) {
            const genres = [...new Set(manager.channels.map(c => c.category || "Altele"))].sort();
            builder.manifest.catalogs[0].extra[1].options = ["🕒 Istoric", ...genres];
        }

        let filtered = manager.channels;
        if (extra.search) {
            const query = extra.search.toLowerCase();
            filtered = filtered.filter(c => c.name.toLowerCase().includes(query));
        } else if (extra.genre === "🕒 Istoric") {
            filtered = channelHistory.map(fp => manager.channels.find(c => getChannelFingerprint(c.name) === fp)).filter(Boolean);
        } else if (extra.genre) {
            filtered = filtered.filter(c => c.category === extra.genre);
        } else {
            filtered = filtered.slice(0, 100); // Default view
        }

        const metas = [];
        const seen = new Set();

        for (const item of filtered) {
            const fp = getChannelFingerprint(item.name);
            if (!seen.has(fp)) {
                seen.add(fp);
                metas.push({
                    id: `group_${fp}`,
                    type: 'tv',
                    name: cleanDisplayNames(item.name).baseName.toUpperCase(),
                    poster: getSmartLogo(item),
                    posterShape: 'square'
                });
            }
        }
        return { metas };
    });

    // META: Detalii Canal + EPG
    builder.defineMetaHandler(async ({ id }) => {
        const fp = id.replace("group_", "");
        const sources = manager.channels.filter(c => getChannelFingerprint(c.name) === fp);
        if (!sources.length) return { meta: null };

        const streamId = sources[0].id.split('_').pop();
        const epg = await manager.getEPG(streamId);
        const now = new Date();

        let desc = `📺 CANAL: ${cleanDisplayNames(sources[0].name).baseName}\n───────────────────\n`;
        if (epg?.length) {
            const cur = epg.find(p => now >= p.start && now <= p.end) || epg[0];
            const progress = Math.min(100, Math.round(((now - cur.start) / (cur.end - cur.start)) * 100));
            const bar = "▓".repeat(Math.round(progress / 10)) + "░".repeat(10 - Math.round(progress / 10));
            desc += `🔴 ACUM: ${cur.title}\nPROGRES: ${bar} ${progress}%\n`;
        }
        desc += `───────────────────\n⭐ SURSE: ${sources.length}`;

        return { meta: { id, type: 'tv', name: cleanDisplayNames(sources[0].name).baseName, description: desc, poster: getSmartLogo(sources[0]) } };
    });

    // STREAM: Ierarhia Calității (4K -> FHD -> HD)
    builder.defineStreamHandler(async ({ id }) => {
        const fp = id.replace("group_", "");
        const sources = manager.channels.filter(c => getChannelFingerprint(c.name) === fp);
        
        // Update Istoric
        channelHistory = [fp, ...channelHistory.filter(f => f !== fp)].slice(0, 15);

        const streams = sources
            .map(s => ({ s, info: cleanDisplayNames(s.name) }))
            .sort((a, b) => b.info.rank - a.info.rank)
            .map(({ s, info }) => ({
                url: s.url,
                title: `${info.icon} ${info.quality} | ${s.name}`
            }));

        return { streams };
    });

    return builder.getInterface();
}

module.exports = createAddon;
