require('dotenv').config();
const Parser = require('rss-parser');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

const rssParser = new Parser({ 
    timeout: 8000,
    customFields: { item: [['media:content', 'mediaContent'], ['media:thumbnail', 'mediaThumbnail']] }
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'llama-3.1-8b-instant';

// ─── HELPER 1: CHECK THE RSS FEED FOR AN IMAGE ──────────────────────────────
function extractRssImage(item) {
    if (item.enclosure && item.enclosure.url) return item.enclosure.url;
    if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) return item.mediaContent.$.url;
    if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) return item.mediaThumbnail.$.url;
    
    const rawText = (item['content:encoded'] || item.content || item.contentSnippet || item.description || '');
    const imgMatch = rawText.match(/<img[^>]+src="([^">]+)"/i);
    if (imgMatch && imgMatch[1]) return imgMatch[1];

    return null;
}

// ─── HELPER 2: SCRAPE THE WEBPAGE IF RSS FAILS ──────────────────────────────
async function fetchOgImage(link) {
    if (!link) return null;
    try {
        const controller = new AbortController();
        // Increased to 5 seconds to give it time to jump twice
        const timeoutId = setTimeout(() => controller.abort(), 5000); 
        
        const options = { 
            signal: controller.signal,
            redirect: 'follow', 
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
        };

        // Jump 1: Hit the Google News link
        let response = await fetch(link, options);
        let html = await response.text();
        
        // Busting the Google News Trap
        if (link.includes('news.google.com')) {
            const $google = cheerio.load(html);
            // Google hides the real URL in the only 'a' tag on their holding page
            const realUrl = $google('a').attr('href'); 
            
            if (realUrl && realUrl.startsWith('http')) {
                // Jump 2: Fetch the actual publisher's website
                response = await fetch(realUrl, options);
                html = await response.text();
            }
        }

        clearTimeout(timeoutId);

        // Now parse the REAL website for the image
        const $ = cheerio.load(html);
        
        // Look for standard Open Graph images, or Twitter Card images as a backup
        const ogImage = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content');
        
        return ogImage || null;
    } catch (e) {
        // If it times out, fail silently and keep moving
        return null; 
    }
}

