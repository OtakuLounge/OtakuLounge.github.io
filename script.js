const JIKAN_API_URL = 'https://api.jikan.moe/v4';
const KITSU_API_URL = 'https://kitsu.io/api/edge';
const RATE_LIMIT_DELAY = 1000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;

// Cache for API results
const apiCache = {
    jikan: new Map(),
    kitsu: new Map()
};

// Queue for managing API requests
class RequestQueue {
    constructor(delay = RATE_LIMIT_DELAY) {
        this.queue = [];
        this.delay = delay;
        this.isProcessing = false;
    }

    async add(request) {
        return new Promise((resolve, reject) => {
            this.queue.push({ request, resolve, reject });
            if (!this.isProcessing) {
                this.processQueue();
            }
        });
    }

    async processQueue() {
        if (this.queue.length === 0) {
            this.isProcessing = false;
            return;
        }

        this.isProcessing = true;
        const { request, resolve, reject } = this.queue.shift();

        try {
            const result = await this.executeWithRetry(request);
            resolve(result);
        } catch (error) {
            reject(error);
        }

        await new Promise(resolve => setTimeout(resolve, this.delay));
        this.processQueue();
    }

    async executeWithRetry(request, retries = MAX_RETRIES) {
        for (let i = 0; i < retries; i++) {
            try {
                const response = await fetch(request);
                
                if (response.status === 429) {
                    const retryAfter = response.headers.get('Retry-After') || RETRY_DELAY / 1000;
                    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                    continue;
                }

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const data = await response.json();
                return data;
            } catch (error) {
                if (i === retries - 1) throw error;
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            }
        }
    }
}

const jikanQueue = new RequestQueue(1000);
const kitsuQueue = new RequestQueue(500);

function showWelcomeMessage() {
    const animeGrid = document.getElementById('animeGrid');
    animeGrid.innerHTML = `
        <div class="welcome-message">
            <h2>Welcome to Anime Browser!</h2>
            <p>Discover your next favorite anime:</p>
            <ul class="welcome-list">
                <li>Browse popular genres from the sidebar</li>
                <li>Search for specific anime titles</li>
                <li>Find where to watch your favorite shows</li>
            </ul>
            <p class="welcome-note">Select a genre or search to get started!</p>
        </div>
    `;
}

async function searchAnime(query) {
    const loadingElement = document.getElementById('loading');
    const errorElement = document.getElementById('error');

    try {
        loadingElement.classList.remove('hidden');
        errorElement.classList.add('hidden');

        const cacheKey = `search-${query}`;
        if (apiCache.jikan.has(cacheKey)) {
            const cachedData = apiCache.jikan.get(cacheKey);
            if (Date.now() - cachedData.timestamp < 6 * 60 * 60 * 1000) {
                displayAnimeData(cachedData.data);
                loadingElement.classList.add('hidden');
                return;
            }
        }

        const endpoint = `${JIKAN_API_URL}/anime?q=${encodeURIComponent(query)}&sfw=true&order_by=popularity&sort=asc&limit=24`;
        const data = await jikanQueue.add(endpoint);

        if (!data.data || data.data.length === 0) {
            throw new Error('No anime found matching your search');
        }

        const batchSize = 5;
        const enhancedData = [];
        
        for (let i = 0; i < data.data.length; i += batchSize) {
            const batch = data.data.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(async (anime) => {
                    const streamingInfo = await getKitsuStreamingInfo(anime.title);
                    return {
                        ...anime,
                        streaming: [...(anime.streaming || []), ...(streamingInfo || [])]
                    };
                })
            );
            enhancedData.push(...batchResults);
            displayAnimeData(enhancedData);
        }

        apiCache.jikan.set(cacheKey, {
            data: enhancedData,
            timestamp: Date.now()
        });
    } catch (error) {
        console.error('Error searching anime:', error);
        errorElement.classList.remove('hidden');
        errorElement.querySelector('p').textContent = error.message;
    } finally {
        loadingElement.classList.add('hidden');
    }
}

