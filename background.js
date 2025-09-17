// Opens sidebar when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (error) {
    console.error('Failed to open sidebar:', error);
  }
});

// Handle messages between different parts of extension
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getPageContent") {
    console.log('Background: Received getPageContent request');
    
    // Get the active tab
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs || tabs.length === 0) {
        console.error('Background: No active tab found');
        sendResponse({ error: "No active tab found" });
        return;
      }
      
      const activeTab = tabs[0];
      console.log('Background: Active tab:', activeTab.url);
      
      // Check if we can access this tab
      if (activeTab.url.startsWith('chrome://') || 
          activeTab.url.startsWith('chrome-extension://') ||
          activeTab.url.startsWith('edge://') ||
          activeTab.url.startsWith('about:')) {
        console.error('Background: Cannot access chrome:// or extension pages');
        sendResponse({ error: "Cannot extract content from browser internal pages" });
        return;
      }
      
      // Ensure content script is injected
      try {
        await ensureContentScript(activeTab.id);
      } catch (injectionError) {
        console.warn('Background: Content script injection failed:', injectionError);
        // Continue anyway - script might already be loaded
      }
      
      // Send message to content script
      chrome.tabs.sendMessage(activeTab.id, message, (response) => {
        if (chrome.runtime.lastError) {
          console.error('Background: Content script communication failed:', chrome.runtime.lastError.message);
          sendResponse({ 
            error: `Content script not responding: ${chrome.runtime.lastError.message}. Try refreshing the page.` 
          });
        } else if (!response) {
          console.error('Background: No response from content script');
          sendResponse({ 
            error: "Content script not responding. Try refreshing the page." 
          });
        } else {
          console.log('Background: Content script responded successfully');
          sendResponse(response);
        }
      });
    });
    
    return true; // Keep message channel open for async response
  }
});

// Ensure content script is injected and loaded
async function ensureContentScript(tabId) {
  try {
    // First, check if content script is already loaded
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        return typeof window.timelineExtractorLoaded !== 'undefined';
      }
    });
    
    const isLoaded = results && results[0] && results[0].result;
    console.log('Background: Content script loaded status:', isLoaded);
    
    if (!isLoaded) {
      console.log('Background: Injecting content script');
      
      // Inject the content script
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['content.js']
      });
      
      // Wait a moment for it to initialize
      await new Promise(resolve => setTimeout(resolve, 500));
      
      console.log('Background: Content script injected successfully');
    }
    
  } catch (error) {
    console.error('Background: Failed to ensure content script:', error);
    throw error;
  }
}