// Manga Reader Script with Vertical Scroll Support

class MangaAPI {
    constructor() {
        this.baseURL = 'https://api.mangadex.org';
        this.cache = new Map();
        this.rateLimitDelay = 200;
        this.lastRequestTime = 0;
    }

    async rateLimit() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.rateLimitDelay) {
            await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay - timeSinceLastRequest));
        }
        this.lastRequestTime = Date.now();
    }

    async makeRequest(endpoint, params = {}) {
        await this.rateLimit();
    
        // 1. Build the complete MangaDex URL
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
    
        // 2. Try using the simple 'corsproxy.io' again
        const finalUrl = `https://corsproxy.io/?${mangaDexUrl.toString()}`;
    
        try {
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
    

    async getMangaChapters(mangaId, page = 0) {
        const params = {
            limit: 500,
            offset: page * 500,
            'translatedLanguage[]': ['en'],
            'order[chapter]': 'asc',
            'includes[]': ['scanlation_group']
        };

        return await this.makeRequest(`/manga/${mangaId}/feed`, params);
    }

    async getChapterPages(chapterId) {
        const cacheKey = `chapter_${chapterId}`;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }

        const chapterInfo = await this.makeRequest(`/chapter/${chapterId}`);

        // CHECK FOR EXTERNAL CHAPTER
        if (chapterInfo.data.attributes.pages === 0 && chapterInfo.data.attributes.externalUrl) {
            return {
                isExternal: true,
                url: chapterInfo.data.attributes.externalUrl,
                chapter: chapterInfo.data // Pass chapter data along for the title
            };
        }

        // If not external, proceed as normal
        const serverInfo = await this.makeRequest(`/at-home/server/${chapterId}`);
        
        const result = {
            isExternal: false,
            chapter: chapterInfo.data,
            baseUrl: serverInfo.baseUrl,
            chapter_hash: serverInfo.chapter.hash,
            data: serverInfo.chapter.data,
            dataSaver: serverInfo.chapter.dataSaver
        };

        this.cache.set(cacheKey, result);
        return result;
    }

    // ADD THIS FUNCTION BACK
    getPageUrl(baseUrl, chapterHash, filename, dataSaver = false) {
        const quality = dataSaver ? 'data-saver' : 'data';
        return `${baseUrl}/${quality}/${chapterHash}/${filename}`;
    }
}

class MangaReader {
    constructor() {
        this.api = new MangaAPI();
        this.currentChapter = null;
        this.currentManga = null;
        this.allChapters = [];
        this.currentChapterIndex = -1;
        this.pages = [];
        this.settings = {
            pageWidth: 'fit-width',
            imageQuality: 'high',
            autoScroll: false,
            scrollSpeed: 5
        };
        this.autoScrollInterval = null;
        this.lastScrollY = 0;
        this.scrollDirection = 'down';
        
        this.init();
    }

    async init() {
        this.loadSettings();
        this.setupEventListeners();
        await this.loadFromURL();
    }

    loadSettings() {
        const saved = localStorage.getItem('mangaReaderSettings');
        if (saved) {
            this.settings = { ...this.settings, ...JSON.parse(saved) };
        }
        this.applySettings();
    }

    saveSettings() {
        localStorage.setItem('mangaReaderSettings', JSON.stringify(this.settings));
    }

    applySettings() {
        const pagesContainer = document.getElementById('mangaPages');
        pagesContainer.className = `manga-pages ${this.settings.pageWidth}`;
        
        document.getElementById('pageWidth').value = this.settings.pageWidth;
        document.getElementById('imageQuality').value = this.settings.imageQuality;
        document.getElementById('autoScroll').checked = this.settings.autoScroll;
        document.getElementById('scrollSpeed').value = this.settings.scrollSpeed;
        
        if (this.settings.autoScroll) {
            this.startAutoScroll();
        } else {
            this.stopAutoScroll();
        }
    }

