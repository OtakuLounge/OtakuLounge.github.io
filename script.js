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

// Enhanced search with relevance scoring
function calculateRelevanceScore(anime, query) {
    const queryLower = query.toLowerCase();
    const title = anime.title.toLowerCase();
    const englishTitle = anime.title_english ? anime.title_english.toLowerCase() : '';
    const synonyms = anime.title_synonyms ? anime.title_synonyms.join(' ').toLowerCase() : '';
    
    let score = 0;
    
    // Exact title match (highest priority)
    if (title === queryLower || englishTitle === queryLower) {
        score += 100;
    }
    // Title starts with query
    else if (title.startsWith(queryLower) || englishTitle.startsWith(queryLower)) {
        score += 80;
    }
    // Title contains query
    else if (title.includes(queryLower) || englishTitle.includes(queryLower)) {
        score += 60;
    }
    // Synonym matches
    else if (synonyms.includes(queryLower)) {
        score += 40;
    }
    // Word boundary matches (whole words)
    else if (title.split(' ').some(word => word.startsWith(queryLower)) || 
             englishTitle.split(' ').some(word => word.startsWith(queryLower))) {
        score += 30;
    }
    
    // Boost score based on popularity (MAL score and members)
    if (anime.score) {
        score += Math.min(anime.score * 2, 20);
    }
    if (anime.members) {
        score += Math.min(Math.log10(anime.members) * 2, 10);
    }
    
    // Penalize very long titles that might be less relevant
    if (title.length > 50) {
        score -= 5;
    }
    
    return score;
}

function fuzzyMatch(str1, str2, threshold = 0.6) {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1.0;
    
    const editDistance = levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length >= threshold;
}

