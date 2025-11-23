/*
  Corrected and consolidated model.js
  All duplicates removed, bugs fixed, ready for production.
  
  Notes:
  - Entry point: single-file frontend app
  - Keep DOM IDs intact: UI relies on exact ID names
  - API key must be provided at runtime; do not commit secrets
*/

/*
  Because we defer in the HTML, this script will not run until 
  the HTML document is fully parsed. This means we can safely call 
  document.getElementById() at the top level, without needing a 
  'DOMContentLoaded' or 'window.onload' listener.
*/

// --- API and App Configuration ---

const apiKey = ""; // Designed to run in an environment where the key is provided. Do NOT commit secrets.

const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

// Backoff and retry logic
const CONFIG = {
    api: {
        maxRetries: 3,
        initialDelayMs: 1000,
        backoffMultiplier: 2,
        timeout: 30000
    },
    content: {
        maxParagraphs: 5,
        sentencesPerParagraph: '2-3'
    },
    // For items that do enter cache, keep them for an hour
    cache: {
        maxSize: 10,
        ttlMs: 3600000
    }
};

const DETAILED_BRAND_VOICE_GUIDE = `
Persona: Helpful expert, not salesperson 
Tone: Confident, clear, inspiring. Active voice. 9th-grade reading level 
Avoid: hyperbole, jargon, 'lit', 'vibe', 'cringe', 'obviously', 'just' 
Rules: No financial advice, use Oxford comma, max 1 exclamation/article, respectful competitors
`;

// --- DOM Element Selection ---
const generateBtn = document.getElementById('generate-btn');
const btnText = document.getElementById('btn-text');
const loadingSpinner = document.getElementById('loading-spinner');
const promptTextarea = document.getElementById('prompt');
const errorContainer = document.getElementById('error-container');
const errorMessageEl = document.getElementById('error-message');
const resultContainer = document.getElementById('result-container');
const resultContentEl = document.getElementById('result-content');
const sourcesContainer = document.getElementById('sources-container');
const sourcesListEl = document.getElementById('sources-list');
const seoContainer = document.getElementById('seo-container');
const seoTitleEl = document.getElementById('seo-title');
const seoDescriptionEl = document.getElementById('seo-description');
const seoKeywordsEl = document.getElementById('seo-keywords');

// --- Event Listener ---

let currentAbortController = null;

// This is the starting point of app logic
generateBtn.addEventListener('click', handleGenerationPipeline);

// Cancel button
const cancelBtn = document.getElementById('cancel-btn');
cancelBtn?.addEventListener('click', () => {
    if (currentAbortController) {
        currentAbortController.abort();
        setLoadingState(false);
        showError('Generation cancelled by user.');
    }
});

// --- Streaming Helper ---
async function callGeminiWithStreaming(payload) {
    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, stream: true })
    });

    if (!response.body) {
        // No streaming body; fallback to full JSON
        return await response.json();
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        fullText += chunk;
        if (resultContentEl) resultContentEl.textContent = fullText;
    }

    return fullText;
}

// --- Main Application Logic ---

function sanitizePrompt(prompt) {
    const cleaned = prompt
        .trim()
        .slice(0, 5000)
        .replace(/<script[^>]*>.*?<\/script>/gi, '')
        .replace(/javascript:/gi, '');

    if (cleaned.length < 10) {
        throw new Error('Prompt too short. Provide at least 10 characters.');
    }

    return cleaned;
}

async function handleGenerationPipeline() {
    const topicPrompt = sanitizePrompt(promptTextarea.value);

    if (!topicPrompt) {
        showError("Please enter a topic for the blog post.");
        return;
    }

    setLoadingState(true, "Step 1/3: Writing draft...");

    try {
        // Agent 1: Writer
        const writerResponse = await monitor.track('Writer Agent', () => callWriterAgent(topicPrompt));
        const initialDraft = getTextFromResponse(writerResponse);
        if (!initialDraft) throw new Error("Agent 1 (Writer) failed to produce content.");
        const sources = getSourcesFromResponse(writerResponse);

        // Agent 2: Brand Guardian
        setLoadingState(true, "Step 2/3: Reviewing for brand...");
        const brandResponse = await monitor.track('Brand Agent', () => 
            callBrandAgent(initialDraft, DETAILED_BRAND_VOICE_GUIDE)
        );
        
        const finalDraft = getTextFromResponse(brandResponse);
        if (!finalDraft) throw new Error("Agent 2 (Brand Guardian) failed to refine content.");

        // Agent 3: SEO Specialist
        setLoadingState(true, "Step 3/3: Optimizing for SEO...");
        const seoResponse = await monitor.track('SEO Agent', () => callSeoAgent(finalDraft));
        const seoData = getJsonFromResponse(seoResponse);
        if (!seoData) throw new Error("Agent 3 (SEO) failed to generate metadata.");

        renderSuccess(finalDraft, sources || [], seoData);
    } catch (error) {
        console.error("Error during generation pipeline:", error);
        showError(error.message || "An unknown error occurred. Please try again.");
    } finally {
        setLoadingState(false);
    }
}