    setupEventListeners() {
        // Navigation buttons
        document.getElementById('prevChapterBtn').addEventListener('click', () => this.previousChapter());
        document.getElementById('nextChapterBtn').addEventListener('click', () => this.nextChapter());
        document.getElementById('prevChapterFooter').addEventListener('click', () => this.previousChapter());
        document.getElementById('nextChapterFooter').addEventListener('click', () => this.nextChapter());
        
        // Chapter selector
        document.getElementById('chapterSelect').addEventListener('change', (e) => {
            const chapterId = e.target.value;
            if (chapterId) {
                this.loadChapter(chapterId);
            }
        });

        // Settings panel
        document.getElementById('settingsToggle').addEventListener('click', () => this.toggleSettings());
        document.getElementById('pageWidth').addEventListener('change', (e) => {
            this.settings.pageWidth = e.target.value;
            this.applySettings();
            this.saveSettings();
        });
        document.getElementById('imageQuality').addEventListener('change', (e) => {
            this.settings.imageQuality = e.target.value;
            this.saveSettings();
            this.reloadPages();
        });
        document.getElementById('autoScroll').addEventListener('change', (e) => {
            this.settings.autoScroll = e.target.checked;
            this.applySettings();
            this.saveSettings();
        });
        document.getElementById('scrollSpeed').addEventListener('input', (e) => {
            this.settings.scrollSpeed = parseInt(e.target.value);
            this.saveSettings();
            if (this.settings.autoScroll) {
                this.startAutoScroll();
            }
        });

        // Help panel
        document.getElementById('helpToggle').addEventListener('click', () => this.toggleHelp());

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboard(e));

