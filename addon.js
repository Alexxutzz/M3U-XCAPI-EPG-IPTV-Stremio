require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

const ADDON_NAME = "IPTV Stremio"; // Nume actualizat
const ADDON_ID = "org.stremio.iptv.4k.v280";
const VERSION = "2.8.0"; // Versiune păstrată
const RO_TIME = { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bucharest', hour12: false };

// Cache global pentru EPG pentru performanță sporită
const epgCache = new Map();

const FEATURED_CHANNELS = [
    "SKY SPORTS MAIN EVENT", "SKY SPORTS PREMIER LEAGUE", "SKY SPORTS FOOTBALL", 
    "TNT SPORTS 1", "TNT SPORTS 2", "PRO TV", "DIGI SPORT 1", "DIGI SPORT 2", 
    "DIGI SPORT 3", "DIGI SPORT 4", "ANTENA 1"
];

// --- UTILITARE ---

const cleanChannelName = (name) => {
    if (!name) return { baseName: "Canal TV", quality: "" };
    let quality = "";
    const lower = name.toLowerCase();
    
    if (lower.includes("4k") || lower.includes("uhd")) quality = "4K UHD";
    else if (lower.includes("fhd") || lower.includes("1080")) quality = "Full HD";
    else if (lower.includes("hd") || lower.includes("720")) quality = "HD";

    let clean = name
        .replace(/^(RO|UK|US|IT|FR|ES|DE|NOWTV)[:| \-|\|]+/gi, '') 
        .replace(/FHD|HD|SD|1080p|720p|4K|UHD|H\.265|HEVC|BACKUP|ALT/gi, '')
        .replace(/\[.*\]|\(.*\)/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return { baseName: clean || name, quality: quality };
};

// Logica Logo Fallback: generează un icon dacă lipsește logoul oficial
const getSmartLogo = (item) => {
    const primaryLogo = item.attributes?.['tvg-logo'] || item.logo;
    if (primaryLogo && primaryLogo.startsWith('http')) return primaryLogo;
    
    const channelName = encodeURIComponent(cleanChannelName(item.name).baseName);
    return `https://ui-avatars.com/api/?name=${channelName}&background=0D8ABC&color=fff&size=512`; 
};

// --- LOGICA ADDON ---

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
        } catch (e) { console.error("Data Fetch Error:", e.message); }
    }

    async getXtreamEpg(streamId) {
        const now = Date.now();
        
        // Verificare Cache (valabilitate 30 min)
        if (epgCache.has(streamId)) {
            const cached = epgCache.get(streamId);
            if (now - cached.timestamp < 1800000) return cached.data;
        }

        const url = `${this.config.xtreamUrl}/player_api.php?username=${this.config.xtreamUsername}&password=${this.config.xtreamPassword}&action=get_short_epg&stream_id=${streamId}`;
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 4000 });
            const data = await res.json();
            const decode = (str) => { try { return Buffer.from(str, 'base64').toString('utf-8'); } catch(e) { return str; } };
            
            const processed = data?.epg_listings?.map(p => ({
                title: p.title ? decode(p.title) : "Program TV",
                desc: p.description ? decode(p.description) : "",
                start: new Date(p.start),
                end: new Date(p.end)
            })) || null;

            if (processed) epgCache.set(streamId, { timestamp: now, data: processed });
            return processed;
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
            extra: [{ name: 'search' }, { name: 'genre', options: ['Ultra HD / 4K', 'Sport', 'Filme', 'Documentare'] }] 
        }],
        idPrefixes: ["group_"]
    });

    builder.defineCatalogHandler(async (args) => {
        await addon.updateData();
        const searchInput = args.extra?.search?.toLowerCase() || "";
        const genreInput = args.extra?.genre || "";

        let results = addon.channels;

        if (searchInput) {
            const words = searchInput.split(/\s+/);
            results = results.filter(item => words.every(word => item.name.toLowerCase().includes(word)));
        } else if (genreInput === 'Ultra HD / 4K') {
            results = results.filter(i => i.name.toUpperCase().includes("4K") || i.name.toUpperCase().includes("UHD"));
        } else if (genreInput) {
            results = results.filter(i => (i.attributes?.['group-title'] || "").toLowerCase().includes(genreInput.toLowerCase()));
        } else {
            results = results.filter(i => FEATURED_CHANNELS.some(f => i.name.toUpperCase().includes(f)));
        }

        const unique = new Map();
        results.forEach(item => {
            const { baseName } = cleanChannelName(item.name);
            if (!unique.has(baseName)) {
                unique.set(baseName, {
                    id: `group_${Buffer.from(baseName).toString('hex')}`,
                    type: 'tv',
                    name: baseName,
                    poster: getSmartLogo(item),
                    posterShape: 'square'
                });
            }
        });

        return { metas: Array.from(unique.values()).slice(0, 100) };
    });

    builder.defineMetaHandler(async ({ id }) => {
        const targetName = Buffer.from(id.replace("group_", ""), 'hex').toString();
        const matches = addon.channels.filter(c => cleanChannelName(c.name).baseName === targetName);
        if (matches.length === 0) return { meta: null };
        
        const logo = getSmartLogo(matches[0]);
        const streamId = matches[0].id.split('_').pop();
        const epg = await addon.getXtreamEpg(streamId);
        const now = new Date();

        // --- DESIGN INTERFAȚĂ EPG ---
        let description = `📅 DATA: ${now.toLocaleDateString('ro-RO')}  |  🕒 ORA: ${now.toLocaleTimeString('ro-RO', RO_TIME)}\n`;
        description += `📺 CANAL: ${targetName.toUpperCase()}\n`;
        description += `─────────────────────────────────\n\n`;

        if (epg && epg.length > 0) {
            const currentIndex = epg.findIndex(p => now >= p.start && now <= p.end);
            const cur = currentIndex !== -1 ? epg[currentIndex] : epg[0];
            const next = epg[currentIndex + 1];

            const percent = Math.max(0, Math.min(100, Math.round(((now - cur.start) / (cur.end - cur.start)) * 100)));
            const bar = "▓".repeat(Math.round(percent / 10)) + "░".repeat(10 - Math.round(percent / 10));

            description += `🔴 ACUM ÎN DIFUZARE:\n${cur.title.toUpperCase()}\n`;
            description += `[ ${cur.start.toLocaleTimeString('ro-RO', RO_TIME)} — ${cur.end.toLocaleTimeString('ro-RO', RO_TIME)} ]\n`;
            description += `PROGRES: ${bar} ${percent}%\n\n`;

            if (cur.desc) description += `ℹ️ INFO: ${cur.desc.substring(0, 150).trim()}...\n\n`;

            if (next) {
                description += `─────────────────────────────────\n`;
                description += `⏭️ URMEAZĂ:\n${next.title.toUpperCase()}\n`;
                description += `🕒 START: ${next.start.toLocaleTimeString('ro-RO', RO_TIME)}\n\n`;
            }
        } else {
            description += `📡 Ghidul TV (EPG) momentan indisponibil.\n\n`;
        }

        description += `─────────────────────────────────\n`;
        description += `⭐ CALITĂȚI: ${[...new Set(matches.map(m => cleanChannelName(m.name).quality || 'SD'))].join(' / ')}`;

        return { meta: { id, type: 'tv', name: targetName, description, poster: logo, background: logo, logo: logo } };
    });

    builder.defineStreamHandler(async ({ id }) => {
        const targetName = Buffer.from(id.replace("group_", ""), 'hex').toString();
        const matches = addon.channels.filter(c => cleanChannelName(c.name).baseName === targetName);
        
        // Sortare: 4K/UHD primele în listă
        const sorted = matches.sort((a, b) => {
            const is4K = (n) => n.toUpperCase().includes("4K") || n.toUpperCase().includes("UHD");
            return is4K(b.name) - is4K(a.name);
        });

        return { 
            streams: sorted.map(m => ({ 
                url: m.url, 
                title: `Sursă ${cleanChannelName(m.name).quality || 'Standard'}` 
            })) 
        };
    });

    return builder.getInterface();
}

module.exports = createAddon;
