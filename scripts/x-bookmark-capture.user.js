// ==UserScript==
// @name         Bookmark Atlas: X bookmark capture
// @namespace    bookmark-atlas
// @version      0.1.0
// @description  Forward already-loaded X bookmark payloads to a local Bookmark Atlas receiver.
// @match        https://x.com/i/bookmarks*
// @match        https://x.com/i/history*
// @match        https://twitter.com/i/bookmarks*
// @match        https://twitter.com/i/history*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
  "use strict";

  const RECEIVER = "http://127.0.0.1:41009";
  const TOKEN_KEY = "bookmark-atlas-capture-token";
  const BATCH_SIZE = 25;
  const seen = new Set();
  let sessionId = null;
  let pending = [];
  let sending = Promise.resolve();

  function log(message) {
    console.info(`[Bookmark Atlas] ${message}`);
  }

  async function token() {
    let value = await GM_getValue(TOKEN_KEY, "");
    if (!value) {
      value = window.prompt("Bookmark Atlas receiver token:", "") || "";
      if (value) await GM_setValue(TOKEN_KEY, value);
    }
    if (!value) throw new Error("No Bookmark Atlas receiver token configured");
    return value;
  }

  function request(path, body) {
    return token().then((authToken) => new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: `${RECEIVER}${path}`,
        headers: {
          "content-type": "application/json",
          "x-bookmark-atlas-session-token": authToken,
        },
        data: JSON.stringify(body),
        timeout: 15000,
        onload: (response) => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`receiver returned HTTP ${response.status}`));
            return;
          }
          try {
            resolve(JSON.parse(response.responseText));
          } catch {
            reject(new Error("receiver returned invalid JSON"));
          }
        },
        onerror: () => reject(new Error("receiver request failed")),
        ontimeout: () => reject(new Error("receiver request timed out")),
      });
    }));
  }

  function isTweet(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      && typeof value.rest_id === "string"
      && (value.legacy || value.core || value.note_tweet);
  }

  function findTweets(value, result = []) {
    if (!value || typeof value !== "object") return result;
    if (isTweet(value)) result.push(value);
    if (Array.isArray(value)) {
      for (const item of value) findTweets(item, result);
    } else {
      for (const child of Object.values(value)) findTweets(child, result);
    }
    return result;
  }

  function enqueue(value) {
    for (const tweet of findTweets(value)) {
      if (seen.has(tweet.rest_id)) continue;
      seen.add(tweet.rest_id);
      pending.push(tweet);
    }
    if (pending.length >= BATCH_SIZE) flush();
  }

  function ensureSession() {
    if (sessionId) return Promise.resolve(sessionId);
    return request("/session/start", { source: "x-browser-userscript" })
      .then((result) => {
        sessionId = result.sessionId;
        log("capture session started");
        return sessionId;
      });
  }

  function flush() {
    if (!pending.length) return sending;
    const batch = pending.splice(0, BATCH_SIZE);
    sending = sending.then(() => ensureSession()
      .then((id) => request("/session/batch", { sessionId: id, bookmarks: batch }))
      .then((result) => log(`imported batch: ${result.imported ?? 0} new, ${result.updated ?? 0} updated`))
      .catch((error) => {
        pending.unshift(...batch);
        log(`capture paused: ${error.message}`);
      }));
    return sending;
  }

  function inspectJson(value) {
    try { enqueue(value); } catch (error) { log(`payload inspection failed: ${error.message}`); }
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    return originalFetch.apply(this, args).then((response) => {
      response.clone().json().then(inspectJson).catch(() => {});
      return response;
    });
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__bookmarkAtlasUrl = String(url);
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      if (!this.__bookmarkAtlasUrl) return;
      try { inspectJson(JSON.parse(this.responseText)); } catch {}
    });
    return originalSend.apply(this, args);
  };

  window.addEventListener("pagehide", () => { flush(); });
  log("watching X bookmark/history responses");
})();
