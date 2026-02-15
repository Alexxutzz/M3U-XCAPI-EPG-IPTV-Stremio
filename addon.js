require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const ADDON_NAME = "IPTV Universal";
const ADDON_ID = "org.stremio.iptv.universal.v280";
const VERSION = "2.8.0";
const HISTORY_PATH = path.join(__dirname, 'history.json');
const RO_TIME = { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bucharest', hour12: false };

// --- GESTIONARE ISTORIC (MAX 10) ---
let channelHistory = [];
try {
    if (fs.existsSync(HISTORY_PATH)) {
        channelHistory = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    }
} catch (e) { console.error("History Load Error:", e); }

const saveHistory = () => {
    try { 
        fs.writeFileSync(HISTORY_PATH, JSON.stringify(channelHistory.slice(0, 10))); 
    } catch (e) { console.error("History Save Error:", e); }
};

// --- CURĂȚARE UNIVERSALĂ ---
const cleanChannelName = (name) => {
    if (!name) return { baseName: "Canal TV", quality: "" };
    
    let workingName = name.replace(/ᵁᴴᴰ/g, 'UHD').replace(/ᴴᴰ/g, 'HD');
    const upper = workingName.toUpperCase();
    let quality = "SD";

    if (upper.includes("4K") || upper.includes("UHD")) quality = "4K UHD";
    else if (upper.includes("FHD") || upper.includes("1080")) quality = "Full HD";
    else if (upper.includes("HD")) quality = "HD";

    let clean = workingName
        .replace(/^.*?([|:\]\-])\s*/, '') 
        .replace(/FHD|HD|SD|1080p|720p|4K|UHD|H\.265|HEVC|RAW|BACKUP|ALT/gi, '')
        .replace(/\[.*?\]|\(.*\)/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return { baseName: clean || workingName, quality: quality };
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
            name: '📺 IPTV UNIVERSAL', 
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
        const searchInput = args.extra?.search?.toLowerCase().trim() || "";

        let results = addon.channels;

        // --- SEARCH OPTIMIZAT ---
        if (searchInput) {
            const searchWords = searchInput.split(/\s+/);
            results = results.filter(item => {
                const name = item.name.toLowerCase();
                // Trebuie să conțină toate cuvintele din căutare, indiferent de ordine
                return searchWords.every(word => name.includes(word));
            });
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

    builder.defineStreamHandler(async ({ id }) => {
        const targetName = Buffer.from(id.replace("group_", ""), 'hex').toString();
        
        channelHistory = [targetName, ...channelHistory.filter(n => n !== targetName)].slice(0, 10);
        saveHistory();

        const matches = addon.channels.filter(c => cleanChannelName(c.name).baseName === targetName);
        return { 
            streams: matches.map(m => ({ 
                url: m.url, 
                title: `${cleanChannelName(m.name).quality} | ${m.name}` 
            })) 
        };
    });

    builder.defineMetaHandler(async ({ id }) => {
        const targetName = Buffer.from(id.replace("group_", ""), 'hex').toString();
        const matches = addon.channels.filter(c => cleanChannelName(c.name).baseName === targetName);
        if (!matches.length) return { meta: null };
        const logo = getSmartLogo(matches[0]);
        return { meta: { id, type: 'tv', name: targetName, poster: logo, background: logo, logo: logo } };
    });

    return builder.getInterface();
}

module.exports = createAddon;