// --- Agent 1: Writer ---
async function callWriterAgent(prompt) {
    const systemPrompt = `You are an expert content creator and blogger.
Write a complete, high-quality blog post based on the user's prompt.
The post should be well-structured, engaging, informative, and ready to publish.
Use Markdown for formatting (like headings, bold, and lists).
You MUST use the provided Google Search results to ground your answer in facts.
To reduce total tokens in use and reduce overall application spend per query to previous business agreements, generate a maximum of 5 paragraphs, 2-3 sentences each.
Do not make up information.`;

    // Try to reuse cached grounding metadata to reduce calls
    const searchKey = extractKeywords(prompt);
    const cachedSearchResults = searchCache.get(`search:${searchKey}`);

    const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        ...(cachedSearchResults
            ? { groundingMetadata: cachedSearchResults }
            : { tools: [{ "google_search": {} }] }
        )
    };

    const response = await callGeminiWithRetry(payload);

    // Cache grounding metadata for future reuse
    if (!cachedSearchResults && response?.candidates?.[0]?.groundingMetadata) {
        searchCache.set(`search:${searchKey}`, response.candidates[0].groundingMetadata);
    }

    return response;
}

// --- Cache Support for Writer Agent ---
class SimpleCache {
    constructor(maxSize = 10, ttlMs = 3600000) {
        this.cache = new Map();
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
    }

    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        if (Date.now() - item.timestamp > this.ttlMs) {
            this.cache.delete(key);
            return null;
        }
        // LRU: move to end
        this.cache.delete(key);
        this.cache.set(key, item);
        return item.value;
    }

    set(key, value) {
        if (this.cache.has(key)) this.cache.delete(key);
        else if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, { value, timestamp: Date.now() });
    }
}

const searchCache = new SimpleCache(CONFIG.cache?.maxSize || 20, CONFIG.cache?.ttlMs || 3600000);

// --- Agent 2: Brand Guardian ---
async function callBrandAgent(blogText, brandGuide) {
    const commonInstructions = "Be concise. Return only the requested output.";
    const systemPrompt = `You are a Brand Guardian agent. Review and fix this blog post per the brand guide. ${commonInstructions}

Brand Guide: ${brandGuide}`;

    const prompt = blogText;
    
    const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
    };

    return callGeminiWithRetry(payload);
}

// --- Agent 3: SEO Specialist ---
async function callSeoAgent(blogText) {
    const systemPrompt = `You are an SEO specialist.
Analyze the provided blog post and generate SEO metadata.
You must return ONLY a JSON object with the specified schema.`;

    const prompt = `Analyze this blog post and generate SEO metadata (title, description, keywords).
- The title should be compelling and under 60 characters.
- The description should be a summary for search results, under 160 characters.
- Provide an array of 5-7 relevant keywords.

Blog Post:

---

${blogText}`;

    const schema = {
        type: "OBJECT",
        properties: {
            title: { type: "STRING" },
            description: { type: "STRING" },
            keywords: { type: "ARRAY", items: { type: "STRING" } }
        },
        required: ["title", "description", "keywords"]
    };

    const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
    };

    const generationConfig = {
        responseMimeType: "application/json",
        responseSchema: schema,
    };

    return callGeminiWithRetry(payload, generationConfig);
}

