// Get references to HTML elements
const extractBtn = document.getElementById('extractBtn');
const statusDiv = document.getElementById('status');
const timelineDiv = document.getElementById('timeline');
const viewAllBtn = document.getElementById('viewAllBtn');

// Cache for processed results
let processedEvents = [];
let aiSession = null;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
  await checkAIAvailability();
  
  // Add event listener for view all button
  if (viewAllBtn) {
    viewAllBtn.addEventListener('click', () => {
      // You can implement this to show more events or open a full view
      console.log('View all clicked - implement as needed');
    });
  }
});

// Check if Chrome AI APIs are available
async function checkAIAvailability() {
  try {
    // Check if LanguageModel is available (the correct API)
    if (!('LanguageModel' in self)) {
      throw new Error('LanguageModel API not available. Please enable chrome://flags/#prompt-api-for-gemini-nano and restart Chrome.');
    }

    console.log('LanguageModel API detected');
    
    // Check availability (this is the correct method according to the docs)
    const available = await LanguageModel.availability();
    console.log('LanguageModel availability:', available);
    
    if (available === 'unavailable') {
      throw new Error('LanguageModel is unavailable on this device/browser');
    } else if (available === 'downloadable') {
      showStatus('AI model needs to be downloaded. Click Extract to start download.', 'loading');
      extractBtn.disabled = false; // Allow user to trigger download
    } else if (available === 'downloading') {
      showStatus('AI model is downloading... Please wait and try again in a few minutes.', 'loading');
      // Check periodically if download completes
      const checkInterval = setInterval(async () => {
        try {
          const newAvailability = await LanguageModel.availability();
          if (newAvailability === 'available') {
            clearInterval(checkInterval);
            showStatus('AI model ready!', 'success');
            extractBtn.disabled = false;
          }
        } catch (e) {
          console.warn('Error checking availability:', e);
        }
      }, 10000); // Check every 10 seconds
    } else if (available === 'available') {
      showStatus('AI ready for timeline extraction', 'success');
      extractBtn.disabled = false;
    }
    
  } catch (error) {
    console.error('AI availability check failed:', error);
    showStatus(`AI Error: ${error.message}`, 'error');
    extractBtn.disabled = true;
  }
}

// When extract button is clicked
extractBtn.addEventListener('click', async () => {
  await extractTimeline();
});

async function extractTimeline() {
  try {
    showStatus('Extracting page content...', 'loading');
    extractBtn.disabled = true;
    
    // Step 1: Get page content
    const pageData = await getPageContent();
    console.log(`Got page content: ${pageData.contentLength} characters`);
    
    // Step 2: Find date matches
    showStatus('Finding date patterns...', 'loading');
    const dateMatches = extractPreciseDateMatches(pageData.content);
    
    console.log(`Found ${dateMatches.length} date matches`);
    
    if (dateMatches.length === 0) {
      throw new Error('No date patterns found in the content. Try a page with historical information, news articles, or biographical content.');
    }
    
    // Step 3: Create AI session
    showStatus('Creating AI session...', 'loading');
    await createAISession();
    
    // Step 4: Process matches with AI
    const events = await processPreciseMatches(dateMatches, pageData.title);
    
    // Step 5: Display results
    processedEvents = events;
    displayTimeline(events);
    showStatus(`Successfully extracted ${events.length} timeline events!`, 'success');
    
  } catch (error) {
    console.error('Timeline extraction error:', error);
    showStatus(`Error: ${error.message}`, 'error');
    
    // Display empty timeline with error message
    displayTimeline([]);
  } finally {
    extractBtn.disabled = false;
    // Clean up AI session
    if (aiSession) {
      try {
        aiSession.destroy();
        aiSession = null;
        console.log('AI session destroyed');
      } catch (e) {
        console.warn('Error destroying AI session:', e);
      }
    }
  }
}

