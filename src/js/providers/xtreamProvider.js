const { addonBuilder } = require("stremio-addon-sdk");
const provider = require('./src/js/providers/xtreamProvider');
const fetch = require('node-fetch');

const builder = new addonBuilder({
    id: "org.iptv.xtream.optimized",
    version: "1.2.0",
    name: "IPTV Xtream Optimized",
    resources: ["catalog", "stream", "meta"],
    types: ["tv", "movie", "series"],
    catalogs: [
        { type: "tv", id: "iptv_channels", name: "IPTV Channels", extra: [{ name: "search" }] },
        { type: "movie", id: "iptv_movies", name: "IPTV Movies", extra: [{ name: "search" }] },
        { type: "series", id: "iptv_series", name: "IPTV Series", extra: [{ name: "search" }] }
    ],
    idPrefixes: ["iptv_"]
});

const addonState = {
    channels: [],
    movies: [],
    series: [],
    lastUpdate: 0,
    config: {
        xtreamUrl: process.env.XTREAM_URL,
        xtreamUsername: process.env.XTREAM_USER,
        xtreamPassword: process.env.XTREAM_PASSWORD
    }
};

// Funcție EPG rapidă (Cere doar datele pentru un singur canal)
async function getQuickEpg(streamId) {
    const url = `${addonState.config.xtreamUrl}/player_api.php?username=${addonState.config.xtreamUsername}&password=${addonState.config.xtreamPassword}&action=get_short_epg&stream_id=${streamId}`;
    try {
        const res = await fetch(url, { timeout: 3000 });
        const data = await res.json();
        const now = data?.epg_listings?.[0];
        if (!now) return "Niciun program disponibil";
        return `ACUM: ${Buffer.from(now.title, 'base64').toString('utf-8')}\nDESC: ${Buffer.from(now.description, 'base64').toString('utf-8')}`;
    } catch (e) { return "EPG indisponibil"; }
}

// Handler Cataloage
builder.defineCatalogHandler(async (args) => {
    // Refresh date la 15 minute
    if (Date.now() - addonState.lastUpdate > 900000) {
        await provider.fetchData(addonState);
        addonState.lastUpdate = Date.now();
    }

    let results = [];
    if (args.type === 'tv') results = addonState.channels;
    if (args.type === 'movie') results = addonState.movies;
    if (args.type === 'series') results = addonState.series;

    if (args.extra.search) {
        const q = args.extra.search.toLowerCase();
        results = results.filter(i => i.name.toLowerCase().includes(q));
    }

    return { metas: results.slice(0, 200).map(i => ({
        id: i.id,
        type: i.type,
        name: i.name,
        poster: i.poster || i.logo
    }))};
});

// Handler Meta (Detalii + EPG)
builder.defineMetaHandler(async ({ type, id }) => {
    let item;
    if (type === 'tv') {
        item = addonState.channels.find(i => i.id === id);
        if (item) item.description = await getQuickEpg(id.split('_').pop());
    } else if (type === 'movie') {
        item = addonState.movies.find(i => i.id === id);
    } else if (type === 'series') {
        item = addonState.series.find(i => i.id === id);
        const info = await provider.fetchSeriesInfo(addonState, item.series_id);
        item.videos = info.videos;
    }

    return { meta: item };
});

// Handler Stream
builder.defineStreamHandler(async ({ id }) => {
    let streamUrl;
    if (id.startsWith('iptv_series_ep_')) {
        // Logica pentru seriale este inclusă în MetaHandler (videos)
        return { streams: [] }; 
    }
    
    const item = [...addonState.channels, ...addonState.movies].find(i => i.id === id);
    return { streams: item ? [{ url: item.url, title: item.name }] : [] };
});

module.exports = builder.getInterface();
