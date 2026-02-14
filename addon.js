require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

const ADDON_NAME = "IPTV Stremio";
const ADDON_ID = "org.stremio.iptv.pro.v251";
const VERSION = "2.5.1";

// --- LOGOURI VERIFICATE (SURSA SIGURĂ) ---
const LOGO_DB = {
    "SKY SPORTS MAIN EVENT": "https://upload.wikimedia.org/wikipedia/en/thumb/3/3e/Sky_Sports_Main_Event_logo.svg/512px-Sky_Sports_Main_Event_logo.svg.png",
    "SKY SPORTS PREMIER LEAGUE": "https://upload.wikimedia.org/wikipedia/en/thumb/9/96/Sky_Sports_Premier_League_logo.svg/512px-Sky_Sports_Premier_League_logo.svg.png",
    "SKY SPORTS FOOTBALL": "https://upload.wikimedia.org/wikipedia/en/thumb/b/bb/Sky_Sports_Football_logo.svg/512px-Sky_Sports_Football_logo.svg.png",
    "TNT SPORTS 1": "https://upload.wikimedia.org/wikipedia/commons/thumb/1/19/TNT_Sports_logo.svg/512px-TNT_Sports_logo.svg.png",
    "TNT SPORTS 2": "https://upload.wikimedia.org/wikipedia/commons/thumb/1/19/TNT_Sports_logo.svg/512px-TNT_Sports_logo.svg.png",
    "PRO TV": "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d2/Pro_TV_logo.svg/512px-Pro_TV_logo.svg.png",
    "DIGI SPORT 1": "https://upload.wikimedia.org/wikipedia/ro/thumb/9/99/Digi_Sport_logo.svg/512px-Digi_Sport_logo.svg.png",
    "ANTENA 1": "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/Antena_1_logo.svg/512px-Antena_1_logo.svg.png"
};

const FEATURED_CHANNELS = Object.keys(LOGO_DB);

const getSmartLogo = (baseName, originalLogo) => {
    // 1. Verificăm dacă avem un logo "bătut în cuie" pentru acest canal
    const upperName = baseName.toUpperCase();
    for (const key in LOGO_DB) {
        if (upperName.includes(key)) return LOGO_DB[key];
    }

    // 2. Dacă originalul e valid, îl folosim
    if (originalLogo && originalLogo.startsWith('http') && !originalLogo.includes('no-logo')) {
        return originalLogo;
    }

    // 3. Fallback final (Sursă alternativă globală)
    const slug = baseName.toLowerCase().replace(/[^a-z0-9]/g, '');
    return `https://tv-logo.com/logo/uk-${slug}.png`;
};

const cleanChannelName = (name) => {
    if (!name) return { baseName: "Canal TV" };
    let clean = name
        .replace(/^(RO|UK|US|IT|FR|ES|DE|NOWTV)[:| \-|\|]+/gi, '') 
        .replace(/FHD|HD|SD|1080p|720p|4K|UHD|H\.265|HEVC|BACKUP|ALT/gi, '')
        .replace(/\[.*\]|\(.*\)/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return { baseName: clean || name };
};

// ... (Restul clasei M3UEPGAddon rămâne neschimbat)

async function createAddon(config) {
    const addon = new M3UEPGAddon(config);
    const builder = new addonBuilder({
        id: ADDON_ID, version: VERSION, name: ADDON_NAME,
        resources: ["catalog", "stream", "meta"],
        types: ["tv"],
        catalogs: [{ type: 'tv', id: 'iptv_dynamic', name: '📺 IPTV PRO', extra: [{ name: 'search' }] }],
        idPrefixes: ["group_"]
    });

    builder.defineCatalogHandler(async (args) => {
        await addon.updateData();
        const q = args.extra?.search ? args.extra.search.toLowerCase() : "";
        let results = q 
            ? addon.channels.filter(i => i.name.toLowerCase().includes(q))
            : addon.channels.filter(i => FEATURED_CHANNELS.some(f => i.name.toUpperCase().includes(f)));

        const unique = new Map();
        results.forEach(item => {
            const { baseName } = cleanChannelName(item.name);
            if (!unique.has(baseName)) {
                const logo = getSmartLogo(baseName, item.attributes?.['tvg-logo'] || item.logo);
                unique.set(baseName, {
                    id: `group_${Buffer.from(baseName).toString('hex')}`,
                    type: 'tv', name: baseName, poster: logo, posterShape: 'square'
                });
            }
        });
        return { metas: Array.from(unique.values()) };
    });

    builder.defineMetaHandler(async ({ id }) => {
        const targetName = Buffer.from(id.replace("group_", ""), 'hex').toString();
        const matches = addon.channels.filter(c => cleanChannelName(c.name).baseName === targetName);
        const logo = getSmartLogo(targetName, matches[0]?.attributes?.['tvg-logo']);
        return { meta: { id, type: 'tv', name: targetName, poster: logo, background: logo, logo: logo, description: `Vizionează ${targetName} live.` } };
    });

    builder.defineStreamHandler(async ({ id }) => {
        const targetName = Buffer.from(id.replace("group_", ""), 'hex').toString();
        const matches = addon.channels.filter(c => cleanChannelName(c.name).baseName === targetName);
        return { streams: matches.map(m => ({ url: m.url, title: `Sursă IPTV` })) };
    });

    return builder.getInterface();
}

module.exports = createAddon;