function levenshteinDistance(str1, str2) {
    const matrix = [];
    
    for (let i = 0; i <= str2.length; i++) {
        matrix[i] = [i];
    }
    
    for (let j = 0; j <= str1.length; j++) {
        matrix[0][j] = j;
    }
    
    for (let i = 1; i <= str2.length; i++) {
        for (let j = 1; j <= str1.length; j++) {
            if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }
    
    return matrix[str2.length][str1.length];
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

        // Fetch more results for better filtering (increased limit)
        const endpoint = `${JIKAN_API_URL}/anime?q=${encodeURIComponent(query)}&sfw=true&limit=25`;
        const data = await jikanQueue.add(endpoint);

        if (!data.data || data.data.length === 0) {
            // Try fuzzy search if no exact results
            const fuzzyEndpoint = `${JIKAN_API_URL}/anime?q=${encodeURIComponent(query.substring(0, Math.max(3, query.length - 2)))}&sfw=true&limit=25`;
            const fuzzyData = await jikanQueue.add(fuzzyEndpoint);
            
            if (!fuzzyData.data || fuzzyData.data.length === 0) {
                throw new Error('No anime found matching your search');
            }
            
            // Filter fuzzy results
            const fuzzyFiltered = fuzzyData.data.filter(anime => 
                fuzzyMatch(anime.title.toLowerCase(), query.toLowerCase()) ||
                (anime.title_english && fuzzyMatch(anime.title_english.toLowerCase(), query.toLowerCase()))
            );
            
            if (fuzzyFiltered.length === 0) {
                throw new Error('No anime found matching your search');
            }
            
            data.data = fuzzyFiltered;
        }

        // Calculate relevance scores and sort
        const scoredResults = data.data.map(anime => ({
            ...anime,
            relevanceScore: calculateRelevanceScore(anime, query)
        }));

        // Sort by relevance score (highest first)
        scoredResults.sort((a, b) => b.relevanceScore - a.relevanceScore);

        // Remove duplicates based on MAL ID
        const uniqueResults = [];
        const seenIds = new Set();
        
        for (const anime of scoredResults) {
            if (!seenIds.has(anime.mal_id)) {
                seenIds.add(anime.mal_id);
                uniqueResults.push(anime);
            }
        }

        // Limit to top 24 most relevant results
        const topResults = uniqueResults.slice(0, 24);

        const batchSize = 5;
        const enhancedData = [];
        
        for (let i = 0; i < topResults.length; i += batchSize) {
            const batch = topResults.slice(i, i + batchSize);
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

async function fetchRecentAnime() {
    const loadingElement = document.getElementById('loading');
    const errorElement = document.getElementById('error');

    try {
        loadingElement.classList.remove('hidden');
        errorElement.classList.add('hidden');
        
        const cacheKey = 'recent-anime';
        if (apiCache.jikan.has(cacheKey)) {
            const cachedData = apiCache.jikan.get(cacheKey);
            if (Date.now() - cachedData.timestamp < 6 * 60 * 60 * 1000) {
                displayAnimeData(cachedData.data);
                loadingElement.classList.add('hidden');
                return;
            }
        }

        // Get current season anime (currently airing)
        const endpoint = `${JIKAN_API_URL}/seasons/now?sfw=true&limit=24`;
        const data = await jikanQueue.add(endpoint);
        
        if (!data.data || data.data.length === 0) {
            throw new Error('No recent anime found');
        }

        // Sort by score and popularity
        const sortedData = data.data
            .filter(anime => anime.score && anime.members) // Filter out anime without ratings
            .sort((a, b) => {
                // Primary sort by score, secondary by member count
                if (b.score !== a.score) {
                    return b.score - a.score;
                }
                return b.members - a.members;
            })
            .slice(0, 24); // Limit to top 24
        
        const batchSize = 5;
        const enhancedData = [];
        
        for (let i = 0; i < sortedData.length; i += batchSize) {
            const batch = sortedData.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(async (anime) => {
                    const streamingInfo = await getKitsuStreamingInfo(anime.title);
                    return {
                        ...anime,
                        streaming: [...(anime.streaming || []), ...(streamingInfo || [])],
                        isCurrentlyAiring: true // Add flag for styling
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
        console.error('Error fetching recent anime:', error);
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
            <div class="anime-image-container">
                <img src="${anime.images.jpg.large_image_url || anime.images.jpg.image_url}" 
                     alt="${anime.title}" 
                     onerror="this.src='https://via.placeholder.com/300x200?text=No+Image'">
                ${anime.isCurrentlyAiring ? '<div class="airing-badge">Currently Airing</div>' : ''}
            </div>
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
                ${anime.score ? `<div class="anime-score">★ ${anime.score}/10</div>` : ''}
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

// Search suggestions functionality
let searchSuggestions = [];
let suggestionTimeout;

async function loadPopularAnime() {
    try {
        const endpoint = `${JIKAN_API_URL}/top/anime?limit=25`;
        const data = await jikanQueue.add(endpoint);
        
        if (data.data) {
            searchSuggestions = data.data.map(anime => ({
                title: anime.title,
                englishTitle: anime.title_english,
                synonyms: anime.title_synonyms || []
            }));
        }
    } catch (error) {
        console.error('Error loading popular anime for suggestions:', error);
    }
}

function createSuggestionsDropdown() {
    const searchSection = document.querySelector('.search-section');
    const dropdown = document.createElement('div');
    dropdown.id = 'searchSuggestions';
    dropdown.className = 'search-suggestions hidden';
    searchSection.appendChild(dropdown);
    return dropdown;
}

function showSearchSuggestions(query, inputElement) {
    if (!query || query.length < 2) {
        hideSearchSuggestions();
        return;
    }

    const dropdown = document.getElementById('searchSuggestions') || createSuggestionsDropdown();
    const queryLower = query.toLowerCase();
    
    // Find matching suggestions
    const matches = searchSuggestions
        .filter(anime => {
            return anime.title.toLowerCase().includes(queryLower) ||
                   (anime.englishTitle && anime.englishTitle.toLowerCase().includes(queryLower)) ||
                   anime.synonyms.some(synonym => synonym.toLowerCase().includes(queryLower));
        })
        .slice(0, 8) // Limit to 8 suggestions
        .map(anime => {
            // Prioritize exact matches and starts-with matches
            const title = anime.title.toLowerCase();
            const englishTitle = anime.englishTitle ? anime.englishTitle.toLowerCase() : '';
            
            let displayTitle = anime.title;
            let priority = 0;
            
            if (title === queryLower || englishTitle === queryLower) {
                priority = 3;
            } else if (title.startsWith(queryLower) || englishTitle.startsWith(queryLower)) {
                priority = 2;
            } else if (title.includes(queryLower) || englishTitle.includes(queryLower)) {
                priority = 1;
            }
            
            return { ...anime, displayTitle, priority };
        })
        .sort((a, b) => b.priority - a.priority);

    if (matches.length === 0) {
        hideSearchSuggestions();
        return;
    }

    dropdown.innerHTML = matches.map(anime => `
        <div class="suggestion-item" data-title="${anime.title}">
            <div class="suggestion-title">${anime.title}</div>
            ${anime.englishTitle && anime.englishTitle !== anime.title ? 
                `<div class="suggestion-english">${anime.englishTitle}</div>` : ''}
        </div>
    `).join('');

    // Add click handlers
    dropdown.querySelectorAll('.suggestion-item').forEach(item => {
        item.addEventListener('click', () => {
            const title = item.dataset.title;
            inputElement.value = title;
            hideSearchSuggestions();
            searchAnime(title);
        });
    });

    dropdown.classList.remove('hidden');
}

function hideSearchSuggestions() {
    const dropdown = document.getElementById('searchSuggestions');
    if (dropdown) {
        dropdown.classList.add('hidden');
    }
}

function setupSidebar() {
    const genreButtons = document.querySelectorAll('.genre-btn');
    const searchBtn = document.getElementById('searchBtn');
    const searchInput = document.getElementById('searchInput');
    const homeTab = document.getElementById('homeTab');
    const recentTab = document.getElementById('recentTab');
    
    let activeGenre = null;
    let currentTab = 'home';

    // Load popular anime for suggestions
    loadPopularAnime();

    // Tab functionality
    function switchToTab(tabName) {
        // Update tab visual states
        homeTab.classList.toggle('active', tabName === 'home');
        recentTab.classList.toggle('active', tabName === 'recent');
        
        // Clear active genre when switching tabs
        genreButtons.forEach(btn => btn.classList.remove('active'));
        activeGenre = null;
        
        currentTab = tabName;
        
        if (tabName === 'home') {
            showWelcomeMessage();
        } else if (tabName === 'recent') {
            fetchRecentAnime();
        }
        
        hideSearchSuggestions();
    }

    homeTab.addEventListener('click', () => switchToTab('home'));
    recentTab.addEventListener('click', () => switchToTab('recent'));

    searchBtn.addEventListener('click', () => {
        const query = searchInput.value.trim();
        if (query) {
            hideSearchSuggestions();
            searchAnime(query);
        }
    });

    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim();
        
        clearTimeout(suggestionTimeout);
        suggestionTimeout = setTimeout(() => {
            showSearchSuggestions(query, searchInput);
        }, 300); // Debounce suggestions
    });

    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const query = searchInput.value.trim();
            if (query) {
                hideSearchSuggestions();
                searchAnime(query);
            }
        } else if (e.key === 'Escape') {
            hideSearchSuggestions();
        }
    });

    searchInput.addEventListener('blur', () => {
        // Delay hiding to allow click on suggestions
        setTimeout(() => hideSearchSuggestions(), 200);
    });

    searchInput.addEventListener('focus', () => {
        const query = searchInput.value.trim();
        if (query.length >= 2) {
            showSearchSuggestions(query, searchInput);
        }
    });

    genreButtons.forEach(button => {
        button.addEventListener('click', async () => {
            const genreId = button.dataset.genre;
            hideSearchSuggestions();
            
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

    // Hide suggestions when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-section')) {
            hideSearchSuggestions();
        }
    });
}

// Initial setup
document.addEventListener('DOMContentLoaded', () => {
    setupSidebar();
    showWelcomeMessage();
});
