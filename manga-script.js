// MangaDx API integration for manga browsing and reading

class MangaAPI {
    constructor() {
        this.baseURL = 'https://api.mangadex.org';
        this.currentPage = 0;
        this.limit = 20;
        this.currentQuery = '';
        this.currentFilters = {};
        this.cache = new Map();
        this.rateLimitDelay = 200; // 200ms between requests to respect rate limits
        this.lastRequestTime = 0;
    }

    // Rate limiting helper
    async rateLimit() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.rateLimitDelay) {
            await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay - timeSinceLastRequest));
        }
        this.lastRequestTime = Date.now();
    }

    // Generic API request with error handling
    async makeRequest(endpoint, params = {}) {
        await this.rateLimit();

        // 1. Build the complete MangaDex URL with its parameters first
        const mangaDexUrl = new URL(`${this.baseURL}${endpoint}`);
        Object.keys(params).forEach(key => {
            if (params[key] !== undefined && params[key] !== null && params[key] !== '') {
                if (Array.isArray(params[key])) {
                    params[key].forEach(value => mangaDexUrl.searchParams.append(key, value));
                } else {
                    mangaDexUrl.searchParams.append(key, params[key]);
                }
            }
        });

        // 2. Create the final URL by prepending the proxy to the complete MangaDex URL
        const finalUrl = `https://otakulounge-github-io.onrender.com/api?url=${encodeURIComponent(mangaDexUrl.toString())}`;

        try {
            // 3. Fetch the final proxied URL
            const response = await fetch(finalUrl);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            return await response.json();
        } catch (error) {
            console.error('API Request failed:', error);
            throw error;
        }
    }


    // Search manga
    async searchManga(query = '', filters = {}, page = 0) {
        const params = {
            title: query,
            limit: this.limit,
            offset: page * this.limit,
            'includes[]': ['cover_art', 'author', 'artist'],
            'order[relevance]': 'desc',
            'contentRating[]': ['safe', 'suggestive'],
            ...filters
        };

        return await this.makeRequest('/manga', params);
    }

    // Get manga details
    async getMangaDetails(mangaId) {
        const cacheKey = `manga_${mangaId}`;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        const params = {
            'includes[]': ['cover_art', 'author', 'artist', 'tag']
        };

        const result = await this.makeRequest(`/manga/${mangaId}`, params);
        this.cache.set(cacheKey, result);
        return result;
    }

    // Get manga chapters
    async getMangaChapters(mangaId, page = 0) {
        const params = {
            limit: 100,
            offset: page * 100,
            'translatedLanguage[]': ['en'],
            'order[chapter]': 'asc',
            'includes[]': ['scanlation_group']
        };

        return await this.makeRequest(`/manga/${mangaId}/feed`, params);
    }

    // Get chapter pages
    async getChapterPages(chapterId) {
        const cacheKey = `chapter_${chapterId}`;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        // First get chapter info
        const chapterInfo = await this.makeRequest(`/chapter/${chapterId}`);
        
        // Then get the at-home server info for pages
        const serverInfo = await this.makeRequest(`/at-home/server/${chapterId}`);
        
        const result = {
            chapter: chapterInfo.data,
            baseUrl: serverInfo.baseUrl,
            chapter_hash: serverInfo.chapter.hash,
            data: serverInfo.chapter.data,
            dataSaver: serverInfo.chapter.dataSaver
        };

        this.cache.set(cacheKey, result);
        return result;
    }

    // Helper to get cover image URL
     // Helper to get cover image URL
    getCoverImageUrl(manga) {
        // Find the cover art object in the manga's relationships
        const coverArt = manga.relationships?.find(rel => rel.type === 'cover_art');

        // Check if all necessary pieces of information exist
        if (manga && manga.id && coverArt && coverArt.attributes?.fileName) {
            const mangaId = manga.id;
            const fileName = coverArt.attributes.fileName;

            // Construct the URL exactly as the documentation specifies
            return `https://uploads.mangadex.org/covers/${mangaId}/${fileName}`;
        }

        // If any information is missing, fall back to the placeholder
        return 'https://via.placeholder.com/300x400/6a5acd/ffffff?text=No+Cover';
    }

    // Helper to get author name
    getAuthorName(manga) {
        const author = manga.relationships?.find(rel => rel.type === 'author');
        return author?.attributes?.name || 'Unknown Author';
    }

    // Helper to format manga status
    formatStatus(status) {
        const statusMap = {
            'ongoing': 'Ongoing',
            'completed': 'Completed',
            'hiatus': 'Hiatus',
            'cancelled': 'Cancelled'
        };
        return statusMap[status] || status;
    }

    // Helper to get page URL
    getPageUrl(baseUrl, chapterHash, filename, dataSaver = false) {
        // 1. First, build the original MangaDex image URL
        const quality = dataSaver ? 'data-saver' : 'data';
        const originalImageUrl = `${baseUrl}/${quality}/${chapterHash}/${filename}`;

        // 2. Then, take that URL and wrap it in your proxy's URL
        return `https://otakulounge-github-io.onrender.com/image?url=${encodeURIComponent(originalImageUrl)}`;
    }
}

