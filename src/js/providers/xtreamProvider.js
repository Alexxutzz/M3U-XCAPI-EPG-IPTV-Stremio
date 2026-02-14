const fetch = require('node-fetch');

async function fetchData(addonInstance) {
    const { config } = addonInstance;
    const { xtreamUrl, xtreamUsername, xtreamPassword } = config;

    if (!xtreamUrl || !xtreamUsername || !xtreamPassword) {
        throw new Error('Xtream credentials incomplete');
    }

    addonInstance.channels = [];
    const base = `${xtreamUrl}/player_api.php?username=${encodeURIComponent(xtreamUsername)}&password=${encodeURIComponent(xtreamPassword)}`;

    try {
        const [liveResp, catsResp] = await Promise.all([
            fetch(`${base}&action=get_live_streams`, { timeout: 30000 }),
            fetch(`${base}&action=get_live_categories`, { timeout: 15000 }).catch(() => null)
        ]);

        if (!liveResp.ok) throw new Error('Xtream API not responding');

        const live = await liveResp.json();
        
        let catMap = {};
        if (catsResp && catsResp.ok) {
            const categories = await catsResp.json();
            if (Array.isArray(categories)) {
                categories.forEach(c => {
                    catMap[c.category_id] = c.category_name;
                });
            }
        }

        // FĂRĂ SORTARE, FĂRĂ LIMITĂ (.slice a fost eliminat)
        addonInstance.channels = (Array.isArray(live) ? live : []).map(s => {
            const categoryName = catMap[s.category_id] || s.category_name || "Live TV";
            
            return {
                id: `iptv_live_${s.stream_id}`,
                name: s.name,
                type: 'tv',
                url: `${xtreamUrl}/live/${xtreamUsername}/${xtreamPassword}/${s.stream_id}.m3u8`,
                logo: s.stream_icon || "",
                category: categoryName,
                attributes: {
                    'tvg-logo': s.stream_icon || "",
                    'group-title': categoryName
                }
            };
        });

        console.log(`[Provider] Succes! Incarcate: ${addonInstance.channels.length} canale in ordine bruta.`);

    } catch (e) {
        console.error('[Provider Error]', e.message);
    }
}

module.exports = { fetchData };
