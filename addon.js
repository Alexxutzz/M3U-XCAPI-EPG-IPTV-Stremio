require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

const ADDON_NAME = "IPTV Stremio";
const ADDON_ID = "org.stremio.iptv.pro.v220";
const VERSION = "2.2.0";
const RO_TIME = { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bucharest', hour12: false };

// --- CONFIGURARE CANALE RECOMANDATE (DISCOVER MODE) ---
const FEATURED_CHANNELS = [
    "PRO TV", "DIGI SPORT 1", "DIGI SPORT 2", "DIGI SPORT 3", "DIGI SPORT 4", 
    "ANTENA 1", "HBO", "CINEMAX", "EUROSPORT", "KANAL D", "PRIMA TV", "ORANGE SPORT"
];

// --- UTILS: LOGICĂ LOGO-URI HD (FALLBACK) ---
const getSmartLogo = (baseName, originalLogo) => {
    if (originalLogo && originalLogo.startsWith('http') && !originalLogo.includes('no-logo')) {
        return originalLogo;
    }
    // Formatare nume pentru URL: "Digi Sport 1" -> "digi-sport-1"
    const slug = baseName.toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    
    return `https://iptv-org.github.io/logos/languages/ron/${slug}.png`;
};

// --- UTILS: CURĂȚARE NUME ȘI DETECTARE CALITATE ---
const cleanChannelName = (name) => {
    if (!name) return { baseName: "Canal TV", quality: "" };
    let quality = "";
    const lower = name.toLowerCase();
    
    if (lower.includes("4k") || lower.includes("uhd")) quality = "4K Ultra HD";
    else if (lower.includes("fhd") || lower.includes("1080")) quality = "Full HD";
    else if (lower.includes("hd") || lower.includes("720")) quality = "HD Quality";

    let clean = name
        .replace(/RO[:| \-]*|ROMANIA[:| \-]*|UK[:| \-]*|UK\||US[:| \-]*|US\||4K\|/gi, '') 
        .replace(/FHD|HD|SD|1080p|720p|4K|UHD|H\.265|HEVC|BACKUP|ALT|NOWTV/gi, '') 
        .replace(/\[.*\]|\(.*\)/g, '') 
        .replace(/\s+/g, ' ') 
        .trim();

    return { baseName: clean || "Canal General", quality: quality };
};

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
        return `${"🔵".repeat(filled)}${"⚪".repeat(10 - filled)} ${progress}%`;
    }

    async updateData() {
        if (Date.now() - this.lastUpdate < 900000 && this.channels.length > 0) return;
        try {
            const provider = require(`./src/js/providers/xtreamProvider.js`);
            await provider.fetchData(this);
            this.lastUpdate = Date.now();
        } catch (e) { console.error("Update Error:", e.message); }
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
        catalogs: [
            { 
                type: 'tv', id: 'iptv_dynamic', name: '📺 IPTV Stremio', 
                extra: [
                    { name: 'search', isRequired: false },
                    { name: 'genre', options: ['Sport', 'Filme', 'Documentare', 'Generale', 'Stiri'], isRequired: false }
                ] 
            }
        ],
        idPrefixes: ["group_"]
    });

    // --- HANDLER CATALOG (CU DISCOVER MODE) ---
    builder.defineCatalogHandler(async (args) => {
        await addon.updateData();
        const q = args.extra?.search ? args.extra.search.toLowerCase() : "";
        const g = args.extra?.genre ? args.extra.genre.toLowerCase() : "";

        let filteredResults = [];

        if (q) {
            filteredResults = addon.channels.filter(i => i.name.toLowerCase().includes(q));
        } else if (g) {
            filteredResults = addon.channels.filter(i => (i.attributes?.['group-title'] || "").toLowerCase().includes(g));
        } else {
            // MODUL DISCOVER: Dacă nu există căutare, afișăm favoritele predefinite
            filteredResults = addon.channels.filter(i => 
                FEATURED_CHANNELS.some(fav => i.name.toUpperCase().includes(fav))
            );
        }

        const uniqueChannels = new Map();
        filteredResults.forEach(item => {
            const { baseName } = cleanChannelName(item.name);
            if (!uniqueChannels.has(baseName)) {
                const logo = getSmartLogo(baseName, item.attributes?.['tvg-logo'] || item.logo);
                uniqueChannels.set(baseName, {
                    id: `group_${Buffer.from(baseName).toString('hex')}`,
                    type: 'tv',
                    name: baseName,
                    poster: logo,
                    posterShape: 'square'
                });
            }
        });

        let finalMetas = Array.from(uniqueChannels.values());

        // Sortare specială pentru favorite (modul Discover)
        if (!q && !g) {
            finalMetas.sort((a, b) => {
                const indexA = FEATURED_CHANNELS.findIndex(f => a.name.toUpperCase().includes(f));
                const indexB = FEATURED_CHANNELS.findIndex(f => b.name.toUpperCase().includes(f));
                return indexA - indexB;
            });
        }

        return { metas: finalMetas.slice(0, 100) };
    });

    // --- HANDLER META (EPG) ---
    builder.defineMetaHandler(async ({ id }) => {
        if (!id.startsWith("group_")) return { meta: null };
        const targetName = Buffer.from(id.replace("group_", ""), 'hex').toString();
        const matches = addon.channels.filter(c => cleanChannelName(c.name).baseName === targetName);
        
        if (matches.length === 0) return { meta: null };
        const first = matches[0];
        const logo = getSmartLogo(targetName, first.attributes?.['tvg-logo'] || first.logo);
        
        const streamId = first.id.split('_').pop();
        const epg = await addon.getXtreamEpg(streamId);
        const now = new Date();
        const oraRO = now.toLocaleTimeString('ro-RO', RO_TIME);

        let description = `🕒 ORA ROMÂNIEI: ${oraRO}\n`;
        description += `📺 CANAL: ${targetName}\n`;
        description += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

        if (epg && epg.length > 0) {
            const cur = epg.find(p => now >= p.start && now <= p.end) || epg[0];
            description += `🔴 ACUM: ${cur.title.toUpperCase()}\n`;
            description += `⏰ [${cur.start.toLocaleTimeString('ro-RO', RO_TIME)} — ${cur.end.toLocaleTimeString('ro-RO', RO_TIME)}]\n`;
            description += `${addon.getProgressBar(cur.start, cur.end)}\n\n`;
            if (cur.desc) description += `ℹ️ INFO: ${cur.desc.substring(0, 180)}...\n\n`;
            
            const next = epg.filter(p => p.start > now).slice(0, 2);
            if (next.length > 0) {
                description += `📅 URMEAZĂ:\n`;
                next.forEach(p => description += `• ${p.start.toLocaleTimeString('ro-RO', RO_TIME)}  ${p.title}\n`);
            }
        } else {
            description += `📡 Ghidul TV (EPG) indisponibil momentan.`;
        }

        return {
            meta: {
                id, type: 'tv', name: targetName,
                description, poster: logo, background: logo, logo: logo
            }
        };
    });

    // --- HANDLER STREAM ---
    builder.defineStreamHandler(async ({ id }) => {
        if (!id.startsWith("group_")) return { streams: [] };
        const targetName = Buffer.from(id.replace("group_", ""), 'hex').toString();
        const matches = addon.channels.filter(c => cleanChannelName(c.name).baseName === targetName);

        return {
            streams: matches.map(m => {
                const { quality } = cleanChannelName(m.name);
                return {
                    url: m.url,
                    title: `🌐 Sursă IPTV ${quality ? `— ${quality}` : '— Standard'}`
                };
            })
        };
    });

    return builder.getInterface();
}

module.exports = createAddon;
