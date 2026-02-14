require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

const ADDON_NAME = "IPTV Stremio PRO";
const ADDON_ID = "org.stremio.iptv.universal.v261";
const VERSION = "2.6.1";
const RO_TIME = { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bucharest', hour12: false };

// --- CONFIGURARE CANALE RECOMANDATE ---
const FEATURED_CHANNELS = [
    "SKY SPORTS MAIN EVENT", "SKY SPORTS PREMIER LEAGUE", "SKY SPORTS FOOTBALL", 
    "TNT SPORTS 1", "TNT SPORTS 2", "PRO TV", "DIGI SPORT 1", "DIGI SPORT 2", 
    "DIGI SPORT 3", "DIGI SPORT 4", "ANTENA 1"
];

// --- MOTOR UNIVERSAL DE LOGO-URI ---
const getUniversalLogo = (name) => {
    // Curățăm numele pentru a crea un slug compatibil cu CDN-ul
    const slug = name.toLowerCase()
        .replace(/sky sports/g, 'sky-sports')
        .replace(/tnt sports/g, 'tnt-sports')
        .replace(/[^a-z0-9]/g, '') 
        .trim();
    
    // Sursă globală via jsDelivr pentru viteză și stabilitate
    return `https://cdn.jsdelivr.net/gh/iptv-org/logos@master/logos/${slug}.png`;
};

// --- CURĂȚARE NUME ȘI DETECTARE CALITATE ---
const cleanChannelName = (name) => {
    if (!name) return { baseName: "Canal TV", quality: "" };
    let quality = "";
    const lower = name.toLowerCase();
    
    if (lower.includes("4k")) quality = "4K UHD";
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
            id: 'iptv_pro', 
            name: '📺 IPTV PRO', 
            extra: [{ name: 'search' }, { name: 'genre', options: ['Sport', 'Filme', 'Documentare'] }] 
        }],
        idPrefixes: ["group_"]
    });

    // --- CATALOG HANDLER ---
    builder.defineCatalogHandler(async (args) => {
        await addon.updateData();
        const searchInput = args.extra?.search ? args.extra.search.toLowerCase() : "";
        const genreInput = args.extra?.genre ? args.extra.genre.toLowerCase() : "";

        let results = [];
        if (searchInput) {
            // Căutare elastică word-by-word
            const words = searchInput.split(/\s+/).filter(w => w.length > 0);
            results = addon.channels.filter(item => words.every(word => item.name.toLowerCase().includes(word)));
        } else if (genreInput) {
            results = addon.channels.filter(i => (i.attributes?.['group-title'] || "").toLowerCase().includes(genreInput));
        } else {
            // Afișare Featured Channels
            results = addon.channels.filter(i => FEATURED_CHANNELS.some(f => i.name.toUpperCase().includes(f)));
        }

        const unique = new Map();
        results.forEach(item => {
            const { baseName } = cleanChannelName(item.name);
            if (!unique.has(baseName)) {
                const logo = getUniversalLogo(baseName);
                unique.set(baseName, {
                    id: `group_${Buffer.from(baseName).toString('hex')}`,
                    type: 'tv',
                    name: baseName,
                    poster: logo,
                    posterShape: 'square'
                });
            }
        });

        let finalMetas = Array.from(unique.values());
        if (!searchInput && !genreInput) {
            finalMetas.sort((a, b) => {
                const indexA = FEATURED_CHANNELS.findIndex(f => a.name.toUpperCase().includes(f));
                const indexB = FEATURED_CHANNELS.findIndex(f => b.name.toUpperCase().includes(f));
                return indexA - indexB;
            });
        }
        return { metas: finalMetas.slice(0, 100) };
    });

    // --- META HANDLER ---
    builder.defineMetaHandler(async ({ id }) => {
        const targetName = Buffer.from(id.replace("group_", ""), 'hex').toString();
        const matches = addon.channels.filter(c => cleanChannelName(c.name).baseName === targetName);
        if (matches.length === 0) return { meta: null };
        
        const logo = getUniversalLogo(targetName);
        const streamId = matches[0].id.split('_').pop();
        const epg = await addon.getXtreamEpg(streamId);
        const now = new Date();

        let description = `🕒 ORA RO: ${now.toLocaleTimeString('ro-RO', RO_TIME)}\n📺 CANAL: ${targetName}\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        if (epg && epg.length > 0) {
            const cur = epg.find(p => now >= p.start && now <= p.end) || epg[0];
            const elapsed = now - cur.start;
            const progress = Math.max(0, Math.min(100, Math.round((elapsed / (cur.end - cur.start)) * 100)));
            const bar = "🔵".repeat(Math.round(progress/10)) + "⚪".repeat(10 - Math.round(progress/10));
            description += `🔴 ACUM: ${cur.title.toUpperCase()}\n⏰ ${cur.start.toLocaleTimeString('ro-RO', RO_TIME)} — ${cur.end.toLocaleTimeString('ro-RO', RO_TIME)}\n${bar} ${progress}%\n\nℹ️ ${cur.desc.substring(0, 200)}`;
        } else {
            description += `📡 Ghidul TV (EPG) nu este disponibil.`;
        }

        return { meta: { id, type: 'tv', name: targetName, description, poster: logo, background: logo, logo: logo } };
    });

    // --- STREAM HANDLER ---
    builder.defineStreamHandler(async ({ id }) => {
        const targetName = Buffer.from(id.replace("group_", ""), 'hex').toString();
        const matches = addon.channels.filter(c => cleanChannelName(c.name).baseName === targetName);
        return { 
            streams: matches.map(m => ({ 
                url: m.url, 
                title: `Sursă ${cleanChannelName(m.name).quality || 'Standard'}` 
            })) 
        };
    });

    return builder.getInterface();
}

module.exports = createAddon;
