require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

const ADDON_NAME = "IPTV Stremio";
const ADDON_ID = "org.stremio.iptv.stremio.v280";
const VERSION = "2.8.0";
const RO_TIME = { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bucharest', hour12: false };

let channelHistory = []; 
const fingerprintCache = new Map();

// --- LOGICA DE GRUPARE ȘI CURĂȚARE (iMPlayer Style) ---

const getChannelFingerprint = (name) => {
    if (!name) return "";
    if (fingerprintCache.has(name)) return fingerprintCache.get(name);

    const fprint = name.toLowerCase()
        // 1. Scoatem prefixele tip |UK| ✪ sau [RO]
        .replace(/^\|.*?\|\s*✪?\s*/, '')
        .replace(/^\[.*?\]\s*/, '')
        // 2. Scoatem calitățile pentru a uni variantele sub același poster
        .replace(/uhd|ultra|fhd|hd|sd|1080p|720p|50\s*fps|60\s*fps|dolby|atmos|vision|backup|alt/gi, '')
        // 3. Unificăm Sky Sport cu Sky Sports
        .replace(/sports/gi, 'sport')
        // 4. Curățăm restul de caractere non-alfanumerice
        .replace(/[^a-z0-9]/g, '')
        .trim();
    
    fingerprintCache.set(name, fprint);
    return fprint;
};

const cleanDisplayNames = (name) => {
    if (!name) return { baseName: "Canal TV", quality: "", icon: "⚪", rank: 0 };
    
    const upper = name.toUpperCase().replace(/ᵁ\s*ᴴ\s*ᴰ/g, 'UHD').replace(/ᴴ\s*ᴰ/g, 'HD');
    let quality = "SD", icon = "⚪", rank = 1;

    // Ierarhie extinsă bazată pe pozele iMPlayer
    if (upper.includes("ULTRA") || upper.includes("4K") || upper.includes("UHD")) { 
        quality = "4K ULTRA UHD"; icon = "🟢"; rank = 5; 
    } else if (upper.includes("FHD") || upper.includes("1080") || upper.includes("FULL HD")) { 
        quality = "Full HD"; icon = "🔵"; rank = 4; 
    } else if (upper.includes("50") && upper.includes("FPS")) { 
        quality = "HD 50 FPS"; icon = "🟡"; rank = 3; 
    } else if (upper.includes("HD") || upper.includes("720")) { 
        quality = "HD"; icon = "🟡"; rank = 2; 
    }

    // Curățăm numele pentru afișarea pe poster
    let clean = name
        .replace(/^\|.*?\|\s*✪?\s*/, '') // Scoate |UK| ✪
        .replace(/UHD|ULTRA|FHD|FULL HD|HD|SD|1080P|720P|50\s*FPS|60\s*FPS|DOLBY.*|HEVC|H265|RAW|BACKUP|ALT/gi, '')
        .replace(/\[.*?\]|\(.*\)/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return { baseName: clean || name, quality, icon, rank };
};

const getSmartLogo = (item) => {
    const primaryLogo = item.attributes?.['tvg-logo'] || item.logo;
    if (primaryLogo && primaryLogo.startsWith('http')) return primaryLogo;
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(cleanDisplayNames(item.name).baseName)}&background=0D8ABC&color=fff&size=512`; 
};

// --- CLASA PRINCIPALĂ ---

class M3UEPGAddon {
    constructor(config = {}) {
        this.config = config;
        this.channels = [];
        this.lastUpdate = 0;
    }

    async updateData() {
        if (Date.now() - this.lastUpdate < 900000 && this.channels.length > 0) return;
        try {
            const provider = require(`./src/js/providers/xtreamProvider.js`);
            await provider.fetchData(this);
            this.lastUpdate = Date.now();
            fingerprintCache.clear();
        } catch (e) { console.error("Data Fetch Error:", e.message); }
    }

    async getXtreamEpg(streamId) {
        const url = `${this.config.xtreamUrl}/player_api.php?username=${this.config.xtreamUsername}&password=${this.config.xtreamPassword}&action=get_short_epg&stream_id=${streamId}`;
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 4000 });
            const data = await res.json();
            const decode = (str) => { try { return Buffer.from(str, 'base64').toString('utf-8'); } catch(e) { return str; } };
            return data?.epg_listings?.map(p => ({
                title: p.title ? decode(p.title) : "Program TV",
                desc: p.description ? decode(p.description) : "",
                start: new Date(p.start),
                end: new Date(p.end)
            })) || null;
        } catch (e) { return null; }
    }
}

async function createAddon(config) {
    const addon = new M3UEPGAddon(config);
    const builder = new addonBuilder({
        id: ADDON_ID,
        version: VERSION,
        name: ADDON_NAME,
        resources: ["catalog", "stream", "meta"],
        types: ["tv"],
        catalogs: [{ 
            type: 'tv', 
            id: 'iptv_stremio', 
            name: '📺 IPTV STREMIO', 
            extra: [{ name: 'search' }, { name: 'genre', options: [] }] 
        }],
        idPrefixes: ["group_"]
    });

    builder.defineCatalogHandler(async (args) => {
        await addon.updateData();
        
        // Curățăm numele categoriilor (scoatem |UK| ✪) pentru meniul Stremio
        const genres = [...new Set(addon.channels.map(c => {
            const cat = c.category || c.attributes?.['group-title'] || "Altele";
            return cat.replace(/^\|.*?\|\s*✪?\s*/, '').trim();
        }))].sort();
        
        if (builder.manifest?.catalogs?.[0]) builder.manifest.catalogs[0].extra[1].options = ["🕒 Istoric Canale", ...genres];

        const genreInput = args.extra?.genre || "";
        const searchInput = args.extra?.search?.toLowerCase().trim() || "";

        let results = addon.channels;

        if (searchInput) {
            results = results.filter(item => item.name.toLowerCase().includes(searchInput));
        } else if (genreInput === "🕒 Istoric Canale") {
            results = channelHistory.map(fprint => addon.channels.find(c => getChannelFingerprint(c.name) === fprint)).filter(Boolean);
        } else if (genreInput) {
            results = results.filter(i => {
                const cat = (i.category || i.attributes?.['group-title'] || "").replace(/^\|.*?\|\s*✪?\s*/, '').trim();
                return cat === genreInput;
            });
        }

        const unique = new Map();
        results.forEach(item => {
            const fingerprint = getChannelFingerprint(item.name);
            const { baseName } = cleanDisplayNames(item.name);
            if (!unique.has(fingerprint)) {
                unique.set(fingerprint, {
                    id: `group_${fingerprint}`,
                    type: 'tv',
                    name: baseName.toUpperCase(),
                    poster: getSmartLogo(item),
                    posterShape: 'square'
                });
            }
        });

        return { metas: Array.from(unique.values()).slice(0, 100) };
    });

    builder.defineMetaHandler(async ({ id }) => {
        const fingerprint = id.replace("group_", "");
        const matches = addon.channels.filter(c => getChannelFingerprint(c.name) === fingerprint);
        if (!matches.length) return { meta: null };
        
        const logo = getSmartLogo(matches[0]);
        const streamId = matches[0].id.split('_').pop();
        const epg = await addon.getXtreamEpg(streamId);
        const now = new Date();

        let description = `📅 DATA: ${now.toLocaleDateString('ro-RO')}  |  🕒 ORA: ${now.toLocaleTimeString('ro-RO', RO_TIME)}\n`;
        description += `📺 CANAL: ${cleanDisplayNames(matches[0].name).baseName.toUpperCase()}\n`;
        description += `─────────────────────────────────\n\n`;

        if (epg && epg.length > 0) {
            const currentIndex = epg.findIndex(p => now >= p.start && now <= p.end);
            const cur = currentIndex !== -1 ? epg[currentIndex] : epg[0];
            const percent = Math.max(0, Math.min(100, Math.round(((now - cur.start) / (cur.end - cur.start)) * 100)));
            const bar = "▓".repeat(Math.round(percent / 10)) + "░".repeat(10 - Math.round(percent / 10));

            description += `🔴 ACUM:\n${cur.title.toUpperCase()}\n`;
            description += `[ ${cur.start.toLocaleTimeString('ro-RO', RO_TIME)} — ${cur.end.toLocaleTimeString('ro-RO', RO_TIME)} ]\n`;
            description += `PROGRES: ${bar} ${percent}%\n\n`;
        }

        description += `─────────────────────────────────\n`;
        description += `⭐ SURSE: ${matches.length}`;

        return { meta: { id, type: 'tv', name: cleanDisplayNames(matches[0].name).baseName.toUpperCase(), description, poster: logo, background: logo, logo: logo } };
    });

    builder.defineStreamHandler(async ({ id }) => {
        const fingerprint = id.replace("group_", "");
        
        if (!channelHistory.includes(fingerprint)) {
            channelHistory = [fingerprint, ...channelHistory.filter(f => f !== fingerprint)].slice(0, 15);
        }

        const matches = addon.channels.filter(c => getChannelFingerprint(c.name) === fingerprint);

        const sortedStreams = matches
            .map(m => ({ ...m, info: cleanDisplayNames(m.name) }))
            .sort((a, b) => b.info.rank - a.info.rank);

        return { 
            streams: sortedStreams.map(m => ({ 
                url: m.url, 
                title: `${m.info.icon} ${m.info.quality} | ${m.name.replace(/^\|.*?\|\s*✪?\s*/, '')}` 
            })) 
        };
    });

    return builder.getInterface();
}

module.exports = createAddon;
