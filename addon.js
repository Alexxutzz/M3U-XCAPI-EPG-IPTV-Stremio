require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

const ADDON_NAME = "IPTV Stremio";
const ADDON_ID = "org.stremio.iptv.pro.ultra";
const RO_TIME = { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bucharest', hour12: false };

// --- UTILS: CURĂȚARE ȘI GRUPARE ---
const cleanChannelName = (name) => {
    if (!name) return { baseName: "Unknown Channel", quality: "" };
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

    return { baseName: clean || "General Channel", quality: quality };
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
        // Cache 15 min pentru a preveni blocarea IP-ului și a mări viteza de search
        if (Date.now() - this.lastUpdate < 900000 && this.channels.length > 0) return;
        try {
            const provider = require(`./src/js/providers/xtreamProvider.js`);
            await provider.fetchData(this);
            this.lastUpdate = Date.now();
            console.log(`Bază de date actualizată: ${this.channels.length} surse.`);
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
        version: "11.0.0",
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

    builder.defineCatalogHandler(async (args) => {
        await addon.updateData();
        const q = args.extra?.search ? args.extra.search.toLowerCase() : "";
        const g = args.extra?.genre ? args.extra.genre.toLowerCase() : "";

        if (!q && !g) return { metas: [] };

        // Filtrare și Gruparea surselor pentru a evita duplicatele din Screenshot_2
        const uniqueChannels = new Map();
        
        addon.channels.forEach(item => {
            const nameMatch = item.name.toLowerCase().includes(q);
            const groupMatch = g ? (item.attributes?.['group-title'] || "").toLowerCase().includes(g) : true;
            
            if (nameMatch && groupMatch) {
                const { baseName } = cleanChannelName(item.name);
                if (!uniqueChannels.has(baseName)) {
                    uniqueChannels.set(baseName, {
                        id: `group_${Buffer.from(baseName).toString('hex')}`,
                        type: 'tv',
                        name: baseName,
                        poster: item.attributes?.['tvg-logo'] || item.logo || "",
                        posterShape: 'square'
                    });
                }
            }
        });

        return { metas: Array.from(uniqueChannels.values()).slice(0, 100) };
    });

    builder.defineMetaHandler(async ({ id }) => {
        if (!id.startsWith("group_")) return { meta: null };
        const targetName = Buffer.from(id.replace("group_", ""), 'hex').toString();
        const matches = addon.channels.filter(c => cleanChannelName(c.name).baseName === targetName);
        
        if (matches.length === 0) return { meta: null };
        const first = matches[0];
        
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
            description += `⏰ ${cur.start.toLocaleTimeString('ro-RO', RO_TIME)} — ${cur.end.toLocaleTimeString('ro-RO', RO_TIME)}\n`;
            description += `${addon.getProgressBar(cur.start, cur.end)}\n\n`;
            if (cur.desc) description += `ℹ️ INFO: ${cur.desc.substring(0, 150)}...\n\n`;
            
            const next = epg.filter(p => p.start > now).slice(0, 2);
            if (next.length > 0) {
                description += `📅 URMEAZĂ:\n`;
                next.forEach(p => description += `• ${p.start.toLocaleTimeString('ro-RO', RO_TIME)}  ${p.title}\n`);
            }
        } else {
            description += `📡 Ghidul TV momentan indisponibil.`;
        }

        return {
            meta: {
                id, type: 'tv', name: targetName,
                description,
                poster: first.attributes?.['tvg-logo'] || first.logo || "",
                background: first.attributes?.['tvg-logo'] || first.logo || ""
            }
        };
    });

    builder.defineStreamHandler(async ({ id }) => {
        if (!id.startsWith("group_")) return { streams: [] };
        const targetName = Buffer.from(id.replace("group_", ""), 'hex').toString();
        const matches = addon.channels.filter(c => cleanChannelName(c.name).baseName === targetName);

        return {
            streams: matches.map(m => {
                const { quality } = cleanChannelName(m.name);
                return {
                    url: m.url,
                    title: `🌐 Sursă ${quality ? `[${quality}]` : '[Standard]'}`
                };
            })
        };
    });

    return builder.getInterface();
}

module.exports = createAddon;
