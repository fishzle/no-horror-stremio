require('dotenv').config();
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const PORT = process.env.PORT || 7000;

// In-memory cache to prevent redundant API calls
// Format: { 'movie_0': [array of metas], 'movie_40': [...] }
const catalogCache = {};

const manifest = {
    id: 'org.custom.nohorror',
    version: '1.0.0',
    name: 'No-Horror Catalog',
    description: 'Top popular movies and series, excluding Horror.',
    resources: ['catalog'],
    types: ['movie', 'series'],
    catalogs: [
        {
            type: 'movie',
            id: 'nohorror_movies',
            name: 'No-Horror',
            extra: [{ name: 'skip', isRequired: false }]
        },
        {
            type: 'series',
            id: 'nohorror_series',
            name: 'No-Horror',
            extra: [{ name: 'skip', isRequired: false }]
        }
    ]
};

const builder = new addonBuilder(manifest);

// Helper to fetch a single page of external IDs
async function fetchExternalId(type, tmdbId) {
    const endpoint = type === 'movie' ? 'movie' : 'tv';
    const url = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`;
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        return data.imdb_id || null;
    } catch (e) {
        return null;
    }
}

// Core fetch logic: fetches 2 pages (40 items) at a time
async function fetchTMDBBatch(type, skip) {
    const startPage = Math.floor(skip / 20) + 1;
    const pagesToFetch = [startPage, startPage + 1]; 
    const endpoint = type === 'movie' ? 'movie' : 'tv';
    
    let rawItems = [];

    try {
        for (const page of pagesToFetch) {
            const url = `https://api.themoviedb.org/3/discover/${endpoint}?api_key=${TMDB_API_KEY}&without_genres=27&sort_by=popularity.desc&page=${page}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`TMDB API error: ${res.status}`);
            const data = await res.json();
            rawItems = rawItems.concat(data.results);
        }

        const metas = await Promise.all(rawItems.map(async (item) => {
            const imdbId = await fetchExternalId(type, item.id);
            
            if (!imdbId) {
                console.warn(`[Skip] No IMDb ID for TMDB ID: ${item.id} (${item.title || item.name})`);
                return null; 
            }

            // Ensure type is strictly 'movie' or 'series'
            const stremioType = type === 'movie' ? 'movie' : 'series';

            return {
                id: imdbId, 
                type: stremioType, 
                name: item.title || item.name,
                poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : undefined,
                description: item.overview,
                releaseInfo: (item.release_date || item.first_air_date || '').substring(0, 4)
            };
        }));

        return metas.filter(m => m !== null);

    } catch (error) {
        console.error(`[Error fetching ${type} at skip ${skip}]:`, error.message);
        return []; 
    }
}

builder.defineCatalogHandler(async (args) => {
    // Determine the skip offset (Stremio passes this in args.extra.skip)
    const skip = parseInt(args.extra.skip || 0, 10);
    const cacheKey = `${args.type}_${skip}`;

    console.log(`[Request] Type: ${args.type}, Skip: ${skip}`);

    // 1. Check Cache
    if (catalogCache[cacheKey]) {
        console.log(`[Cache Hit] ${cacheKey}`);
        return { metas: catalogCache[cacheKey] };
    }

    // 2. Fetch Data
    let metas = [];
    if (args.id === 'nohorror_movies') { // Updated here
        metas = await fetchTMDBBatch('movie', skip);
    } else if (args.id === 'nohorror_series') {
        metas = await fetchTMDBBatch('series', skip);
    }
    
    // 3. Save to Cache (only if we got data)
    if (metas.length > 0) {
        catalogCache[cacheKey] = metas;
    }

    // 4. Pre-fetch the NEXT batch in the background (skip + 40)
    // We don't await this, so it doesn't block the current response
    if (metas.length > 0) {
        const nextSkip = skip + 40;
        const nextCacheKey = `${args.type}_${nextSkip}`;
        
        if (!catalogCache[nextCacheKey]) {
            console.log(`[Pre-fetching] ${nextCacheKey}`);
            fetchTMDBBatch(args.type, nextSkip).then(nextMetas => {
                if (nextMetas.length > 0) {
                    catalogCache[nextCacheKey] = nextMetas;
                    console.log(`[Pre-fetch Complete] ${nextCacheKey}`);
                }
            });
        }
    }

    return { metas };
});

serveHTTP(builder.getInterface(), { port: PORT })
    .then(() => {
        console.log(`Addon running at http://127.0.0.1:${PORT}/manifest.json`);
    })
    .catch((err) => {
        console.error('Failed to start server:', err);
    });
