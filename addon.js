require('dotenv').config();
const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');

const ADDON_NAME = "PRO IPTV RO Premium";
const ADDON_ID = "org.stremio.m3u-epg-ro-final";

// Forțăm ora României peste tot
const RO_TIME_OPTS = { 
    hour: '2-digit', 
    minute: '2-digit', 
    timeZone: 'Europe/Bucharest', 
    hour12: false 
};

class M3UEPGAddon {
    constructor(config = {}) {
        this.config = config;
        this.channels = [];
        this.lastUpdate = 0;
    }

    // Indicator vizual progres emisiune
    getProgressBar(start, end) {
        const now = new Date();
        const total = end - start;
        const elapsed = now - start;
        const progress = Math.max(0, Math.min(100, Math.round((elapsed / total) * 100)));
        const size = 10;
        const filled = Math.round((progress / 100) * size);
        return `${"🟢".repeat(filled)}${"⚪".repeat(size - filled)} ${progress}%`;
    }

    // Extragere EPG de pe serverul Xtream
    async getXtreamEpg(streamId) {
        const url = `${this.config.xtreamUrl}/player_api.php?username=${this.config.xtreamUsername}&password=${this.config.xtreamPassword}&action=get_short_epg&stream_id=${streamId}`;
        try {
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 4000 });
            const data = await res.json();
            if (!data || !data.epg_listings) return null;

            const decode = (str) => {
                try { return Buffer.from(str, 'base64').toString('utf-8'); }
                catch(e) { return str; }
            };

            return data.epg_listings.map(p => ({
                title: decode(p.title),
                desc: decode(p.description),
                start: new Date(p.start),
                end: new Date(p.end),
                duration: Math.round((new Date(p.end) - new Date(p.start)) / 60000)
            }));
        } catch (e) { return null; }
    }

    // Actualizare listă completă de canale
    async updateData() {
        // Cache de 30 min pentru a nu bloca Vercel la fiecare accesare
        if (Date.now() - this.lastUpdate < 1800000 && this.channels.length > 0) return;
        
        try {
            const streamRes = await fetch(`${this.config.xtreamUrl}/player_api.php?username=${this.config.xtreamUsername}&password=${this.config.xtreamPassword}&action=get_live_streams`);
            const streams = await streamRes.json();
            
            if (Array.isArray(streams)) {
                this.channels = streams.map(s => ({
                    id: `iptv_${s.stream_id}`,
                    name: s.name,
                    logo: s.stream_icon || "",
                    url: `${this.config.xtreamUrl}/live/${this.config.xtreamUsername}/${this.config.xtreamPassword}/${s.stream_id}.ts`
                }));
                this.lastUpdate = Date.now();
                console.log(`Succes: ${this.channels.length} canale încărcate.`);
            }
        } catch (e) {
            console.error("Eroare la încărcarea canalelor:", e.message);
        }
    }
}

async function createAddon(config) {
    const addon = new M3UEPGAddon(config);

    const builder = new addonBuilder({
        id: ADDON_ID,
        version: "4.0.0",
        name: ADDON_NAME,
        description: "IPTV cu EPG complet, logo-uri și ora României.",
        resources: ["catalog", "stream", "meta"],
        types: ["tv"],
        catalogs: [
            { 
                type: 'tv', 
                id: 'iptv_search', 
                name: '🔍 Toate Canalele / Căutare', 
                extra: [{ name: 'search', isRequired: false }] 
            }
        ],
        idPrefixes: ["iptv_"]
    });

    // --- HANDLER CATALOG (Căutare și Afișare) ---
    builder.defineCatalogHandler(async (args) => {
        await addon.updateData();
        let results = addon.channels;

        if (args.extra?.search) {
            const query = args.extra.search.toLowerCase();
            results = results.filter(i => i.name.toLowerCase().includes(query));
        }

        return { 
            // Returnăm maxim 1000 de rezultate pentru a păstra viteza în aplicație
            metas: results.slice(0, 1000).map(i => ({
                id: i.id,
                type: 'tv',
                name: i.name,
                poster: i.logo || "https://via.placeholder.com/400x400.png?text=Fara+Logo",
                posterShape: 'square'
            }))
        };
    });

    // --- HANDLER META (EPG Detaliat + Ora RO) ---
    builder.defineMetaHandler(async ({ id }) => {
        const item = addon.channels.find(i => i.id === id);
        if (!item) return { meta: null };

        const streamId = id.split('_').pop();
        const epgData = await addon.getXtreamEpg(streamId);
        
        const now = new Date();
        const oraRo = now.toLocaleTimeString('ro-RO', RO_TIME_OPTS);

        let desc = `🕒 ORA ROMÂNIEI: ${oraRo}\n`;
        desc += `───────────────────────────\n`;

        if (epgData && epgData.length > 0) {
            const currentIdx = epgData.findIndex(p => now >= p.start && now <= p.end);
            const current = currentIdx !== -1 ? epgData[currentIdx] : null;

            if (current) {
                const s = current.start.toLocaleTimeString('ro-RO', RO_TIME_OPTS);
                const e = current.end.toLocaleTimeString('ro-RO', RO_TIME_OPTS);
                
                desc += `🔴 ACUM: ${current.title}\n`;
                desc += `⏰ [${s} - ${e}] (${current.duration} min)\n`;
                desc += `${addon.getProgressBar(current.start, current.end)}\n\n`;
                desc += `📝 ${current.desc || 'Fără descriere.'}\n`;
                
                const next = epgData.slice(currentIdx + 1, currentIdx + 5);
                if (next.length > 0) {
                    desc += `───────────────────────────\n📅 URMEAZĂ:\n`;
                    next.forEach(p => {
                        desc += `🔹 ${p.start.toLocaleTimeString('ro-RO', RO_TIME_OPTS)} - ${p.title}\n`;
                    });
                }
            }
        } else {
            desc += `⚠️ EPG indisponibil pentru acest canal.`;
        }

        return { 
            meta: { 
                id, 
                type: 'tv', 
                name: item.name, 
                description: desc, 
                poster: item.logo,
                background: item.logo,
                logo: item.logo
            } 
        };
    });

    // --- HANDLER STREAM ---
    builder.defineStreamHandler(async ({ id }) => {
        const item = addon.channels.find(i => i.id === id);
        return { 
            streams: item ? [{ url: item.url, title: `Stream Direct: ${item.name}` }] : [] 
        };
    });

    return builder.getInterface();
}

module.exports = createAddon;
