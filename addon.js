require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

const ADDON_NAME = "IPTV Stremio";
const ADDON_ID = "org.stremio.iptv.stremio.v280";
const VERSION = "2.8.0";
const RO_TIME = { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bucharest', hour12: false };

let channelHistory = []; 

// --- UTILITARE ---

const normalizeString = (str) => {
    if (!str) return "";
    return str.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, "")
        .trim();
};

const cleanChannelName = (name) => {
    if (!name) return { baseName: "Canal TV", quality: "", icon: "⚪" };
    
    let workingName = name.replace(/ᵁᴴᴰ/g, 'UHD').replace(/ᴴᴰ/g, 'HD');
    const upper = workingName.toUpperCase();
    let quality = "SD";
    let icon = "⚪";

    if (upper.includes("4K") || upper.includes("UHD")) { quality = "4K UHD"; icon = "🟢"; }
    else if (upper.includes("FHD") || upper.includes("1080")) { quality = "Full HD"; icon = "🔵"; }
    else if (upper.includes("HD")) { quality = "HD"; icon = "🟡"; }

    let clean = workingName
        .replace(/^.*?([|:\]\-])\s*/, '') 
        .replace(/FHD|HD|SD|1080p|720p|4K|UHD|H\.265|HEVC|RAW|BACKUP|ALT/gi, '')
        .replace(/\[.*?\]|\(.*\)/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return { baseName: clean || workingName, quality, icon };
};

const getSmartLogo = (item) => {
    const primaryLogo = item.attributes?.['tvg-logo'] || item.logo;
    if (primaryLogo && primaryLogo.startsWith('http')) return primaryLogo;
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(cleanChannelName(item.name).baseName)}&background=0D8ABC&color=fff&size=512`; 
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

    async getStreamDetails(streamId) {
        const url = `${this.config.xtreamUrl}/player_api.php?username=${this.config.xtreamUsername}&password=${this.config.xtreamPassword}&action=get_live_streams&stream_id=${streamId}`;
        try {
            const res = await fetch(url, { timeout: 3000 });
            const data = await res.json();
            const info = Array.isArray(data) ? data.find(i => i.stream_id == streamId) : data;
            if (info && info.stream_decode) {
                const d = info.stream_decode;
                return {
                    fps: d.frame_rate || "N/A",
                    bitrate: d.bitrate ? `${(d.bitrate / 1024).toFixed(1)} Mbps` : "N/A",
                    codec: d.video_codec || "H.264",
                    res: d.width && d.height ? `${d.width}x${d.height}` : ""
                };
            }
        } catch (e) { return null; }
        return null;
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
        const genres = [...new Set(addon.channels.map(c => c.category || c.attributes?.['group-title'] || "Altele"))].sort();
        
        if (builder.manifest?.catalogs?.[0]) {
            builder.manifest.catalogs[0].extra[1].options = ["🕒 Istoric Canale", ...genres];
        }

        const genreInput = args.extra?.genre || "";
        const searchInput = args.extra?.search ? normalizeString(args.extra.search) : "";

        let results = addon.channels;

        if (searchInput) {
            const searchWords = searchInput.split(/\s+/);
            results = addon.channels
                .map(item => {
                    const normalizedName = normalizeString(item.name);
                    let score = 0;
                    if (normalizedName.includes(searchInput)) score += 100;
                    if (normalizedName.startsWith(searchWords[0])) score += 50;
                    searchWords.forEach(word => { if (normalizedName.includes(word)) score += 10; });
                    return { item, score };
                })
                .filter(obj => obj.score > 0)
                .sort((a, b) => b.score - a.score)
                .map(obj => obj.item);
        } else if (genreInput === "🕒 Istoric Canale") {
            results = channelHistory.map(name => addon.channels.find(c => cleanChannelName(c.name).baseName === name)).filter(Boolean);
        } else if (genreInput) {
            results = results.filter(i => (i.category || i.attributes?.['group-title']) === genreInput);
        } else {
            const historyItems = channelHistory.map(name => addon.channels.find(c => cleanChannelName(c.name).baseName === name)).filter(Boolean);
            const others = addon.channels.filter(c => !channelHistory.includes(cleanChannelName(c.name).baseName)).slice(0, 40);
            results = [...historyItems, ...others];
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
        if (!matches.length) return { meta: null };
        
        const logo = getSmartLogo(matches[0]);
        const streamId = matches[0].id.split('_').pop();
        const now = new Date();

        const [epg, tech] = await Promise.all([
            addon.getXtreamEpg(streamId),
            addon.getStreamDetails(streamId)
        ]);

        let description = `📅 DATA: ${now.toLocaleDateString('ro-RO')}  |  🕒 ORA: ${now.toLocaleTimeString('ro-RO', RO_TIME)}\n`;
        description += `📺 CANAL: ${targetName.toUpperCase()}\n`;
        description += `─────────────────────────────────\n`;
        
        if (tech) {
            description += `📊 TECH: ${tech.res} | ${tech.fps} FPS | ${tech.bitrate} | ${tech.codec}\n`;
            description += `─────────────────────────────────\n\n`;
        }

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
        description += `⭐ CALITĂȚI: ${[...new Set(matches.map(m => cleanChannelName(m.name).quality))].join(' / ')}`;

        return { meta: { id, type: 'tv', name: targetName, description, poster: logo, background: logo, logo: logo } };
    });

    builder.defineStreamHandler(async ({ id }) => {
        const targetName = Buffer.from(id.replace("group_", ""), 'hex').toString();
        channelHistory = [targetName, ...channelHistory.filter(n => n !== targetName)].slice(0, 10);
        const matches = addon.channels.filter(c => cleanChannelName(c.name).baseName === targetName);

        return { 
            streams: matches.map(m => {
                const info = cleanChannelName(m.name);
                let fpsLabel = "";
                if (m.name.toLowerCase().includes("50fps")) fpsLabel = " [50 FPS]";
                if (m.name.toLowerCase().includes("60fps")) fpsLabel = " [60 FPS]";
                return { 
                    url: m.url, 
                    title: `${info.icon} ${info.quality}${fpsLabel} | ${m.name}` 
                };
            }) 
        };
    });

    return builder.getInterface();
}

module.exports = createAddon;
