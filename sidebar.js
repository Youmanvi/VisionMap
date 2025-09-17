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
    
    // Step 2: Fast preprocessing - find date candidates
    showStatus('Finding date patterns...', 'loading');
    const dateSnippets = extractDateCandidates(pageData.content);
    
    console.log(`Found ${dateSnippets.length} date candidates`);
    
    // Step 3: Process with hybrid approach
    const events = await processEventsHybrid(dateSnippets, pageData.title);
    
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

// Get content from current webpage
async function getPageContent() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Request timed out'));
    }, 10000);
    
    chrome.runtime.sendMessage(
      { type: "getPageContent" },
      (response) => {
        clearTimeout(timeout);
        
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.error) {
          reject(new Error(response.error));
        } else if (response?.content) {
          resolve(response);
        } else {
          reject(new Error('No content received'));
        }
      }
    );
  });
}

// Extract date candidates with pattern recognition
function extractDateCandidates(content) {
  const candidates = [];
  const seen = new Set(); // Deduplicate
  
  // Split into sentences for context
  const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 15);
  
  // Date patterns with confidence scoring
  const patterns = [
    // High confidence - explicit dates
    {
      regex: /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+(19|20)\d{2}\b/gi,
      type: 'full_date',
      confidence: 0.95
    },
    {
      regex: /\b\d{1,2}[\/\-]\d{1,2}[\/\-](19|20)?\d{2}\b/g,
      type: 'numeric_date',
      confidence: 0.90
    },
    {
      regex: /\b(19|20)\d{2}\b/g,
      type: 'year',
      confidence: 0.85
    },
    // Medium confidence - contextual dates
    {
      regex: /\b(early|mid|late)\s+(19|20)\d{2}s?\b/gi,
      type: 'period',
      confidence: 0.75
    },
    {
      regex: /\b(during|in|since|until|by|from)\s+(19|20)\d{2}\b/gi,
      type: 'contextual',
      confidence: 0.70
    },
    // Lower confidence - relative dates (need AI)
    {
      regex: /\b(recently|soon|later|eventually|nowadays|currently)\b/gi,
      type: 'relative',
      confidence: 0.30
    },
    {
      regex: /\b(next|last|this|previous)\s+(week|month|year|decade|century)\b/gi,
      type: 'relative_period',
      confidence: 0.40
    }
  ];
  
  // Process each sentence
  sentences.forEach((sentence, sentenceIndex) => {
    patterns.forEach(pattern => {
      const matches = [...sentence.matchAll(pattern.regex)];
      
      matches.forEach(match => {
        const dateText = match[0];
        const contextKey = sentence.substring(0, 100).toLowerCase();
        
        // Skip duplicates
        if (seen.has(contextKey)) return;
        seen.add(contextKey);
        
        // Get surrounding context
        const contextStart = Math.max(0, sentenceIndex - 1);
        const contextEnd = Math.min(sentences.length - 1, sentenceIndex + 1);
        const fullContext = sentences.slice(contextStart, contextEnd + 1).join('. ');
        
        candidates.push({
          dateText,
          sentence,
          context: fullContext,
          type: pattern.type,
          confidence: pattern.confidence,
          position: match.index,
          sentenceIndex
        });
      });
    });
  });
  
  // Sort by confidence and limit
  return candidates
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 25); // Process top 25 candidates
}

// Hybrid processing: local parsing + AI for complex cases
async function processEventsHybrid(candidates, pageTitle) {
  const events = [];
  const processedDates = new Set();
  
  // Step 1: Process high-confidence dates locally (>= 0.7)
  const localCandidates = candidates.filter(c => c.confidence >= 0.7);
  const complexCandidates = candidates.filter(c => c.confidence < 0.7);
  
  console.log(`Processing ${localCandidates.length} locally, ${complexCandidates.length} with AI`);
  
  // Local processing
  showStatus('Processing explicit dates...', 'loading');
  localCandidates.forEach(candidate => {
    const event = parseLocalDate(candidate);
    if (event && !processedDates.has(event.date)) {
      events.push(event);
      processedDates.add(event.date);
    }
  });
  
  // AI processing for complex cases
  if (complexCandidates.length > 0) {
    showStatus('Processing complex dates with AI...', 'loading');
    
    try {
      const aiEvents = await processWithAI(complexCandidates, pageTitle);
      aiEvents.forEach(event => {
        if (event && !processedDates.has(event.date)) {
          events.push(event);
          processedDates.add(event.date);
        }
      });
    } catch (aiError) {
      console.warn('AI processing failed:', aiError);
      // Continue with local results only
    }
  }
  
  // Sort chronologically and return
  return events
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(0, 20);
}

