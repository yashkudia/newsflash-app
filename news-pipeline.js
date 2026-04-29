require('dotenv').config();
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ─── DUAL AI SETUP ─────────────────────────────────────────────────────────
let geminiModel = null;
try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({ 
        model: "gemini-2.5-flash",
        generationConfig: { responseMimeType: "application/json" }
    });
    console.log('✅ Gemini ready');
} catch(e) {
    console.log('⚠️  Gemini not available:', e.message);
}

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
console.log(GROQ_API_KEY ? '✅ Groq ready' : '⚠️  Groq not available');

let aiCallCount = 0;

// ─── AI SUMMARIZE (DUAL PROVIDER) ──────────────────────────────────────────
async function summarizeWithAI(article, retries = 3) {
    const prompt = `You are a senior news editor at a fast-paced mobile news app. Your readers are busy Americans who want to understand what happened in 10 seconds.

Article:
Title: ${article.title}
Content: ${(article.description || '')} ${(article.content || '').slice(0, 1000)}

Write a JSON object with these keys:
"summary": Write exactly 50-65 words. Start with the most important fact — WHO did WHAT. Then add context — WHY it matters. End with what happens next or the bigger picture. Use active voice, short sentences. No filler words. Make every word count. Write like you're telling a smart friend who missed the news.
"category": Pick ONE from: ["economy", "sports", "tech", "politics", "entertainment", "science", "health", "world"]. Use "world" for international/global stories.
"is_trending": true only if this is a major breaking story that most Americans would care about.

Output ONLY valid JSON, nothing else.`;

    // Alternate: even = Gemini, odd = Groq
    const useGemini = (aiCallCount % 2 === 0) && geminiModel;
    aiCallCount++;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            let parsed;
            
            if (useGemini) {
                const result = await geminiModel.generateContent(prompt);
                parsed = JSON.parse(result.response.text());
            } else if (GROQ_API_KEY) {
                const res = await fetch(GROQ_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${GROQ_API_KEY}`
                    },
                    body: JSON.stringify({
                        model: 'llama-3.1-8b-instant',
                        messages: [{ role: 'user', content: prompt }],
                        max_tokens: 300,
                        temperature: 0.5,
                        response_format: { type: 'json_object' }
                    })
                });
                if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
                const data = await res.json();
                parsed = JSON.parse(data.choices[0].message.content);
            } else {
                return null;
            }

            if (parsed && parsed.summary) {
                const p = useGemini ? 'G' : 'Q';
                console.log(`    [${p}] ${parsed.summary.slice(0, 50)}...`);
                return parsed;
            }
            throw new Error('Invalid response');
            
        } catch (error) {
            const provider = useGemini ? 'Gemini' : 'Groq';
            if (attempt < retries && (error.message.includes('503') || error.message.includes('429') || error.message.includes('rate'))) {
                const wait = attempt * 5000;
                console.log(`    ⏳ ${provider} rate limited. Wait ${wait/1000}s...`);
                await new Promise(r => setTimeout(r, wait));
            } else {
                console.error(`    ❌ ${provider}: ${error.message.slice(0, 80)}`);
                return null;
            }
        }
    }
    return null;
}

// ─── IMAGE HELPERS ─────────────────────────────────────────────────────────
async function fetchOgImage(link) {
    if (!link) return null;
    try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 5000);
        const opts = { signal: controller.signal, redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }};
        let res = await fetch(link, opts);
        let html = await res.text();
        if (link.includes('news.google.com')) {
            const $g = cheerio.load(html);
            const realUrl = $g('a').attr('href');
            if (realUrl && realUrl.startsWith('http')) {
                res = await fetch(realUrl, opts);
                html = await res.text();
            }
        }
        clearTimeout(tid);
        const $ = cheerio.load(html);
        return $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content') || null;
    } catch(e) { return null; }
}

// ─── FETCH FROM NEWSDATA.IO ────────────────────────────────────────────────
async function fetchTopNews(category) {
    const catMap = {
        general: 'top', technology: 'technology', sports: 'sports',
        business: 'business', entertainment: 'entertainment', science: 'science',
        health: 'health', politics: 'politics'
    };
    const url = `https://newsdata.io/api/1/latest?apikey=${process.env.NEWSDATA_API_KEY}&country=us&language=en&category=${catMap[category]}`;
    try {
        console.log(`  📡 NewsData US: ${category.toUpperCase()}`);
        const res = await fetch(url);
        const data = await res.json();
        if (data.status !== 'success' || !data.results) {
            console.log(`  ⚠️  NewsData returned: ${data.status || 'error'}`);
            return [];
        }
        return data.results
            .filter(item => item.title && item.title.length > 20)
            .map(item => ({
                title: item.title,
                description: item.description || '',
                content: item.content || item.description || '',
                url: item.link,
                urlToImage: item.image_url || null,
                source: { name: item.source_id || 'Unknown' },
                publishedAt: item.pubDate,
            }));
    } catch(e) {
        console.error(`  NewsData failed for ${category}:`, e.message);
        return [];
    }
}

async function fetchGlobalNews() {
    // Fetch world news from major countries
    const countries = ['gb', 'au', 'ca', 'de', 'fr'];
    const countryName = { gb: 'UK', au: 'Australia', ca: 'Canada', de: 'Germany', fr: 'France' };
    const allArticles = [];

    for (const country of countries) {
        const url = `https://newsdata.io/api/1/latest?apikey=${process.env.NEWSDATA_API_KEY}&country=${country}&language=en&category=top`;
        try {
            console.log(`  🌍 Global: ${countryName[country]}`);
            const res = await fetch(url);
            const data = await res.json();
            if (data.status === 'success' && data.results) {
                const articles = data.results
                    .filter(item => item.title && item.title.length > 20)
                    .slice(0, 3) // Top 3 per country
                    .map(item => ({
                        title: item.title,
                        description: item.description || '',
                        content: item.content || item.description || '',
                        url: item.link,
                        urlToImage: item.image_url || null,
                        source: { name: item.source_id || countryName[country] },
                        publishedAt: item.pubDate,
                        isGlobal: true,
                    }));
                allArticles.push(...articles);
            }
            // Small delay between country fetches
            await new Promise(r => setTimeout(r, 500));
        } catch(e) {
            console.error(`  Global failed for ${countryName[country]}:`, e.message);
        }
    }
    return allArticles;
}

// ─── SAVE TO DATABASE ──────────────────────────────────────────────────────
async function saveToDatabase(articles) {
    if (!articles.length) return;
    console.log(`  💾 Saving ${articles.length} articles...`);
    const { error } = await supabase.from('articles').upsert(articles, { onConflict: 'url' });
    if (error) console.error("  DB error:", error.message);
    else console.log("  ✅ Saved!");
}

// ─── CLEANUP ───────────────────────────────────────────────────────────────
async function deleteOldArticles() {
    const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase.from('articles').delete().lt('published_at', cutoff);
    if (error) console.error('Delete failed:', error.message);
    else console.log('🗑️  Cleaned articles older than 72 hours');
}

// ─── SMART TRENDING LOGIC ──────────────────────────────────────────────────
const TIER_1_SOURCES = [
    'reuters', 'associated press', 'ap news', 'bbc', 'cnn', 'nytimes',
    'new york times', 'washington post', 'wall street journal', 'wsj',
    'bloomberg', 'the guardian', 'al jazeera', 'npr', 'abc news',
    'cbs news', 'nbc news', 'fox news', 'politico', 'the hill'
];

const TRENDING_CATEGORIES = ['politics', 'economy', 'tech'];

function calculateTrending(article, aiData) {
    let score = 0;
    
    // 1. Source tier (+40) — top news orgs are more likely to cover trending stories
    const sourceLower = (article.source.name || '').toLowerCase();
    if (TIER_1_SOURCES.some(s => sourceLower.includes(s))) score += 40;
    
    // 2. AI says trending (+30) — AI's judgment still counts
    if (aiData.is_trending) score += 30;
    
    // 3. Category weight (+15) — politics, economy, tech trend more
    if (TRENDING_CATEGORIES.includes(aiData.category.toLowerCase())) score += 15;
    
    // 4. Recency (+25) — articles under 6 hours old get full boost
    const ageHours = (Date.now() - new Date(article.publishedAt).getTime()) / 3600000;
    score += Math.max(0, 25 - (ageHours * 4));
    
    // 5. Has image (+5) — trending stories almost always have images
    if (article.urlToImage) score += 5;
    
    // Threshold: 50+ = trending
    return score >= 50;
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function runPipeline() {
    console.log("🚀 News Flip Pipeline (Gemini + Groq)\n");
    await deleteOldArticles();
    
    const categories = ['general', 'technology', 'sports', 'business', 'entertainment', 'science', 'health', 'politics'];
    let totalOk = 0, totalFail = 0, totalTrending = 0;
    
    // US news by category
    for (const cat of categories) {
        console.log(`\n📂 ${cat.toUpperCase()}`);
        const raw = await fetchTopNews(cat);
        const batch = [];

        for (const article of raw) {
            console.log(`  📰 ${article.title.slice(0, 55)}...`);
            const ai = await summarizeWithAI(article);
            if (ai && ai.summary) {
                let imageUrl = article.urlToImage;
                if (!imageUrl) {
                    console.log(`    🖼️  No image, scraping OG...`);
                    imageUrl = await fetchOgImage(article.url);
                    if (imageUrl) console.log(`    ✅ Found OG image`);
                }
                const isTrending = calculateTrending(article, ai);
                if (isTrending) totalTrending++;
                batch.push({
                    title: article.title, summary: ai.summary,
                    full_text: article.content || "Read more at the source.",
                    source: article.source.name, url: article.url,
                    image_url: imageUrl,
                    category: ai.category.toLowerCase(),
                    is_trending: isTrending,
                    published_at: article.publishedAt,
                    language: 'en'
                });
                totalOk++;
            } else { totalFail++; }
            await new Promise(r => setTimeout(r, 1500));
        }
        if (batch.length) await saveToDatabase(batch);
    }

    // Global / World news
    console.log(`\n🌍 GLOBAL NEWS`);
    const globalRaw = await fetchGlobalNews();
    const globalBatch = [];
    
    for (const article of globalRaw) {
        console.log(`  📰 ${article.title.slice(0, 55)}...`);
        const ai = await summarizeWithAI(article);
        if (ai && ai.summary) {
            let imageUrl = article.urlToImage;
            if (!imageUrl) {
                imageUrl = await fetchOgImage(article.url);
            }
            const isTrending = calculateTrending(article, ai);
            if (isTrending) totalTrending++;
            // Force category to "world" for global articles
            globalBatch.push({
                title: article.title, summary: ai.summary,
                full_text: article.content || "Read more at the source.",
                source: article.source.name, url: article.url,
                image_url: imageUrl,
                category: 'world',
                is_trending: isTrending,
                published_at: article.publishedAt,
                language: 'en'
            });
            totalOk++;
        } else { totalFail++; }
        await new Promise(r => setTimeout(r, 1500));
    }
    if (globalBatch.length) await saveToDatabase(globalBatch);

    console.log(`\n✨ DONE: ${totalOk} saved, ${totalFail} failed, ${totalTrending} trending`);
    console.log(`   AI calls: ${aiCallCount} (Gemini ~${Math.ceil(aiCallCount/2)} + Groq ~${Math.floor(aiCallCount/2)})`);
}

runPipeline();