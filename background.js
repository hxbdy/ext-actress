chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // URLが確定し、読み込みが完了したタイミングで通知
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes('video.dmm.co.jp/av/content/')) {
    chrome.tabs.sendMessage(tabId, { action: "RE_RUN_SCRIPT" }).catch(err => {
      // まだcontent scriptがロードされていない場合は無視
    });
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "fetchWiki") {
    fetch(request.url)
      .then(response => response.text())
      .then(html => sendResponse({ data: html }))
      .catch(error => sendResponse({ error: error.message }));
    return true; // 非同期処理のために必要
  }
});

