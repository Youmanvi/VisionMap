// Mark that content script is loaded
window.timelineExtractorLoaded = true;

// Content extraction cache
let contentCache = {
  url: null,
  content: null,
  timestamp: null
};

// Listen for content extraction requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getPageContent") {
    try {
      console.log('Content script: Extracting page content');
      
      const currentUrl = window.location.href;
      const now = Date.now();
      
      // Use cache if same URL and less than 5 minutes old
      if (contentCache.url === currentUrl && 
          contentCache.content && 
          contentCache.timestamp && 
          (now - contentCache.timestamp) < 300000) {
        console.log('Content script: Using cached content');
        sendResponse({
          title: document.title || "Untitled Page",
          url: currentUrl,
          content: contentCache.content,
          contentLength: contentCache.content.length,
          cached: true
        });
        return true;
      }
      
      // Extract fresh content
      const pageContent = extractPageContent();
      const pageTitle = document.title || "Untitled Page";
      
      // Update cache
      contentCache = {
        url: currentUrl,
        content: pageContent,
        timestamp: now
      };
      
      console.log(`Content script: Extracted ${pageContent.length} characters`);
      
      const response = {
        title: pageTitle,
        url: currentUrl,
        content: pageContent,
        contentLength: pageContent.length,
        cached: false
      };
      
      sendResponse(response);
      
    } catch (error) {
      console.error('Content extraction error:', error);
      sendResponse({
        error: `Content extraction failed: ${error.message}`,
        title: document.title || "Error",
        url: window.location.href,
        content: "",
        contentLength: 0
      });
    }
    
    return true; // Keep message channel open
  }
});

// Efficient content extraction
function extractPageContent() {
  // Priority selectors for different site types
  const contentSelectors = [
    // Wikipedia and wikis
    '.mw-parser-output',
    '.mw-content-text',
    
    // News sites
    '.article-body',
    '.story-body',
    '.entry-content',
    '.post-content',
    '.article-content',
    '.content-body',
    
    // Academic papers
    '.paper-body',
    '.abstract',
    '.full-text',
    
    // Blogs and general content
    'main article',
    'main',
    'article',
    '[role="main"]',
    '.main-content',
    '.content',
    '#content',
    '.post',
    '.entry'
  ];
  
  let bestContent = '';
  let bestScore = 0;
  
  // Try each selector and score the content
  for (const selector of contentSelectors) {
    try {
      const elements = document.querySelectorAll(selector);
      
      for (const element of elements) {
        if (!element) continue;
        
        const content = extractTextFromElement(element);
        const score = scoreContent(content);
        
        if (score > bestScore) {
          bestContent = content;
          bestScore = score;
        }
      }
    } catch (e) {
      // Skip failed selectors
      continue;
    }
  }
  
  // Fallback to body if no good content found
  if (bestScore < 100) {
    const bodyContent = extractTextFromElement(document.body);
    const bodyScore = scoreContent(bodyContent);
    
    if (bodyScore > bestScore) {
      bestContent = bodyContent;
    }
  }
  
  return bestContent || "No content could be extracted from this page";
}

// Extract clean text from a DOM element
function extractTextFromElement(element) {
  if (!element) return '';
  
  // Clone to avoid modifying original
  const clone = element.cloneNode(true);
  
  // Remove unwanted elements
  const unwantedSelectors = [
    // Scripts and styles
    'script', 'style', 'noscript',
    
    // Navigation
    'nav', 'header', 'footer', '.navigation', '.nav', '.menu',
    '.breadcrumb', '.pagination',
    
    // Ads and social
    '.ad', '.ads', '.advertisement', '.social-share', '.share-buttons',
    '.newsletter', '.subscription', '.popup', '.modal',
    
    // Comments and metadata
    '.comments', '.comment', '.comment-section',
    '.metadata', '.byline', '.tags', '.categories',
    
    // Sidebars and related content
    '.sidebar', '.related', '.recommended', '.more-articles',
    '[role="complementary"]', '[role="banner"]', '[role="contentinfo"]'
  ];
  
  // Remove unwanted elements
  unwantedSelectors.forEach(selector => {
    try {
      const elements = clone.querySelectorAll(selector);
      elements.forEach(el => el.remove());
    } catch (e) {
      // Skip if selector fails
    }
  });
  
  // Get text content
  const text = clone.innerText || clone.textContent || '';
  
  // Clean and return
  return cleanExtractedText(text);
}

// Clean extracted text
function cleanExtractedText(text) {
  if (!text) return '';
  
  return text
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    
    // Remove common navigation patterns
    .replace(/\b(Home|About|Contact|Menu|Search|Login|Sign up|Subscribe|Follow us)\b/gi, ' ')
    
    // Remove copyright and legal text
    .replace(/\b(Copyright|©|All rights reserved|Terms of Service|Privacy Policy).*$/gm, '')
    
    // Remove URLs and emails
    .replace(/https?:\/\/[^\s]+/g, ' ')
    .replace(/\S+@\S+\.\S+/g, ' ')
    
    // Remove excessive punctuation
    .replace(/[^\w\s\.,;:!?\-()\/'"]/g, ' ')
    
    // Clean up extra spaces
    .replace(/\s+/g, ' ')
    .trim();
}

// Score content quality for timeline extraction
function scoreContent(text) {
  if (!text) return 0;
  
  let score = text.length * 0.1; // Base score from length
  
  // Bonus for date patterns (key for timeline extraction)
  const datePatterns = [
    /\b(19|20)\d{2}\b/g, // Years
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+(19|20)\d{2}\b/gi, // Full dates
    /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/g // Numeric dates
  ];
  
  datePatterns.forEach(pattern => {
    const matches = text.match(pattern);
    if (matches) {
      score += matches.length * 20; // Big bonus for dates
    }
  });
  
  // Bonus for historical/timeline keywords
  const timelineKeywords = [
    /\b(history|historical|timeline|chronology|events|occurred|happened|began|started|ended|founded|established|created|built|died|born|elected|war|battle|treaty|revolution|independence)\b/gi
  ];
  
  timelineKeywords.forEach(pattern => {
    const matches = text.match(pattern);
    if (matches) {
      score += matches.length * 5;
    }
  });
  
  // Penalty for navigation-heavy content
  const navigationKeywords = [
    /\b(click here|read more|continue reading|next page|previous page|menu|navigation)\b/gi
  ];
  
  navigationKeywords.forEach(pattern => {
    const matches = text.match(pattern);
    if (matches) {
      score -= matches.length * 10;
    }
  });
  
  return Math.max(0, score);
}

// Clear cache when page changes
let currentUrl = window.location.href;
const observer = new MutationObserver(() => {
  if (window.location.href !== currentUrl) {
    contentCache = { url: null, content: null, timestamp: null };
    currentUrl = window.location.href;
    console.log('Content script: Page changed, cache cleared');
  }
});

// Start observing for SPA navigation
observer.observe(document, { 
  subtree: true, 
  childList: true, 
  attributes: false 
});

console.log('Timeline Extractor content script loaded:', window.location.href);