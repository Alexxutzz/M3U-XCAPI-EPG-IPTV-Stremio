require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

const ADDON_NAME = "IPTV Stremio";
const ADDON_ID = "org.stremio.iptv.professional";
const RO_TIME = { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bucharest', hour12: false };

// --- UTILS: CURĂȚARE ȘI FORMATARE PROFESIONALĂ ---
const cleanChannelName = (name) => {
    if (!name) return { baseName: "Unknown Channel", quality: "" };
    
    let quality = "";
    const lowerName = name.toLowerCase();
    
    if (lowerName.includes("4k") || lowerName.includes("uhd")) quality = "4K Ultra HD";
    else if (lowerName.includes("fhd") || lowerName.includes("1080")) quality = "Full HD";
    else if (lowerName.includes("hd") || lowerName.includes("720")) quality = "HD Quality";

    let clean = name
        .replace(/RO[:| \-]*|ROMANIA[:| \-]*|UK[:| \-]*|UK\||US[:| \-]*|US\|/gi, '') 
        .replace(/FHD|HD|SD|1080p|720p|4K|UHD|H\.265|HEVC|BACKUP|ALT/gi, '') 
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

    // Progres bar cu aspect minimalist
    getProgressBar(start, end) {
        const now = new Date();
        const total = end - start;
        const elapsed = now - start;
        const progress = Math.max(0, Math.min(100, Math.round((elapsed / total) * 100)));
        const filled = Math.round(progress / 10);
        return `${"🔵".repeat(filled)}${"⚪".repeat(10 - filled)} ${progress}%`;
    }

    async getXtreamEpg(streamId) {
        const url = `${this.config.xtreamUrl}/player_api.php?username=${this.config.xtreamUsername}&password=${this.config.xtreamPassword}&action=get_short_epg&stream_id=${streamId}`;
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 3500 });
            const data = await res.json();
            const decode = (str) => {
                try { return Buffer.from(str, 'base64').toString('utf-8'); }
                catch(e) { return str; }
            };
            return data?.epg_listings?.map(p => ({
                title: p.title ? decode(p.title) : "Program TV",
                desc: p.description ? decode(p.description) : "Nicio descriere disponibilă.",
                start: new Date(p.start),
                end: new Date(p.end)
            })) || null;
        } catch (e) { return null; }
    }

    async updateData() {
        if (Date.now() - this.lastUpdate < 900000 && this.channels.length > 0) return;
        try {
            const provider = require(`./src/js/providers/xtreamProvider.js`);
            await provider.fetchData(this);
            this.lastUpdate = Date.now();
        } catch (e) { console.error("Update Error:", e.message); }
    }
}

async function createAddon(config) {
    const addon = new M3UEPGAddon(config);
    const builder = new addonBuilder({
        id: ADDON_ID,
        version: "10.0.0",
        name: ADDON_NAME,
        resources: ["catalog", "stream", "meta"],
        types: ["tv"],
        catalogs: [
            { 
                type: 'tv', id: 'iptv_main', name: '📺 IPTV Stremio', 
                extra: [
                    { name: 'search', isRequired: false },
                    { name: 'genre', options: ['Sport', 'Filme', 'Documentare', 'Generale', 'Stiri'], isRequired: false }
                ] 
            }
        ],
        idPrefixes: ["group_"]
    });

    // --- CATALOG HANDLER (LOGICĂ DE GRUPARE RAPIDĂ) ---
    builder.defineCatalogHandler(async (args) => {
        await addon.updateData();
        let list = addon.channels;

        const q = args.extra?.search ? args.extra.search.toLowerCase() : "";
        const g = args.extra?.genre ? args.extra.genre.toLowerCase() : "";

        if (!q && !g) return { metas: [] };

        let filtered = list.filter(i => {
            const nameMatch = i.name.toLowerCase().includes(q);
            const groupMatch = g ? (i.attributes?.['group-title'] || "").toLowerCase().includes(g) : true;
            return nameMatch && groupMatch;
        });

        const uniqueChannels = new Map();
        for (const item of filtered) {
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

        return { metas: Array.from(uniqueChannels.values()).slice(0, 80) };
    });

    // --- META HANDLER (EPG PROFESIONAL) ---
    builder.defineMetaHandler(async ({ id }) => {
        if (!id.startsWith("group_")) return { meta: null };
        const targetName = Buffer.from(id.replace("group_", ""), 'hex').toString();
        
        const firstMatch = addon.channels.find(c => cleanChannelName(c.name).baseName === targetName);
        if (!firstMatch) return { meta: null };

        const streamId = firstMatch.id.split('_').pop();
        const epg = await addon.getXtreamEpg(streamId);
        const now = new Date();
        const oraRO = now.toLocaleTimeString('ro-RO', RO_TIME);

        let desc = `🕒 Ora curentă: ${oraRO}\n`;
        desc += `📡 Status: Semnal stabil\n`;
        desc += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

        if (epg && epg.length > 0) {
            const current = epg.find(p => now >= p.start && now <= p.end) || epg[0];
            desc += `🔴 ACUM: ${current.title.toUpperCase()}\n`;
            desc += `⏰ [${current.start.toLocaleTimeString('ro-RO', RO_TIME)} — ${current.end.toLocaleTimeString('ro-RO', RO_TIME)}]\n`;
            desc += `${addon.getProgressBar(current.start, current.end)}\n\n`;
            
            if (current.desc) {
                desc += `ℹ️ INFO:\n${current.desc.substring(0, 180)}${current.desc.length > 180 ? '...' : ''}\n\n`;
            }

            const next = epg.filter(p => p.start > now).slice(0, 3);
            if (next.length > 0) {
                desc += `📅 PROGRAM URMĂTOR:\n`;
                next.forEach(p => {
                    desc += `• ${p.start.toLocaleTimeString('ro-RO', RO_TIME)}  ${p.title}\n`;
                });
            }
        } else {
            desc += `📡 Ghidul TV nu este disponibil pentru acest canal.`;
        }

        return {
            meta: {
                id, type: 'tv', name: targetName,
                description: desc,
                poster: firstMatch.attributes?.['tvg-logo'] || firstMatch.logo || "",
                background: firstMatch.attributes?.['tvg-logo'] || firstMatch.logo || ""
            }
        };
    });

    // --- STREAM HANDLER ---
    builder.defineStreamHandler(async ({ id }) => {
        if (!id.startsWith("group_")) return { streams: [] };
        const targetName = Buffer.from(id.replace("group_", ""), 'hex').toString();
        const matches = addon.channels.filter(c => cleanChannelName(c.name).baseName === targetName);

        return {
            streams: matches.map(m => {
                const { quality } = cleanChannelName(m.name);
                return {
                    url: m.url,
                    title: `🌐 Sursă Server ${quality ? `— ${quality}` : '— Standard'}`
                };
            })
        };
    });

    return builder.getInterface();
}

module.exports = createAddon;
