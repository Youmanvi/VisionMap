// Get references to HTML elements
const extractBtn = document.getElementById('extractBtn');
const statusDiv = document.getElementById('status');
const timelineDiv = document.getElementById('timeline');

// Cache for processed results
let processedEvents = [];

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
    
    // Step 2: Precise preprocessing - find and highlight exact date matches
    showStatus('Finding precise date matches...', 'loading');
    const dateMatches = extractPreciseDateMatches(pageData.content);
    
    console.log(`Found ${dateMatches.length} precise date matches`);
    
    if (dateMatches.length === 0) {
      throw new Error('No date patterns found in the content');
    }
    
    // Step 3: Process in small batches with exact context
    const events = await processPreciseMatches(dateMatches, pageData.title);
    
    // Step 4: Cache and display
    processedEvents = events;
    displayTimeline(events);
    showStatus(`Extracted ${events.length} timeline events!`, 'success');
    
  } catch (error) {
    console.error('Timeline extraction error:', error);
    showStatus('Error: ' + error.message, 'error');
  } finally {
    extractBtn.disabled = false;
  }
}

// Get content from current webpage with retry logic
async function getPageContent() {
  const maxRetries = 3;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Attempting to get page content (attempt ${attempt}/${maxRetries})`);
      
      const pageData = await attemptGetPageContent();
      console.log('Successfully got page content:', pageData.title);
      return pageData;
      
    } catch (error) {
      console.warn(`Attempt ${attempt} failed:`, error.message);
      lastError = error;
      
      if (attempt < maxRetries) {
        // Wait before retry, and try to ensure content script is loaded
        await new Promise(resolve => setTimeout(resolve, 1000));
        await ensureContentScriptLoaded();
      }
    }
  }
  
  // All attempts failed
  throw new Error(`Failed to get page content after ${maxRetries} attempts. Last error: ${lastError.message}`);
}

// Single attempt to get page content
function attemptGetPageContent() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Request timed out after 8 seconds'));
    }, 8000);
    
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
          reject(new Error(`Background script error: ${response.error}`));
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

// Ensure content script is loaded
async function ensureContentScriptLoaded() {
  try {
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab) {
      throw new Error('No active tab found');
    }
    
    console.log('Checking content script on tab:', tab.url);
    
    // Try to inject content script if it's not loaded
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          // Check if content script is already loaded
          if (!window.timelineExtractorLoaded) {
            console.log('Content script not detected, may need manual reload');
          }
          return window.timelineExtractorLoaded || false;
        }
      });
    } catch (scriptError) {
      console.warn('Could not check/inject content script:', scriptError);
    }
    
  } catch (error) {
    console.warn('Error ensuring content script loaded:', error);
  }
}

// Extract precise date matches with highlighted context
function extractPreciseDateMatches(content) {
  const matches = [];
  const seen = new Set(); // Prevent duplicates
  
  // Comprehensive date patterns with exact matching
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
      priority: 1
    },
    {
      regex: /\b(19|20)\d{2}[\/\-]\d{1,2}[\/\-]\d{1,2}\b/g,
      type: 'iso_date',
      priority: 1
    },
    // Years with context
    {
      regex: /\b(in|during|since|from|until|by|around|circa|about)\s+(19|20)\d{2}\b/gi,
      type: 'year_context',
      priority: 2
    },
    // Standalone years (be more selective)
    {
      regex: /\b(19[0-9]{2}|20[0-2][0-9])\b/g,
      type: 'year_only',
      priority: 3
    },
    // Ancient/BC dates
    {
      regex: /\b\d{1,4}\s*(BC|BCE|AD|CE)\b/gi,
      type: 'ancient_date',
      priority: 1
    },
    // Day names with dates
    {
      regex: /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[,\s]+(?:(January|February|March|April|May|June|July|August|September|October|November|December)\s+)?\d{1,2}(?:st|nd|rd|th)?,?\s+(19|20)\d{2}\b/gi,
      type: 'day_date',
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
      
      // Extract 100 characters before and after the match
      const contextStart = Math.max(0, startPos - 100);
      const contextEnd = Math.min(content.length, endPos + 100);
      const context = content.substring(contextStart, contextEnd);
      
      // Create unique key to avoid duplicates
      const contextKey = `${dateText}-${context.substring(0, 50)}`.toLowerCase().replace(/\s+/g, ' ');
      
      if (seen.has(contextKey)) return;
      seen.add(contextKey);
      
      // Validate the match isn't just noise
      if (isValidDateMatch(context, dateText)) {
        matches.push({
          dateText: dateText,
          context: context.trim(),
          fullContext: getExpandedContext(content, startPos, endPos),
          type: pattern.type,
          priority: pattern.priority,
          position: startPos
        });
      }
    });
  });
  
  // Sort by priority (1 = highest) then by position
  return matches
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.position - b.position;
    })
    .slice(0, 15); // Limit to 15 best matches
}

// Validate that a date match is meaningful
function isValidDateMatch(context, dateText) {
  // Skip if it's just navigation or metadata
  const lowContext = context.toLowerCase();
  const skipPatterns = [
    'copyright', 'all rights reserved', 'terms of service', 'privacy policy',
    'home', 'about', 'contact', 'menu', 'search', 'login', 'sign up',
    'next page', 'previous page', 'page 1', 'page 2', 
    'posted on', 'updated on', 'last modified',
    'isbn', 'doi:', 'http://', 'https://'
  ];
  
  if (skipPatterns.some(pattern => lowContext.includes(pattern))) {
    return false;
  }
  
  // Skip standalone years that don't have historical context
  if (dateText.match(/^\d{4}$/)) {
    const historicalWords = ['war', 'battle', 'born', 'died', 'founded', 'established', 'began', 'ended', 'revolution', 'independence', 'treaty', 'elected', 'invented', 'discovered'];
    if (!historicalWords.some(word => lowContext.includes(word))) {
      return false;
    }
  }
  
  // Must have some substantial text around it
  return context.trim().length > 30;
}

// Get expanded context for better AI processing
function getExpandedContext(content, startPos, endPos) {
  // Find sentence boundaries around the match
  const beforeText = content.substring(Math.max(0, startPos - 300), startPos);
  const afterText = content.substring(endPos, Math.min(content.length, endPos + 300));
  
  // Find last sentence start before match
  const sentenceStart = Math.max(
    beforeText.lastIndexOf('. '),
    beforeText.lastIndexOf('! '),
    beforeText.lastIndexOf('? '),
    0
  );
  
  // Find first sentence end after match
  const sentenceEnd = Math.min(
    afterText.indexOf('. ') + 1 || afterText.length,
    afterText.indexOf('! ') + 1 || afterText.length,
    afterText.indexOf('? ') + 1 || afterText.length
  );
  
  const expandedStart = Math.max(0, startPos - 300 + sentenceStart);
  const expandedEnd = Math.min(content.length, endPos + sentenceEnd);
  
  return content.substring(expandedStart, expandedEnd).trim();
}

// Process precise matches in very small batches
async function processPreciseMatches(matches, pageTitle) {
  const allEvents = [];
  const batchSize = 3; // Very small batches for reliability
  
  for (let i = 0; i < matches.length; i += batchSize) {
    const batch = matches.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(matches.length / batchSize);
    
    showStatus(`Processing batch ${batchNum}/${totalBatches} (${batch.length} events)...`, 'loading');
    
    try {
      const events = await processSmallBatch(batch, pageTitle);
      console.log(`Batch ${batchNum} produced ${events.length} events`);
      
      if (events.length > 0) {
        allEvents.push(...events);
      }
      
      // Delay between batches to avoid overwhelming the API
      if (i + batchSize < matches.length) {
        await new Promise(resolve => setTimeout(resolve, 800));
      }
      
    } catch (error) {
      console.warn(`Batch ${batchNum} failed:`, error);
      // Continue with remaining batches
    }
  }
  
  console.log(`Total events from all batches: ${allEvents.length}`);
  
  // Remove duplicates and sort chronologically
  return deduplicateAndSort(allEvents);
}

// Process a small batch with focused AI prompting
async function processSmallBatch(matches, pageTitle) {
  if (!window.ai?.writer) {
    console.warn('Writer API not available');
    return [];
  }
  
  let session = null;
  
  try {
    const capabilities = await ai.writer.capabilities();
    if (capabilities.available !== 'readily') {
      throw new Error('Writer API not ready');
    }
    
    session = await ai.writer.create({
      tone: 'neutral',
      format: 'plain-text',
      length: 'short'
    });
    
    // Create very focused prompts for each match
    const contextBlocks = matches.map((match, index) => {
      return `Event ${index + 1}:
Date Pattern: "${match.dateText}"
Context: "${match.fullContext}"
Type: ${match.type}`;
    }).join('\n\n');
    
    const prompt = `Extract timeline events from these precise date matches. Focus on the specific historical event or fact mentioned.

Page: ${pageTitle}

Date Matches:
${contextBlocks}

Rules:
- Extract ONLY the specific event mentioned around each date
- Create clear, factual titles (30-70 chars)
- Provide brief descriptions (80-150 chars)  
- Use the exact date when clear, or best approximation
- Skip if no clear historical event is mentioned
- For ancient dates (BC/BCE), preserve the original format

Return ONLY valid JSON:
[{"date": "YYYY-MM-DD", "title": "Event title", "description": "Brief description"}]

For BC dates use negative years: {"date": "-0100-01-01", "title": "Event in 100 BC", "description": "Description"}`;

    console.log('Sending prompt to AI:', prompt.substring(0, 200) + '...');
    
    const result = await session.write(prompt);
    console.log('AI response received:', result.substring(0, 200) + '...');
    
    session.destroy();
    return parseAIResponse(result);
    
  } catch (error) {
    console.error('Small batch AI processing failed:', error);
    if (session) session.destroy();
    return [];
  }
}

// Parse AI response with better error handling and validation
function parseAIResponse(response) {
  try {
    // Clean the response
    let clean = response.trim();
    
    // Remove markdown formatting
    clean = clean.replace(/```json\s*/g, '').replace(/```\s*$/g, '');
    clean = clean.replace(/```/g, '');
    
    // Extract JSON array
    const start = clean.indexOf('[');
    const end = clean.lastIndexOf(']') + 1;
    
    if (start === -1 || end <= start) {
      console.warn('No JSON array found in response:', clean);
      return [];
    }
    
    const jsonStr = clean.substring(start, end);
    console.log('Parsing JSON:', jsonStr);
    
    const events = JSON.parse(jsonStr);
    
    if (!Array.isArray(events)) {
      console.warn('Parsed result is not an array');
      return [];
    }
    
    // Validate and clean events
    return events
      .filter(event => {
        if (!event.date || !event.title) {
          console.warn('Event missing date or title:', event);
          return false;
        }
        
        // Validate date format
        let testDate;
        if (event.date.startsWith('-')) {
          // BC date - just check it's reasonable
          const year = parseInt(event.date.split('-')[1]);
          if (isNaN(year) || year > 9999) return false;
          testDate = new Date('0001-01-01'); // Placeholder for BC dates
        } else {
          testDate = new Date(event.date);
          if (isNaN(testDate.getTime())) {
            console.warn('Invalid date:', event.date);
            return false;
          }
        }
        
        // Filter out bad titles
        const titleLower = event.title.toLowerCase();
        const badPatterns = ['wikipedia', 'disambiguation', 'copyright', 'all rights', 'home page'];
        if (badPatterns.some(pattern => titleLower.includes(pattern))) {
          console.warn('Filtered out bad title:', event.title);
          return false;
        }
        
        return true;
      })
      .map(event => ({
        date: event.date,
        title: event.title.substring(0, 80).trim(),
        description: (event.description || event.title).substring(0, 200).trim(),
        confidence: 0.90,
        source: 'ai'
      }));
      
  } catch (error) {
    console.error('Failed to parse AI response:', error);
    console.log('Raw response that failed:', response);
    return [];
  }
}

