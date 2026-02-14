const fetch = require('node-fetch');

async function fetchData(addonInstance) {
    const { config } = addonInstance;
    const { xtreamUrl, xtreamUsername, xtreamPassword } = config;

    if (!xtreamUrl || !xtreamUsername || !xtreamPassword) {
        throw new Error('Xtream credentials incomplete');
    }

    // Resetăm listele
    addonInstance.channels = [];
    addonInstance.movies = [];
    addonInstance.series = [];

    const base = `${xtreamUrl}/player_api.php?username=${encodeURIComponent(xtreamUsername)}&password=${encodeURIComponent(xtreamPassword)}`;

    try {
        // Cerem doar fluxurile, fără categorii momentan pentru a salva timp/memorie pe Vercel
        const [liveResp, vodResp] = await Promise.all([
            fetch(`${base}&action=get_live_streams`, { timeout: 15000 }),
            fetch(`${base}&action=get_vod_streams`, { timeout: 15000 })
        ]);

        const live = liveResp.ok ? await liveResp.json() : [];
        const vod = vodResp.ok ? await vodResp.json() : [];

        // Mapare Live Channels
        addonInstance.channels = (Array.isArray(live) ? live : []).slice(0, 1500).map(s => ({
            id: `iptv_live_${s.stream_id}`,
            name: s.name,
            type: 'tv',
            url: `${xtreamUrl}/live/${xtreamUsername}/${xtreamPassword}/${s.stream_id}.m3u8`,
            logo: s.stream_icon,
            category: s.category_name || 'Live TV',
            attributes: { 'tvg-logo': s.stream_icon, 'group-title': s.category_name || 'Live' }
        }));

        // Mapare VOD (Limitat pentru performanță)
        addonInstance.movies = (Array.isArray(vod) ? vod : []).slice(0, 1000).map(s => ({
            id: `iptv_vod_${s.stream_id}`,
            name: s.name,
            type: 'movie',
            url: `${xtreamUrl}/movie/${xtreamUsername}/${xtreamPassword}/${s.stream_id}.${s.container_extension || 'mp4'}`,
            poster: s.stream_icon,
            plot: s.plot || '',
            attributes: { 'tvg-logo': s.stream_icon, 'plot': s.plot }
        }));

        // NOTĂ: Am eliminat descărcarea XMLTV de aici. 
        // EPG-ul va fi servit "la cerere" prin getXtreamEpg în addon.js

    } catch (e) {
        console.error('[Provider Error]', e.message);
    }
}

async function fetchSeriesInfo(addonInstance, seriesId) {
    // Rămâne neschimbat, e bine scris pentru că e "Lazy Loading" (se execută doar când dai click pe serial)
    // ... codul tău de fetchSeriesInfo ...
}

module.exports = { fetchData, fetchSeriesInfo };
