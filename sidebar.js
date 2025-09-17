// Get references to HTML elements
const extractBtn = document.getElementById('extractBtn');
const statusDiv = document.getElementById('status');
const timelineDiv = document.getElementById('timeline');

// When extract button is clicked
extractBtn.addEventListener('click', async () => {
  await extractTimeline();
});

async function extractTimeline() {
  try {
    // Show loading status
    showStatus('Analyzing page content...', 'loading');
    extractBtn.disabled = true;
    
    // Step 1: Get page content
    const pageData = await getPageContent();
    
    // Step 2: Process with AI
    showStatus('Extracting timeline events with AI...', 'loading');
    const events = await processWithAI(pageData.content);
    
    // Step 3: Display timeline
    displayTimeline(events);
    showStatus(`Found ${events.length} timeline events!`, 'success');
    
  } catch (error) {
    console.error('Error:', error);
    showStatus('Error: ' + error.message, 'error');
  } finally {
    extractBtn.disabled = false;
  }
}

// Get content from current webpage
async function getPageContent() {
  return new Promise(async (resolve, reject) => {
    try {
      // First, check if we can get the current tab
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tabs || tabs.length === 0) {
        reject(new Error('No active tab found'));
        return;
      }
      
      const currentTab = tabs[0];
      
      // Check if the current page supports content scripts
      if (currentTab.url.startsWith('chrome://') || 
          currentTab.url.startsWith('chrome-extension://') ||
          currentTab.url.startsWith('edge://') ||
          currentTab.url.startsWith('about:') ||
          currentTab.url.startsWith('moz-extension://')) {
        reject(new Error('Cannot extract content from this page. Try a regular website like Wikipedia or a news site.'));
        return;
      }
      
      const timeout = setTimeout(() => {
        reject(new Error('Request timed out. The page may not be fully loaded or content script failed to inject.'));
      }, 8000);
      
      // Try to inject content script manually if needed
      try {
        await chrome.scripting.executeScript({
          target: { tabId: currentTab.id },
          func: () => {
            // Test if our content script is already loaded
            if (!window.timelineExtractorLoaded) {
              window.timelineExtractorLoaded = true;
            }
          }
        });
      } catch (injectionError) {
        console.warn('Script injection failed:', injectionError);
      }
      
      chrome.runtime.sendMessage(
        { type: "getPageContent" },
        (response) => {
          clearTimeout(timeout);
          
          if (chrome.runtime.lastError) {
            reject(new Error('Connection failed: ' + chrome.runtime.lastError.message + '. Try refreshing the page and opening the extension again.'));
          } else if (response?.error) {
            reject(new Error(response.error));
          } else if (response?.content !== undefined) {
            resolve(response);
          } else {
            reject(new Error('No response from page. Try refreshing the page and reopening the extension.'));
          }
        }
      );
    } catch (error) {
      reject(new Error('Failed to access page: ' + error.message));
    }
  });
}