// Deduplicate events and sort chronologically
function deduplicateAndSort(events) {
  // Remove duplicates based on similar dates and titles
  const uniqueEvents = [];
  const seen = new Set();
  
  events.forEach(event => {
    const key = `${event.date}-${event.title.substring(0, 30).toLowerCase().replace(/\s+/g, '')}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueEvents.push(event);
    }
  });
  
  // Sort chronologically (handle BC dates)
  return uniqueEvents.sort((a, b) => {
    const dateA = a.date.startsWith('-') ? new Date(`0001${a.date.substring(5)}`) : new Date(a.date);
    const dateB = b.date.startsWith('-') ? new Date(`0001${b.date.substring(5)}`) : new Date(b.date);
    
    // BC dates should come first
    if (a.date.startsWith('-') && !b.date.startsWith('-')) return -1;
    if (!a.date.startsWith('-') && b.date.startsWith('-')) return 1;
    
    if (a.date.startsWith('-') && b.date.startsWith('-')) {
      // For BC dates, more negative (earlier) comes first
      return a.date.localeCompare(b.date);
    }
    
    return dateA - dateB;
  });
}

// Display timeline with better BC date handling
function displayTimeline(events) {
  if (!events || events.length === 0) {
    timelineDiv.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📅</div>
        <h3>No Timeline Events Found</h3>
        <p>Try a page with historical content, news articles, or biographical information.</p>
      </div>
    `;
    return;
  }
  
  let html = '<div class="timeline-container">';
  
  events.forEach((event, index) => {
    const formattedDate = formatDate(event.date);
    const sourceIcon = event.source === 'local' ? '⚡' : '🤖';
    
    html += `
      <div class="timeline-event">
        <div class="event-header" onclick="toggleEvent(${index})">
          <div class="event-main">
            <span class="event-date">${formattedDate}</span>
            <span class="event-title">${escapeHtml(event.title)}</span>
          </div>
          <div class="event-controls">
            <span class="source-indicator" title="Processed with AI">${sourceIcon}</span>
            <button class="expand-btn" id="btn-${index}">
              <span class="expand-icon">▼</span>
            </button>
          </div>
        </div>
        <div class="event-details" id="details-${index}" style="display: none;">
          <div class="event-description">${escapeHtml(event.description)}</div>
          <div class="event-meta">
            <small>Confidence: ${Math.round(event.confidence * 100)}% | AI Processed</small>
          </div>
        </div>
      </div>
    `;
  });
  
  html += '</div>';
  timelineDiv.innerHTML = html;
}

// Format dates including BC dates
function formatDate(dateString) {
  try {
    if (dateString.startsWith('-')) {
      // Handle BC dates
      const parts = dateString.substring(1).split('-');
      const year = parseInt(parts[0]);
      return `${year} BC`;
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

// Toggle event details
function toggleEvent(index) {
  const details = document.getElementById(`details-${index}`);
  const button = document.getElementById(`btn-${index}`);
  const icon = button.querySelector('.expand-icon');
  
  if (details.style.display === 'none') {
    details.style.display = 'block';
    icon.textContent = '▲';
    button.classList.add('expanded');
  } else {
    details.style.display = 'none';
    icon.textContent = '▼';
    button.classList.remove('expanded');
  }
}

// Make toggleEvent globally accessible
window.toggleEvent = toggleEvent;

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