async function fetchAnimeByGenre(genreId) {
    const loadingElement = document.getElementById('loading');
    const errorElement = document.getElementById('error');

    try {
        loadingElement.classList.remove('hidden');
        errorElement.classList.add('hidden');
        
        const cacheKey = `genre-${genreId}`;
        if (apiCache.jikan.has(cacheKey)) {
            const cachedData = apiCache.jikan.get(cacheKey);
            if (Date.now() - cachedData.timestamp < 6 * 60 * 60 * 1000) {
                displayAnimeData(cachedData.data);
                loadingElement.classList.add('hidden');
                return;
            }
        }

        const endpoint = `${JIKAN_API_URL}/anime?genres=${genreId}&sfw=true&order_by=score&sort=desc&limit=24`;
        const data = await jikanQueue.add(endpoint);
        
        if (!data.data || data.data.length === 0) {
            throw new Error('No anime found for this genre');
        }
        
        const batchSize = 5;
        const enhancedData = [];
        
        for (let i = 0; i < data.data.length; i += batchSize) {
            const batch = data.data.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(async (anime) => {
                    const streamingInfo = await getKitsuStreamingInfo(anime.title);
                    return {
                        ...anime,
                        streaming: [...(anime.streaming || []), ...(streamingInfo || [])]
                    };
                })
            );
            enhancedData.push(...batchResults);
            displayAnimeData(enhancedData);
        }

        apiCache.jikan.set(cacheKey, {
            data: enhancedData,
            timestamp: Date.now()
        });
    } catch (error) {
        console.error('Error fetching anime by genre:', error);
        errorElement.classList.remove('hidden');
        errorElement.querySelector('p').textContent = error.message;
    } finally {
        loadingElement.classList.add('hidden');
    }
}

function displayAnimeData(animeList) {
    const animeGrid = document.getElementById('animeGrid');
    animeGrid.innerHTML = '';
    
    if (!animeList || animeList.length === 0) {
        animeGrid.innerHTML = `
            <div class="welcome-message">
                <p>No anime found. Try a different category or check back later.</p>
            </div>
        `;
        return;
    }
    
    const displayedAnime = new Set();
    
    animeList.forEach(anime => {
        if (displayedAnime.has(anime.mal_id)) return;
        displayedAnime.add(anime.mal_id);
        
        const card = document.createElement('div');
        card.className = 'anime-card';
        
        const streamingLinks = getStreamingLinks(anime.streaming);
        
        card.innerHTML = `
            <img src="${anime.images.jpg.large_image_url || anime.images.jpg.image_url}" 
                 alt="${anime.title}" 
                 onerror="this.src='https://via.placeholder.com/300x200?text=No+Image'">
            <div class="anime-info">
                <div class="anime-title">
                    ${anime.title}
                    ${anime.title_english && anime.title_english !== anime.title ? 
                        `<div class="english-title">${anime.title_english}</div>` : 
                        ''}
                </div>
                <div class="anime-date">
                    ${formatDate(anime.aired?.from)} ${anime.aired?.to ? `- ${formatDate(anime.aired.to)}` : ''}
                </div>
                <div>Episodes: ${anime.episodes || 'TBA'}</div>
                <div class="anime-description">
                    ${anime.synopsis ? truncateDescription(anime.synopsis, 150) : 'No description available.'}
                </div>
                ${streamingLinks ? `
                    <div class="watch-links">
                        ${streamingLinks}
                    </div>
                ` : ''}
            </div>
        `;
        
        animeGrid.appendChild(card);
    });
}

