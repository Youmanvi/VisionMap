// Mark that our content script is loaded
window.timelineExtractorLoaded = true;

// Listen for requests to extract page content
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getPageContent") {
    try {
      console.log('Content script received getPageContent request');
      
      // Extract text content from the page
      let pageText = "";
      
      // Try multiple methods to get page content
      if (document.body) {
        pageText = document.body.innerText || document.body.textContent || "";
      }
      
      // If body text is empty, try getting text from main content areas
      if (!pageText || pageText.trim().length < 100) {
        const contentSelectors = [
          'main', 'article', '[role="main"]', '.content', '#content', 
          '.post', '.entry', '.article-body', '.story-body'
        ];
        
        for (const selector of contentSelectors) {
          const element = document.querySelector(selector);
          if (element) {
            const text = element.innerText || element.textContent || "";
            if (text.trim().length > pageText.length) {
              pageText = text;
            }
          }
        }
      }
      
      // If still no content, try getting all text
      if (!pageText || pageText.trim().length < 50) {
        pageText = document.documentElement.innerText || document.documentElement.textContent || "No content found";
      }
      
      const pageTitle = document.title || "Untitled Page";
      const pageUrl = window.location.href;
      
      console.log('Extracted content length:', pageText.length);
      
      // Send back the page content immediately
      const response = {
        title: pageTitle,
        url: pageUrl,
        content: pageText.substring(0, 5000), // Limit to first 5000 characters
        contentLength: pageText.length
      };
      
      sendResponse(response);
      console.log('Sent response to sidebar');
      
    } catch (error) {
      console.error('Content extraction error:', error);
      sendResponse({ 
        error: "Failed to extract page content: " + error.message,
        title: document.title || "Error",
        url: window.location.href,
        content: "",
        contentLength: 0
      });
    }
    
    // Return true to indicate we will send a response
    return true;
  }
});

console.log('Timeline Extractor content script loaded on:', window.location.href);