// Create AI session
async function createAISession() {
  try {
    if (aiSession) {
      aiSession.destroy();
    }
    
    // Check availability first (required according to docs)
    const available = await LanguageModel.availability();
    console.log('Current availability:', available);
    
    if (available === 'unavailable') {
      throw new Error('LanguageModel is unavailable');
    }
    
    if (available === 'downloadable' || available === 'downloading') {
      throw new Error('LanguageModel is not ready yet. Please wait for download to complete.');
    }
    
    if (available !== 'available') {
      throw new Error(`LanguageModel status: ${available}`);
    }
    
    // Get parameters for session creation
    const params = await LanguageModel.params();
    console.log('LanguageModel params:', params);
    
    // Create session using the correct LanguageModel API
    aiSession = await LanguageModel.create({
      temperature: params.defaultTemperature || 1.0,
      topK: params.defaultTopK || 3,
      initialPrompts: [
        {
          role: 'system',
          content: 'You are a helpful assistant that extracts timeline events from text. Always respond with valid JSON arrays containing date, title, and description fields.'
        }
      ]
    });
    
    console.log('LanguageModel session created successfully');
    
  } catch (error) {
    console.error('Failed to create AI session:', error);
    throw new Error(`AI session creation failed: ${error.message}`);
  }
}

// Get content from current webpage with retry logic
async function getPageContent() {
  const maxRetries = 3;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Getting page content (attempt ${attempt}/${maxRetries})`);
      const pageData = await attemptGetPageContent();
      console.log('Successfully got page content:', pageData.title);
      return pageData;
    } catch (error) {
      console.warn(`Attempt ${attempt} failed:`, error.message);
      lastError = error;
      
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  
  throw new Error(`Failed to get page content: ${lastError.message}`);
}

// Single attempt to get page content
function attemptGetPageContent() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Request timed out after 10 seconds'));
    }, 10000);
    
    chrome.runtime.sendMessage(
      { type: "getPageContent" },
      (response) => {
        clearTimeout(timeout);
        
        if (chrome.runtime.lastError) {
          reject(new Error(`Chrome runtime error: ${chrome.runtime.lastError.message}`));
          return;
        }
        
        if (!response) {
          reject(new Error('No response received from background script'));
          return;
        }
        
        if (response.error) {
          reject(new Error(response.error));
          return;
        }
        
        if (!response.content || response.content.trim().length === 0) {
          reject(new Error('No content extracted from the page'));
          return;
        }
        
        resolve(response);
      }
    );
  });
}

// Extract precise date matches with context
function extractPreciseDateMatches(content) {
  const matches = [];
  const seen = new Set();
  
  // More comprehensive patterns for historical content
  const datePatterns = [
    // Ancient dates with AD/BC/CE/BCE - highest priority
    {
      regex: /\b(\d{1,4})\s*(AD|CE|BC|BCE)\b/gi,
      type: 'ancient_date',
      priority: 1
    },
    // Full dates with months and ancient eras
    {
      regex: /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{1,4})\s*(AD|CE|BC|BCE)\b/gi,
      type: 'full_date_ancient',
      priority: 1
    },
    // Short month dates with ancient eras
    {
      regex: /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2}),?\s+(\d{1,4})\s*(AD|CE|BC|BCE)\b/gi,
      type: 'short_date_ancient',
      priority: 1
    },
    // Years in historical context
    {
      regex: /\b(in|during|around|circa|about|year|from|until|by)\s+(\d{1,4})\s*(AD|CE|BC|BCE)\b/gi,
      type: 'year_context_ancient',
      priority: 1
    },
    // Standalone ancient years (be more permissive for historical sites)
    {
      regex: /\b([1-9]\d{0,3})\s*(AD|CE|BC|BCE)\b/gi,
      type: 'standalone_ancient',
      priority: 1
    },
    // Ranges like "79-81 AD" or "62–79 AD"
    {
      regex: /\b(\d{1,4})[-–—](\d{1,4})\s*(AD|CE|BC|BCE)\b/gi,
      type: 'date_range_ancient',
      priority: 1
    },
    // Modern dates for archaeological context
    {
      regex: /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(19|20)\d{2}\b/gi,
      type: 'full_date_modern',
      priority: 3
    },
    // Years with clear archaeological/historical context
    {
      regex: /\b(excavat|discover|found|uncover|research|stud)\w*\s+.*?(\d{4})\b/gi,
      type: 'archaeological_context',
      priority: 3
    },
    // Roman numerals for centuries
    {
      regex: /\b(\d{1,2})(st|nd|rd|th)\s+century\s*(AD|CE|BC|BCE)\b/gi,
      type: 'century_ancient',
      priority: 2
    },
    // Numeric dates that might be ancient (more permissive)
    {
      regex: /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{1,4})\s*(AD|CE|BC|BCE)?\b/g,
      type: 'numeric_date',
      priority: 4
    }
  ];
  
  // Process each pattern
  datePatterns.forEach(pattern => {
    const patternMatches = [...content.matchAll(pattern.regex)];
    console.log(`Pattern ${pattern.type} found ${patternMatches.length} matches`);
    
    patternMatches.forEach(match => {
      const dateText = match[0];
      const startPos = match.index;
      const endPos = startPos + dateText.length;
      
      // Get more context around the match
      const contextStart = Math.max(0, startPos - 250);
      const contextEnd = Math.min(content.length, endPos + 250);
      const context = content.substring(contextStart, contextEnd);
      
      // Create unique key to avoid duplicates
      const contextKey = `${dateText}-${context.substring(0, 80)}`.toLowerCase().replace(/\s+/g, '');
      
      if (seen.has(contextKey)) return;
      seen.add(contextKey);
      
      // More permissive validation for historical content
      if (isValidHistoricalDateMatch(context, dateText, pattern.type)) {
        matches.push({
          dateText: dateText,
          context: context.trim(),
          type: pattern.type,
          priority: pattern.priority,
          position: startPos
        });
      }
    });
  });
  
  console.log(`Total valid matches found: ${matches.length}`);
  
  // Sort by priority and limit results
  return matches
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.position - b.position;
    })
    .slice(0, 18); // Increase to 18 matches for more events
}

// More permissive validation for historical content
function isValidHistoricalDateMatch(context, dateText, type) {
  const lowContext = context.toLowerCase();
  
  // Skip obvious navigation and metadata
  const skipPatterns = [
    'copyright', 'all rights reserved', 'terms of service', 'privacy policy',
    'home', 'about', 'contact', 'menu', 'search', 'login', 'sign up',
    'isbn', 'doi:', 'http://', 'https://', 'www.', '.com', '.org',
    'retrieved on', 'accessed', 'cite web', 'citation needed'
  ];
  
  if (skipPatterns.some(pattern => lowContext.includes(pattern))) {
    return false;
  }
  
  // For ancient dates (AD/BC), be very permissive - they're almost always relevant
  if (type.includes('ancient') || dateText.match(/\b(AD|CE|BC|BCE)\b/i)) {
    // Just need some substantial context
    return context.trim().length > 40;
  }
  
  // For archaeological dates, look for discovery/research context
  if (type === 'archaeological_context') {
    const archaeoWords = [
      'excavat', 'discover', 'found', 'uncover', 'research', 'study', 
      'investigation', 'restoration', 'conservation', 'archaeological'
    ];
    return archaeoWords.some(word => lowContext.includes(word)) && context.trim().length > 50;
  }
  
  // For modern dates, be more selective but not too restrictive
  if (dateText.match(/^(19|20)\d{2}$/)) {
    const relevantWords = [
      'discovery', 'excavation', 'found', 'uncovered', 'archaeological',
      'research', 'study', 'investigation', 'restoration', 'conservation',
      'unesco', 'world heritage', 'site', 'monument', 'artifact', 'ruins'
    ];
    return relevantWords.some(word => lowContext.includes(word)) && context.trim().length > 60;
  }
  
  // Default: need substantial context
  return context.trim().length > 50;
}

// Process matches with AI in small batches
async function processPreciseMatches(matches, pageTitle) {
  const allEvents = [];
  const batchSize = 4; // Slightly larger batches since we want more results
  
  console.log(`Processing ${matches.length} date matches in batches of ${batchSize}`);
  
  for (let i = 0; i < matches.length; i += batchSize) {
    const batch = matches.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(matches.length / batchSize);
    
    showStatus(`Processing events ${i + 1}-${Math.min(i + batchSize, matches.length)} of ${matches.length}...`, 'loading');
    
    try {
      const events = await processSmallBatch(batch, pageTitle);
      console.log(`Batch ${batchNum}/${totalBatches} produced ${events.length} events`);
      
      if (events.length > 0) {
        allEvents.push(...events);
        console.log(`Total events so far: ${allEvents.length}`);
      }
      
      // Very small delay between batches for responsiveness
      if (i + batchSize < matches.length) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      
    } catch (error) {
      console.warn(`Batch ${batchNum} failed:`, error);
      // Continue processing other batches
    }
  }
  
  console.log(`Total events extracted: ${allEvents.length}`);
  return deduplicateAndSort(allEvents);
}

// Process a small batch with AI
async function processSmallBatch(matches, pageTitle) {
  if (!aiSession) {
    throw new Error('AI session not available');
  }
  
  try {
    // Create focused prompt for historical content
    const contextBlocks = matches.map((match, index) => {
      return `[${index + 1}] Original: "${match.dateText}" | Context: "${match.context.substring(0, 150)}..."`;
    }).join('\n\n');
    
    const prompt = `You are analyzing historical content from "${pageTitle}". Extract timeline events from these date patterns, being very careful about historical accuracy.

CRITICAL INSTRUCTIONS:
- For ancient dates (like "79 AD", "62 BC"), preserve the era (AD/BC/CE/BCE)
- For BC dates, use negative ISO years: 79 BC becomes "-0079-08-24"  
- For AD dates before year 1000, use proper ISO: 79 AD becomes "0079-08-24"
- When you see a year like "79" in Pompeii context, it likely means "79 AD" (the famous eruption)
- Create events for EACH date pattern provided - don't skip any unless clearly irrelevant
- Use specific dates when mentioned, otherwise reasonable defaults (August 24 for Vesuvius, etc.)
- Include both ancient events AND modern archaeological discoveries
- Be generous - extract as many relevant historical events as possible

Date patterns found:
${contextBlocks}

Examples of correct formatting:
- "79 AD" (Vesuvius eruption) → {"date": "0079-08-24", "title": "Mount Vesuvius Erupts", "description": "Volcanic eruption destroys Pompeii and Herculaneum"}
- "62 AD" (earthquake) → {"date": "0062-02-05", "title": "Major Earthquake", "description": "Earthquake damages buildings in Pompeii"}  
- "1748" (excavation) → {"date": "1748-03-23", "title": "Pompeii Rediscovered", "description": "First systematic excavations begin"}
- "200 BC" → {"date": "-0200-01-01", "title": "Samnite Period", "description": "Pompeii under Samnite control"}

Try to extract an event for each date pattern. Respond with valid JSON array only:
[{"date": "YYYY-MM-DD", "title": "Event title", "description": "Brief description"}]`;

    console.log('Sending historical prompt to LanguageModel...');
    
    // Use non-streaming for more reliable JSON parsing
    const result = await aiSession.prompt(prompt);
    
    console.log('AI response received, parsing...');
    return parseAIResponse(result);
    
  } catch (error) {
    console.error('AI processing failed:', error);
    throw error;
  }
}

// Parse AI response with robust error handling
function parseAIResponse(response) {
  try {
    // Clean response
    let clean = response.trim();
    
    // Remove markdown code blocks
    clean = clean.replace(/```json\s*/gi, '').replace(/```\s*$/g, '');
    clean = clean.replace(/```/g, '');
    
    // Find JSON array
    const start = clean.indexOf('[');
    const end = clean.lastIndexOf(']') + 1;
    
    if (start === -1 || end <= start) {
      console.warn('No JSON array found in response');
      return [];
    }
    
    const jsonStr = clean.substring(start, end);
    console.log('Parsing JSON:', jsonStr.substring(0, 200) + '...');
    
    const events = JSON.parse(jsonStr);
    
    if (!Array.isArray(events)) {
      console.warn('Response is not an array');
      return [];
    }
    
    // Validate and clean events
    return events
      .filter(event => {
        if (!event.date || !event.title) {
          console.warn('Event missing required fields:', event);
          return false;
        }
        
        // Basic date validation
        if (event.date.startsWith('-')) {
          // BC date
          const yearPart = event.date.substring(1).split('-')[0];
          if (isNaN(parseInt(yearPart))) return false;
        } else {
          const testDate = new Date(event.date);
          if (isNaN(testDate.getTime())) {
            console.warn('Invalid date format:', event.date);
            return false;
          }
        }
        
        return true;
      })
      .map(event => ({
        date: event.date,
        title: event.title.substring(0, 80).trim(),
        description: (event.description || event.title).substring(0, 150).trim(),
        source: 'ai'
      }));
      
  } catch (error) {
    console.error('Failed to parse AI response:', error);
    console.log('Raw response:', response.substring(0, 500));
    return [];
  }
}