// ─── RSS FEEDS (Real-time, no delay) ─────────────────────────────────────────
const RSS_FEEDS = [
    // General / Top news
    { url: 'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml', category: 'general' },
    { url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', category: 'general' },
    { url: 'https://feeds.npr.org/1001/rss.xml', category: 'general' },
    // Politics
    { url: 'https://rss.politico.com/politics-news.xml', category: 'politics' },
    { url: 'https://feeds.nbcnews.com/nbcnews/public/politics', category: 'politics' },
    // Tech
    { url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', category: 'technology' },
    { url: 'https://www.theverge.com/rss/index.xml', category: 'technology' },
    // Business / Economy
    { url: 'https://feeds.bloomberg.com/markets/news.rss', category: 'business' },
    { url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10001147', category: 'business' },
    // Sports
    { url: 'https://www.espn.com/espn/rss/news', category: 'sports' },
    // Entertainment
    { url: 'https://www.hollywoodreporter.com/feed/', category: 'entertainment' },
    // Science / Health
    { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Science.xml', category: 'science' },
    { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Health.xml', category: 'health' },
];

async function fetchRssFeeds() {
    console.log('\n\n========== 📡 RSS FEEDS (Real-time) ==========');
    const allArticles = [];

    for (const feed of RSS_FEEDS) {
        try {
            console.log(`  Fetching RSS: ${feed.url.split('/')[2]}`);
            const parsed = await rssParser.parseURL(feed.url);
            const items = (parsed.items || []).slice(0, 5); // Top 5 per feed

            for (const item of items) {
                const title = item.title || '';
                const description = item.contentSnippet || item.content || item.description || '';
                
                // Skip thin articles
                if ((title + description).length < 80) {
                    console.log(`    ⚠️  Skipped thin article: ${title}`);
                    continue;
                }

                const image = extractRssImage(item);
                
                allArticles.push({
                    title,
                    description,
                    content: description,
                    url: item.link || '',
                    urlToImage: image,
                    source: { name: parsed.title || feed.url.split('/')[2] },
                    publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
                    _feedCategory: feed.category,
                });
            }
        } catch (e) {
            console.error(`  RSS failed for ${feed.url.split('/')[2]}:`, e.message);
        }
    }

    console.log(`  Total RSS articles collected: ${allArticles.length}`);
    return allArticles;
}

// ─── SOURCE BLOCKLIST (junk/irrelevant sources) ─────────────────────────────
const BLOCKED_SOURCES = new Set([
    'shanghai metals market', 'menafn', 'kallanish energy', 'kallanish commodities',
    'biztoc', 'newsnow', 'yahoo movies uk', 'bollywood hungama', 'mid-day',
    'business wire', 'pr newswire', 'globenewswire', 'accesswire', 'prnewswire',
    'webwire', 'einpresswire', 'issuewire', 'send2press', 'marketersmedia',
    'openpr', 'prlog', 'digital journal', 'zawya', 'african news agency',
    'mena report', 'asia one', 'china daily', 'xinhua', 'tass',
    'google news', 'news.google.com',
    'the hans india', 'the hindu', 'ndtv', 'times of india', 'hindustan times',
    'economic times', 'mint', 'indian express', 'firstpost', 'zee news',
    'news18', 'republic world', 'india today', 'dna india', 'tribune india',
]);

// ─── 1. FETCH FROM NEWSDATA.IO API (with pagination for 25+ articles) ───────
async function fetchTopNews(category, lang = 'en') {
    const newsDataCategories = {
        general:       'top',
        technology:    'technology',
        sports:        'sports',
        business:      'business',
        entertainment: 'entertainment',
        science:       'science',
        health:        'health',
        politics:      'politics'
    };

    const ndCat = newsDataCategories[category];
    const apiKey = process.env.NEWSDATA_API_KEY;
    const country = lang === 'es' ? 'us,mx,es,ar,co' : 'us';
    const baseUrl = `https://newsdata.io/api/1/latest?apikey=${apiKey}&country=${country}&language=${lang}&category=${ndCat}&prioritydomain=top`;
    const MAX_PAGES = 2; // 2 pages × 10 articles = up to 20 articles
    const allResults = [];
    let nextPage = null;

    try {
        for (let page = 0; page < MAX_PAGES; page++) {
            const url = nextPage ? `${baseUrl}&page=${nextPage}` : baseUrl;
            console.log(`  Fetching NewsData.io: ${category.toUpperCase()} [${lang}] page ${page + 1}`);
            
            const response = await fetch(url);
            const data = await response.json();

            if (data.status !== 'success' || !data.results) {
                if (page === 0) console.error(`  NewsData.io error:`, data.results?.message || 'Unknown error');
                break;
            }

            // Filter out blocked sources
            const filtered = data.results.filter(item => {
                const src = (item.source_name || item.source_id || '').toLowerCase();
                const itemUrl = (item.link || '').toLowerCase();
                if (BLOCKED_SOURCES.has(src)) return false;
                if (itemUrl.includes('news.google.com')) return false;
                return true;
            });

            allResults.push(...filtered.map(item => ({
                title:       item.title,
                description: item.description || '',
                content:     item.content || item.description || '',
                url:         item.link,
                urlToImage:  item.image_url || null,
                source:      { name: item.source_name || item.source_id || 'Unknown' },
                publishedAt: item.pubDate,
            })));

            nextPage = data.nextPage;
            if (!nextPage) break; // No more pages
            
            // Brief pause between pages
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.log(`  Total for ${category} [${lang}]: ${allResults.length} articles`);
        return allResults;
    } catch (e) {
        console.error(`  NewsData.io failed for ${category}:`, e.message);
        return allResults; // Return whatever we got before the error
    }
}

// ─── 1b. FETCH GLOBAL/WORLD NEWS ─────────────────────────────────────────────
async function fetchGlobalNews(lang = 'en') {
    const apiKey = process.env.NEWSDATA_API_KEY;
    const country = lang === 'es' ? 'mx,es,ar,co,cl' : 'gb,au,ca,de,fr';
    const baseUrl = `https://newsdata.io/api/1/latest?apikey=${apiKey}&country=${country}&language=${lang}&category=top&prioritydomain=top`;
    const MAX_PAGES = 2;
    const allResults = [];
    let nextPage = null;

    try {
        for (let page = 0; page < MAX_PAGES; page++) {
            const url = nextPage ? `${baseUrl}&page=${nextPage}` : baseUrl;
            console.log(`  Fetching NewsData.io: GLOBAL [${lang}] page ${page + 1}`);
            
            const response = await fetch(url);
            const data = await response.json();

            if (data.status !== 'success' || !data.results) {
                if (page === 0) console.error(`  NewsData.io error (global):`, data.results?.message || 'Unknown');
                break;
            }

            const filtered = data.results.filter(item => {
                const src = (item.source_name || item.source_id || '').toLowerCase();
                const itemUrl = (item.link || '').toLowerCase();
                if (BLOCKED_SOURCES.has(src)) return false;
                if (itemUrl.includes('news.google.com')) return false;
                return true;
            });

            allResults.push(...filtered.map(item => ({
                title:       item.title,
                description: item.description || '',
                content:     item.content || item.description || '',
                url:         item.link,
                urlToImage:  item.image_url || null,
                source:      { name: item.source_name || item.source_id || 'Unknown' },
                publishedAt: item.pubDate,
                _forceCategory: 'global',
            })));

            nextPage = data.nextPage;
            if (!nextPage) break;
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.log(`  Total GLOBAL [${lang}]: ${allResults.length} articles`);
        return allResults;
    } catch (e) {
        console.error(`  NewsData.io failed for global:`, e.message);
        return allResults;
    }
}

// ─── 2. AI SUMMARIZE & CATEGORIZE (Groq + Llama) ────────────────────────────
async function summarizeWithAI(article, lang = 'en', retries = 4) {
    const langInstruction = lang === 'es' 
        ? 'Write the title and summary ENTIRELY IN SPANISH. Do not use any English.'
        : 'Write the title and summary in English.';

    const contentText = (article.description + ' ' + article.content).substring(0, 800);

    const prompt = `You are an elite news editor at a top mobile news app like Apple News or Artifact. Your job is to rewrite headlines and craft perfect summaries.

ARTICLE TO PROCESS:
Original title: ${article.title}
Content: ${contentText}

Output ONLY a valid JSON object with exactly these 5 keys, no extra text:
{"title": "...", "summary": "...", "category": "...", "subcategory": "...", "is_trending": true/false}

STRICT RULES:

LANGUAGE: ${langInstruction}

TITLE RULES:
- Rewrite the headline to be clear, compelling, and concise (max 12 words)
- Remove source attribution like "— Reuters" or "| CNN" from the title
- Remove clickbait. No "You won't believe" or "Here's why"
- Use active voice. "Tesla recalls 500K cars" not "500K cars recalled by Tesla"
- Capitalize first word and proper nouns only (sentence case). NOT Title Case
- The title should make someone WANT to read the 60-word summary

SUMMARY RULES:
- MUST be 40 words or fewer. Count carefully.
- Write like a sharp, authoritative journalist — not a robot
- Lead with the most important fact (inverted pyramid style)
- Include WHO, WHAT, and WHY in the first sentence
- Use short punchy sentences. No filler words
- End with the broader impact or what happens next
- Never start with "In a..." or "According to..."

- category: Choose ONE from: economy, sports, tech, politics, entertainment, science, health
- subcategory: ONLY if category is "sports", pick ONE from: nfl, nba, mlb, nhl, soccer, mma, tennis, golf, college, other. If NOT sports, set to null.
- is_trending: true ONLY if this is a massive breaking story or top national headline, otherwise false`;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${GROQ_API_KEY}`
                },
                body: JSON.stringify({
                    model: GROQ_MODEL,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.4,
                    max_tokens: 250,
                    response_format: { type: 'json_object' }
                })
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errText}`);
            }

            const data = await response.json();
            const text = data.choices[0].message.content;
            return JSON.parse(text);
        } catch (error) {
            if ((error.message.includes('429') || error.message.includes('503')) && attempt < retries) {
                const wait = attempt * 5;
                console.log(`    ⏳ Rate limited. Retrying in ${wait}s (Attempt ${attempt + 1}/${retries})...`);
                await new Promise(resolve => setTimeout(resolve, wait * 1000));
            } else {
                console.error(`    ❌ AI failed for: ${article.title} -`, error.message);
                return null;
            }
        }
    }
}

// ─── 3. SAVE TO DATABASE ────────────────────────────────────────────────────
async function saveToDatabase(formattedArticles) {
    if (formattedArticles.length === 0) return;
    console.log(`Saving ${formattedArticles.length} articles to Supabase...`);
    const { data, error } = await supabase.from('articles').upsert(formattedArticles, { onConflict: 'url' }); 
    if (error) console.error("Database error:", error.message);
    else console.log("Successfully updated database!");
}

// ─── 4. CLEANUP OLD NEWS ────────────────────────────────────────────────────
async function deleteOldArticles() {
    const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase.from('articles').delete().lt('published_at', cutoff); 
    if (error) console.error('Delete old articles failed:', error.message);
    else console.log('🗑️  Cleaned up articles older than 72 hours');
}

// ─── 5. FETCH SPORTS BY LEAGUE ──────────────────────────────────────────────
const SPORTS_LEAGUES = [
    { query: 'NFL football',     subcategory: 'nfl' },
    { query: 'NBA basketball',   subcategory: 'nba' },
    { query: 'MLB baseball',     subcategory: 'mlb' },
    { query: 'NHL hockey',       subcategory: 'nhl' },
    { query: 'soccer MLS premier league', subcategory: 'soccer' },
    { query: 'UFC MMA fighting', subcategory: 'mma' },
];

async function fetchSportsLeague(league) {
    const apiKey = process.env.NEWSDATA_API_KEY;
    const url = `https://newsdata.io/api/1/latest?apikey=${apiKey}&country=us&language=en&category=sports&q=${encodeURIComponent(league.query)}&prioritydomain=top`;

    try {
        console.log(`  Fetching NewsData.io: SPORTS → ${league.subcategory.toUpperCase()}`);
        const response = await fetch(url);
        const data = await response.json();

        if (data.status !== 'success' || !data.results) {
            console.error(`  NewsData.io error for ${league.subcategory}:`, data.results?.message || 'Unknown');
            return [];
        }

        // Apply same source filtering
        const filtered = data.results.filter(item => {
            const src = (item.source_name || item.source_id || '').toLowerCase();
            const itemUrl = (item.link || '').toLowerCase();
            if (BLOCKED_SOURCES.has(src)) return false;
            if (itemUrl.includes('news.google.com')) return false;
            return true;
        });

        console.log(`  Got ${data.results.length} results, kept ${filtered.length} after filtering`);

        return filtered.map(item => ({
            title:       item.title,
            description: item.description || '',
            content:     item.content || item.description || '',
            url:         item.link,
            urlToImage:  item.image_url || null,
            source:      { name: item.source_name || item.source_id || 'Unknown' },
            publishedAt: item.pubDate,
            subcategory: league.subcategory,
        }));
    } catch (e) {
        console.error(`  NewsData.io failed for ${league.subcategory}:`, e.message);
        return [];
    }
}

// ─── MAIN ENGINE ────────────────────────────────────────────────────────────
async function runPipeline() {
    console.log("🚀 Starting News Flip Pipeline...");
    
    await deleteOldArticles();

    const LANGUAGES = ['en', 'es'];
    
    for (const lang of LANGUAGES) {
        console.log(`\n\n========== 🌐 LANGUAGE: ${lang.toUpperCase()} ==========`);

        // ── Standard categories ──
        const categories = ['general', 'technology', 'sports', 'business', 'entertainment', 'science', 'health', 'politics'];
        
        for (const cat of categories) {
            console.log(`\n--- 📂 [${lang.toUpperCase()}] Category: ${cat.toUpperCase()} ---`);
            
            const rawArticles = await fetchTopNews(cat, lang);
            const processedArticles = [];

            for (const article of rawArticles) {
                const inputText = (article.title + ' ' + article.description + ' ' + article.content).trim();
                if (inputText.length < 80) {
                    console.log(`    ⚠️  Skipped thin article: ${article.title}`);
                    continue;
                }

                console.log(`Processing [${lang}/${cat}]: ${article.title}`);
                
                const aiData = await summarizeWithAI(article, lang);
                
                if (aiData && aiData.summary) {
                    let finalImage = article.urlToImage;
                    if (!finalImage) {
                        console.log(`    🖼️  No image from API — scraping OG image...`);
                        finalImage = await fetchOgImage(article.url);
                        if (finalImage) console.log(`    ✅ Found OG image`);
                        else console.log(`    ⚠️  No image found — card will show category art`);
                    }

                    processedArticles.push({
                        title: aiData.title || article.title,
                        summary: aiData.summary,
                        full_text: article.content || "Read more at the source.",
                        source: article.source.name,
                        url: article.url,
                        image_url: finalImage,
                        category: aiData.category.toLowerCase(), 
                        subcategory: aiData.subcategory ? aiData.subcategory.toLowerCase() : null,
                        is_trending: aiData.is_trending,         
                        published_at: article.publishedAt,
                        language: lang
                    });
                }
                
                await new Promise(resolve => setTimeout(resolve, 3000));
            }

            if (processedArticles.length > 0) {
                await saveToDatabase(processedArticles);
            }
            
            console.log(`--- ✅ [${lang.toUpperCase()}] Finished: ${cat} ---`);
        }

        // ── Global / World News ──
        console.log(`\n--- 🌍 [${lang.toUpperCase()}] GLOBAL NEWS ---`);
        const globalRaw = await fetchGlobalNews(lang);
        const globalProcessed = [];

        for (const article of globalRaw) {
            const inputText = (article.title + ' ' + article.description + ' ' + article.content).trim();
            if (inputText.length < 80) continue;

            console.log(`Processing [${lang}/global]: ${article.title}`);
            const aiData = await summarizeWithAI(article, lang);

            if (aiData && aiData.summary) {
                let finalImage = article.urlToImage;
                if (!finalImage) {
                    finalImage = await fetchOgImage(article.url);
                }

                globalProcessed.push({
                    title: aiData.title || article.title,
                    summary: aiData.summary,
                    full_text: article.content || "Read more at the source.",
                    source: article.source.name,
                    url: article.url,
                    image_url: finalImage,
                    category: 'global',
                    subcategory: null,
                    is_trending: aiData.is_trending,
                    published_at: article.publishedAt,
                    language: lang
                });
            }
            await new Promise(resolve => setTimeout(resolve, 3000));
        }

        if (globalProcessed.length > 0) {
            await saveToDatabase(globalProcessed);
        }
        console.log(`--- ✅ [${lang.toUpperCase()}] Global: Saved ${globalProcessed.length} articles ---`);

        // ── Sports league sub-categories (English only) ──
        if (lang === 'en') {
            console.log(`\n\n========== SPORTS LEAGUES ==========`);
            for (const league of SPORTS_LEAGUES) {
                console.log(`\n--- Starting League: ${league.subcategory.toUpperCase()} ---`);

                const rawArticles = await fetchSportsLeague(league);
                const processedArticles = [];

                for (const article of rawArticles) {
                    console.log(`Processing [${league.subcategory}]: ${article.title}`);
                    
                    const aiData = await summarizeWithAI(article, 'en');
                    
                    if (aiData && aiData.summary) {
                        let finalImage = article.urlToImage;
                        if (!finalImage) {
                            finalImage = await fetchOgImage(article.url);
                        }

                        processedArticles.push({
                            title: aiData.title || article.title,
                            summary: aiData.summary,
                            full_text: article.content || "Read more at the source.",
                            source: article.source.name,
                            url: article.url,
                            image_url: finalImage,
                            category: 'sports',
                            subcategory: aiData.subcategory ? aiData.subcategory.toLowerCase() : league.subcategory,
                            is_trending: aiData.is_trending,         
                            published_at: article.publishedAt,
                            language: 'en'
                        });
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }

                if (processedArticles.length > 0) {
                    await saveToDatabase(processedArticles);
                }
                
                console.log(`--- ✅ Finished League: ${league.subcategory.toUpperCase()} ---`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }

    // ── RSS Feeds (English only — real-time, no delay) ──
    const rssArticles = await fetchRssFeeds();
    const rssProcessed = [];

    for (const article of rssArticles) {
        const inputText = (article.title + ' ' + article.description).trim();
        if (inputText.length < 80) continue;

        console.log(`Processing [RSS]: ${article.title}`);
        
        const aiData = await summarizeWithAI(article, 'en');
        
        if (aiData && aiData.summary) {
            let finalImage = article.urlToImage;
            if (!finalImage) {
                finalImage = await fetchOgImage(article.url);
            }

            rssProcessed.push({
                title: aiData.title || article.title,
                summary: aiData.summary,
                full_text: article.content || "Read more at the source.",
                source: article.source.name,
                url: article.url,
                image_url: finalImage,
                category: aiData.category.toLowerCase(),
                subcategory: aiData.subcategory ? aiData.subcategory.toLowerCase() : null,
                is_trending: aiData.is_trending,
                published_at: article.publishedAt,
                language: 'en'
            });
        }

        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    if (rssProcessed.length > 0) {
        await saveToDatabase(rssProcessed);
        console.log(`--- ✅ RSS: Saved ${rssProcessed.length} real-time articles ---`);
    }

    console.log("\n✨ SUCCESS: All categories, leagues, languages, and RSS feeds processed.");
}

runPipeline();