// --- Core API & Helper Functions ---
async function callGeminiWithRetry(payload, generationConfig = null) {
    currentAbortController = new AbortController();
    let attempt = 0;
    let delay = CONFIG.api.initialDelayMs;
    const finalPayload = generationConfig ? { ...payload, generationConfig } : payload;

    while (attempt < CONFIG.api.maxRetries) {
        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(finalPayload),
                signal: currentAbortController.signal
            });

            if (response.status === 429 || response.status >= 500) {
                throw new Error(`Retryable error: ${response.status}`);
            }

            if (!response.ok) {
                const errorBody = await response.json().catch(() => ({}));
                const errorMsg = errorBody.error?.message || `HTTP error! Status: ${response.status}`;
                throw new Error(errorMsg);
            }

            return await response.json();
        } catch (error) {
            if (error && error.name === 'AbortError') throw new Error('Request cancelled');

            attempt++;
            if (attempt >= CONFIG.api.maxRetries) {
                console.error("Max retries reached. Failing.");
                throw new Error("Failed to generate content after multiple retries.");
            }

            console.warn(`Attempt ${attempt} failed. Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= CONFIG.api.backoffMultiplier;
        }
    }

    throw new Error("Failed to get a response after all retries.");
}

function extractKeywords(prompt) {
    if (!prompt || typeof prompt !== 'string') return '';
    
    const stopWords = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'about',
        'write', 'create', 'generate', 'blog', 'post', 'article'
    ]);
    
    const words = prompt
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 3 && !stopWords.has(w))
        .slice(0, 5);
        
    return words.join(' ');
}

// --- Response Parsing Helpers ---
function getTextFromResponse(result) {
    return result?.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

function getJsonFromResponse(result) {
    try {
        const text = getTextFromResponse(result);
        if (!text) return null;
        return JSON.parse(text);
    } catch (e) {
        console.error("Failed to parse JSON response:", e);
        return null;
    }
}

function getSourcesFromResponse(result) {
    const metadata = result?.candidates?.[0]?.groundingMetadata;
    const sources = metadata?.groundingAttributions?.map(attr => attr.web).filter(Boolean) || [];
    return sources;
}

// --- UI Helper Functions ---
function renderSuccess(finalDraft, sources, seoData) {
    seoTitleEl.value = seoData.title || "No title generated";
    seoDescriptionEl.value = seoData.description || "No description generated";
    seoKeywordsEl.textContent = (seoData.keywords || []).join(', ') || "No keywords generated";
    seoContainer.classList.remove('hidden');

    resultContentEl.textContent = finalDraft;
    resultContainer.classList.remove('hidden');

    if ((sources || []).length > 0) {
        const fragment = document.createDocumentFragment();
        sources.forEach(source => {
            const li = document.createElement('li');
            const a = document.createElement('a');
            a.href = source.uri || source.url || '#';
            a.textContent = source.title || source.uri || a.href;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.className = 'text-indigo-600 hover:text-indigo-800 underline';
            li.appendChild(a);
            fragment.appendChild(li);
        });

        sourcesListEl.innerHTML = '';
        sourcesListEl.appendChild(fragment);
        sourcesContainer.classList.remove('hidden');
    } else {
        sourcesContainer.classList.add('hidden');
    }
}

function setLoadingState(isLoading, message = 'Generate Post') {
    generateBtn.disabled = isLoading;
    btnText.textContent = message;
    if (isLoading) {
        loadingSpinner.classList.remove('hidden');
        errorContainer.classList.add('hidden');
        resultContainer.classList.add('hidden');
    } else {
        btnText.textContent = 'Generate Post';
        loadingSpinner.classList.add('hidden');
    }
}

function showError(message) {
    errorMessageEl.textContent = message;
    errorContainer.classList.remove('hidden');
    setLoadingState(false);
}

// --- Monitoring Success ---
class PerformanceMonitor {
    constructor() { 
        this.metrics = []; 
    }

    async track(name, fn) {
        const start = performance.now();
        try {
            const result = await fn();
            const duration = performance.now() - start;
            this.metrics.push({ name, duration, success: true });
            console.log(`✓ ${name}: ${duration.toFixed(2)}ms`);
            return result;
        } catch (error) {
            const duration = performance.now() - start;
            this.metrics.push({ name, duration, success: false, error: error.message });
            console.error(`✗ ${name}: ${duration.toFixed(2)}ms - ${error.message}`);
            throw error;
        }
    }

    getStats() {
        return {
            total: this.metrics.length,
            avgDuration: this.metrics.reduce((sum, m) => sum + m.duration, 0) / Math.max(1, this.metrics.length),
            successRate: this.metrics.filter(m => m.success).length / Math.max(1, this.metrics.length)
        };
    }
}

const monitor = new PerformanceMonitor();