// Remove duplicates and sort chronologically
function deduplicateAndSort(events) {
  const uniqueEvents = [];
  const seen = new Set();
  
  events.forEach(event => {
    const key = `${event.date}-${event.title.substring(0, 20).toLowerCase().replace(/\s+/g, '')}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueEvents.push(event);
    }
  });
  
  // Sort chronologically
  return uniqueEvents.sort((a, b) => {
    // Handle BC dates
    if (a.date.startsWith('-') && !b.date.startsWith('-')) return -1;
    if (!a.date.startsWith('-') && b.date.startsWith('-')) return 1;
    
    if (a.date.startsWith('-') && b.date.startsWith('-')) {
      return a.date.localeCompare(b.date);
    }
    
    return new Date(a.date) - new Date(b.date);
  });
}

// Display timeline with new card-based styling
function displayTimeline(events) {
  const timelineDiv = document.getElementById('timeline');
  
  if (!events || events.length === 0) {
    timelineDiv.innerHTML = `
      <div class="timeline-line"></div>
      <div class="empty-state">
        <div class="icon">📅</div>
        <h3>No Timeline Events Found</h3>
        <p>Try a page with historical content, news articles, or biographical information.</p>
      </div>
    `;
    return;
  }
  
  let html = '<div class="timeline-line"></div>';
  
  events.forEach((event, index) => {
    const formattedDate = formatDate(event.date);
    const eventType = determineEventType(event);
    
    html += `
      <div class="timeline-item">
        <div class="timeline-dot ${eventType}"></div>
        <div class="timeline-card ${eventType}" onclick="toggleEventDetails(${index})">
          <div class="card-header">
            <div class="card-content">
              <div class="card-title">${escapeHtml(event.title)}</div>
              <div class="card-description">${escapeHtml(event.description.substring(0, 60))}${event.description.length > 60 ? '...' : ''}</div>
              <div class="card-timestamp">${formattedDate}</div>
            </div>
            <svg class="chevron" id="chevron-${index}" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>
            </svg>
          </div>
          <div class="card-details" id="details-${index}" style="display: none;">
            <p>${escapeHtml(event.description)}</p>
            <div style="margin-top: 0.5rem; font-size: 0.75rem; color: var(--muted-foreground);">
              🤖 Generated by AI • Click to collapse
            </div>
          </div>
        </div>
      </div>
    `;
  });
  
  timelineDiv.innerHTML = html;
}

// Determine event type for styling
function determineEventType(event) {
  const title = event.title.toLowerCase();
  const desc = event.description.toLowerCase();
  
  if (title.includes('search') || title.includes('research') || title.includes('query') || desc.includes('database')) {
    return 'search';
  }
  if (title.includes('visit') || title.includes('site') || desc.includes('location') || desc.includes('place')) {
    return 'location';
  }
  if (title.includes('document') || title.includes('manuscript') || title.includes('analysis') || desc.includes('papers')) {
    return 'document';
  }
  return 'activity';
}

// Toggle event details with chevron animation
function toggleEventDetails(index) {
  const details = document.getElementById(`details-${index}`);
  const chevron = document.getElementById(`chevron-${index}`);
  
  if (details && chevron) {
    if (details.style.display === 'none') {
      details.style.display = 'block';
      chevron.classList.add('expanded');
    } else {
      details.style.display = 'none';
      chevron.classList.remove('expanded');
    }
  }
}

// Make function globally accessible
window.toggleEventDetails = toggleEventDetails;

// Format dates including BC dates
function formatDate(dateString) {
  try {
    if (dateString.startsWith('-')) {
      const parts = dateString.substring(1).split('-');
      const year = parseInt(parts[0]);
      const month = parseInt(parts[1]) || 1;
      const day = parseInt(parts[2]) || 1;
      
      if (month === 1 && day === 1) {
        return `${year} BC`;
      }
      
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                         'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${monthNames[month - 1]} ${day}, ${year} BC`;
    }
    
    const date = new Date(dateString);
    if (isNaN(date)) return dateString;
    
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch (e) {
    return dateString;
  }
}

// Show status messages
function showStatus(message, type) {
  statusDiv.textContent = message;
  statusDiv.className = `status ${type}`;
  statusDiv.style.display = 'block';
  
  if (type === 'success') {
    setTimeout(() => {
      statusDiv.style.display = 'none';
    }, 4000);
  }
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}