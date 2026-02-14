require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

const ADDON_NAME = "IPTV Stremio";
const ADDON_ID = "org.stremio.iptv.pro.v230";
const VERSION = "2.3.0";
const RO_TIME = { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bucharest', hour12: false };

// Cache pentru Canale Recente (la nivel de server)
let recentChannels = []; 

const FEATURED_CHANNELS = ["PRO TV", "DIGI SPORT 1", "DIGI SPORT 2", "DIGI SPORT 3", "DIGI SPORT 4", "ANTENA 1", "HBO", "CINEMAX", "EUROSPORT", "KANAL D"];

// --- SMART CLEAN: REZOLVĂ PROBLEMA "USA NETWORK" ---
const cleanChannelName = (name) => {
    if (!name) return { baseName: "Canal TV", quality: "" };
    let quality = "";
    const lower = name.toLowerCase();
    
    if (lower.includes("4k")) quality = "4K Ultra HD";
    else if (lower.includes("fhd") || lower.includes("1080")) quality = "Full HD";
    else if (lower.includes("hd") || lower.includes("720")) quality = "HD Quality";

    // Modificăm regex-ul să nu șteargă "USA" dacă e urmat de alt cuvânt (ex: Network)
    let clean = name
        .replace(/^(RO|UK|US|IT|FR|ES|DE)[:| \-]*/gi, '') // Șterge prefixul doar dacă e la început
        .replace(/FHD|HD|SD|1080p|720p|4K|UHD|H\.265|HEVC|BACKUP|ALT/gi, '')
        .replace(/\[.*\]|\(.*\)/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return { baseName: clean || name, quality: quality };
};

const getSmartLogo = (baseName, originalLogo) => {
    if (originalLogo && originalLogo.startsWith('http')) return originalLogo;
    const slug = baseName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
    return `https://iptv-org.github.io/logos/languages/ron/${slug}.png`;
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
        } catch (e) { console.error("Search Error:", e.message); }
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
                type: 'tv', id: 'iptv_recent', name: '🕒 Recent Accesate',
                extra: [] 
            },
            { 
                type: 'tv', id: 'iptv_main', name: '📺 IPTV Stremio', 
                extra: [{ name: 'search' }, { name: 'genre', options: ['Sport', 'Filme', 'Documentare', 'Stiri'] }] 
            }
        ],
        idPrefixes: ["group_"]
    });

    builder.defineCatalogHandler(async (args) => {
        await addon.updateData();
        
        if (args.id === 'iptv_recent') {
            return { metas: recentChannels.slice(0, 10) };
        }

        const q = args.extra?.search ? args.extra.search.toLowerCase() : "";
        const g = args.extra?.genre ? args.extra.genre.toLowerCase() : "";

        let results = [];
        if (q) {
            results = addon.channels.filter(i => i.name.toLowerCase().includes(q));
        } else if (g) {
            results = addon.channels.filter(i => (i.attributes?.['group-title'] || "").toLowerCase().includes(g));
        } else {
            results = addon.channels.filter(i => FEATURED_CHANNELS.some(f => i.name.toUpperCase().includes(f)));
        }

        const unique = new Map();
        results.forEach(item => {
            const { baseName } = cleanChannelName(item.name);
            if (!unique.has(baseName)) {
                unique.set(baseName, {
                    id: `group_${Buffer.from(baseName).toString('hex')}`,
                    type: 'tv',
                    name: baseName,
                    poster: getSmartLogo(baseName, item.attributes?.['tvg-logo'] || item.logo),
                    posterShape: 'square'
                });
            }
        });

        return { metas: Array.from(unique.values()).slice(0, 100) };
    });

    builder.defineStreamHandler(async ({ id }) => {
        if (!id.startsWith("group_")) return { streams: [] };
        const targetName = Buffer.from(id.replace("group_", ""), 'hex').toString();
        
        // Logica pentru "Recente": adăugăm canalul în listă când e accesat
        const firstMatch = addon.channels.find(c => cleanChannelName(c.name).baseName === targetName);
        if (firstMatch) {
            const meta = {
                id, type: 'tv', name: targetName,
                poster: getSmartLogo(targetName, firstMatch.attributes?.['tvg-logo'] || firstMatch.logo),
                posterShape: 'square'
            };
            recentChannels = [meta, ...recentChannels.filter(c => c.name !== targetName)].slice(0, 15);
        }

        const matches = addon.channels.filter(c => cleanChannelName(c.name).baseName === targetName);
        return {
            streams: matches.map(m => ({
                url: m.url,
                title: `Sursă ${cleanChannelName(m.name).quality || 'Standard'}`
            }))
        };
    });

    // (Handler-ul de Meta rămâne cel din versiunea anterioară)
    return builder.getInterface();
}

module.exports = createAddon;