async function getKitsuStreamingInfo(animeTitle) {
    if (apiCache.kitsu.has(animeTitle)) {
        const cachedData = apiCache.kitsu.get(animeTitle);
        if (Date.now() - cachedData.timestamp < 24 * 60 * 60 * 1000) {
            return cachedData.data;
        }
    }

    try {
        const searchData = await kitsuQueue.add(
            `${KITSU_API_URL}/anime?filter[text]=${encodeURIComponent(animeTitle)}&page[limit]=1`
        );

        if (!searchData.data || searchData.data.length === 0) {
            const emptyResult = [];
            apiCache.kitsu.set(animeTitle, {
                data: emptyResult,
                timestamp: Date.now()
            });
            return emptyResult;
        }

        const animeId = searchData.data[0].id;
        const streamingData = await kitsuQueue.add(
            `${KITSU_API_URL}/anime/${animeId}/streaming-links`
        );

        const streamingLinks = streamingData.data.map(link => ({
            name: link.attributes.platform,
            url: link.attributes.url
        }));

        apiCache.kitsu.set(animeTitle, {
            data: streamingLinks,
            timestamp: Date.now()
        });
        return streamingLinks;
    } catch (error) {
        console.error('Error fetching Kitsu data:', error);
        apiCache.kitsu.set(animeTitle, {
            data: [],
            timestamp: Date.now()
        });
        return [];
    }
}

function getStreamingLinks(streamingData) {
    const commonPlatforms = [
        { name: 'Crunchyroll', domain: 'crunchyroll.com' },
        { name: 'Funimation', domain: 'funimation.com' },
        { name: 'HIDIVE', domain: 'hidive.com' },
        { name: 'Netflix', domain: 'netflix.com' },
        { name: 'Hulu', domain: 'hulu.com' },
        { name: 'Amazon Prime', domain: 'amazon.com' }
    ];

    if (!streamingData || streamingData.length === 0) {
        return `
            <div class="streaming-info">
                <div class="streaming-header">Where to Watch</div>
                <div class="no-streams">No streaming information available yet.</div>
                <div class="streaming-note">Note: Streaming availability may vary by region.</div>
            </div>
        `;
    }

    const availablePlatforms = commonPlatforms.map(platform => {
        const streamLink = streamingData.find(stream => 
            stream.url.includes(platform.domain)
        );
        
        return streamLink ? `
            <a href="${streamLink.url}" 
               target="_blank" 
               rel="noopener noreferrer" 
               class="watch-link available">
                ${platform.name}
            </a>
        ` : `
            <span class="watch-link unavailable">
                ${platform.name}
            </span>
        `;
    }).join('');

    const otherPlatforms = streamingData
        .filter(stream => !commonPlatforms.some(platform => 
            stream.url.includes(platform.domain)
        ))
        .map(stream => `
            <a href="${stream.url}" 
               target="_blank" 
               rel="noopener noreferrer" 
               class="watch-link available">
                ${stream.name}
            </a>
        `)
        .join('');

    return `
        <div class="streaming-info">
            <div class="streaming-header">Where to Watch</div>
            <div class="streaming-platforms">
                ${availablePlatforms}
                ${otherPlatforms}
            </div>
            <div class="streaming-note">Note: Streaming availability may vary by region.</div>
        </div>
    `;
}

function truncateDescription(text, maxLength) {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength).trim() + '...';
}

function formatDate(dateString) {
    if (!dateString) return 'TBA';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

function setupSidebar() {
    const genreButtons = document.querySelectorAll('.genre-btn');
    const homeBtn = document.getElementById('homeBtn');
    const searchBtn = document.getElementById('searchBtn');
    const searchInput = document.getElementById('searchInput');
    
    let activeGenre = null;

    homeBtn.addEventListener('click', () => {
        genreButtons.forEach(btn => btn.classList.remove('active'));
        activeGenre = null;
        showWelcomeMessage();
    });

    searchBtn.addEventListener('click', () => {
        const query = searchInput.value.trim();
        if (query) {
            searchAnime(query);
        }
    });

    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const query = searchInput.value.trim();
            if (query) {
                searchAnime(query);
            }
        }
    });

    genreButtons.forEach(button => {
        button.addEventListener('click', async () => {
            const genreId = button.dataset.genre;
            
            if (activeGenre === genreId) {
                activeGenre = null;
                button.classList.remove('active');
                showWelcomeMessage();
            } else {
                genreButtons.forEach(btn => btn.classList.remove('active'));
                button.classList.add('active');
                activeGenre = genreId;
                await fetchAnimeByGenre(genreId);
            }
        });
    });
}

// Initial setup
document.addEventListener('DOMContentLoaded', () => {
    setupSidebar();
    showWelcomeMessage();
});