// Parse high-confidence dates locally
function parseLocalDate(candidate) {
  const { dateText, context, type } = candidate;
  
  let parsedDate = null;
  let title = '';
  
  try {
    // Parse different date formats
    switch (type) {
      case 'full_date':
        parsedDate = new Date(dateText);
        break;
        
      case 'numeric_date':
        // Handle different formats
        const normalized = dateText.replace(/[-]/g, '/');
        parsedDate = new Date(normalized);
        break;
        
      case 'year':
        const year = dateText.match(/\b(19|20)\d{2}\b/)[0];
        parsedDate = new Date(`${year}-01-01`);
        break;
        
      case 'period':
        // "early 1990s" -> "1990-01-01"
        const periodYear = dateText.match(/\b(19|20)\d{2}/)[0];
        parsedDate = new Date(`${periodYear}-01-01`);
        break;
        
      case 'contextual':
        // "during 1945" -> "1945-01-01"
        const contextYear = dateText.match(/\b(19|20)\d{2}/)[0];
        parsedDate = new Date(`${contextYear}-01-01`);
        break;
    }
    
    // Validate date
    if (!parsedDate || isNaN(parsedDate.getTime())) {
      return null;
    }
    
    // Extract meaningful title from context
    title = extractEventTitle(context, dateText);
    
    return {
      date: parsedDate.toISOString().split('T')[0],
      title: title.substring(0, 80),
      description: context.substring(0, 200),
      confidence: candidate.confidence,
      source: 'local'
    };
    
  } catch (error) {
    console.warn('Local parsing failed:', dateText, error);
    return null;
  }
}

// Extract event title from context
function extractEventTitle(context, dateText) {
  // Remove the date text itself
  let cleanContext = context.replace(new RegExp(dateText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  
  // Look for meaningful phrases
  const titlePatterns = [
    // Events and actions
    /\b(was|were|became|started|began|ended|finished|launched|founded|established|created|built|died|born|elected|appointed|signed|declared|announced)\s+[^.!?]+/gi,
    // Proper nouns and important phrases
    /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g,
    // Historical events
    /\b(war|battle|treaty|revolution|independence|constitution|law|act|movement|crisis|period)\b[^.!?]*/gi
  ];
  
  for (const pattern of titlePatterns) {
    const matches = cleanContext.match(pattern);
    if (matches && matches[0]) {
      let title = matches[0].trim();
      // Clean up
      title = title
        .replace(/^(was|were|became|started|began|ended|in|on|at|during|the|a|an)\s+/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      
      if (title.length > 10) {
        return title;
      }
    }
  }
  
  // Fallback: use first meaningful sentence fragment
  const sentences = cleanContext.split(/[.!?]+/);
  for (const sentence of sentences) {
    const clean = sentence.trim();
    if (clean.length > 15 && clean.length < 100) {
      return clean;
    }
  }
  
  return 'Historical Event';
}

// Process complex dates with AI
async function processWithAI(candidates, pageTitle) {
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
    
    // Create focused prompt with just the complex snippets
    const snippetText = candidates
      .slice(0, 10) // Limit to avoid token overflow
      .map((c, i) => `${i + 1}. "${c.context}" (Contains: "${c.dateText}")`)
      .join('\n');
    
    const currentDate = new Date().toISOString().split('T')[0];
    const prompt = `Parse these date references into timeline events. Today's date: ${currentDate}

Page: ${pageTitle}

Date snippets:
${snippetText}

Return ONLY valid JSON array:
[{"date": "YYYY-MM-DD", "title": "Event title (max 80 chars)", "description": "Brief description (max 200 chars)"}]`;
    
    const result = await session.write(prompt);
    session.destroy();
    
    return parseAIResponse(result);
    
  } catch (error) {
    console.error('AI processing failed:', error);
    if (session) session.destroy();
    return [];
  }
}

// Parse AI response into events
function parseAIResponse(response) {
  try {
    // Clean response
    let clean = response.trim();
    clean = clean.replace(/```json\s*/g, '').replace(/```\s*$/g, '');
    
    // Extract JSON array
    const start = clean.indexOf('[');
    const end = clean.lastIndexOf(']') + 1;
    if (start !== -1 && end > start) {
      clean = clean.substring(start, end);
    }
    
    const events = JSON.parse(clean);
    
    if (Array.isArray(events)) {
      return events
        .filter(e => e.date && e.title && !isNaN(new Date(e.date).getTime()))
        .map(e => ({
          ...e,
          title: e.title.substring(0, 80),
          description: (e.description || '').substring(0, 200),
          source: 'ai'
        }));
    }
  } catch (error) {
    console.warn('Failed to parse AI response:', error);
  }
  
  return [];
}

// Display timeline with expandable format
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
    const confidenceClass = event.confidence > 0.8 ? 'high' : event.confidence > 0.5 ? 'medium' : 'low';
    
    html += `
      <div class="timeline-event" data-confidence="${confidenceClass}">
        <div class="event-header" onclick="toggleEvent(${index})">
          <div class="event-main">
            <span class="event-date">${formattedDate}</span>
            <span class="event-title">${escapeHtml(event.title)}</span>
          </div>
          <div class="event-controls">
            <span class="source-indicator" title="${event.source === 'local' ? 'Parsed locally' : 'Processed with AI'}">${sourceIcon}</span>
            <button class="expand-btn" id="btn-${index}">
              <span class="expand-icon">▼</span>
            </button>
          </div>
        </div>
        <div class="event-details" id="details-${index}" style="display: none;">
          <div class="event-description">${escapeHtml(event.description || 'No additional details available.')}</div>
          <div class="event-meta">
            <small>Confidence: ${Math.round(event.confidence * 100)}% | Source: ${event.source === 'local' ? 'Local parsing' : 'AI processing'}</small>
          </div>
        </div>
      </div>
    `;
  });
  
  html += '</div>';
  timelineDiv.innerHTML = html;
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

// Format dates nicely
function formatDate(dateString) {
  try {
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

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}