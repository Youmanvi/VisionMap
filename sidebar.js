// Get references to HTML elements
const extractBtn = document.getElementById('extractBtn');
const statusDiv = document.getElementById('status');
const timelineDiv = document.getElementById('timeline');

// Cache for processed results
let processedEvents = [];
let aiSession = null;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
  await checkAIAvailability();
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
    
    // Create session using the correct LanguageModel API
    aiSession = await LanguageModel.create({
      temperature: 0.3,
      topK: 20,
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
  
  // Comprehensive date patterns
  const datePatterns = [
    // Full dates with months
    {
      regex: /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+(19|20)\d{2}\b/gi,
      type: 'full_date',
      priority: 1
    },
    {
      regex: /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2},?\s+(19|20)\d{2}\b/gi,
      type: 'short_date', 
      priority: 1
    },
    // Numeric dates
    {
      regex: /\b\d{1,2}[\/\-]\d{1,2}[\/\-](19|20)\d{2}\b/g,
      type: 'numeric_date',
      priority: 2
    },
    {
      regex: /\b(19|20)\d{2}[\/\-]\d{1,2}[\/\-]\d{1,2}\b/g,
      type: 'iso_date',
      priority: 2
    },
    // Years with context
    {
      regex: /\b(in|during|since|from|until|by|around|circa|about|year)\s+(19|20)\d{2}\b/gi,
      type: 'year_context',
      priority: 2
    },
    // Historical years
    {
      regex: /\b(19[0-9]{2}|20[0-2][0-9])\b(?=\s*[-–—]\s*|\s+(war|battle|revolution|independence|founded|established|born|died|elected|treaty|agreement|act|law))/gi,
      type: 'historical_year',
      priority: 3
    },
    // Ancient dates
    {
      regex: /\b\d{1,4}\s*(BC|BCE|AD|CE)\b/gi,
      type: 'ancient_date',
      priority: 1
    }
  ];
  
  // Process each pattern
  datePatterns.forEach(pattern => {
    const patternMatches = [...content.matchAll(pattern.regex)];
    
    patternMatches.forEach(match => {
      const dateText = match[0];
      const startPos = match.index;
      const endPos = startPos + dateText.length;
      
      // Get context around the match
      const contextStart = Math.max(0, startPos - 150);
      const contextEnd = Math.min(content.length, endPos + 150);
      const context = content.substring(contextStart, contextEnd);
      
      // Create unique key
      const contextKey = `${dateText}-${context.substring(0, 50)}`.toLowerCase().replace(/\s+/g, ' ');
      
      if (seen.has(contextKey)) return;
      seen.add(contextKey);
      
      // Validate the match
      if (isValidDateMatch(context, dateText)) {
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
  
  // Sort by priority and limit results
  return matches
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.position - b.position;
    })
    .slice(0, 20); // Limit to 20 matches
}

// Validate date matches
function isValidDateMatch(context, dateText) {
  const lowContext = context.toLowerCase();
  
  // Skip navigation and metadata
  const skipPatterns = [
    'copyright', 'all rights reserved', 'terms of service', 'privacy policy',
    'home', 'about', 'contact', 'menu', 'search', 'login', 'sign up',
    'posted on', 'updated on', 'last modified', 'page', 'next', 'previous'
  ];
  
  if (skipPatterns.some(pattern => lowContext.includes(pattern))) {
    return false;
  }
  
  // For standalone years, require historical context
  if (dateText.match(/^\d{4}$/)) {
    const historicalWords = [
      'war', 'battle', 'born', 'died', 'founded', 'established', 'began', 'ended', 
      'revolution', 'independence', 'treaty', 'elected', 'invented', 'discovered',
      'built', 'created', 'started', 'opened', 'closed', 'married', 'graduated'
    ];
    if (!historicalWords.some(word => lowContext.includes(word))) {
      return false;
    }
  }
  
  return context.trim().length > 50;
}

// Process matches with AI in small batches
async function processPreciseMatches(matches, pageTitle) {
  const allEvents = [];
  const batchSize = 5; // Small batches for reliability
  
  for (let i = 0; i < matches.length; i += batchSize) {
    const batch = matches.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(matches.length / batchSize);
    
    showStatus(`Processing events ${i + 1}-${Math.min(i + batchSize, matches.length)} of ${matches.length}...`, 'loading');
    
    try {
      const events = await processSmallBatch(batch, pageTitle);
      console.log(`Batch ${batchNum} produced ${events.length} events`);
      
      if (events.length > 0) {
        allEvents.push(...events);
      }
      
      // Small delay between batches
      if (i + batchSize < matches.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
    } catch (error) {
      console.warn(`Batch ${batchNum} failed:`, error);
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
    // Create focused prompt for each match
    const contextBlocks = matches.map((match, index) => {
      return `[${index + 1}] Date: "${match.dateText}" | Context: "${match.context.substring(0, 200)}..."`;
    }).join('\n\n');
    
    const prompt = `Extract timeline events from this webpage content. For each date pattern, identify the specific historical event, fact, or milestone mentioned.

Page: ${pageTitle}

Date patterns found:
${contextBlocks}

Instructions:
- Extract only clear, factual events (births, deaths, founding dates, historical events, etc.)
- Create concise titles (max 60 characters)
- Provide brief descriptions (max 120 characters)
- Use ISO date format (YYYY-MM-DD) when possible
- For incomplete dates, use YYYY-01-01 or YYYY-MM-01
- For BC dates, use negative years like -0044-03-15
- Skip if no clear event is mentioned

Respond with valid JSON array only:
[
  {"date": "YYYY-MM-DD", "title": "Event title", "description": "Brief description"},
  {"date": "YYYY-MM-DD", "title": "Another event", "description": "Another description"}
]`;

    console.log('Sending prompt to LanguageModel...');
    
    // Use the correct prompt method
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

// Display timeline with enhanced styling
function displayTimeline(events) {
  if (!events || events.length === 0) {
    timelineDiv.innerHTML = `
      <div class="empty-state">
        <div style="font-size: 3rem; margin-bottom: 1rem;">📅</div>
        <h3 style="margin: 0 0 0.5rem 0; color: #667eea;">No Timeline Events Found</h3>
        <p style="margin: 0; color: #888; font-size: 0.9rem;">Try a page with historical content, news articles, or biographical information.</p>
      </div>
    `;
    return;
  }
  
  let html = '';
  
  events.forEach((event, index) => {
    const formattedDate = formatDate(event.date);
    
    html += `
      <div class="timeline-item" onclick="toggleEventDetails(${index})">
        <div class="event-date">${formattedDate}</div>
        <div class="event-title">${escapeHtml(event.title)}</div>
        <div class="event-description" id="desc-${index}" style="display: none;">
          ${escapeHtml(event.description)}
          <div style="margin-top: 8px; font-size: 0.75rem; color: #888;">
            🤖 Generated by AI • Click to collapse
          </div>
        </div>
      </div>
    `;
  });
  
  timelineDiv.innerHTML = html;
}

// Toggle event details
function toggleEventDetails(index) {
  const desc = document.getElementById(`desc-${index}`);
  if (desc) {
    desc.style.display = desc.style.display === 'none' ? 'block' : 'none';
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