require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

const ADDON_NAME = "IPTV Stremio PRO";
const ADDON_ID = "org.stremio.iptv.4k.v280";
const VERSION = "2.8.0";
const RO_TIME = { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bucharest', hour12: false };

// --- CONFIGURARE CANALE RECOMANDATE ---
const FEATURED_CHANNELS = [
    "SKY SPORTS MAIN EVENT", "SKY SPORTS PREMIER LEAGUE", "SKY SPORTS FOOTBALL", 
    "TNT SPORTS 1", "TNT SPORTS 2", "PRO TV", "DIGI SPORT 1", "DIGI SPORT 2", 
    "DIGI SPORT 3", "DIGI SPORT 4", "ANTENA 1"
];

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
            // Am adăugat categoria Ultra HD / 4K aici
            extra: [{ name: 'search' }, { name: 'genre', options: ['Ultra HD / 4K', 'Sport', 'Filme', 'Documentare'] }] 
        }],
        idPrefixes: ["group_"]
    });

    builder.defineCatalogHandler(async (args) => {
        await addon.updateData();
        const searchInput = args.extra?.search ? args.extra.search.toLowerCase() : "";
        const genreInput = args.extra?.genre ? args.extra.genre : "";

        let results = [];

        // Logica de filtrare
        if (searchInput) {
            const words = searchInput.split(/\s+/).filter(w => w.length > 0);
            results = addon.channels.filter(item => words.every(word => item.name.toLowerCase().includes(word)));
        } else if (genreInput === 'Ultra HD / 4K') {
            // Filtrare specială pentru 4K/UHD
            results = addon.channels.filter(i => 
                i.name.toUpperCase().includes("4K") || i.name.toUpperCase().includes("UHD")
            );
        } else if (genreInput) {
            results = addon.channels.filter(i => (i.attributes?.['group-title'] || "").toLowerCase().includes(genreInput.toLowerCase()));
        } else {
            results = addon.channels.filter(i => FEATURED_CHANNELS.some(f => i.name.toUpperCase().includes(f)));
        }

        const unique = new Map();
        results.forEach(item => {
            const { baseName } = cleanChannelName(item.name);
            if (!unique.has(baseName)) {
                const logo = item.attributes?.['tvg-logo'] || item.logo;
                unique.set(baseName, {
                    id: `group_${Buffer.from(baseName).toString('hex')}`,
                    type: 'tv',
                    name: baseName,
                    poster: logo,
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
    
    const logo = matches[0].attributes?.['tvg-logo'] || matches[0].logo;
    const streamId = matches[0].id.split('_').pop();
    const epg = await addon.getXtreamEpg(streamId);
    const now = new Date();

    // --- CONSTRUCȚIE HEADER ---
    let description = `📅 ${now.toLocaleDateString('ro-RO')}  |  🕒 ${now.toLocaleTimeString('ro-RO', RO_TIME)}\n`;
    description += `📺 CANAL: ${targetName.toUpperCase()}\n`;
    description += `──────────────────────────────\n\n`;

    if (epg && epg.length > 0) {
        const currentIndex = epg.findIndex(p => now >= p.start && now <= p.end);
        const cur = currentIndex !== -1 ? epg[currentIndex] : epg[0];
        const next = epg[currentIndex + 1];

        // --- PROGRAM CURENT ---
        const total = cur.end - cur.start;
        const elapsed = now - cur.start;
        const percent = Math.max(0, Math.min(100, Math.round((elapsed / total) * 100)));
        
        // Bară de progres minimalistă și elegantă
        const bar = "■".repeat(Math.round(percent / 10)) + "□".repeat(10 - Math.round(percent / 10));

        description += `🔴 **ACUM ÎN DIFUZARE**\n`;
        description += `**${cur.title.toUpperCase()}**\n`;
        description += `⏱️ ${cur.start.toLocaleTimeString('ro-RO', RO_TIME)} — ${cur.end.toLocaleTimeString('ro-RO', RO_TIME)}\n`;
        description += `PROGRES: ${bar} ${percent}%\n\n`;

        if (cur.desc) {
            description += `📖 *${cur.desc.substring(0, 180).trim()}...*\n\n`;
        }

        // --- PROGRAMUL URMĂTOR (Adăugat pentru organizare) ---
        if (next) {
            description += `──────────────────────────────\n`;
            description += `⏭️ **URMEAZĂ DISPONIBIL**\n`;
            description += `**${next.title}**\n`;
            description += `🕒 Începe la: ${next.start.toLocaleTimeString('ro-RO', RO_TIME)}\n`;
        }

    } else {
        description += `📡 Ghidul TV (EPG) nu este disponibil momentan.\n`;
        description += `Verificați conexiunea sau sursa IPTV.`;
    }

    // Adăugăm un footer discret
    description += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    description += `⭐ Calitate disponibilă: ${matches.map(m => cleanChannelName(m.name).quality || 'SD').join(' / ')}`;

    return { 
        meta: { 
            id, 
            type: 'tv', 
            name: targetName, 
            description, 
            poster: logo, 
            background: logo, 
            logo: logo 
        } 
    };
});

    builder.defineStreamHandler(async ({ id }) => {
        const targetName = Buffer.from(id.replace("group_", ""), 'hex').toString();
        const matches = addon.channels.filter(c => cleanChannelName(c.name).baseName === targetName);
        // Sortăm sursele astfel încât 4K să fie prima opțiune în lista de stream-uri
        const sortedMatches = matches.sort((a, b) => {
            const isA4k = a.name.toUpperCase().includes("4K") || a.name.toUpperCase().includes("UHD");
            const isB4k = b.name.toUpperCase().includes("4K") || b.name.toUpperCase().includes("UHD");
            return isB4k - isA4k;
        });

        return { 
            streams: sortedMatches.map(m => ({ 
                url: m.url, 
                title: `Sursă ${cleanChannelName(m.name).quality || 'Standard'}` 
            })) 
        };
    });

    return builder.getInterface();
}

module.exports = createAddon;