// Process content with Gemini Nano AI using both Summarization and Writer APIs
async function processWithAI(content) {
  try {
    // Step 1: Check if both APIs are available
    if (!window.ai?.summarizer || !window.ai?.writer) {
      throw new Error('Summarization or Writer API not available. Enable both APIs in Chrome flags.');
    }
    
    // Check API capabilities
    const summarizerCapabilities = await ai.summarizer.capabilities();
    const writerCapabilities = await ai.writer.capabilities();
    
    if (summarizerCapabilities.available === 'no' || writerCapabilities.available === 'no') {
      throw new Error('One or both AI APIs not available on this device.');
    }
    
    // Step 2: First, summarize the content to extract key information
    showStatus('Summarizing page content...', 'loading');
    
    const summarizerSession = await ai.summarizer.create({
      type: 'key-points',
      format: 'plain-text',
      length: 'medium'
    });
    
    // Summarize the content focusing on chronological events
    const summaryPrompt = `Focus on chronological events, dates, and historical timeline when summarizing this content:\n\n${content.substring(0, 4000)}`;
    const summary = await summarizerSession.summarize(summaryPrompt);
    
    console.log('Generated summary:', summary);
    
    // Step 3: Use Writer API to structure the summary into timeline JSON
    showStatus('Extracting timeline events with AI...', 'loading');
    
    const writerSession = await ai.writer.create({
      tone: 'neutral',
      format: 'plain-text',
      length: 'medium'
    });
    
    // Create a focused prompt for timeline extraction from the summary
    const timelinePrompt = `Based on this summary, extract chronological events and format as a JSON array. Focus on events with specific dates or time periods.

Summary: ${summary}

Original content snippet: ${content.substring(0, 1500)}

Create a JSON array where each event has:
- date: Use YYYY-MM-DD format, or YYYY-01-01 if only year is known
- title: Brief event title (max 60 characters)
- description: Event description (max 200 characters)

Return ONLY the JSON array, no other text:
[{"date": "YYYY-MM-DD", "title": "Event Title", "description": "Event description"}]`;
    
    const result = await writerSession.write(timelinePrompt);
    
    console.log('Writer API result:', result);
    
    // Step 4: Clean up and parse the response
    let cleanResult = result.trim();
    
    // Remove markdown formatting
    if (cleanResult.startsWith('```json')) {
      cleanResult = cleanResult.replace(/```json\n?/, '').replace(/\n?```$/, '');
    }
    if (cleanResult.startsWith('```')) {
      cleanResult = cleanResult.replace(/```\n?/, '').replace(/\n?```$/, '');
    }
    
    // Extract JSON array from response
    const jsonMatch = cleanResult.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      cleanResult = jsonMatch[0];
    }
    
    let events;
    try {
      events = JSON.parse(cleanResult);
      console.log('Parsed events:', events);
    } catch (parseError) {
      console.warn('JSON parsing failed, trying fallback with summary');
      events = createFallbackTimeline(summary + '\n\n' + content);
    }
    
    // Validate and clean events
    if (!Array.isArray(events)) {
      console.warn('Invalid events array, using fallback');
      events = createFallbackTimeline(summary + '\n\n' + content);
    }
    
    // Filter out invalid events and sort by date
    const validEvents = events.filter(event => 
      event && 
      typeof event === 'object' && 
      event.date && 
      event.title &&
      event.title.trim().length > 0
    ).slice(0, 20); // Limit to 20 events max
    
    return validEvents.sort((a, b) => {
      const dateA = new Date(a.date);
      const dateB = new Date(b.date);
      return dateA - dateB;
    });
    
  } catch (error) {
    console.error('AI processing error:', error);
    // Fallback to regex-based extraction
    showStatus('AI processing failed, using fallback extraction...', 'loading');
    return createFallbackTimeline(content);
  }
}

// Create a simple fallback timeline using regex patterns
function createFallbackTimeline(content) {
  const events = [];
  
  // Look for year patterns (1900-2099)
  const yearRegex = /\b(19|20)\d{2}\b/g;
  const years = [...content.matchAll(yearRegex)].map(match => match[0]).slice(0, 10);
  
  // Look for date patterns (Month Day, Year or Day Month Year)
  const dateRegex = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+(19|20)\d{2}\b/gi;
  const dates = [...content.matchAll(dateRegex)].slice(0, 5);
  
  // Create events from found dates
  dates.forEach((match, index) => {
    const dateStr = match[0];
    const startPos = match.index;
    const contextStart = Math.max(0, startPos - 100);
    const contextEnd = Math.min(content.length, startPos + 200);
    const context = content.substring(contextStart, contextEnd);
    
    // Extract a title from the surrounding context
    const sentences = context.split(/[.!?]+/);
    let title = sentences.find(s => s.includes(dateStr)) || sentences[0] || 'Historical Event';
    title = title.trim().substring(0, 60);
    
    try {
      const date = new Date(dateStr);
      if (!isNaN(date)) {
        events.push({
          date: date.toISOString().split('T')[0],
          title: title,
          description: context.trim().substring(0, 200)
        });
      }
    } catch (e) {
      // Skip invalid dates
    }
  });
  
  // If no date-based events found, create year-based events
  if (events.length === 0 && years.length > 0) {
    years.slice(0, 5).forEach(year => {
      const yearPos = content.indexOf(year);
      const contextStart = Math.max(0, yearPos - 50);
      const contextEnd = Math.min(content.length, yearPos + 150);
      const context = content.substring(contextStart, contextEnd);
      
      events.push({
        date: `${year}-01-01`,
        title: `Event in ${year}`,
        description: context.trim().substring(0, 200)
      });
    });
  }
  
  return events;
}

// Display the timeline in the sidebar
function displayTimeline(events) {
  if (!events || events.length === 0) {
    timelineDiv.innerHTML = '<div class="empty-state">No timeline events found on this page.</div>';
    return;
  }
  
  let html = '';
  events.forEach(event => {
    const formattedDate = formatDate(event.date);
    html += `
      <div class="timeline-item">
        <div class="event-date">${formattedDate}</div>
        <div class="event-title">${escapeHtml(event.title || 'Untitled Event')}</div>
        <div class="event-description">${escapeHtml(event.description || 'No description')}</div>
      </div>
    `;
  });
  
  timelineDiv.innerHTML = html;
}

// Show status messages to user
function showStatus(message, type) {
  statusDiv.textContent = message;
  statusDiv.className = `status ${type}`;
  statusDiv.style.display = 'block';
  
  if (type === 'success') {
    setTimeout(() => {
      statusDiv.style.display = 'none';
    }, 3000);
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

// Prevent XSS by escaping HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}