        // Scroll tracking
        let scrollTimeout;
        window.addEventListener('scroll', () => {
            this.updateProgress();
            this.handleHeaderAutoHide();
            
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                this.checkChapterEnd();
            }, 150);
        });

        // Close panels when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.settings-panel') && !e.target.closest('.settings-toggle')) {
                document.getElementById('settingsPanel').classList.remove('active');
            }
            if (!e.target.closest('.help-panel') && !e.target.closest('.help-toggle')) {
                document.getElementById('helpPanel').classList.add('hidden');
            }
        });

        this.setupTouchGestures();
    }

    setupTouchGestures() {
        let startY = 0;
        let startX = 0;
        
        document.addEventListener('touchstart', (e) => {
            startY = e.touches[0].clientY;
            startX = e.touches[0].clientX;
        });
        
        document.addEventListener('touchend', (e) => {
            const endY = e.changedTouches[0].clientY;
            const endX = e.changedTouches[0].clientX;
            const diffY = startY - endY;
            const diffX = startX - endX;
            
            if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 50) {
                if (diffX > 0) {
                    this.nextChapter();
                } else {
                    this.previousChapter();
                }
            }
        });
    }

    async loadFromURL() {
        const urlParams = new URLSearchParams(window.location.search);
        const chapterId = urlParams.get('chapter');
        const mangaId = urlParams.get('manga');
        
        if (!chapterId || !mangaId) {
            this.showError('Invalid chapter or manga ID');
            return;
        }

        try {
            this.showLoading();
            
            const [mangaResponse, chaptersResponse] = await Promise.all([
                this.api.getMangaDetails(mangaId),
                this.api.getMangaChapters(mangaId)
            ]);
            
            this.currentManga = mangaResponse.data;
            this.allChapters = chaptersResponse.data.sort((a, b) => 
                parseFloat(a.attributes.chapter || 0) - parseFloat(b.attributes.chapter || 0)
            );
            
            this.currentChapterIndex = this.allChapters.findIndex(ch => ch.id === chapterId);
            
            this.updateMangaInfo();
            this.populateChapterSelector();
            await this.loadChapter(chapterId);
            
        } catch (error) {
            this.showError('Failed to load manga data');
            console.error('Error loading manga:', error);
        }
    }

    updateMangaInfo() {
        const title = this.currentManga.attributes.title.en || 
                     this.currentManga.attributes.title.ja || 
                     'Unknown Title';
        document.getElementById('mangaTitle').textContent = title;
        document.title = `${title} - Manga Reader`;
    }

    populateChapterSelector() {
        const selector = document.getElementById('chapterSelect');
        selector.innerHTML = this.allChapters.map(chapter => {
            const chapterNum = chapter.attributes.chapter || 'N/A';
            const chapterTitle = chapter.attributes.title || '';
            const displayTitle = chapterTitle ? 
                `Ch. ${chapterNum}: ${chapterTitle}` : 
                `Chapter ${chapterNum}`;
            
            return `<option value="${chapter.id}">${displayTitle}</option>`;
        }).join('');
    }

    async loadChapter(chapterId) {
        try {
            this.showLoading();
            
            const chapterData = await this.api.getChapterPages(chapterId);
            this.currentChapter = chapterData;
            
            // Set chapter title regardless of type
            const chapterInfo = chapterData.chapter;
            const chapterNum = chapterInfo.attributes.chapter || 'N/A';
            const chapterTitle = chapterInfo.attributes.title || '';
            const displayTitle = chapterTitle ? 
                `Chapter ${chapterNum}: ${chapterTitle}` : 
                `Chapter ${chapterNum}`;
            document.getElementById('chapterTitle').textContent = displayTitle;
            document.getElementById('chapterSelect').value = chapterId;
            
            this.currentChapterIndex = this.allChapters.findIndex(ch => ch.id === chapterId);

            // HANDLE EXTERNAL CHAPTER
            if (chapterData.isExternal) {
                // Clear the page and show a message with the link
                document.getElementById('mangaPages').innerHTML = ''; 
                this.showError(`This chapter is hosted externally. Please read it at: <a href="${chapterData.url}" target="_blank">${chapterData.url}</a>`);
                this.updateNavigationButtons(); // Update nav buttons
                return; // Stop the function here
            }
            
            // If not external, load pages as normal
            await this.loadPages();
            this.updateNavigationButtons();
            this.hideLoading();
            
            window.scrollTo(0, 0);
            
        } catch (error) {
            this.showError('Failed to load chapter');
            console.error('Error loading chapter:', error);
        }
    }

    async loadPages() {
        const pagesContainer = document.getElementById('mangaPages');
        const { baseUrl, chapter_hash, data, dataSaver } = this.currentChapter;
        
        const imageFiles = this.settings.imageQuality === 'data-saver' ? dataSaver : data;
        
        pagesContainer.innerHTML = imageFiles.map((filename, index) => `
            <div class="page-placeholder" id="placeholder-${index}"></div>
            <img class="manga-page" 
                 id="page-${index}" 
                 data-src="${this.api.getPageUrl(baseUrl, chapter_hash, filename, this.settings.imageQuality === 'data-saver')}"
                 alt="Page ${index + 1}"
                 style="display: none;">
        `).join('');

        this.loadImagesProgressively(imageFiles.length);
        
        document.getElementById('chapterNavigation').classList.remove('hidden');
        this.updateChapterNavigation();
    }

    async loadImagesProgressively(totalPages) {
        const loadPromises = [];
        
        for (let i = 0; i < totalPages; i++) {
            const promise = this.loadSinglePage(i);
            loadPromises.push(promise);
            
            if (i < 3) {
                await promise;
            }
        }
        
        await Promise.all(loadPromises);
    }

    loadSinglePage(index) {
        return new Promise((resolve) => {
            const img = document.getElementById(`page-${index}`);
            const placeholder = document.getElementById(`placeholder-${index}`);
            
            img.onload = () => {
                placeholder.style.display = 'none';
                img.style.display = 'block';
                resolve();
            };
            
            img.onerror = () => {
                placeholder.innerHTML = `
                    <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #e74c3c;">
                        Failed to load page ${index + 1}
                    </div>
                `;
                resolve();
            };
            
            img.src = img.dataset.src;
        });
    }

    async reloadPages() {
        if (this.currentChapter) {
            await this.loadPages();
        }
    }

    updateNavigationButtons() {
        const prevBtn = document.getElementById('prevChapterBtn');
        const nextBtn = document.getElementById('nextChapterBtn');
        const prevFooter = document.getElementById('prevChapterFooter');
        const nextFooter = document.getElementById('nextChapterFooter');
        
        const hasPrev = this.currentChapterIndex > 0;
        const hasNext = this.currentChapterIndex < this.allChapters.length - 1;
        
        prevBtn.disabled = !hasPrev;
        nextBtn.disabled = !hasNext;
        prevFooter.disabled = !hasPrev;
        nextFooter.disabled = !hasNext;
    }

    updateChapterNavigation() {
        const prevTitle = document.getElementById('prevChapterTitle');
        const nextTitle = document.getElementById('nextChapterTitle');
        
        if (this.currentChapterIndex > 0) {
            const prevChapter = this.allChapters[this.currentChapterIndex - 1];
            const prevChapterNum = prevChapter.attributes.chapter || 'N/A';
            const prevChapterTitle = prevChapter.attributes.title || '';
            prevTitle.textContent = prevChapterTitle ? 
                `Ch. ${prevChapterNum}: ${prevChapterTitle}` : 
                `Chapter ${prevChapterNum}`;
        } else {
            prevTitle.textContent = 'No previous chapter';
        }
        
        if (this.currentChapterIndex < this.allChapters.length - 1) {
            const nextChapter = this.allChapters[this.currentChapterIndex + 1];
            const nextChapterNum = nextChapter.attributes.chapter || 'N/A';
            const nextChapterTitle = nextChapter.attributes.title || '';
            nextTitle.textContent = nextChapterTitle ? 
                `Ch. ${nextChapterNum}: ${nextChapterTitle}` : 
                `Chapter ${nextChapterNum}`;
        } else {
            nextTitle.textContent = 'No next chapter';
        }
    }

    async previousChapter() {
        if (this.currentChapterIndex > 0) {
            const prevChapter = this.allChapters[this.currentChapterIndex - 1];
            await this.loadChapter(prevChapter.id);
        }
    }

    async nextChapter() {
        if (this.currentChapterIndex < this.allChapters.length - 1) {
            const nextChapter = this.allChapters[this.currentChapterIndex + 1];
            await this.loadChapter(nextChapter.id);
        }
    }

    updateProgress() {
        const scrollTop = window.pageYOffset;
        const docHeight = document.documentElement.scrollHeight - window.innerHeight;
        const progress = (scrollTop / docHeight) * 100;
        
        document.getElementById('progressBar').style.width = `${Math.min(progress, 100)}%`;
    }

    handleHeaderAutoHide() {
        const currentScrollY = window.pageYOffset;
        const header = document.querySelector('.reader-header');
        
        if (currentScrollY > this.lastScrollY && currentScrollY > 100) {
            header.classList.add('scrolling-down');
        } else {
            header.classList.remove('scrolling-down');
        }
        
        this.lastScrollY = currentScrollY;
    }

    checkChapterEnd() {
        const scrollTop = window.pageYOffset;
        const docHeight = document.documentElement.scrollHeight;
        const windowHeight = window.innerHeight;
        
        if (scrollTop + windowHeight >= docHeight - 100) {
            // Near end of chapter, show next chapter option
            if (this.currentChapterIndex < this.allChapters.length - 1) {
                // Could add auto-advance to next chapter here
            }
        }
    }

    handleKeyboard(e) {
        // Prevent default for handled keys
        const handledKeys = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyF', 'KeyH'];
        if (handledKeys.includes(e.code)) {
            e.preventDefault();
        }

        switch (e.code) {
            case 'Space':
                if (e.shiftKey) {
                    window.scrollBy(0, -window.innerHeight * 0.8);
                } else {
                    window.scrollBy(0, window.innerHeight * 0.8);
                }
                break;
            case 'ArrowUp':
                window.scrollBy(0, -100);
                break;
            case 'ArrowDown':
                window.scrollBy(0, 100);
                break;
            case 'ArrowLeft':
                this.previousChapter();
                break;
            case 'ArrowRight':
                this.nextChapter();
                break;
            case 'KeyF':
                this.toggleFullscreen();
                break;
            case 'KeyH':
                this.toggleHelp();
                break;
        }
    }

    startAutoScroll() {
        this.stopAutoScroll();
        const speed = this.settings.scrollSpeed * 10;
        this.autoScrollInterval = setInterval(() => {
            window.scrollBy(0, 1);
        }, 100 - speed);
    }

    stopAutoScroll() {
        if (this.autoScrollInterval) {
            clearInterval(this.autoScrollInterval);
            this.autoScrollInterval = null;
        }
    }

    toggleSettings() {
        const panel = document.getElementById('settingsPanel');
        panel.classList.toggle('active');
    }

    toggleHelp() {
        const panel = document.getElementById('helpPanel');
        panel.classList.toggle('hidden');
    }

    toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
            document.body.classList.add('fullscreen');
        } else {
            document.exitFullscreen();
            document.body.classList.remove('fullscreen');
        }
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

// Initialize the manga reader when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new MangaReader();
});