// Main application class
class MangaBrowser {
    constructor() {
        this.api = new MangaAPI();
        this.currentManga = null;
        this.currentChapters = [];
        this.initializeEventListeners();
        this.showWelcomeMessage();
    }

    initializeEventListeners() {
        // Search functionality
        const searchInput = document.getElementById('mangaSearchInput');
        const searchBtn = document.getElementById('mangaSearchBtn');
        
        searchBtn.addEventListener('click', () => this.handleSearch());
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.handleSearch();
        });

        // Genre buttons
        document.querySelectorAll('.manga-genre-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.handleGenreFilter(e));
        });

        // Status buttons
        document.querySelectorAll('.manga-status-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.handleStatusFilter(e));
        });

        // Sort and filter dropdowns
        document.getElementById('sortOrder').addEventListener('change', () => this.handleSearch());
        document.getElementById('contentRating').addEventListener('change', () => this.handleSearch());

        // Pagination
        document.getElementById('prevPage').addEventListener('click', () => this.previousPage());
        document.getElementById('nextPage').addEventListener('click', () => this.nextPage());

        // Modal functionality
        document.querySelector('.close').addEventListener('click', () => this.closeModal());
        document.getElementById('mangaModal').addEventListener('click', (e) => {
            if (e.target.id === 'mangaModal') this.closeModal();
        });
    }

    showWelcomeMessage() {
        const grid = document.getElementById('mangaGrid');
        grid.innerHTML = `
            <div class="welcome-message">
                <h2>Welcome to Manga Browser!</h2>
                <p>Discover and read your favorite manga:</p>
                <ul class="welcome-list">
                    <li>Browse popular manga by genre</li>
                    <li>Search for specific manga titles</li>
                    <li>Read manga with our vertical scroll reader</li>
                    <li>Track your reading progress</li>
                </ul>
                <p class="welcome-note">Select a genre or search to get started!</p>
            </div>
        `;
        
        // Ensure modal is hidden on page load
        document.getElementById('mangaModal').classList.add('hidden');
    }

    async handleSearch() {
        const query = document.getElementById('mangaSearchInput').value.trim();
        const sortOrder = document.getElementById('sortOrder').value;
        const contentRating = document.getElementById('contentRating').value;

        // Build filters
        const filters = {
            'order[relevance]': 'desc'
        };

        if (sortOrder !== 'relevance') {
            delete filters['order[relevance]'];
            filters[`order[${sortOrder}]`] = 'desc';
        }

        if (contentRating !== 'safe') {
            filters['contentRating[]'] = [contentRating];
        }

        // Add active genre filter
        const activeGenre = document.querySelector('.manga-genre-btn.active');
        if (activeGenre) {
            filters['includedTags[]'] = [this.getGenreId(activeGenre.dataset.genre)];
        }

        // Add active status filter
        const activeStatus = document.querySelector('.manga-status-btn.active');
        if (activeStatus) {
            filters['status[]'] = [activeStatus.dataset.status];
        }

        this.api.currentQuery = query;
        this.api.currentFilters = filters;
        this.api.currentPage = 0;

        await this.loadManga();
    }

    async handleGenreFilter(e) {
        // Toggle active state
        document.querySelectorAll('.manga-genre-btn').forEach(btn => btn.classList.remove('active'));
        e.target.classList.add('active');
        
        await this.handleSearch();
    }

    async handleStatusFilter(e) {
        // Toggle active state
        document.querySelectorAll('.manga-status-btn').forEach(btn => btn.classList.remove('active'));
        e.target.classList.add('active');
        
        await this.handleSearch();
    }

    getGenreId(genreName) {
        // MangaDx genre IDs - this is a simplified mapping
        const genreMap = {
            'action': '391b0423-d847-456f-aff0-8b0cfc03066b',
            'comedy': '4d32cc48-9f00-4cca-9b5a-a839f0764984',
            'drama': 'b9af3a63-f058-46de-a9a0-e0c13906197a',
            'fantasy': 'cdc58593-87dd-415e-bbc0-2ec27bf404cc',
            'romance': '423e2eae-a7a2-4a8b-ac03-a8351462d71d',
            'slice_of_life': 'e5301a23-ebd9-49dd-a0cb-2add944c7fe9',
            'supernatural': 'eabc5b4c-6aff-42f3-b657-3e90cbd00b75',
            'shounen': '27a4f54c-8e5a-4c30-99dc-e6b89322eda9'
        };
        return genreMap[genreName] || '';
    }

    async loadManga() {
        this.showLoading();
        
        try {
            const response = await this.api.searchManga(
                this.api.currentQuery,
                this.api.currentFilters,
                this.api.currentPage
            );

            this.displayManga(response.data);
            this.updatePagination(response.total);
            this.hideLoading();
        } catch (error) {
            this.showError('Failed to load manga. Please try again.');
            console.error('Error loading manga:', error);
        }
    }

    displayManga(mangaList) {
        const grid = document.getElementById('mangaGrid');
        
        if (!mangaList || mangaList.length === 0) {
            grid.innerHTML = '<div class="no-results">No manga found. Try different search terms or filters.</div>';
            return;
        }

        grid.innerHTML = mangaList.map(manga => this.createMangaCard(manga)).join('');
        
        // Add click listeners to manga cards
        document.querySelectorAll('.manga-card').forEach(card => {
            card.addEventListener('click', () => {
                const mangaId = card.dataset.mangaId;
                this.showMangaDetails(mangaId);
            });
        });
    }

    createMangaCard(manga) {
        const title = manga.attributes.title.en || manga.attributes.title.ja || 'Unknown Title';
        const description = manga.attributes.description?.en || 'No description available.';
        const status = this.api.formatStatus(manga.attributes.status);
        const year = manga.attributes.year || 'Unknown';
        const coverUrl = this.api.getCoverImageUrl(manga);
        const author = this.api.getAuthorName(manga);

        // Get first few tags
        const tags = manga.attributes.tags?.slice(0, 3).map(tag => 
            `<span class="manga-tag">${tag.attributes.name.en}</span>`
        ).join('') || '';

        return `
            <div class="manga-card" data-manga-id="${manga.id}">
                <div class="manga-image-container">
                    <img src="${coverUrl}" alt="${title}" loading="lazy">
                    <div class="manga-status-badge status-${manga.attributes.status}">${status}</div>
                </div>
                <div class="manga-info">
                    <h3 class="manga-title">${title}</h3>
                    <p class="manga-author">by ${author}</p>
                    <p class="manga-year">${year}</p>
                    <p class="manga-description">${description.substring(0, 150)}${description.length > 150 ? '...' : ''}</p>
                    <div class="manga-tags">${tags}</div>
                    <div class="manga-stats">
                        <span class="manga-rating">★ N/A</span>
                        <span class="manga-chapters">Click to view chapters</span>
                    </div>
                </div>
            </div>
        `;
    }

    async showMangaDetails(mangaId) {
        try {
            this.showLoading();
            
            // Get manga details and chapters
            const [mangaResponse, chaptersResponse] = await Promise.all([
                this.api.getMangaDetails(mangaId),
                this.api.getMangaChapters(mangaId)
            ]);

            const manga = mangaResponse.data;
            const chapters = chaptersResponse.data;

            this.currentManga = manga;
            this.currentChapters = chapters;

            this.displayMangaModal(manga, chapters);
            this.hideLoading();
        } catch (error) {
            this.showError('Failed to load manga details.');
            console.error('Error loading manga details:', error);
        }
    }

    displayMangaModal(manga, chapters) {
        const title = manga.attributes.title.en || manga.attributes.title.ja || 'Unknown Title';
        const description = manga.attributes.description?.en || 'No description available.';
        const status = this.api.formatStatus(manga.attributes.status);
        const year = manga.attributes.year || 'Unknown';
        const coverUrl = this.api.getCoverImageUrl(manga);
        const author = this.api.getAuthorName(manga);

        // Create tags
        const tags = manga.attributes.tags?.map(tag => 
            `<span class="tag">${tag.attributes.name.en}</span>`
        ).join('') || '';

        // Create chapters list
        const chaptersList = chapters.map(chapter => {
            const chapterTitle = chapter.attributes.title || `Chapter ${chapter.attributes.chapter}`;
            const chapterNum = chapter.attributes.chapter || 'N/A';
            const publishDate = new Date(chapter.attributes.publishAt).toLocaleDateString();
            
            return `
                <div class="chapter-item" data-chapter-id="${chapter.id}">
                    <span class="chapter-title">Ch. ${chapterNum}: ${chapterTitle}</span>
                    <span class="chapter-date">${publishDate}</span>
                </div>
            `;
        }).join('');

        // Update modal content
        document.getElementById('modalCover').src = coverUrl;
        document.getElementById('modalTitle').textContent = title;
        document.getElementById('modalAuthor').textContent = `Author: ${author}`;
        document.getElementById('modalStatus').textContent = `Status: ${status} (${year})`;
        document.getElementById('modalTags').innerHTML = tags;
        document.getElementById('modalDescription').textContent = description;
        document.getElementById('chaptersList').innerHTML = chaptersList;

        // Add chapter click listeners
        document.querySelectorAll('.chapter-item').forEach(item => {
            item.addEventListener('click', () => {
                const chapterId = item.dataset.chapterId;
                this.openMangaReader(chapterId);
            });
        });

        // Show modal
        document.getElementById('mangaModal').classList.remove('hidden');
    }

    openMangaReader(chapterId) {
        // Create URL for manga reader with chapter ID
        const readerUrl = `manga-reader.html?chapter=${chapterId}&manga=${this.currentManga.id}`;
        window.open(readerUrl, '_blank');
    }

    closeModal() {
        document.getElementById('mangaModal').classList.add('hidden');
    }

    async previousPage() {
        if (this.api.currentPage > 0) {
            this.api.currentPage--;
            await this.loadManga();
        }
    }

    async nextPage() {
        this.api.currentPage++;
        await this.loadManga();
    }

    updatePagination(total) {
        const totalPages = Math.ceil(total / this.api.limit);
        const currentPage = this.api.currentPage + 1;
        
        document.getElementById('pageInfo').textContent = `Page ${currentPage} of ${totalPages}`;
        document.getElementById('prevPage').disabled = this.api.currentPage === 0;
        document.getElementById('nextPage').disabled = currentPage >= totalPages;
        
        document.getElementById('pagination').classList.remove('hidden');
    }

    showLoading() {
        document.getElementById('loading').classList.remove('hidden');
        document.getElementById('error').classList.add('hidden');
    }

    hideLoading() {
        document.getElementById('loading').classList.add('hidden');
    }

    showError(message) {
        document.getElementById('error').querySelector('p').textContent = message;
        document.getElementById('error').classList.remove('hidden');
        document.getElementById('loading').classList.add('hidden');
    }
}

// Initialize the manga browser when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new MangaBrowser();
});
