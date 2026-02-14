const fetch = require('node-fetch');

async function fetchData(addonInstance) {
    const { config } = addonInstance;
    const { xtreamUrl, xtreamUsername, xtreamPassword } = config;

    if (!xtreamUrl || !xtreamUsername || !xtreamPassword) {
        throw new Error('Xtream credentials incomplete');
    }

    // Resetăm lista de canale
    addonInstance.channels = [];

    const base = `${xtreamUrl}/player_api.php?username=${encodeURIComponent(xtreamUsername)}&password=${encodeURIComponent(xtreamPassword)}`;

    try {
        // Luăm în paralel fluxurile live și categoriile pentru a pune numele corect la grupuri
        const [liveResp, catsResp] = await Promise.all([
            fetch(`${base}&action=get_live_streams`, { timeout: 10000 }),
            fetch(`${base}&action=get_live_categories`, { timeout: 10000 }).catch(() => null)
        ]);

        if (!liveResp.ok) throw new Error('Xtream API not responding');

        const live = await liveResp.json();
        
        // Mapăm categoriile (ID -> Nume) pentru o organizare mai bună
        let catMap = {};
        if (catsResp && catsResp.ok) {
            const categories = await catsResp.json();
            if (Array.isArray(categories)) {
                categories.forEach(c => {
                    catMap[c.category_id] = c.category_name;
                });
            }
        }

        // Procesăm canalele (Limitat la 2500 pentru a nu bloca memoria Vercel)
        addonInstance.channels = (Array.isArray(live) ? live : []).slice(0, 2500).map(s => {
            const categoryName = catMap[s.category_id] || s.category_name || "Live TV";
            
            return {
                id: `iptv_live_${s.stream_id}`,
                name: s.name,
                type: 'tv',
                // Generăm URL-ul de stream direct
                url: `${xtreamUrl}/live/${xtreamUsername}/${xtreamPassword}/${s.stream_id}.m3u8`,
                logo: s.stream_icon || "",
                category: categoryName,
                // Păstrăm atributele pentru compatibilitate cu handler-ul de meta
                attributes: {
                    'tvg-logo': s.stream_icon || "",
                    'group-title': categoryName
                }
            };
        });

        console.log(`[Provider] Succes! Am încărcat ${addonInstance.channels.length} canale.`);

    } catch (e) {
        console.error('[Provider Error]', e.message);
    }
}

// Exportăm doar fetchData (fetchSeriesInfo nu mai este necesar)
module.exports = {
    fetchData
};
