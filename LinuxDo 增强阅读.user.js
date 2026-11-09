// ==UserScript==
// @name         LinuxDo 增强阅读
// @namespace    https://linux.do/
// @version      2.2.2
// @license      MIT
// @description  在 LINUX DO 与 IDC Flare 高性能浮窗阅读帖子，支持默认楼中楼、自动载入新回复、全表情点赞回应、列表发帖时间列、右侧时间轴、投票、剧透、视频、公式、大图压缩上传、删帖、历史收藏、双栏资料卡和 Obsidian 快照。
// @author       Fashion
// @match        https://linux.do/*
// @match        https://idcflare.com/*
// @icon         https://cdn3.ldstatic.com/optimized/4X/6/a/6/6a6affc7b1ce8140279e959d32671304db06d5ab_2_180x180.png
// @homepageURL  https://github.com/liansishen/linuxdo-read-script
// @updateURL    https://raw.githubusercontent.com/liansishen/linuxdo-read-script/main/LinuxDo%20%E5%A2%9E%E5%BC%BA%E9%98%85%E8%AF%BB.user.js
// @downloadURL  https://raw.githubusercontent.com/liansishen/linuxdo-read-script/main/LinuxDo%20%E5%A2%9E%E5%BC%BA%E9%98%85%E8%AF%BB.user.js
// @grant        unsafeWindow
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.setClipboard
// @grant        GM.xmlHttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const BASE = location.origin;
  const PAGE_WIN = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  const PAGE_SIZE = 40;
  const MAX_RENDERED_POSTS = 72;
  const READ_THRESHOLD = 1500;
  const FLUSH_INTERVAL = 5000;
  let ME_USERNAME = null;
  let ME_USER = null;
  let ME_STATE = 'unknown';

  // --- 楼中楼默认展开分批加载 & 自动载入新回复配置 ---
  const SUB_REPLY_INITIAL_SIZE = 5;   // 楼中楼默认自动展开条数
  const SUB_REPLY_PAGE_SIZE = 20;     // 点击“展示更多回复”每次追加条数
  const REPLIES_HOVER_DELAY = 200;    // 楼层进入视口后触发楼中楼补全延迟(ms)
  const AUTO_REFRESH_INTERVAL = 15000;// 自动检查并载入新回复间隔(ms)
  const AUTO_LOAD_REPLIES_KEY = 'ldp-auto-load-replies';
  const TOPIC_LIVE_LISTENERS = new Set();

  function onDomReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  /* ============ 0. 列表发帖时间列数据采集（document-start 拦截 fetch/XHR） ============ */
  const CREATED_AT_LS_KEY = 'linuxdo-topic-created-at';
  const CREATED_AT_MAX_CACHE = 4000;
  const CREATED_AT_COL_CLASS = 'topic-created-at';
  const CREATED_AT_COL_LABEL = '发帖';
  const CREATED_AT_THEME_MODES = { '-2': 'horizon', '105': 'classic', '106': 'classic' };
  const topicCreatedMap = new Map();
  let topicCreatedSaveTimer = 0;
  let scheduleTopicCreatedSweep = () => {};

  try {
    const savedCreated = JSON.parse(localStorage.getItem(CREATED_AT_LS_KEY) || '[]');
    for (let i = 0; i < savedCreated.length; i++) {
      if (Array.isArray(savedCreated[i]) && savedCreated[i][0] != null && savedCreated[i][1]) {
        topicCreatedMap.set(String(savedCreated[i][0]), savedCreated[i][1]);
      }
    }
    while (topicCreatedMap.size > CREATED_AT_MAX_CACHE) {
      topicCreatedMap.delete(topicCreatedMap.keys().next().value);
    }
  } catch (e) { /* ignore corrupted cache */ }

  function scheduleTopicCreatedSave() {
    if (topicCreatedSaveTimer) return;
    topicCreatedSaveTimer = setTimeout(() => {
      topicCreatedSaveTimer = 0;
      try {
        localStorage.setItem(CREATED_AT_LS_KEY, JSON.stringify(Array.from(topicCreatedMap)));
      } catch (e) { /* ignore quota error */ }
    }, 2000);
  }

  function putTopicCreated(id, iso) {
    if (id == null || !iso) return;
    const key = String(id);
    if (topicCreatedMap.has(key)) return;
    topicCreatedMap.set(key, iso);
    while (topicCreatedMap.size > CREATED_AT_MAX_CACHE) {
      topicCreatedMap.delete(topicCreatedMap.keys().next().value);
    }
    scheduleTopicCreatedSave();
    scheduleTopicCreatedSweep();
  }

  function harvestTopicCreatedData(data) {
    if (!data || typeof data !== 'object') return;
    const topics = data.topic_list && data.topic_list.topics;
    if (Array.isArray(topics)) {
      for (let i = 0; i < topics.length; i++) {
        const t = topics[i];
        if (t && t.id != null && t.created_at) putTopicCreated(t.id, t.created_at);
      }
      return;
    }
    if (Array.isArray(data)) {
      for (let k = 0; k < data.length; k++) {
        const msg = data[k];
        if (Array.isArray(msg)) {
          const channel = typeof msg[0] === 'string' ? msg[0] : '';
          const payload = msg[1];
          if (payload && typeof payload === 'object') harvestTopicCreatedData(payload);
          const topicMatch = channel.match(/^\/topic\/(\d+)$/);
          if (topicMatch && payload && typeof payload === 'object') {
            TOPIC_LIVE_LISTENERS.forEach((listener) => {
              try { listener(topicMatch[1], payload); } catch (e) {}
            });
          }
        }
      }
      return;
    }
    if (data.id != null && data.created_at && (data.post_stream || Array.isArray(data.posters) || data.slug)) {
      putTopicCreated(data.id, data.created_at);
    }
  }

  function isDiscourseHarvestUrl(url) {
    return typeof url === 'string' && (/\.json(\?|#|$)/.test(url) || /message-bus\/.+\/poll/.test(url));
  }

  const nativePageFetch = PAGE_WIN.fetch;
  if (typeof nativePageFetch === 'function' && !nativePageFetch.__ldpHarvestHooked) {
    const wrappedFetch = function (input) {
      const promise = nativePageFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (isDiscourseHarvestUrl(url)) {
          promise.then((res) => {
            try { res.clone().json().then(harvestTopicCreatedData, () => {}); } catch (e) {}
          }, () => {});
        }
      } catch (e) {}
      return promise;
    };
    wrappedFetch.__ldpHarvestHooked = true;
    try { PAGE_WIN.fetch = wrappedFetch; } catch (e) {}
  }

  const PageXHR = PAGE_WIN.XMLHttpRequest && PAGE_WIN.XMLHttpRequest.prototype;
  if (PageXHR && !PageXHR.__ldpHarvestHooked) {
    const origOpen = PageXHR.open;
    const origSend = PageXHR.send;
    PageXHR.open = function (method, url) {
      this.__ldpHarvestUrl = isDiscourseHarvestUrl(url);
      return origOpen.apply(this, arguments);
    };
    PageXHR.send = function () {
      if (this.__ldpHarvestUrl) {
        this.addEventListener('load', () => {
          try {
            if (this.responseType === 'json') harvestTopicCreatedData(this.response);
            else if (this.responseType === '' || this.responseType === 'text') {
              harvestTopicCreatedData(JSON.parse(this.responseText));
            }
          } catch (e) {}
        });
      }
      return origSend.apply(this, arguments);
    };
    PageXHR.__ldpHarvestHooked = true;
  }

  // --- 全局只读请求队列 & HTTP 429 退避重试 ---
  const REQUEST_MIN_INTERVAL = 100;   // 相邻 GET 请求最小间隔(ms)
  const REQUEST_MAX_CONCURRENCY = 3;
  const RETRY_MAX_ATTEMPTS = 3;       // 429 最多重试次数（不含首次请求）
  const RETRY_BASE_DELAY = 500;       // 无 Retry-After 时的指数退避基础延迟(ms)
  const SLICE_RADIUS = 20;            // 定位楼层前后各预加载的窗口半径
  const TOPIC_CACHE_FRESH_MS = 90 * 1000;
  const TOPIC_CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
  const TOPIC_CACHE_MAX_COUNT = 50;
  const TOPIC_CACHE_MAX_BYTES = 25 * 1024 * 1024;
  const TOPIC_SNAPSHOT_WRITES = new Map();
  const HISTORY_KEY = 'ldp-reader-history-v1';
  const DB_NAME = 'linuxdo-convenience-reader-v1';
  const DB_VERSION = 1;
  const REQUEST_PRIORITY = { target: 0, visible: 1, background: 2 };
  let lastRequestTime = 0;
  let requestSequence = 0;
  let activeGetRequests = 0;
  let globalCooldownUntil = 0;
  let requestPumpTimer = null;
  const requestQueue = [];
  const inflightGetRequests = new Map();
  const cooldownChannel = typeof BroadcastChannel === 'function'
    ? new BroadcastChannel('ldp-reader-request-cooldown-v1') : null;

  const MENU_PANEL_SEL = '.menu-panel, .user-menu, .quick-access-panel, .notifications';
  const SEARCH_SEL = '.search-results, .fps-result, .search-menu, .search-menu-container, .search-result-topic';
  const USER_CARD_CACHE_TTL = 5 * 60 * 1000;
  const USER_CARD_CACHE = new Map();
  let REACTIONS_AVAILABLE = null;
  let CURRENT_USER_CARD = null;

  /* ============ 1. 样式 ============ */
  const style = document.createElement('style');
  style.textContent = `
    .ldp-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;
      align-items:center;justify-content:center;background:rgba(0,0,0,.55);}
    .ldp-modal{display:flex;flex-direction:column;
      width: 90%;max-width: 1080px;height:90vh;
      border-radius:12px;overflow:hidden;font-size:16px;
      line-height:1.65;background:var(--secondary,#fff);color:var(--primary,#222);
      box-shadow:0 16px 50px rgba(0,0,0,.4);}
    .ldp-header{display:flex;align-items:flex-start;gap:10px;padding:16px 20px;
      border-bottom:1px solid var(--primary-low,#e5e5e5);}
    .ldp-header-main{flex:1;min-width:0;}
    .ldp-title-lockup{display:flex;align-items:flex-start;gap:9px;min-width:0;}
    .ldp-title-copy{flex:1;min-width:0;}
    .ldp-title{margin:0;font-size:18px;font-weight:700;line-height:1.35;}
    .ldp-meta{font-size:12px;opacity:.7;margin-top:4px;}
    .ldp-head-btns{display:flex;gap:8px;align-items:center;}
    .ldp-close{cursor:pointer;border:none;background:transparent;font-size:22px;
      line-height:1;color:inherit;padding:0 4px;}
    /* Obsidian 快照操作沿用论坛主题，保持工具按钮视觉一致 */
    .ldp-obsidian-actions{display:inline-flex;align-items:center;gap:6px;flex:none;}
    .ldp-obsidian-save,.ldp-obsidian-copy,.ldp-obsidian-settings{display:inline-flex;align-items:center;
      justify-content:center;border:1px solid transparent;border-radius:7px;cursor:pointer;
      font:600 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      transition:background-color .16s ease,border-color .16s ease,color .16s ease,opacity .16s ease;}
    .ldp-obsidian-save svg,.ldp-obsidian-copy svg,.ldp-obsidian-settings svg{width:16px;height:16px;fill:currentColor;flex:none;}
    .ldp-obsidian-label{display:none;}
    .ldp-obsidian-save,.ldp-obsidian-copy,.ldp-obsidian-settings{width:32px;height:32px;padding:0;color:var(--primary-medium,#667085);
      background:var(--primary-very-low,#f7f7f8);border-color:var(--primary-low,#e5e7eb);}
    .ldp-obsidian-save:hover,.ldp-obsidian-copy:hover,.ldp-obsidian-settings:hover{color:var(--primary,#1f2937);
      border-color:var(--primary-medium,#9ca3af);background:var(--primary-low,#e9e9e9);}
    .ldp-obsidian-save:disabled,.ldp-obsidian-copy:disabled,.ldp-obsidian-settings:disabled{cursor:wait;opacity:.62;}
    .ldp-obsidian-save:focus-visible,.ldp-obsidian-copy:focus-visible,.ldp-obsidian-settings:focus-visible,
    .ldp-obsidian-dialog button:focus-visible,.ldp-obsidian-dialog input:focus-visible,
    .ldp-obsidian-dialog select:focus-visible{outline:2px solid #2f855a;outline-offset:2px;}
    .ldp-obsidian-page-actions{width:max-content;margin:8px 0 8px auto;}
    .ldp-obsidian-dialog-overlay{position:fixed;inset:0;z-index:2147483640;display:grid;
      place-items:center;padding:20px;background:rgba(10,12,18,.58);backdrop-filter:blur(3px);}
    .ldp-obsidian-dialog{width:min(540px,100%);max-height:calc(100vh - 40px);overflow:auto;
      box-sizing:border-box;padding:22px;border:1px solid var(--primary-low,#e5e7eb);
      border-radius:13px;color:var(--primary,#1f2937);background:var(--secondary,#fff);
      box-shadow:0 22px 70px rgba(0,0,0,.34);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
    .ldp-obsidian-dialog-head{display:flex;align-items:flex-start;justify-content:space-between;
      gap:16px;margin-bottom:16px;}
    .ldp-obsidian-dialog h2{margin:0;font-size:20px;line-height:1.3;}
    .ldp-obsidian-dialog-subtitle{margin:4px 0 0;color:var(--primary-medium,#667085);font-size:12px;}
    .ldp-obsidian-dialog-close{border:0;background:transparent;color:inherit;cursor:pointer;
      padding:0 4px;font-size:24px;line-height:1;}
    .ldp-obsidian-dialog label{display:block;margin:13px 0 5px;font-weight:650;}
    .ldp-obsidian-dialog input,.ldp-obsidian-dialog select{width:100%;box-sizing:border-box;
      padding:9px 10px;border:1px solid var(--primary-low-mid,#cfd4dc);border-radius:7px;
      color:var(--primary,#1f2937);background:var(--secondary,#fff);font:inherit;}
    .ldp-obsidian-dialog-help{margin:5px 0 0;color:var(--primary-medium,#667085);font-size:12px;}
    .ldp-obsidian-dialog-note{margin:0 0 14px;padding:10px 12px;border-left:3px solid #2f855a;
      border-radius:0 7px 7px 0;background:rgba(47,133,90,.08);font-size:12px;}
    .ldp-obsidian-dialog-status{min-height:21px;margin-top:12px;color:var(--primary-medium,#667085);
      font-size:13px;}
    .ldp-obsidian-dialog-status[data-type="error"]{color:var(--danger,#b42318);}
    .ldp-obsidian-dialog-status[data-type="success"]{color:#15803d;}
    .ldp-obsidian-confirm-icon{display:grid;width:42px;height:42px;margin-bottom:14px;
      place-items:center;border-radius:11px;color:#26734d;background:rgba(47,133,90,.11);
      font-size:24px;font-weight:700;}
    .ldp-obsidian-confirm-copy{margin:8px 0 0;color:var(--primary-medium,#667085);}
    .ldp-obsidian-confirm-path{display:block;margin-top:14px;padding:9px 10px;overflow-wrap:anywhere;
      border:1px solid var(--primary-low,#e5e7eb);border-radius:7px;
      color:var(--primary,#1f2937);background:var(--primary-very-low,#f7f7f8);font-size:12px;}
    .ldp-obsidian-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px;}
    .ldp-obsidian-dialog-actions button,.ldp-obsidian-test{border:0;border-radius:7px;
      padding:8px 12px;cursor:pointer;font:inherit;font-size:13px;font-weight:600;line-height:1.2;}
    .ldp-obsidian-dialog button:disabled{cursor:wait;opacity:.62;}
    .ldp-obsidian-primary{color:#fff;background:#2f855a;}
    .ldp-obsidian-primary:hover{background:#26734d;}
    .ldp-obsidian-secondary,.ldp-obsidian-test{color:var(--primary,#1f2937);
      background:var(--primary-low,#e9eaec);}
    .ldp-obsidian-test{margin-top:10px;}
    .ldp-obsidian-toast{position:fixed;right:20px;bottom:20px;z-index:2147483641;
      max-width:min(460px,calc(100vw - 40px));padding:11px 14px;border-radius:9px;
      color:#fff;background:#24262d;box-shadow:0 10px 32px rgba(0,0,0,.28);
      font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
    .ldp-obsidian-toast[data-type="success"]{background:#166534;}
    .ldp-obsidian-toast[data-type="error"]{background:#b42318;}
    @media (prefers-reduced-motion:reduce){
      .ldp-obsidian-save,.ldp-obsidian-copy,.ldp-obsidian-settings{transition:none;}
    }
    .ldp-shell{flex:1;min-width:0;min-height:0;position:relative;display:flex;overflow:hidden;}
    .ldp-body{flex:1;min-width:0;min-height:0;position:relative;
      padding:8px 20px 20px;overflow-y:auto;overscroll-behavior:contain;
      scrollbar-width:none;overflow-anchor:none;}
    .ldp-body::-webkit-scrollbar{width:0;height:0;}

    /* 右侧时间轴 */
    .ldp-timeline{flex:0 0 96px;display:flex;flex-direction:column;align-items:center;
      gap:8px;padding:12px 10px;
      background:var(--secondary,#fff);color:var(--primary-medium,#666);}
    .ldp-tl-date,.ldp-tl-current{border:none;
      background:transparent;color:inherit;font:inherit;}
    .ldp-tl-date{cursor:pointer;}
    .ldp-tl-date{width:100%;min-height:36px;padding:4px 2px;border-radius:6px;
      font-size:13px;line-height:1.25;text-align:center;}
    .ldp-tl-date:hover{
      background:var(--primary-low,#f0f0f0);color:var(--tertiary,#08c);}
    .ldp-tl-current{width:100%;min-height:58px;padding:5px 2px;border-radius:6px;
      line-height:1.25;text-align:center;}
    .ldp-tl-current strong{display:block;font-size:17px;color:var(--primary,#222);}
    .ldp-tl-current span{display:block;margin-top:3px;font-size:12px;opacity:.7;}
    .ldp-tl-track{position:relative;flex:1;width:44px;min-height:130px;border:none;
      padding:0;background:transparent;cursor:pointer;}
    .ldp-tl-track::before{content:"";position:absolute;top:8px;bottom:8px;left:50%;
      width:2px;transform:translateX(-50%);background:var(--primary-low,#e6e6e6);}
    .ldp-tl-fill{position:absolute;top:8px;bottom:8px;left:50%;width:3px;
      transform:translateX(-50%) scaleY(0);transform-origin:center top;
      will-change:transform;border-radius:999px;background:var(--tertiary,#08c);}
    .ldp-tl-thumb{position:absolute;left:50%;top:8px;width:14px;height:14px;
      transform:translate(-50%,-50%) translateY(0);will-change:transform;
      border-radius:50%;background:var(--tertiary,#08c);
      box-shadow:0 0 0 4px rgba(8,132,255,.14);}
    .ldp-tl-loading .ldp-tl-date,.ldp-tl-loading .ldp-tl-track{opacity:.6;cursor:progress;}
    .ldp-tl-date:focus-visible,.ldp-tl-track:focus-visible{
      outline:2px solid var(--tertiary,#08c);outline-offset:2px;}
    @media (max-width: 760px){
      .ldp-modal{width:96%;height:92vh;}
      .ldp-header{padding-left:16px;padding-right:16px;}
      .ldp-obsidian-label{display:none;}
      .ldp-obsidian-save{width:32px;padding:0;}
      .ldp-obsidian-page-actions{margin-top:6px;}
      .ldp-obsidian-dialog-overlay{padding:10px;}
      .ldp-obsidian-dialog{max-height:calc(100vh - 20px);padding:18px;}
      .ldp-body{padding-right:76px;}
      .ldp-timeline{position:absolute;right:8px;top:8px;bottom:8px;z-index:4;
        width:58px;flex-basis:auto;padding:8px 6px;border:1px solid var(--primary-low,#eee);
        border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.14);}
      .ldp-tl-date{font-size:11px;}
      .ldp-tl-current strong{font-size:13px;}
      .ldp-tl-current span{display:none;}
    }
    @media (max-width: 420px){
      .ldp-header{gap:6px;}
      .ldp-title-lockup{gap:7px;}
      .ldp-title{font-size:16px;}
    }

    /* 楼主帖自身的点赞/回复按钮已挪到底部操作栏，这里隐藏原位置 */
    .ldp-topic > .ldp-post > .ldp-actions{display:none;}

    /* 骨架屏 */
    .ldp-loadmask{position:absolute;inset:0;z-index:5;
      padding:8px 20px 20px;overflow:hidden;
      background:var(--secondary,#fff);color:inherit;}
    .ldp-loadmask.hide{opacity:0;pointer-events:none;transition:opacity .25s ease;}
    .ldp-sk{position:relative;overflow:hidden;border-radius:6px;
      background:var(--primary-low,#e9e9e9);}
    .ldp-sk::after{content:"";position:absolute;inset:0;
      transform:translateX(-100%);
      background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);
      animation:ldp-shimmer 1.2s infinite;}
    @keyframes ldp-shimmer{100%{transform:translateX(100%);}}
    .ldp-sk-title{height:18px;width:55%;border-radius:6px;
      display:inline-block;vertical-align:middle;}
    .ldp-sk-meta{height:11px;width:35%;border-radius:5px;
      display:inline-block;}
    .ldp-sk-head{display:flex;align-items:center;gap:10px;margin:12px 0 10px;}
    .ldp-sk-avatar{width:32px;height:32px;border-radius:50%;flex:none;}
    .ldp-sk-line{height:12px;}
    .ldp-sk-w30{width:30%;} .ldp-sk-w40{width:40%;} .ldp-sk-w60{width:60%;}
    .ldp-sk-w80{width:80%;} .ldp-sk-w90{width:90%;} .ldp-sk-w100{width:100%;}
    .ldp-sk-para .ldp-sk-line{margin-bottom:8px;}
    .ldp-sk-divider{height:1px;background:var(--primary-low,#e0e0e0);margin:16px 0 12px;}
    .ldp-sk-comment{display:flex;gap:10px;margin-bottom:18px;}
    .ldp-sk-comment .ldp-sk-avatar{width:28px;height:28px;}
    .ldp-sk-cbody{flex:1;}

    /* 楼主帖区块 */
    .ldp-topic{padding:4px 0 14px;}
    .ldp-topic .ldp-post{border-bottom:none;}

    /* 评论区分隔 + 左上角“评论”标题 */
    .ldp-comments-header{display:flex;align-items:center;gap:8px;
      margin:6px 0 2px;padding-top:14px;border-top:2px solid var(--primary-low,#e0e0e0);
      font-size:16px;font-weight:700;letter-spacing:.5px;}
    .ldp-comments-header::before{content:"💬";font-size:14px;}
    .ldp-comments-count{font-size:12px;font-weight:500;opacity:.6;}
    .ldp-comments{padding-top:4px;}
    .ldp-comments-empty{padding:18px 0;text-align:center;opacity:.5;font-size:13px;}

    .ldp-post{padding:12px 0 12px 12px;border-bottom:1px solid var(--primary-low,#eee);}
    .ldp-topic > .ldp-post,.ldp-comments > .ldp-post{
      content-visibility:auto;contain-intrinsic-size:auto 180px;}
    .ldp-post.ldp-flash{animation:ldp-flash-bg 1.6s ease;}
    @keyframes ldp-flash-bg{
      0%{background:rgba(8,132,255,.16);}
      100%{background:transparent;}
    }
    .ldp-post-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;}
    .ldp-avatar-btn{flex:none;width:28px;height:28px;padding:0;border:none;border-radius:50%;
      background:transparent;color:inherit;cursor:pointer;position:relative;}
    .ldp-avatar{width:28px;height:28px;border-radius:50%;display:block;}
    .ldp-avatar-btn:hover .ldp-avatar{box-shadow:0 0 0 3px rgba(8,132,255,.18);}
    .ldp-avatar-btn:focus-visible{outline:2px solid var(--tertiary,#08c);outline-offset:2px;}
    .ldp-user-card{position:fixed;z-index:2147483300;width:min(390px,calc(100vw - 24px));
      max-height:calc(100vh - 24px);overflow-y:auto;overscroll-behavior:contain;
      border:1px solid var(--primary-low,#e5e5e5);border-radius:10px;
      background:var(--secondary,#fff);color:var(--primary,#222);
      box-shadow:0 18px 50px rgba(0,0,0,.24);font-size:14px;line-height:1.45;}
    .ldp-user-card-cover{height:82px;background:
      linear-gradient(135deg,rgba(8,132,255,.18),rgba(128,128,128,.08));background-size:cover;background-position:center;}
    .ldp-user-card-body{padding:0 14px 14px;}
    .ldp-user-card-main{display:flex;gap:12px;align-items:flex-end;margin-top:-34px;}
    .ldp-user-card-avatar{width:76px;height:76px;padding:0;border:3px solid var(--secondary,#fff);
      border-radius:50%;background:var(--secondary,#fff);cursor:pointer;flex:none;}
    .ldp-user-card-avatar img{width:100%;height:100%;display:block;border-radius:50%;}
    .ldp-user-card-avatar:hover{box-shadow:0 0 0 4px rgba(8,132,255,.18);}
    .ldp-user-card-avatar:focus-visible{outline:2px solid var(--tertiary,#08c);outline-offset:2px;}
    .ldp-user-card-name{min-width:0;padding-bottom:4px;}
    .ldp-user-card-name strong{display:block;font-size:22px;line-height:1.1;}
    .ldp-user-card-name span{display:block;opacity:.68;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .ldp-user-card-name .ldp-user-level{display:inline-flex;max-width:100%;margin-top:7px;
      padding:3px 8px;border:1px solid var(--primary-low,#dfe3e8);border-radius:999px;
      color:var(--primary-high,#374151);background:var(--primary-very-low,#f6f7f8);
      font-size:11px;font-weight:700;line-height:1.25;letter-spacing:.01em;opacity:1;}
    .ldp-user-card-loading,.ldp-user-card-error{padding:16px;opacity:.72;}
    .ldp-user-card-bio{margin:12px 0 0;color:var(--primary,#222);}
    .ldp-user-card-meta{display:grid;gap:5px;margin:12px 0 0;font-size:13px;opacity:.82;}
    .ldp-user-card-meta a{color:var(--tertiary,#08c);text-decoration:none;}
    .ldp-user-card-meta a:hover{text-decoration:underline;}
    .ldp-user-card-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px;}
    .ldp-user-card-stat{padding:8px;border-radius:8px;background:var(--primary-very-low,#f6f6f6);text-align:center;}
    .ldp-user-card-stat strong{display:block;font-size:16px;line-height:1.2;}
    .ldp-user-card-stat span{display:block;margin-top:2px;font-size:12px;opacity:.65;}
    .ldp-author{font-weight:600;}
    .ldp-op{font-size:11px;font-weight:700;color:#fff;background:var(--tertiary,#08c);
      border-radius:4px;padding:1px 6px;letter-spacing:.5px;}
    .ldp-me{font-size:11px;font-weight:700;color:#fff;background:#3ea66b;
      border-radius:4px;padding:1px 6px;letter-spacing:.5px;}
    .ldp-user{font-size:12px;opacity:.6;}
    .ldp-time{font-size:12px;opacity:.55;}
    .ldp-floor{font-size:12px;opacity:.5;margin-left:auto;
      padding-left:8px;white-space:nowrap;}
    .ldp-unread-dot{display:inline-block;visibility:hidden;flex:none;width:8px;height:8px;border-radius:50%;
      background:#55c7f7;box-shadow:0 0 0 3px rgba(85,199,247,.18);
      margin-left:2px;}
    .ldp-post.ldp-unread > .ldp-post-head .ldp-unread-dot{visibility:visible;}
    .ldp-content img{max-width:100%;height:auto;cursor:zoom-in;border-radius:4px;}
    .ldp-content pre{overflow:auto;background:var(--primary-very-low,#f6f6f6);
      padding:10px;border-radius:6px;}

    /* Base64 解码 */
    .ldp-base64-selection-menu{position:fixed;z-index:2147483550;display:block;
      padding:4px;border:1px solid var(--primary-low,#ddd);border-radius:7px;
      background:var(--secondary,#fff);color:var(--primary,#222);
      box-shadow:0 8px 24px rgba(0,0,0,.2);}
    .ldp-base64-selection-menu[hidden]{display:none;}
    .ldp-base64-selection-menu button{display:flex;align-items:center;gap:6px;
      min-height:32px;padding:5px 10px;border:none;border-radius:5px;cursor:pointer;
      background:transparent;color:inherit;font:inherit;font-size:13px;white-space:nowrap;}
    .ldp-base64-selection-menu button:hover{background:var(--primary-low,#eee);}
    .ldp-base64-result{position:relative;margin:8px 0;min-height:42px;
      overflow:hidden;border:none;border-radius:4px;
      background:var(--primary-very-low,#f6f6f6);color:var(--primary,#222);}
    .ldp-base64-result pre{box-sizing:border-box;max-height:420px;min-height:42px;
      margin:0;padding:11px 78px 11px 14px;overflow:auto;border:none;
      border-radius:inherit;background:transparent;color:inherit;
      font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere;}
    .ldp-base64-result code{font-family:ui-monospace,SFMono-Regular,Consolas,
      "Liberation Mono",monospace;}
    .ldp-base64-toolbar{position:absolute;top:50%;right:7px;z-index:1;
      display:flex;gap:2px;transform:translateY(-50%);}
    .ldp-base64-toolbar button{display:grid;min-width:28px;width:28px;height:28px;
      place-items:center;padding:5px;border:none;border-radius:4px;cursor:pointer;
      background:transparent;color:var(--primary-medium,#777);
      font:inherit;font-size:18px;line-height:1;box-shadow:none;}
    .ldp-base64-toolbar button:hover{color:var(--primary,#222);
      background:var(--primary-low,#e9e9e9);}
    .ldp-base64-toolbar button:focus-visible{outline:2px solid var(--tertiary,#08c);
      outline-offset:1px;}
    .ldp-base64-toolbar button:disabled{cursor:default;opacity:.65;}
    .ldp-base64-toolbar button.ldp-base64-copy.copied{width:auto;padding-inline:7px;
      font-size:12px;white-space:nowrap;}
    .ldp-base64-toolbar svg{display:block;width:16px;height:16px;fill:currentColor;}

    /* 弹窗正文代码块工具栏（原站会运行组件补按钮，弹窗需自行补齐） */
    .ldp-codeblock-host{position:relative;}
    .ldp-codeblock-host > pre{padding-right:48px;}
    .ldp-codeblock-toolbar{position:absolute;top:6px;right:10px;z-index:2;
      display:flex;gap:2px;}
    .ldp-codeblock-toolbar button{display:grid;width:28px;height:28px;place-items:center;
      padding:5px;border:none;border-radius:4px;cursor:pointer;box-shadow:none;
      background:transparent;color:var(--primary-medium,#888);}
    .ldp-codeblock-toolbar button:hover{background:var(--primary-low,#e8e8e8);
      color:var(--primary,#222);}
    .ldp-codeblock-toolbar button:focus-visible{outline:2px solid var(--tertiary,#08c);
      outline-offset:1px;}
    .ldp-codeblock-toolbar button:disabled{cursor:default;opacity:.65;}
    .ldp-codeblock-toolbar svg{display:block;width:16px;height:16px;fill:currentColor;}
    .ldp-children{margin-left:22px;
      border-left:1px solid var(--tertiary,#08c);}
    .ldp-actions{display:flex;gap:14px;margin-top:8px;font-size:12px;align-items:center;}
    .ldp-btn{cursor:pointer;border:none;background:transparent;color:inherit;
      opacity:.7;display:inline-flex;align-items:center;gap:4px;padding:2px 4px;}
    .ldp-btn:hover{opacity:1;}
    .ldp-btn:disabled{cursor:default;opacity:.4;}
    .ldp-like.liked{color:var(--love,#e25822);opacity:1;font-weight:600;}
    
    .ldp-replybox{margin-top:8px;display:none;position:relative;}
    .ldp-replybox.open{display:block;}
    .ldp-replybox textarea{width:100%;min-height:90px;box-sizing:border-box;
      border:1px solid var(--primary-low,#ccc);border-radius:6px;padding:8px;
      font:inherit;background:var(--secondary,#fff);color:inherit;resize:vertical;}
    .ldp-replybox textarea.uploading{opacity:0.6;pointer-events:none;}
    .ldp-send{margin-top:6px;background:var(--tertiary,#08c);color:#fff;border:none;
      border-radius:6px;padding:6px 14px;cursor:pointer;}
    .ldp-reply-tip{margin-left:10px;font-size:12px;color:#3ea66b;opacity:0;
      transition:opacity .25s ease;}
    .ldp-reply-tip.show{opacity:1;}
    
    .ldp-loading-tip{padding:14px 0;text-align:center;font-size:13px;
      color:var(--primary-medium,#888);display:none;user-select:none;}
    .ldp-loading-tip.show{display:block;}
    .ldp-loading-tip .ldp-tip-icon{display:inline-block;margin-right:6px;
      animation:ldp-spin .9s linear infinite;}
    @keyframes ldp-spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}

    .ldp-load-up-tip,.ldp-load-down-tip{display:none;padding:9px 0;text-align:center;
      font-size:12px;color:var(--primary-medium,#888);user-select:none;}
    .ldp-load-up-tip.show,.ldp-load-down-tip.show{display:block;}
    .ldp-load-up-tip .ldp-tip-icon,.ldp-load-down-tip .ldp-tip-icon{
      display:inline-block;margin-right:5px;animation:ldp-spin .9s linear infinite;}
    .ldp-top-tip{padding:10px 0;text-align:center;font-size:12px;
      color:var(--primary-medium,#888);user-select:none;}

    .ldp-bottom-tip{padding:16px 0;text-align:center;font-size:13px;
      color:var(--primary-medium,#888);user-select:none;}

    /* 灯箱 */
    .ldp-lightbox{position:fixed;inset:0;z-index:2147483600;display:flex;
      flex-direction:column;background:rgba(0,0,0,.9);}
    .ldp-lb-stage{flex:1;overflow:auto;display:flex;align-items:center;
      justify-content:center;padding:20px;}
    .ldp-lb-stage img{display:block;max-width:94vw;max-height:88vh;
      width:auto;height:auto;border-radius:4px;cursor:zoom-out;
      box-shadow:0 10px 40px rgba(0,0,0,.6);}
    .ldp-lb-x{position:fixed;top:12px;right:12px;z-index:1;display:grid;
      width:44px;height:44px;place-items:center;cursor:pointer;
      border:1px solid rgba(255,255,255,.45);border-radius:4px;
      background:rgba(0,0,0,.35);color:#fff;font-size:30px;line-height:1;}
    .ldp-lb-x:hover{background:rgba(255,255,255,.14);}
    .ldp-lb-x:focus-visible{outline:3px solid #fff;outline-offset:2px;}

    /* 楼中楼“展示更多回复”按钮与加载状态 */
    .ldp-sub-actions{margin-left:31px;padding-left:12px;margin-top:4px;display:none;}
    .ldp-load-more-replies{font-size:12px;color:#28724d;font-weight:600;opacity:.92;padding:4px 8px;border-radius:5px;}
    .ldp-load-more-replies:hover{opacity:1;background:#edf6f1;text-decoration:none;}
    .ldp-sub-loading{font-size:12px;opacity:.58;margin-left:31px;padding-left:12px;margin-top:4px;display:none;}
    /* ============ Boost样式（仿官方 discourse-boosts 插件，独立实现） ============ */
    /* 气泡列表 */
    .ldp-boosts-list{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-top:6px;min-height:0;}
    /* 单个气泡：胶囊形，与官方 bubble 对齐 */
    .ldp-boost-bubble{display:inline-flex;align-items:center;gap:4px;
      padding:3px 8px 3px 4px;border:none;
      background:rgba(128,128,128,.1);border-radius:50px;
      font-size:14px;line-height:1.4;cursor:default;position:relative;
      transition:background .15s;}
    .ldp-boost-bubble:hover{background:rgba(128,128,128,.18);}
    /* 气泡内头像 */
    .ldp-b-avatar{width:18px;height:18px;border-radius:50%;flex:none;display:block;}
    /* 气泡内文字/表情段落 */
    .ldp-boost-bubble p{margin:0;display:inline-flex;gap:2px;align-items:center;flex-wrap:wrap;}
    .ldp-boost-bubble p img.emoji{width:14px;height:14px;margin:0;vertical-align:middle;}
    /* 删除按钮：hover 气泡时才显示 */
    .ldp-boost-del{cursor:pointer;margin-left:2px;opacity:0;font-size:13px;
      color:var(--danger,#cc4b4b);line-height:1;border:none;background:transparent;
      padding:0 2px;transition:opacity .15s;flex:none;}
    .ldp-boost-bubble:hover .ldp-boost-del{opacity:.65;}
    .ldp-boost-del:hover{opacity:1!important;}
    /* 发射输入框容器：默认隐藏，.open 时展开 */
    .ldp-boost-input-wrap{display:none;align-items:center;gap:5px;margin-top:6px;
      padding:4px 6px;border-radius:8px;
      border:1px solid var(--primary-low,#ddd);
      background:var(--secondary,#fff);}
    .ldp-boost-input-wrap.open{display:flex;}
    /* 输入框本身 */
    .ldp-boost-input{flex:1;border:none;background:transparent;outline:none;
      font-size:13px;padding:2px 4px;color:inherit;min-width:0;}
    .ldp-boost-input::placeholder{color:var(--primary-medium,#999);font-size:12px;}
    /* 发射确认按钮（绿色圆形） */
    .ldp-boost-submit{width:22px;height:22px;padding:0;display:flex;flex:none;
      align-items:center;justify-content:center;border-radius:50%;
      border:1px solid #3ea66b;background:transparent;color:#3ea66b;
      cursor:pointer;font-size:14px;line-height:1;transition:all .15s;}
    .ldp-boost-submit:hover{background:#3ea66b;color:#fff;}
    .ldp-boost-submit:disabled{opacity:.5;cursor:default;pointer-events:none;}
    /* 取消按钮（红色圆形） */
    .ldp-boost-cancel{width:22px;height:22px;padding:0;display:flex;flex:none;
      align-items:center;justify-content:center;border-radius:50%;
      border:1px solid var(--danger,#cc4b4b);background:transparent;
      color:var(--danger,#cc4b4b);cursor:pointer;font-size:16px;line-height:1;
      transition:all .15s;}
    .ldp-boost-cancel:hover{background:var(--danger,#cc4b4b);color:#fff;}
    /* 操作栏里的火箭按钮 */
    .ldp-btn.ldp-boost-btn{font-size:12px;}
    .ldp-btn.ldp-boost-btn:disabled{opacity:.35;cursor:default;pointer-events:none;}

    /* 2.0 阅读器：安静的论坛工作台，绿色只表达阅读关系和当前状态 */
    .ldp-overlay.ldp-v2{padding:4vh 3vw;box-sizing:border-box;background:rgba(18,22,20,.58);backdrop-filter:blur(2px);}
    .ldp-v2 .ldp-modal{position:relative;width:min(1080px,94vw);max-width:none;height:86vh;
      border:1px solid var(--primary-low,#dfe4e1);border-radius:8px;background:var(--secondary,#fff);
      box-shadow:0 24px 70px rgba(15,23,18,.32);}
    .ldp-v2 .ldp-header{display:block;flex:none;padding:12px 16px 10px;background:var(--secondary,#fff);}
    .ldp-v2 .ldp-header-line{display:flex;align-items:flex-start;gap:11px;min-width:0;}
    .ldp-v2 .ldp-header-close{flex:none;margin-left:auto;}
    .ldp-site-mark{width:34px;height:34px;flex:none;border-radius:7px;object-fit:cover;background:#1f8f58;}
    .ldp-v2 .ldp-title-lockup{align-items:center;gap:8px;}
    .ldp-v2 .ldp-title{font-size:17px;line-height:1.35;letter-spacing:0;}
    .ldp-v2 .ldp-meta{display:flex;align-items:center;flex-wrap:wrap;gap:5px;margin-top:3px;color:var(--primary-medium,#66706a);opacity:1;}
    .ldp-topic-taxonomy{display:flex;gap:5px;flex-wrap:wrap;}
    .ldp-topic-chip{display:inline-flex;align-items:center;min-height:20px;padding:1px 6px;border:1px solid var(--primary-low,#dfe4e1);
      border-radius:4px;background:var(--primary-very-low,#f5f7f6);font-size:11px;line-height:1.3;color:var(--primary-medium,#5f6963);}
    .ldp-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:9px;padding-top:8px;
      border-top:1px solid var(--primary-low,#e5e9e7);}
    .ldp-toolbar-group{display:flex;align-items:center;gap:5px;min-width:0;}
    .ldp-toolbtn,.ldp-v2 .ldp-close,.ldp-v2 .ldp-obsidian-save,.ldp-v2 .ldp-obsidian-copy,.ldp-v2 .ldp-obsidian-settings{
      display:inline-grid;place-items:center;box-sizing:border-box;width:32px;height:32px;padding:0;border:1px solid var(--primary-low,#dce2df);
      border-radius:6px;color:var(--primary-medium,#5d6862);background:var(--primary-very-low,#f5f7f6);cursor:pointer;text-decoration:none;}
    .ldp-toolbtn:hover,.ldp-v2 .ldp-close:hover,.ldp-v2 .ldp-obsidian-save:hover,.ldp-v2 .ldp-obsidian-copy:hover,
    .ldp-v2 .ldp-obsidian-settings:hover{border-color:#85aa96;color:#176c43;background:#edf6f1;}
    .ldp-toolbtn.active{border-color:#5f9f7d;color:#176c43;background:#e4f2ea;}
    .ldp-collections-tool:hover,.ldp-collections-tool.active{border-color:#55998d;color:#12665a;background:#e5f3f0;}
    .ldp-toolbtn svg,.ldp-v2 .ldp-close svg{width:16px;height:16px;fill:currentColor;}
    .ldp-tool-separator{width:1px;height:22px;margin:0 2px;background:var(--primary-low,#dfe4e1);}
    .ldp-v2 .ldp-head-btns{gap:5px;}
    .ldp-v2 .ldp-settings-host{display:inline-flex;flex:none;}
    .ldp-v2 .ldp-close{font-size:0;}
    .ldp-v2 .ldp-shell{background:var(--secondary,#fff);}
    .ldp-v2 .ldp-shell-host{display:flex;flex:1;min-width:0;min-height:0;overflow:hidden;}
    .ldp-v2 .ldp-shell-host > .ldp-shell{flex:1;width:100%;min-width:0;min-height:0;}
    .ldp-v2 .ldp-footer{display:flex;flex:none;align-items:center;justify-content:space-around;padding:10px 22px;
      border-top:1px solid var(--primary-low,#e2e6e4);background:var(--secondary,#fff);}
    .ldp-v2 .ldp-footer[hidden]{display:none;}
    .ldp-v2 .ldp-fbtn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:70px;padding:7px 14px;
      border:0;border-radius:6px;color:var(--primary-medium,#66706a);background:transparent;cursor:pointer;text-decoration:none;
      font:600 13px/1.25 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
    .ldp-v2 .ldp-fbtn:hover{color:var(--primary,#29312c);background:var(--primary-very-low,#f3f6f4);}
    .ldp-v2 .ldp-fbtn:disabled{cursor:default;opacity:.42;}
    .ldp-v2 .ldp-fbtn svg{width:18px;height:18px;fill:currentColor;flex:none;}
    .ldp-v2 .ldp-fbtn.liked{color:#c64c3d;}
    .ldp-v2 .ldp-fbtn.bookmarked{color:#9a641c;background:#fff4df;}
    .ldp-v2 .ldp-body{padding:8px 22px 28px;scrollbar-width:thin;scrollbar-color:var(--primary-low-mid,#c6ccc9) transparent;}
    .ldp-v2 .ldp-body::-webkit-scrollbar{width:7px;}
    .ldp-v2 .ldp-body::-webkit-scrollbar-thumb{border-radius:7px;background:var(--primary-low-mid,#c6ccc9);}
    .ldp-v2 .ldp-timeline{flex-basis:82px;border-left:1px solid var(--primary-low,#e6e9e7);padding-left:8px;padding-right:8px;}
    .ldp-v2 .ldp-topic{padding:2px 0 8px;}
    .ldp-v2 .ldp-topic > .ldp-post > .ldp-actions{display:none;}
    .ldp-v2 .ldp-comments-header{position:sticky;top:0;z-index:3;margin:4px -2px 0;padding:10px 2px 7px;
      border-top:1px solid var(--primary-low,#dfe4e1);background:var(--secondary,#fff);font-size:13px;}
    .ldp-v2 .ldp-comments-header::before{content:"";width:3px;height:14px;border-radius:2px;background:#3d8d65;}
    .ldp-virtual-spacer{width:1px;pointer-events:none;}
    .ldp-virtual-window{min-height:1px;}
    .ldp-missing-post{min-height:56px;border-bottom:1px solid var(--primary-low,#e5e7e6);opacity:.35;}
    .ldp-v2 .ldp-post{padding:12px 10px 11px;border-bottom:1px solid var(--primary-low,#e4e8e6);background:transparent;}
    .ldp-v2 .ldp-virtual-window > .ldp-post:nth-child(even){background:var(--primary-very-low,#f7f8f7);}
    .ldp-v2 .ldp-post-head{margin-bottom:7px;}
    .ldp-v2 .ldp-avatar,.ldp-v2 .ldp-avatar-btn{width:30px;height:30px;}
    .ldp-v2 .ldp-author{font-size:13px;}
    .ldp-v2 .ldp-content{font-size:15px;line-height:1.7;}
    .ldp-v2 .ldp-actions{gap:3px;margin-top:7px;}
    .ldp-v2 .ldp-btn{min-width:27px;min-height:27px;border-radius:5px;}
    .ldp-post-bookmark.bookmarked{color:#a46015;background:#fff4df;}
    .ldp-like-icon,.ldp-f-like-icon{display:inline-flex;align-items:center;justify-content:center;line-height:1;}
    .ldp-like.liked .ldp-reaction-char,.ldp-fbtn.liked .ldp-reaction-char{font-size:14px;line-height:1;}
    .ldp-reaction-img{width:15px;height:15px;display:inline-block;vertical-align:middle;object-fit:contain;pointer-events:none;}
    .ldp-f-like-icon .ldp-reaction-img{width:18px;height:18px;}
    .ldp-reply-summary{position:relative;}
    .ldp-reply-summary::before{content:"";position:absolute;left:3px;top:9px;bottom:9px;width:2px;border-radius:2px;background:#79aa90;}
    .ldp-reply-summary:not(.expanded) > .ldp-content{max-height:5.1em;overflow:hidden;mask-image:linear-gradient(#000 65%,transparent);}
    .ldp-thread-toggle{margin:0 0 5px 31px;padding:0;border:0;color:#28724d;background:transparent;cursor:pointer;font-size:11px;}
    .ldp-children{display:block;margin:6px 0 0 26px;border-left:2px solid #74aa8c;}
    .ldp-children:empty{display:none;}
    .ldp-children > .ldp-post-copy{margin:0;padding:10px 8px 10px 12px;background:transparent;}
    .ldp-post-copy > .ldp-children{margin-left:18px;}
    .ldp-post-copy.ldp-reply-depth-capped > .ldp-children{margin-left:0;}
    .ldp-reply-gap{padding:6px 10px;color:var(--primary-medium,#777);font-size:11px;border-bottom:1px dashed var(--primary-low,#ddd);}
    .ldp-reaction-hover-bar{position:fixed;z-index:2147483565;display:flex;align-items:center;
      gap:4px;max-width:min(92vw,520px);overflow-x:auto;padding:5px 8px;
      border:1px solid var(--primary-low,#dce2df);border-radius:999px;
      background:var(--secondary,#fff);box-shadow:0 8px 26px rgba(0,0,0,.2);
      scrollbar-width:none;animation:ldp-rx-pop .12s ease-out;}
    .ldp-reaction-hover-bar::-webkit-scrollbar{display:none;}
    @keyframes ldp-rx-pop{from{opacity:0;transform:translateY(4px) scale(.96);}to{opacity:1;transform:none;}}
    .ldp-reaction-hover-item{flex:none;width:32px;height:32px;padding:4px;border:0;border-radius:50%;
      background:transparent;cursor:pointer;display:grid;place-items:center;
      transition:transform .14s ease,background-color .14s ease;}
    .ldp-reaction-hover-item:hover{background:#edf6f1;transform:scale(1.22);}
    .ldp-reaction-hover-item.selected{background:#e4f2ea;box-shadow:inset 0 0 0 1.5px #5f9f7d;}
    .ldp-reaction-hover-item img{width:22px;height:22px;display:block;object-fit:contain;pointer-events:none;}
    .ldp-reaction-hover-item .ldp-reaction-char{font-size:19px;line-height:1;pointer-events:none;}
    .ldp-char-counter{font-size:12px;line-height:1.2;color:var(--primary-medium,#7a837e);
      font-variant-numeric:tabular-nums;white-space:nowrap;user-select:none;flex:none;}
    .ldp-reply-tools .ldp-char-counter{margin-left:2px;}
    .ldp-boost-input-wrap .ldp-char-counter{margin:0 2px;}
    .ldp-char-counter.is-short{color:var(--danger,#e03131);font-weight:600;}
    .ldp-reader-panel{position:absolute;z-index:20;right:16px;top:88px;width:min(420px,calc(100% - 32px));height:min(560px,calc(100% - 108px));
      display:flex;flex-direction:column;border:1px solid var(--primary-low,#dce2df);border-radius:8px;background:var(--secondary,#fff);
      box-shadow:0 18px 48px rgba(20,30,24,.24);overflow:hidden;}
    .ldp-panel-head{display:flex;align-items:center;gap:8px;padding:10px 11px;border-bottom:1px solid var(--primary-low,#e3e7e5);}
    .ldp-panel-head strong{flex:1;font-size:14px;}
    .ldp-panel-close{width:28px;height:28px;border:0;background:transparent;color:inherit;font-size:20px;cursor:pointer;}
    .ldp-panel-search{margin:9px 11px 6px;padding:8px 9px;border:1px solid var(--primary-low-mid,#cbd2ce);border-radius:6px;
      color:inherit;background:var(--secondary,#fff);font:inherit;}
    .ldp-panel-tabs{display:flex;gap:2px;padding:0 11px 7px;border-bottom:1px solid var(--primary-low,#e4e8e6);}
    .ldp-panel-tab{flex:1;padding:7px;border:0;border-radius:5px;background:transparent;color:var(--primary-medium,#657069);cursor:pointer;}
    .ldp-panel-tab.active{color:#176c43;background:#e9f4ee;font-weight:700;}
    .ldp-panel-list{flex:1;overflow:auto;padding:4px 0;}
    .ldp-panel-item{display:grid;grid-template-columns:34px minmax(0,1fr) 28px;gap:9px;align-items:center;padding:9px 11px;border-bottom:1px solid var(--primary-low,#edf0ee);}
    .ldp-panel-item:hover{background:var(--primary-very-low,#f6f8f7);}
    .ldp-panel-avatar{width:32px;height:32px;border-radius:50%;object-fit:cover;background:var(--primary-low,#e6e9e7);}
    .ldp-panel-item-main{min-width:0;border:0;padding:0;text-align:left;color:inherit;background:transparent;cursor:pointer;}
    .ldp-panel-item-title{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:650;}
    .ldp-panel-item-meta{display:block;margin-top:2px;color:var(--primary-medium,#6b746f);font-size:11px;}
    .ldp-panel-delete{width:28px;height:28px;border:0;border-radius:4px;color:var(--primary-medium,#6b746f);background:transparent;cursor:pointer;}
    .ldp-panel-delete:hover{color:var(--danger,#b42318);background:var(--primary-very-low,#f4f5f4);}
    .ldp-panel-empty,.ldp-panel-loading,.ldp-panel-error{padding:32px 18px;text-align:center;color:var(--primary-medium,#6b746f);font-size:13px;}
    .ldp-panel-foot{display:flex;align-items:center;justify-content:space-between;padding:8px 11px;border-top:1px solid var(--primary-low,#e3e7e5);font-size:12px;}
    .ldp-panel-foot button{padding:6px 8px;border:1px solid var(--primary-low,#dce2df);border-radius:5px;color:inherit;background:var(--primary-very-low,#f5f7f6);cursor:pointer;}
    .ldp-page-collections-button svg{display:block;width:1.15em;height:1.15em;fill:currentColor;}
    .ldp-page-collections-button[aria-expanded="true"]{color:var(--tertiary,#08c);background:var(--primary-low,#e7e9e8);}
    .ldp-page-collection-host{position:fixed;inset:0;z-index:2147483500;pointer-events:none;}
    .ldp-page-collection-host .ldp-reader-panel{position:fixed;z-index:1;pointer-events:auto;
      width:min(420px,calc(100vw - 16px));height:min(560px,calc(100vh - 72px));}
    .ldp-new-posts{position:absolute;z-index:8;top:12px;left:50%;transform:translateX(-50%);padding:7px 11px;border:1px solid #70a889;
      border-radius:6px;color:#155e3b;background:#e9f5ee;box-shadow:0 6px 18px rgba(30,90,57,.15);cursor:pointer;font-size:12px;}
    .ldp-user-card.ldp-user-card-v2{width:min(420px,calc(100vw - 24px));overflow:hidden;}
    .ldp-user-card.ldp-user-card-v2.has-cover{width:min(720px,calc(100vw - 24px));}
    .ldp-user-card-v2 .ldp-user-card-layout{display:grid;grid-template-columns:minmax(310px,1fr) minmax(250px,.9fr);min-height:330px;}
    .ldp-user-card-v2 .ldp-user-card-layout.ldp-user-card-no-cover{display:block;min-height:0;}
    .ldp-user-card-v2 .ldp-user-card-layout.ldp-user-card-no-cover .ldp-user-card-cover{display:none;}
    .ldp-user-card-v2 .ldp-user-card-cover{height:auto;min-height:330px;order:2;background-color:var(--primary-very-low,#eef1ef);background-size:cover;background-position:center;}
    .ldp-user-card-v2 .ldp-user-card-body{order:1;padding:18px;}
    .ldp-user-card-v2 .ldp-user-card-main{align-items:center;margin:0;}
    .ldp-user-card-v2 .ldp-user-card-avatar{width:68px;height:68px;}
    .ldp-user-card-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px;}
    .ldp-user-card-actions a,.ldp-user-card-actions button,.ldp-user-notify{padding:7px 9px;border:1px solid var(--primary-low,#dce2df);border-radius:5px;
      color:inherit;background:var(--primary-very-low,#f5f7f6);text-decoration:none;cursor:pointer;font-size:12px;}
    .ldp-user-badges{display:flex;gap:5px;flex-wrap:wrap;margin-top:11px;}
    .ldp-user-badge{padding:3px 6px;border-radius:4px;background:#fff1d6;color:#77511a;font-size:11px;}
    @media (max-width:760px){
      .ldp-overlay.ldp-v2{padding:8px;align-items:stretch;}
      .ldp-v2 .ldp-modal{width:calc(100vw - 16px);height:calc(100vh - 16px);}
      .ldp-v2 .ldp-header{padding:10px;}
      .ldp-site-mark{width:30px;height:30px;}
      .ldp-toolbar{overflow-x:auto;scrollbar-width:none;}
      .ldp-v2 .ldp-footer{padding:7px 8px;}
      .ldp-v2 .ldp-fbtn{min-width:42px;width:42px;height:38px;padding:0;}
      .ldp-v2 .ldp-fbtn span{display:none;}
      .ldp-v2 .ldp-body{padding:6px 70px 22px 12px;}
      .ldp-v2 .ldp-timeline{right:6px;top:6px;bottom:6px;}
      .ldp-v2 .ldp-tl-current strong{font-size:11px;white-space:nowrap;}
      .ldp-v2 .ldp-time{display:none;}
      .ldp-reader-panel{top:76px;right:8px;width:calc(100% - 16px);height:calc(100% - 88px);}
      .ldp-user-card-v2 .ldp-user-card-layout{display:block;min-height:0;}
      .ldp-user-card-v2 .ldp-user-card-cover{display:none;}
    }

    /* 脚本 b (1.9.1) 新增能力与 2.0 主题融合样式 */
    .ldp-user-link{display:inline-flex;align-items:center;gap:6px;color:inherit;text-decoration:none;min-width:0;}
    .ldp-user-link:hover{color:#176c43;}
    .ldp-overlay a.ldp-user-link:visited{color:inherit;}
    .ldp-overlay a.ldp-user-link:visited:hover{color:#176c43;}
    .ldp-boost-avatar-link{display:inline-flex;align-items:center;flex:none;border-radius:50%;line-height:0;}
    .ldp-boost-avatar-link:hover .ldp-b-avatar{opacity:.84;transform:scale(1.08);}
    .ldp-b-avatar{transition:opacity .15s,transform .15s;}
    .ldp-level{flex:none;font-size:11px;font-weight:600;line-height:1.4;padding:0 5px;border-radius:4px;
      border:1px solid var(--primary-low,#dfe4e1);background:var(--primary-very-low,#f3f6f4);color:var(--primary-medium,#5f6963);}
    .ldp-topic-category-chip{border-color:#9fc5b1;background:#edf6f1;color:#176c43;font-weight:600;}
    .ldp-content .ldp-deleted{color:var(--primary-medium,#888);}
    .ldp-deletebtn:hover{color:var(--danger,#b42318);background:rgba(180,35,24,.08);opacity:1;}
    .ldp-user-badge{display:inline-flex;align-items:center;gap:4px;}
    .ldp-user-badge img{width:14px;height:14px;object-fit:contain;flex:none;}

    /* 视频占位播放 */
    .ldp-content .video-placeholder-container{max-width:100%;overflow:hidden;border-radius:6px;}
    .ldp-content .video-placeholder-container[data-video-src]:not(.ldp-video-ready){
      position:relative;background:#000;cursor:pointer;}
    .ldp-content .video-placeholder-container[data-video-src]:not(.ldp-video-ready)::before{
      content:"";position:absolute;z-index:3;left:50%;top:50%;width:62px;height:62px;
      transform:translate(-50%,-50%);border:2px solid rgba(255,255,255,.92);
      border-radius:50%;background:rgba(0,0,0,.58);pointer-events:none;
      box-shadow:0 4px 18px rgba(0,0,0,.35);transition:background .18s,transform .18s;}
    .ldp-content .video-placeholder-container[data-video-src]:not(.ldp-video-ready)::after{
      content:"";position:absolute;z-index:4;left:50%;top:50%;
      transform:translate(-35%,-50%);border-top:11px solid transparent;
      border-bottom:11px solid transparent;border-left:18px solid #fff;
      pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));}
    .ldp-content .video-placeholder-container[data-video-src]:not(.ldp-video-ready):hover::before{
      background:rgba(23,108,67,.86);transform:translate(-50%,-50%) scale(1.06);}
    .ldp-content .video-placeholder-container[data-video-src]:not(.ldp-video-ready)
      .video-placeholder-overlay{display:none;}
    .ldp-content .video-placeholder-container.ldp-video-ready{cursor:default!important;background:#000;}
    .ldp-content video{display:block;width:100%;max-width:100%;max-height:70vh;background:#000;}

    /* 模糊剧透 */
    .ldp-content .ldp-spoiler{cursor:pointer;}
    .ldp-content .ldp-spoiler.ldp-spoiler-blurred{
      filter:blur(8px)!important;-webkit-filter:blur(8px)!important;user-select:none;}
    .ldp-content .ldp-spoiler.ldp-spoiler-expanded{cursor:default;}

    /* 投票 */
    .ldp-content .ldp-poll{display:grid;gap:10px;margin:12px 0;padding:12px;
      border:1px solid var(--primary-low,#dce2df);border-radius:8px;
      background:var(--primary-very-low,#f7f9f8);}
    .ldp-poll-title{margin:0;font-size:15px;font-weight:700;}
    .ldp-poll-meta{font-size:12px;color:var(--primary-medium,#6b746f);}
    .ldp-poll-options{display:grid;gap:8px;}
    .ldp-poll-option{position:relative;overflow:hidden;width:100%;
      display:flex;flex-direction:column;gap:6px;padding:10px 12px;
      border:1px solid var(--primary-low,#dce2df);border-radius:8px;
      background:var(--secondary,#fff);color:inherit;font:inherit;
      text-align:left;cursor:pointer;}
    .ldp-poll-option[aria-pressed="true"]{
      border-color:#4f9d70;background:#edf6f1;}
    .ldp-poll-option:disabled{cursor:default;opacity:.65;}
    .ldp-poll-option-content{position:relative;z-index:1;display:flex;
      align-items:baseline;justify-content:space-between;gap:12px;}
    .ldp-poll-option-html{min-width:0;overflow-wrap:anywhere;}
    .ldp-poll-option-meta{flex:none;font-size:12px;color:var(--primary-medium,#6b746f);}
    .ldp-poll-bar{position:absolute;left:0;bottom:0;height:3px;background:#3d8d65;}
    .ldp-poll-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;}
    .ldp-poll-submit,.ldp-poll-remove{border:1px solid var(--primary-low,#cbd2ce);
      border-radius:6px;padding:5px 12px;background:var(--secondary,#fff);
      color:var(--primary,#222);font:inherit;font-size:13px;cursor:pointer;}
    .ldp-poll-submit:hover,.ldp-poll-remove:hover{border-color:#85aa96;color:#176c43;background:#edf6f1;}
    .ldp-poll-submit:disabled,.ldp-poll-remove:disabled{cursor:default;opacity:.5;}
    .ldp-poll-selected-count{font-size:12px;color:var(--primary-medium,#6b746f);}
    .ldp-poll-status{min-height:18px;font-size:12px;color:var(--primary-medium,#6b746f);}
    .ldp-poll-status.ldp-poll-error{color:var(--danger,#b42318);}
    .ldp-poll[data-loading] .ldp-poll-option,
    .ldp-poll[data-loading] .ldp-poll-submit,
    .ldp-poll[data-loading] .ldp-poll-remove{cursor:default;opacity:.55;pointer-events:none;}

    /* 回复框模板与表情工具栏 */
    .ldp-reply-tools{display:flex;align-items:center;gap:6px;margin-top:6px;}
    .ldp-reply-tools .ldp-send{margin-top:0;}
    .ldp-insert-wrap{position:relative;display:inline-flex;}
    .ldp-insert-menu{position:absolute;top:calc(100% + 4px);left:0;z-index:25;
      min-width:150px;padding:4px 0;border:1px solid var(--primary-low,#dce2df);
      border-radius:6px;background:var(--secondary,#fff);
      box-shadow:0 8px 24px rgba(0,0,0,.18);list-style:none;margin:0;}
    .ldp-insert-menu[hidden]{display:none;}
    .ldp-insert-item{display:flex;align-items:center;gap:8px;width:100%;
      padding:7px 10px;border:none;background:transparent;color:inherit;
      font-size:13px;text-align:left;cursor:pointer;white-space:nowrap;}
    .ldp-insert-item:hover{background:var(--primary-very-low,#eff4f1);color:#176c43;}
    .ldp-insert-item svg{width:14px;height:14px;flex:none;fill:currentColor;}

    /* Emoji Picker */
    .ldp-emoji-btn{width:26px;height:26px;padding:0;display:flex;flex:none;
      align-items:center;justify-content:center;border-radius:50%;
      border:1px solid var(--primary-low,#cbd2ce);background:transparent;
      color:var(--primary-medium,#66706a);cursor:pointer;font-size:14px;line-height:1;
      transition:all .15s;position:relative;}
    .ldp-emoji-btn:hover{background:#edf6f1;border-color:#85aa96;color:#176c43;}
    .ldp-emoji-btn svg{width:15px;height:15px;fill:currentColor;display:block;}
    .ldp-emoji-panel{position:fixed;z-index:2147483560;width:320px;height:360px;
      background:var(--secondary,#fff);border:1px solid var(--primary-low,#dce2df);
      border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.22);
      display:flex;flex-direction:column;overflow:hidden;font-size:13px;color:var(--primary,#222);}
    .ldp-emoji-search{flex:none;padding:6px 8px;border-bottom:1px solid var(--primary-low,#e4e8e6);}
    .ldp-emoji-search input{width:100%;box-sizing:border-box;border:1px solid var(--primary-low-mid,#cbd2ce);
      border-radius:6px;padding:5px 8px;font-size:12px;outline:none;
      background:var(--secondary,#fff);color:inherit;}
    .ldp-emoji-tabs{flex:none;display:flex;border-bottom:1px solid var(--primary-low,#e4e8e6);
      overflow-x:auto;padding:0 4px;}
    .ldp-emoji-tabs::-webkit-scrollbar{display:none;}
    .ldp-emoji-tab{flex:none;width:30px;height:30px;padding:0;cursor:pointer;
      display:flex;align-items:center;justify-content:center;font-size:16px;
      opacity:.5;border-bottom:2px solid transparent;transition:all .15s;
      background:none;border-top:none;border-left:none;border-right:none;}
    .ldp-emoji-tab img{width:20px;height:20px;display:block;}
    .ldp-emoji-tab:hover{opacity:.8;}
    .ldp-emoji-tab.active{opacity:1;border-bottom-color:#28724d;}
    .ldp-emoji-grid{flex:1;overflow-y:auto;padding:6px;display:grid;
      grid-template-columns:repeat(8,1fr);gap:2px;align-content:start;}
    .ldp-emoji-grid::-webkit-scrollbar{width:5px;}
    .ldp-emoji-grid::-webkit-scrollbar-thumb{background:rgba(128,128,128,.3);border-radius:3px;}
    .ldp-emoji-item{width:100%;aspect-ratio:1;display:flex;align-items:center;
      justify-content:center;border-radius:6px;cursor:pointer;border:none;
      background:transparent;padding:2px;transition:background .1s;}
    .ldp-emoji-item:hover{background:var(--primary-low,#eff3f1);}
    .ldp-emoji-item img{width:24px;height:24px;display:block;}
    .ldp-emoji-empty{grid-column:1/-1;text-align:center;padding:20px 0;
      color:var(--primary-medium,#888);font-size:12px;}

    /* 时间轴圆点拖拽跳转提示 */
    .ldp-tl-thumb{cursor:grab;touch-action:none;}
    .ldp-tl-thumb.dragging{cursor:grabbing;box-shadow:0 0 0 6px rgba(8,132,255,.24);}
    .ldp-tl-drag-tip{position:absolute;right:calc(100% + 4px);top:8px;z-index:6;
      padding:3px 7px;border-radius:4px;background:var(--primary,#222);color:var(--secondary,#fff);
      font-size:11px;font-weight:700;line-height:1.3;white-space:nowrap;
      transform:translateY(-50%);opacity:0;pointer-events:none;transition:opacity .12s;}
    .ldp-tl-drag-tip.show{opacity:1;}

    /* 话题列表“发帖时间列”样式（兼容经典表格、移动端内联与 Horizon 主题） */
    table.topic-list th.topic-created-at{text-align:right;white-space:nowrap;}
    table.topic-list td.topic-created-at{text-align:right;white-space:nowrap;font-size:.93em;color:var(--primary-medium,#919191);}
    .topic-created-at-inline{display:none;}
    .topic-created-at-inline:empty{display:none!important;}
    html.mobile-view table.topic-list th.topic-created-at,html.mobile-view table.topic-list td.topic-created-at{display:none!important;}
    html.mobile-view .topic-created-at-inline{display:inline-block;font-size:.87rem;line-height:1.2;color:var(--primary-medium,#919191);margin:0 8px;white-space:nowrap;}
    html.mobile-view .topic-list .topic-item-stats .num.activity{white-space:nowrap;flex-shrink:0;}
    .topic-list .topic-activity__time .topic-created-at-inline{display:inline-block;font-size:.87rem;line-height:1.2;color:var(--primary-medium,#919191);margin:0 8px;white-space:nowrap;}
    html.ldc-horizon table.topic-list tr.topic-list-item td.topic-activity-data{grid-column:activity/-1;text-align:right;white-space:nowrap;overflow:hidden;}
    html.ldc-horizon .topic-list .topic-activity__time .topic-created-at-inline{margin-right:0;color:inherit;}
    html.ldc-horizon .topic-list .topic-activity__time{display:flex;align-items:center;justify-content:flex-end;column-gap:8px;}
    @media (max-width:580px){
      table.topic-list th.topic-created-at,table.topic-list td.topic-created-at{display:none!important;}
      .topic-created-at-inline{display:inline-block;font-size:.87rem;line-height:1.2;color:var(--primary-medium,#919191);margin:0 8px;white-space:nowrap;}
      .topic-list .topic-item-stats .num.activity{white-space:nowrap;flex-shrink:0;}
    }
    /* 发帖时间颜色梯度：当天鲜红，近7天（1~6天前）逐级变淡过渡至默认灰色 */
    table.topic-list td.topic-created-at[data-age-bucket="0"],
    .topic-created-at-inline[data-age-bucket="0"]{color:#e03131!important;font-weight:600;}
    table.topic-list td.topic-created-at[data-age-bucket="1"],
    .topic-created-at-inline[data-age-bucket="1"]{color:#d64f4f!important;color:color-mix(in srgb,#e03131 82%,var(--primary-medium,#919191))!important;}
    table.topic-list td.topic-created-at[data-age-bucket="2"],
    .topic-created-at-inline[data-age-bucket="2"]{color:#c86464!important;color:color-mix(in srgb,#e03131 66%,var(--primary-medium,#919191))!important;}
    table.topic-list td.topic-created-at[data-age-bucket="3"],
    .topic-created-at-inline[data-age-bucket="3"]{color:#ba7474!important;color:color-mix(in srgb,#e03131 50%,var(--primary-medium,#919191))!important;}
    table.topic-list td.topic-created-at[data-age-bucket="4"],
    .topic-created-at-inline[data-age-bucket="4"]{color:#ad8080!important;color:color-mix(in srgb,#e03131 35%,var(--primary-medium,#919191))!important;}
    table.topic-list td.topic-created-at[data-age-bucket="5"],
    .topic-created-at-inline[data-age-bucket="5"]{color:#a08989!important;color:color-mix(in srgb,#e03131 22%,var(--primary-medium,#919191))!important;}
    table.topic-list td.topic-created-at[data-age-bucket="6"],
    .topic-created-at-inline[data-age-bucket="6"]{color:#978e8e!important;color:color-mix(in srgb,#e03131 11%,var(--primary-medium,#919191))!important;}
  `;
  (document.head || document.documentElement).appendChild(style);

  /* 图标 */
  const ICONS = {
    // 点赞
    like: '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>',
    // 回复
    reply: '<path d="M1024 640q0 94.857143-72.571429 257.714286-1.714286 4-6 13.714286t-7.714286 17.142857-7.428571 12.571429q-6.857143 9.714286-16 9.714286-8.571429 0-13.428571-5.714286t-4.857143-14.285714q0-5.142857 1.428571-15.142857t1.428571-13.428571q2.857143-38.857143 2.857143-70.285714 0-57.714286-10-103.428571t-27.714286-79.142857-45.714286-57.714286-60.285714-39.714286-76-24.285714-88-12.285714-100.285714-3.428571l-128 0 0 146.285714q0 14.857143-10.857143 25.714286t-25.714286 10.857143-25.714286-10.857143l-292.571429-292.571429q-10.857143-10.857143-10.857143-25.714286t10.857143-25.714286l292.571429-292.571429q10.857143-10.857143 25.714286-10.857143t25.714286 10.857143 10.857143 25.714286l0 146.285714 128 0q407.428571 0 500 230.285714 30.285714 76.571429 30.285714 190.285714z"/>',
    // boost
    boost: '<path d="M1010.092957 38.19946a31.779551 31.779551 0 0 0-24.399655-24.399655C921.294212 0 870.914925 0 820.715635 0c-206.397081 0-330.195331 110.398439-422.574025 255.99638H189.744557A95.998643 95.998643 0 0 0 104.005769 308.975631l-98.838602 197.597206A47.999321 47.999321 0 0 0 48.146559 575.991855h207.537065l-44.939364 44.939365a63.999095 63.999095 0 0 0 0 90.49872l101.79856 101.81856a63.999095 63.999095 0 0 0 90.51872 0L448.000905 768.309136V975.986199a47.999321 47.999321 0 0 0 69.399019 42.979392l197.397208-98.778603a95.818645 95.818645 0 0 0 52.999251-85.798787V625.571154c145.177947-92.598691 255.99638-216.796934 255.99638-422.17403 0.199997-50.399287 0.199997-100.798575-13.699806-165.197664zM767.99638 335.995249a79.998869 79.998869 0 1 1 79.998869-79.998869 79.998869 79.998869 0 0 1-79.998869 79.998869z"/>',
    // 书签
    bookmark: '<path d="M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2z"/>',
    // 新标签页打开
    newTab: '<path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/>',
    // 下载到托盘
    download: '<path d="M11 3h2v10.17l3.59-3.58L18 11l-6 6-6-6 1.41-1.41L11 13.17V3ZM5 19h14v2H5v-2Z"/>',
    // Obsidian 水晶与设置
    obsidian: '<path d="M12 1.8 19.2 7l-1.8 11.1L12 22l-5.4-3.9L4.8 7 12 1.8Zm0 3L8 7.7l1.3 8.8 2.7 2 2.7-2L16 7.7 12 4.8Z"/>',
    settings: '<path d="M19.4 13a7.8 7.8 0 0 0 .1-1 7.8 7.8 0 0 0-.1-1l2.1-1.6-2-3.4-2.5 1a7.7 7.7 0 0 0-1.7-1L15 3.3h-4L10.6 6a7.7 7.7 0 0 0-1.7 1L6.4 6l-2 3.4L6.5 11a7.8 7.8 0 0 0-.1 1 7.8 7.8 0 0 0 .1 1l-2.1 1.6 2 3.4 2.5-1a7.7 7.7 0 0 0 1.7 1l.4 2.7h4l.4-2.7a7.7 7.7 0 0 0 1.7-1l2.5 1 2-3.4L19.4 13ZM13 15.5A3.5 3.5 0 1 1 13 8a3.5 3.5 0 0 1 0 7.5Z"/>',
    // 复制
    copy: '<path d="M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z"/>'
  };

  const EMOJI_BTN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm-3.5-9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm7 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm-7.43 3.5a4.5 4.5 0 0 0 7.86 0h-1.8a2.8 2.8 0 0 1-4.26 0h-1.8Z"/></svg>';
  const INSERT_BTN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 9h4v2h-4v4h-2v-4H7v-2h4V7h2v4Z"/></svg>';
  const DETAILS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.4 6.6 5.4 5.4-5.4 5.4L8 16l4-4-4-4 1.4-1.4Z"/></svg>';
  const SPOILER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5c-5 0-9.27 3.11-11 7.5C2.73 16.89 7 20 12 20s9.27-3.11 11-7.5C21.27 8.11 17 5 12 5Zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/></svg>';
  const TRASH_BTN_ICON = '<svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:currentColor;vertical-align:middle;" aria-hidden="true"><path d="M8 3h8l1 2h4v2H3V5h4l1-2Zm-2 6h12l-1 12H7L6 9Zm3 2 .5 8h2L11 11H9Zm4 0-.5 8h2l.5-8h-2Z"/></svg>';

  function setSpoilerState(spoiler, blurred) {
    spoiler.classList.add('spoiled');
    spoiler.classList.toggle('spoiler-blurred', blurred);
    spoiler.classList.toggle('spoiler-revealed', !blurred);
    spoiler.classList.toggle('ldp-spoiler-blurred', blurred);
    spoiler.classList.toggle('ldp-spoiler-expanded', !blurred);
    spoiler.dataset.spoilerState = blurred ? 'blurred' : 'expanded';
    spoiler.setAttribute('aria-expanded', String(!blurred));
    spoiler.style.setProperty('filter', blurred ? 'blur(8px)' : 'none', 'important');
    spoiler.style.setProperty('-webkit-filter', blurred ? 'blur(8px)' : 'none', 'important');
  }

  function prepareSpoilers(root) {
    if (!root) return;
    const spoilers = [];
    const selector = '.spoiler, .spoiled, .spoiler-blurred, [data-spoiler-state]';
    if (root.matches && root.matches(selector)) spoilers.push(root);
    spoilers.push(...root.querySelectorAll(selector));
    spoilers.forEach((spoiler) => {
      spoiler.classList.add('ldp-spoiler');
      spoiler.setAttribute('role', 'button');
      spoiler.setAttribute('tabindex', '0');
      setSpoilerState(spoiler, true);
    });
  }

  /* ============ 2. 工具 ============ */
  const esc = (s) => (s || '').replace(/[<>&]/g, (c) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const escAttr = (s) => esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function stripHtml(html) {
    if (!html) return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return (tmp.textContent || '').trim();
  }

  function resolveAvatar(template, size) {
    return template ? absoluteUrl(template.replace('{size}', String(size || 96))) : '';
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    const diff = Date.now() - t;
    const min = 60000, hour = 60 * min, day = 24 * hour;
    if (diff < min) return '刚刚';
    if (diff < hour) return Math.floor(diff / min) + ' 分钟前';
    if (diff < day) return Math.floor(diff / hour) + ' 小时前';
    if (diff < 30 * day) return Math.floor(diff / day) + ' 天前';
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  const csrfToken = () =>
      (document.querySelector('meta[name="csrf-token"]') || {}).content || '';

  function abortError() {
    return new DOMException('The operation was aborted.', 'AbortError');
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw abortError();
  }

  function sleep(ms, signal) {
    if (!(ms > 0)) {
      throwIfAborted(signal);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      throwIfAborted(signal);
      const timer = setTimeout(done, ms);
      function cleanup() {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      function done() { cleanup(); resolve(); }
      function onAbort() { cleanup(); reject(abortError()); }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function parseRetryAfter(value) {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
  }

  function setGlobalCooldown(until, broadcast) {
    const next = Math.max(globalCooldownUntil, Number(until) || 0);
    if (next === globalCooldownUntil) return;
    globalCooldownUntil = next;
    if (broadcast && cooldownChannel) cooldownChannel.postMessage({ until: next });
    scheduleRequestPump(Math.max(0, next - Date.now()));
  }

  if (cooldownChannel) {
    cooldownChannel.addEventListener('message', (event) => {
      if (event.data && event.data.until) setGlobalCooldown(event.data.until, false);
    });
  }

  async function fetchOnce(url, options, attempt) {
    const opts = options || {};
    const signal = opts.signal;
    const headers = Object.assign({ 'Accept': 'application/json' }, opts.headers || {});
    const fetchOptions = Object.assign({}, opts, {
      method: 'GET', credentials: 'include', headers,
    });
    delete fetchOptions.priority;
    delete fetchOptions.dedupeKey;

    throwIfAborted(signal);
    const res = await fetch(url, fetchOptions);
    if (res.ok) return res.json().then((json) => { harvestTopicCreatedData(json); return json; });
    const error = new Error('HTTP ' + res.status);
    error.status = res.status;
    error.url = String(url);
    error.attempt = attempt;
    if (res.status === 429) {
      const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
      error.retryDelay = retryAfter === null ? RETRY_BASE_DELAY * Math.pow(2, attempt) : retryAfter;
    }
    throw error;
  }

  async function waitForGlobalCooldown(signal) {
    while (globalCooldownUntil > Date.now()) {
      await sleep(globalCooldownUntil - Date.now(), signal);
    }
  }

  async function fetchWithRetry(url, options) {
    const opts = options || {};
    for (let attempt = 0; ; attempt++) {
      try {
        return await queueRequest(
          () => fetchOnce(url, opts, attempt), opts.signal, opts.priority
        );
      } catch (error) {
        if (!error || error.status !== 429 || attempt >= RETRY_MAX_ATTEMPTS) throw error;
        setGlobalCooldown(Date.now() + Math.max(0, Number(error.retryDelay) || 0), true);
        await waitForGlobalCooldown(opts.signal);
      }
    }
  }

  function scheduleRequestPump(delay) {
    if (requestPumpTimer) clearTimeout(requestPumpTimer);
    requestPumpTimer = setTimeout(() => {
      requestPumpTimer = null;
      pumpRequestQueue();
    }, Math.max(0, Number(delay) || 0));
  }

  function pumpRequestQueue() {
    if (activeGetRequests >= REQUEST_MAX_CONCURRENCY || !requestQueue.length) return;
    const cooldownWait = globalCooldownUntil - Date.now();
    const spacingWait = REQUEST_MIN_INTERVAL - (Date.now() - lastRequestTime);
    const wait = Math.max(cooldownWait, spacingWait, 0);
    if (wait > 0) {
      scheduleRequestPump(wait);
      return;
    }

    requestQueue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
    const item = requestQueue.shift();
    if (!item) return;
    if (item.signal && item.signal.aborted) {
      item.reject(abortError());
      pumpRequestQueue();
      return;
    }
    activeGetRequests += 1;
    lastRequestTime = Date.now();
    item.started = true;
    item.task().then(item.resolve, item.reject).finally(() => {
      activeGetRequests -= 1;
      scheduleRequestPump(0);
    });
    if (activeGetRequests < REQUEST_MAX_CONCURRENCY) scheduleRequestPump(REQUEST_MIN_INTERVAL);
  }

  function queueRequest(task, signal, priority) {
    return new Promise((resolve, reject) => {
      const item = {
        task, signal, resolve, reject, started: false,
        priority: REQUEST_PRIORITY[priority] ?? REQUEST_PRIORITY.visible,
        sequence: requestSequence++,
      };
      if (signal && signal.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = () => {
        if (item.started) return;
        const index = requestQueue.indexOf(item);
        if (index >= 0) requestQueue.splice(index, 1);
        reject(abortError());
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const finish = (handler) => (value) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        handler(value);
      };
      item.resolve = finish(resolve);
      item.reject = finish(reject);
      requestQueue.push(item);
      pumpRequestQueue();
    });
  }

  function createSharedGetRequest(key, url, options) {
    const controller = new AbortController();
    const record = { key, controller, subscribers: new Set(), settled: false };
    const opts = Object.assign({}, options || {}, { signal: controller.signal });
    record.promise = fetchWithRetry(url, opts).then(
      (value) => {
        record.settled = true;
        record.subscribers.forEach((subscriber) => subscriber.resolve(value));
      },
      (error) => {
        record.settled = true;
        record.subscribers.forEach((subscriber) => subscriber.reject(error));
      }
    ).finally(() => {
      record.subscribers.forEach((subscriber) => subscriber.cleanup());
      record.subscribers.clear();
      if (inflightGetRequests.get(key) === record) inflightGetRequests.delete(key);
    });
    inflightGetRequests.set(key, record);
    return record;
  }

  function subscribeSharedGet(record, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(abortError());
        if (!record.subscribers.size && !record.settled) record.controller.abort();
        return;
      }
      const subscriber = {
        resolve, reject, signal, cleanup: () => {
          if (signal) signal.removeEventListener('abort', onAbort);
        },
      };
      const onAbort = () => {
        if (!record.subscribers.delete(subscriber)) return;
        subscriber.cleanup();
        reject(abortError());
        if (!record.subscribers.size && !record.settled) record.controller.abort();
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      record.subscribers.add(subscriber);
    });
  }

  function fetchJSON(url, options) {
    const opts = options || {};
    const key = opts.dedupeKey || String(url);
    let record = inflightGetRequests.get(key);
    if (!record || record.settled || record.controller.signal.aborted) {
      record = createSharedGetRequest(key, url, opts);
    }
    return subscribeSharedGet(record, opts.signal);
  }

  async function apiSend(url, method, params, extraHeaders) {
    const opt = {
      method,
      credentials: 'include',
      headers: Object.assign({
        'Accept': 'application/json',
        'X-CSRF-Token': csrfToken(),
        'X-Requested-With': 'XMLHttpRequest',
      }, extraHeaders || {}),
    };
    if (params instanceof FormData) {
      opt.body = params;
    } else if (params instanceof URLSearchParams) {
      opt.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      opt.body = params.toString();
    } else if (params) {
      opt.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      const body = new URLSearchParams();
      Object.keys(params).forEach((key) => {
        const value = params[key];
        if (Array.isArray(value)) {
          value.forEach((item) => body.append(`${key}[]`, item));
        } else if (value !== undefined && value !== null) {
          body.append(key, value);
        }
      });
      opt.body = body.toString();
    }
    const res = await fetch(url, opt);
    if (!res.ok) {
      let message = 'HTTP ' + res.status;
      try {
        const data = await res.json();
        const errors = Array.isArray(data.errors)
          ? data.errors.map((item) => typeof item === 'string' ? item : (item && item.message))
              .filter((item) => typeof item === 'string' && item.trim())
          : [];
        const candidate = errors.join(' ') || data.error || data.message;
        if (typeof candidate === 'string' && candidate.trim()) message = candidate.trim();
      } catch (e) { /* keep HTTP status fallback */ }
      const error = new Error(message);
      error.status = res.status;
      throw error;
    }
    return res.json().catch(() => ({}));
  }

  async function ensureMe(signal) {
    if (ME_STATE !== 'unknown') return ME_USERNAME || '';
    try {
      const s = await fetchJSON(`${BASE}/session/current.json`, { signal });
      ME_USER = s && s.current_user ? s.current_user : null;
      ME_USERNAME = (ME_USER && ME_USER.username) || '';
      ME_STATE = ME_USER ? 'authenticated' : 'guest';
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw e;
    }
    return ME_USERNAME;
  }

  let readerDbPromise = null;
  function openReaderDb() {
    if (!('indexedDB' in window)) return Promise.resolve(null);
    if (readerDbPromise) return readerDbPromise;
    readerDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('topics')) {
          const store = db.createObjectStore('topics', { keyPath: 'key' });
          store.createIndex('updatedAt', 'updatedAt');
          store.createIndex('scope', 'scope');
        }
        if (!db.objectStoreNames.contains('collections')) {
          const store = db.createObjectStore('collections', { keyPath: 'key' });
          store.createIndex('updatedAt', 'updatedAt');
          store.createIndex('scope', 'scope');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB 初始化失败'));
    }).catch(() => null);
    return readerDbPromise;
  }

  function dbRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB 操作失败'));
    });
  }

  async function readerScope(signal) {
    const username = await ensureMe(signal);
    if (ME_STATE === 'unknown') throw new Error('用户身份尚未确认');
    return `${BASE}|${username || 'guest'}`;
  }

  async function readDbRecord(storeName, key) {
    const db = await openReaderDb();
    if (!db) return null;
    return dbRequest(db.transaction(storeName, 'readonly').objectStore(storeName).get(key)).catch(() => null);
  }

  async function writeDbRecord(storeName, value) {
    const db = await openReaderDb();
    if (!db) return;
    await dbRequest(db.transaction(storeName, 'readwrite').objectStore(storeName).put(value)).catch(() => {});
  }

  async function deleteDbRecord(storeName, key) {
    const db = await openReaderDb();
    if (!db) return;
    await dbRequest(db.transaction(storeName, 'readwrite').objectStore(storeName).delete(key)).catch(() => {});
  }

  async function topicCacheKey(topicId, signal) {
    let scope;
    try { scope = await readerScope(signal); }
    catch (error) {
      if (error && error.name === 'AbortError') throw error;
      return null;
    }
    return { scope, key: `${scope}|topic|${topicId}` };
  }

  async function readTopicSnapshot(topicId, signal) {
    const pendingWrite = TOPIC_SNAPSHOT_WRITES.get(String(topicId));
    if (pendingWrite) await pendingWrite.catch(() => {});
    const identity = await topicCacheKey(topicId, signal);
    if (!identity) return null;
    const record = await readDbRecord('topics', identity.key);
    if (!record || Date.now() - record.updatedAt > TOPIC_CACHE_STALE_MS) return null;
    return Object.assign({}, record, { fresh: Date.now() - record.updatedAt <= TOPIC_CACHE_FRESH_MS });
  }

  async function pruneTopicSnapshots(scope) {
    const db = await openReaderDb();
    if (!db) return;
    const records = await dbRequest(db.transaction('topics', 'readonly').objectStore('topics').getAll()).catch(() => []);
    const scoped = records.filter((item) => item.scope === scope)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    let bytes = 0;
    const expiredKeys = [];
    scoped.forEach((record, index) => {
      bytes += Number(record.bytes) || 0;
      if (index >= TOPIC_CACHE_MAX_COUNT || bytes > TOPIC_CACHE_MAX_BYTES) expiredKeys.push(record.key);
    });
    if (!expiredKeys.length) return;
    const transaction = db.transaction('topics', 'readwrite');
    const store = transaction.objectStore('topics');
    expiredKeys.forEach((key) => store.delete(key));
  }

  async function writeTopicSnapshot(topicId, topic, posts, signal) {
    const identity = await topicCacheKey(topicId, signal);
    if (!identity) return;
    const payload = { schemaVersion: 2, topic, posts: Array.from(posts || []) };
    let bytes = 0;
    try { bytes = new Blob([JSON.stringify(payload)]).size; } catch (error) { /* 忽略估算失败 */ }
    await writeDbRecord('topics', {
      key: identity.key, scope: identity.scope, topicId: String(topicId),
      updatedAt: Date.now(), bytes, payload,
    });
    pruneTopicSnapshots(identity.scope).catch(() => {});
  }

  async function invalidateTopicSnapshot(topicId) {
    const identity = await topicCacheKey(topicId);
    if (!identity) return;
    return deleteDbRecord('topics', identity.key);
  }

  let historyStoreMemory = null;
  let historyWriteTimer = 0;
  let historyDirty = false;
  let lastRememberedHistoryKey = '';

  function readHistoryStore() {
    if (historyStoreMemory) return historyStoreMemory;
    try {
      const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
      historyStoreMemory = value && typeof value === 'object' ? value : {};
    } catch (error) { historyStoreMemory = {}; }
    return historyStoreMemory;
  }

  function historyScope() {
    if (ME_STATE === 'unknown') return null;
    return `${BASE}|${ME_USERNAME || 'guest'}`;
  }

  function getHistoryEntries() {
    const scope = historyScope();
    if (!scope) return [];
    const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
    return (readHistoryStore()[scope] || [])
      .filter((item) => item && item.lastViewedAt >= cutoff)
      .sort((a, b) => b.lastViewedAt - a.lastViewedAt)
      .slice(0, 500);
  }

  function flushHistoryEntries() {
    if (historyWriteTimer) clearTimeout(historyWriteTimer);
    historyWriteTimer = 0;
    if (!historyDirty || !historyStoreMemory) return;
    historyDirty = false;
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(historyStoreMemory)); } catch (error) { /* 配额不足时不阻断阅读 */ }
  }

  function saveHistoryEntries(entries, immediate) {
    const scope = historyScope();
    if (!scope) return;
    const store = readHistoryStore();
    store[scope] = entries.slice(0, 500);
    historyDirty = true;
    if (immediate) flushHistoryEntries();
    else {
      if (historyWriteTimer) clearTimeout(historyWriteTimer);
      historyWriteTimer = setTimeout(flushHistoryEntries, 750);
    }
  }

  function rememberTopicHistory(topic, postNumber) {
    if (!topic || !topic.id || ME_STATE === 'unknown') return;
    const normalizedPostNumber = Math.max(1, Number(postNumber) || 1);
    const memoryKey = `${historyScope()}|${topic.id}|${normalizedPostNumber}`;
    if (memoryKey === lastRememberedHistoryKey) return;
    lastRememberedHistoryKey = memoryKey;
    const entries = getHistoryEntries().filter((item) => String(item.topicId) !== String(topic.id));
    const op = topic._opPost || {};
    entries.unshift({
      topicId: String(topic.id), title: topic.title || `主题 ${topic.id}`,
      username: topic._opUsername || op.username || '', avatar: resolveAvatar(op.avatar_template, 48),
      lastViewedAt: Date.now(), lastPostNumber: normalizedPostNumber,
      lastReadPostNumber: Number(topic.last_read_post_number) || 0,
    });
    saveHistoryEntries(entries);
  }

  async function collectionCacheIdentity(name, signal) {
    let scope;
    try { scope = await readerScope(signal); }
    catch (error) {
      if (error && error.name === 'AbortError') throw error;
      return null;
    }
    return { scope, key: `${scope}|collection|${name}` };
  }

  async function readCollectionCache(name, maxAge, signal) {
    const identity = await collectionCacheIdentity(name, signal);
    if (!identity) return null;
    const record = await readDbRecord('collections', identity.key);
    if (!record || Date.now() - record.updatedAt > (maxAge || TOPIC_CACHE_FRESH_MS)) return null;
    return record.payload;
  }

  async function writeCollectionCache(name, payload, signal) {
    const identity = await collectionCacheIdentity(name, signal);
    if (!identity) return;
    return writeDbRecord('collections', {
      key: identity.key, scope: identity.scope, name, updatedAt: Date.now(), payload,
    });
  }

  async function invalidateCollectionCache(name) {
    const identity = await collectionCacheIdentity(name);
    if (!identity) return;
    return deleteDbRecord('collections', identity.key);
  }

  window.addEventListener('pagehide', flushHistoryEntries);

  async function loadBookmarksCollection(signal) {
    const cached = await readCollectionCache('bookmarks', TOPIC_CACHE_FRESH_MS, signal);
    if (cached) return cached;
    const username = await ensureMe(signal);
    if (!username) return [];
    const items = [];
    const seenIds = new Set();
    const seenUrls = new Set();
    let page = 0;
    let nextUrl = `${BASE}/u/${encodeURIComponent(username)}/bookmarks.json?page=0`;
    while (nextUrl && !seenUrls.has(nextUrl)) {
      seenUrls.add(nextUrl);
      const data = await fetchJSON(nextUrl, {
        signal, priority: page === 0 ? 'visible' : 'background',
      });
      const root = data.user_bookmark_list || data;
      const batch = root.bookmarks || data.bookmarks || [];
      let added = 0;
      batch.forEach((item) => {
        const key = String(item.id || item.bookmark_id);
        if (!seenIds.has(key)) { seenIds.add(key); items.push(item); added += 1; }
      });
      page += 1;
      nextUrl = root.more_bookmarks_url
        ? new URL(root.more_bookmarks_url, BASE).href
        : (batch.length >= 20 && added ? `${BASE}/u/${encodeURIComponent(username)}/bookmarks.json?page=${page}` : '');
    }
    await writeCollectionCache('bookmarks', items, signal);
    return items;
  }

  async function loadResponsesCollection(signal) {
    const cached = await readCollectionCache('responses', TOPIC_CACHE_FRESH_MS, signal);
    if (cached) return cached;
    const username = await ensureMe(signal);
    if (!username) return [];
    const likesPromise = (async () => {
      const items = [], seen = new Set();
      let offset = 0;
      while (true) {
        const data = await fetchJSON(`${BASE}/user_actions.json?username=${encodeURIComponent(username)}&filter=1&offset=${offset}&limit=60`, {
          signal, priority: offset ? 'background' : 'visible',
        });
        const batch = data.user_actions || [];
        let added = 0;
        batch.forEach((item) => {
          const key = String(item.id || item.post_id);
          if (!seen.has(key)) { seen.add(key); items.push(Object.assign({ _reactionType: 'like' }, item)); added += 1; }
        });
        if (batch.length < 60 || !added) break;
        offset += batch.length;
      }
      return items;
    })();
    const reactionsPromise = (async () => {
      const items = [], seenRecords = new Set(), seenCursors = new Set();
      let cursor = 0;
      while (true) {
        const suffix = cursor ? `&before_reaction_user_id=${cursor}` : '';
        const data = await fetchJSON(`${BASE}/discourse-reactions/posts/reactions.json?username=${encodeURIComponent(username)}${suffix}`, {
          signal, priority: cursor ? 'background' : 'visible',
        });
        REACTIONS_AVAILABLE = true;
        const batch = data.reactions || data.post_reactions || [];
        let nextCursor = 0;
        batch.forEach((item) => {
          const id = Number(item.id) || 0;
          if (id && (!nextCursor || id < nextCursor)) nextCursor = id;
          const key = String(item.id || `${item.post_id}:${item.reaction_value || ''}`);
          if (!seenRecords.has(key)) { seenRecords.add(key); items.push(Object.assign({ _reactionType: 'reaction' }, item)); }
        });
        if (!batch.length || !nextCursor || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor); cursor = nextCursor;
      }
      return items;
    })().catch((error) => {
      if (error && error.name === 'AbortError') throw error;
      if (error && error.status === 404) {
        REACTIONS_AVAILABLE = false;
        document.querySelectorAll('.ldp-v2 .ldp-reaction-btn,.ldp-v2 .ldp-reaction-picker').forEach((node) => node.remove());
      }
      return [];
    });
    const items = (await Promise.all([likesPromise, reactionsPromise])).flat()
      .sort((a, b) => Date.parse(b.created_at || b.acted_at || 0) - Date.parse(a.created_at || a.acted_at || 0));
    await writeCollectionCache('responses', items, signal);
    return items;
  }

  function collectionItemTarget(item) {
    const topicId = item.topic_id || (item.topic && item.topic.id) || item.bookmarkable_id;
    const postNumber = item.post_number || (item.post && item.post.post_number) || 1;
    return { topicId: topicId && String(topicId), postNumber: Number(postNumber) || 1 };
  }

  function likeInfo(p) {
    const like = (p.actions_summary || []).find((a) => a.id === 2) || {};
    return { count: like.count || 0, acted: !!like.acted, canAct: !!like.can_act };
  }

  const DEFAULT_ENABLED_REACTIONS = [
    'heart', '+1', 'laughing', 'open_mouth', 'clap', 'confetti_ball', 'hugs',
  ];

  let cachedDiscourseSiteSettings = null;
  function getDiscourseSiteSettings() {
    try {
      const live = PAGE_WIN && PAGE_WIN.Discourse && PAGE_WIN.Discourse.SiteSettings;
      if (live && typeof live === 'object') {
        cachedDiscourseSiteSettings = live;
        return live;
      }
    } catch (e) {}
    if (cachedDiscourseSiteSettings) return cachedDiscourseSiteSettings;
    try {
      const el = document.getElementById && document.getElementById('data-preloaded');
      if (el && el.dataset && el.dataset.preloaded) {
        const pre = JSON.parse(el.dataset.preloaded);
        if (pre && pre.siteSettings) {
          cachedDiscourseSiteSettings = typeof pre.siteSettings === 'string'
            ? JSON.parse(pre.siteSettings) : pre.siteSettings;
          return cachedDiscourseSiteSettings;
        }
      }
    } catch (e) {}
    return null;
  }

  function getMinReplyLength(topic) {
    const settings = getDiscourseSiteSettings();
    const isPM = topic && topic.archetype === 'private_message';
    const raw = settings && (isPM ? settings.min_personal_message_post_length : settings.min_post_length);
    const num = Number(raw);
    return Number.isFinite(num) && num > 0 ? num : 16;
  }

  function getBoostCharLimits() {
    const settings = getDiscourseSiteSettings();
    const maxRaw = Number(settings && (settings.discourse_boosts_max_length || settings.boost_max_length));
    const minRaw = Number(settings && (settings.discourse_boosts_min_length || settings.boost_min_length));
    return {
      min: Number.isFinite(minRaw) && minRaw > 0 ? minRaw : 1,
      max: Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : 16,
    };
  }

  function countInputChars(text) {
    return Array.from(String(text || '').trim()).length;
  }

  const REACTION_LABELS = {
    heart: '❤', '+1': '👍', laughing: '😄', tada: '🎉',
    open_mouth: '😮', cry: '😢', angry: '😠', confused: '😕',
    rocket: '🚀', eyes: '👀', fire: '🔥', clap: '👏', thinking: '🤔',
    confetti_ball: '🎊', hugs: '🤗', thumbsup: '👍',
  };

  function normalizeEmojiId(id) {
    return String(id || '').replace(/^:|:$/g, '').trim();
  }

  function reactionLabel(id) {
    const clean = normalizeEmojiId(id);
    return REACTION_LABELS[clean] || `:${clean}:`;
  }

  function reactionIconHtml(id) {
    const clean = normalizeEmojiId(id);
    if (!clean) return '☺';
    if (!emojiDataCache && !emojiDataLoading) {
      fetchEmojiData().then(refreshCustomReactionImages).catch(() => {});
    }
    if (REACTION_LABELS[clean] && !emojiUrlMap.has(clean)) {
      return `<span class="ldp-reaction-char" aria-hidden="true">${REACTION_LABELS[clean]}</span>`;
    }
    const fallbackName = clean === '+1' ? 'thumbsup' : clean;
    return `<img class="ldp-reaction-img" data-emoji-name="${escAttr(clean)}" src="${escAttr(emojiUrl(fallbackName))}" alt=":${escAttr(clean)}:" loading="lazy">`;
  }

  function refreshCustomReactionImages() {
    document.querySelectorAll('img.ldp-reaction-img[data-emoji-name]').forEach((img) => {
      const name = img.dataset.emojiName;
      if (name && emojiUrlMap.has(name)) {
        const nextSrc = emojiUrlMap.get(name);
        if (nextSrc && img.getAttribute('src') !== nextSrc) img.src = nextSrc;
      }
    });
  }

  function validReactionIds(topic, post) {
    if (topic && Array.isArray(topic.valid_reactions) && topic.valid_reactions.length) {
      return Array.from(new Set(
        topic.valid_reactions
          .map((item) => normalizeEmojiId(typeof item === 'string' ? item : (item && (item.id || item.name)) || ''))
          .filter(Boolean),
      ));
    }
    const settings = getDiscourseSiteSettings();
    const rawEnabled = settings && settings.discourse_reactions_enabled_reactions;
    if (typeof rawEnabled === 'string' && rawEnabled.trim()) {
      const mainId = normalizeEmojiId((settings && settings.discourse_reactions_reaction_for_like) || 'heart').replace(/-/g, '');
      const list = [mainId, ...rawEnabled.split('|').map(normalizeEmojiId)].filter(Boolean);
      if (list.length) return Array.from(new Set(list));
    }
    const fromPost = post && Array.isArray(post.reactions)
      ? post.reactions.map((item) => normalizeEmojiId(item && item.id)).filter(Boolean)
      : [];
    return Array.from(new Set([...DEFAULT_ENABLED_REACTIONS, ...fromPost]));
  }
  function getPostLikeView(post) {
    const info = likeInfo(post || {});
    const currentReaction = normalizeEmojiId(post && post.current_user_reaction && post.current_user_reaction.id);
    const reactionsSum = (post && Array.isArray(post.reactions) ? post.reactions : [])
      .reduce((sum, item) => sum + Math.max(0, Number(item && item.count) || 0), 0);
    const count = Math.max(info.count, reactionsSum);
    const acted = info.acted || !!currentReaction;
    const isCustomReaction = !!(currentReaction && currentReaction !== 'heart');
    const isOwnPost = !!(ME_USERNAME && post && post.username === ME_USERNAME);
    const canInteract = !isOwnPost && (info.canAct || acted);
    return { count, acted, canAct: info.canAct, currentReaction, isCustomReaction, canInteract };
  }

  function parseTopicHref(href) {
    if (!href) return null;
    let pathname;
    try { pathname = new URL(href, location.origin).pathname; }
    catch (err) { return null; }
    const parts = pathname.split('/').filter(Boolean);
    if (parts[0] !== 't' || !parts[1]) return null;
    const hasSlug = !/^\d+$/.test(parts[1]);
    const topicPart = hasSlug ? parts[2] : parts[1];
    const postPart = hasSlug ? parts[3] : parts[2];
    if (!topicPart || !/^\d+$/.test(topicPart)) return null;
    return {
      topicId: topicPart,
      targetPostNumber: postPart && /^\d+$/.test(postPart) ? Number(postPart) : null,
    };
  }

  function resolveInitialTarget(topic, requestedTarget) {
    const requested = Number(requestedTarget) || 0;
    if (requested > 0) return requested;
    const lastRead = Number(topic && topic.last_read_post_number) || 0;
    const highest = Number(topic && topic.highest_post_number)
        || Number(topic && topic.posts_count)
        || 1;
    return lastRead > 0 && lastRead < highest ? lastRead + 1 : 1;
  }

  /* ============ 2.5 保存首帖快照到 Obsidian ============ */
  // Markdown 转换与写入流程移植并改编自 zsq 的 MIT 脚本：
  // https://greasyfork.org/zh-CN/scripts/587200-linux-do-%E5%B8%96%E5%AD%90%E4%BF%9D%E5%AD%98%E5%88%B0-obsidian
  const OBSIDIAN_SETTINGS_KEY = 'ldp-obsidian-settings-v1';
  const OBSIDIAN_TOPIC_PATHS_KEY = 'ldp-obsidian-topic-paths-v2';
  const OBSIDIAN_DEFAULT_SETTINGS = {
    mode: 'rest',
    apiUrl: 'http://127.0.0.1:27123',
    apiKey: '',
    vaultName: '',
    baseFolder: '论坛收藏',
  };
  let OBSIDIAN_SAVING = false;
  let OBSIDIAN_SAVE_TEXT = '保存到 Obsidian';
  let CURRENT_OBSIDIAN_DIALOG_CLOSE = null;
  let OBSIDIAN_PAGE_ACTIONS_RAF = 0;
  let CATEGORY_SITE_CACHE = null;

  function getGMMethod(name) {
    if (typeof GM !== 'undefined' && GM && typeof GM[name] === 'function') {
      return GM[name].bind(GM);
    }
    throw new Error('当前脚本管理器不支持所需的 GM.' + name + ' 接口');
  }

  async function loadObsidianSettings() {
    const stored = await getGMMethod('getValue')(OBSIDIAN_SETTINGS_KEY, {});
    const value = stored && typeof stored === 'object' ? stored : {};
    const settings = Object.assign({}, OBSIDIAN_DEFAULT_SETTINGS, value);
    if (settings.mode !== 'rest' && settings.mode !== 'uri') settings.mode = 'rest';
    return settings;
  }

  async function persistObsidianSettings(settings) {
    await getGMMethod('setValue')(OBSIDIAN_SETTINGS_KEY, settings);
  }

  function obsidianErrorMessage(error) {
    if (error && error.name === 'AbortError') return '操作已取消';
    return error instanceof Error ? error.message : String(error || '未知错误');
  }

  function showObsidianToast(message, type, duration) {
    document.querySelectorAll('.ldp-obsidian-toast').forEach((node) => node.remove());
    const toast = document.createElement('div');
    toast.className = 'ldp-obsidian-toast';
    toast.dataset.type = type || 'info';
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), duration || (type === 'error' ? 8000 : 5500));
  }

  function setObsidianSaveState(text, busy) {
    OBSIDIAN_SAVE_TEXT = text;
    OBSIDIAN_SAVING = !!busy;
    document.querySelectorAll('[data-ldp-obsidian-save]').forEach((button) => {
      const label = button.querySelector('.ldp-obsidian-label');
      if (label) label.textContent = text;
      button.disabled = !!busy;
      button.setAttribute('aria-busy', busy ? 'true' : 'false');
    });
    document.querySelectorAll('[data-ldp-obsidian-settings]').forEach((button) => {
      button.disabled = !!busy;
    });
  }

  async function copyTopicUrl(topicId) {
    const topicUrl = `${BASE}/t/${encodeURIComponent(String(topicId))}`;
    try {
      await copyText(topicUrl);
      showObsidianToast('帖子链接已复制', 'success');
    } catch (error) {
      showObsidianToast('复制失败，请检查浏览器剪贴板权限', 'error');
    }
  }

  function createObsidianActionGroup(topicId, topicProvider, extraClass) {
    const group = document.createElement('div');
    group.className = 'ldp-obsidian-actions' + (extraClass ? ` ${extraClass}` : '');
    group.dataset.topicId = String(topicId);
    group.innerHTML = `
      <button type="button" class="ldp-obsidian-save" data-ldp-obsidian-save
        title="将楼主首帖保存为新的 Obsidian 快照" aria-label="保存到 Obsidian">
        <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS.download}</svg>
        <span class="ldp-obsidian-label"></span>
      </button>
      <button type="button" class="ldp-obsidian-copy" data-ldp-obsidian-copy
        title="复制帖子链接" aria-label="复制帖子链接">
        <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS.copy}</svg>
      </button>
      <button type="button" class="ldp-obsidian-settings" data-ldp-obsidian-settings
        title="设置 Obsidian 连接" aria-label="设置 Obsidian 连接">
        <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS.settings}</svg>
      </button>`;
    const saveButton = group.querySelector('[data-ldp-obsidian-save]');
    const copyButton = group.querySelector('[data-ldp-obsidian-copy]');
    const settingsButton = group.querySelector('[data-ldp-obsidian-settings]');
    saveButton.querySelector('.ldp-obsidian-label').textContent = OBSIDIAN_SAVE_TEXT;
    saveButton.disabled = OBSIDIAN_SAVING;
    saveButton.setAttribute('aria-busy', OBSIDIAN_SAVING ? 'true' : 'false');
    settingsButton.disabled = OBSIDIAN_SAVING;
    saveButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const suppliedTopic = typeof topicProvider === 'function' ? topicProvider() : null;
      saveTopicToObsidian(topicId, suppliedTopic);
    });
    copyButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      copyTopicUrl(topicId);
    });
    settingsButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showObsidianSettings();
    });
    return group;
  }

  function validateObsidianApiUrl(value) {
    let url;
    try { url = new URL(String(value || '').trim()); }
    catch (error) { throw new Error('REST API 地址格式不正确'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('REST API 只支持 HTTP 或 HTTPS');
    }
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      throw new Error('为保护 API Key，REST API 地址只允许 localhost 或 127.0.0.1');
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error('REST API 地址不能包含账号、查询参数或锚点');
    }
    return url.origin;
  }

  function obsidianGMRequest(options) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler) => (value) => {
        if (settled) return;
        settled = true;
        handler(value);
      };
      const onResolve = finish(resolve);
      const onReject = finish(reject);
      const requestOptions = Object.assign({}, options, {
        timeout: 20000,
        onload: onResolve,
        onerror: () => onReject(new Error('无法连接 Obsidian Local REST API')),
        ontimeout: () => onReject(new Error('连接 Obsidian Local REST API 超时')),
        onabort: () => onReject(new Error('Obsidian 请求已取消')),
      });
      try {
        const request = getGMMethod('xmlHttpRequest')(requestOptions);
        if (request && typeof request.then === 'function') request.then(onResolve, onReject);
      } catch (error) {
        onReject(error);
      }
    });
  }

  async function testObsidianRest(apiUrl, apiKey) {
    const origin = validateObsidianApiUrl(apiUrl);
    if (!String(apiKey || '').trim()) throw new Error('请先填写 Local REST API Key');
    const response = await obsidianGMRequest({
      method: 'GET',
      url: origin + '/',
      headers: { Authorization: `Bearer ${String(apiKey).trim()}` },
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error('服务响应异常：HTTP ' + response.status);
    }
  }

  async function saveObsidianWithRest(markdown, vaultPath, settings) {
    const origin = validateObsidianApiUrl(settings.apiUrl);
    const apiKey = String(settings.apiKey || '').trim();
    if (!apiKey) throw new Error('请先填写 Local REST API Key');
    const encodedPath = vaultPath.split('/').map(encodeURIComponent).join('/');
    const response = await obsidianGMRequest({
      method: 'PUT',
      url: `${origin}/vault/${encodedPath}`,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'text/markdown; charset=utf-8',
      },
      data: markdown,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error('Obsidian 写入失败：HTTP ' + response.status);
    }
  }

  async function inspectObsidianRestPath(settings, vaultPath, topicId) {
    const origin = validateObsidianApiUrl(settings.apiUrl);
    const apiKey = String(settings.apiKey || '').trim();
    if (!apiKey) throw new Error('请先填写 Local REST API Key');
    const encodedPath = vaultPath.split('/').map(encodeURIComponent).join('/');
    const response = await obsidianGMRequest({
      method: 'GET',
      url: `${origin}/vault/${encodedPath}`,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (response.status === 404) return 'available';
    if (response.status < 200 || response.status >= 300) {
      throw new Error('检查 Obsidian 笔记失败：HTTP ' + response.status);
    }
    const content = String(response.responseText || '');
    const escapedTopicId = String(topicId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const isSameTopic = new RegExp(`(?:\\*\\*帖子 ID\\*\\*：|topic_id:\\s*)${escapedTopicId}(?:\\s|$)`).test(content);
    return isSameTopic ? 'same-topic' : 'occupied';
  }

  async function saveObsidianWithUri(markdown, vaultPath, settings, overwrite) {
    await getGMMethod('setClipboard')(markdown, 'text');
    const params = new URLSearchParams();
    const vaultName = String(settings.vaultName || '').trim();
    if (vaultName) params.set('vault', vaultName);
    params.set('file', vaultPath);
    params.set('clipboard', 'true');
    if (overwrite) params.set('overwrite', 'true');
    const link = document.createElement('a');
    link.href = `obsidian://new?${params.toString()}`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function showObsidianSettings() {
    if (CURRENT_OBSIDIAN_DIALOG_CLOSE) CURRENT_OBSIDIAN_DIALOG_CLOSE(false);
    const settings = await loadObsidianSettings();
    const returnFocus = document.activeElement;
    return new Promise((resolve) => {
      let closed = false;
      const overlay = document.createElement('div');
      overlay.className = 'ldp-obsidian-dialog-overlay';
      overlay.innerHTML = `
        <form class="ldp-obsidian-dialog" role="dialog" aria-modal="true" aria-labelledby="ldp-obsidian-dialog-title">
          <div class="ldp-obsidian-dialog-head">
            <div>
              <h2 id="ldp-obsidian-dialog-title">保存到 Obsidian</h2>
              <p class="ldp-obsidian-dialog-subtitle">同一帖子再次保存时更新原笔记，不创建重复文件</p>
            </div>
            <button type="button" class="ldp-obsidian-dialog-close" title="关闭" aria-label="关闭设置">×</button>
          </div>
          <p class="ldp-obsidian-dialog-note">REST 模式不会切换窗口，但需要 Obsidian 正在运行并启用 Local REST API；URI 模式无需插件，会打开 Obsidian 并使用剪贴板。</p>
          <label for="ldp-obsidian-mode">写入方式</label>
          <select id="ldp-obsidian-mode">
            <option value="rest">直接写入 Vault（推荐）</option>
            <option value="uri">Obsidian URI（会打开 Obsidian）</option>
          </select>
          <div data-ldp-rest-fields>
            <label for="ldp-obsidian-api-url">Local REST API 地址</label>
            <input id="ldp-obsidian-api-url" type="url" inputmode="url" autocomplete="off">
            <label for="ldp-obsidian-api-key">API Key</label>
            <input id="ldp-obsidian-api-key" type="password" autocomplete="off">
            <p class="ldp-obsidian-dialog-help">Key 只保存在油猴私有存储，并且只能发送到本机地址。</p>
            <button type="button" class="ldp-obsidian-test">测试连接</button>
          </div>
          <div data-ldp-uri-fields>
            <label for="ldp-obsidian-vault">Vault 名称</label>
            <input id="ldp-obsidian-vault" type="text" placeholder="留空则使用当前 Vault">
            <p class="ldp-obsidian-dialog-help">保存时会复制 Markdown，并调用 obsidian://new。</p>
          </div>
          <label for="ldp-obsidian-folder">基础目录</label>
          <input id="ldp-obsidian-folder" type="text" placeholder="论坛收藏">
          <p class="ldp-obsidian-dialog-help">实际路径会自动追加站点和帖子标题；同一帖子始终复用原路径。</p>
          <div class="ldp-obsidian-dialog-status" aria-live="polite"></div>
          <div class="ldp-obsidian-dialog-actions">
            <button type="button" class="ldp-obsidian-secondary" data-action="cancel">取消</button>
            <button type="submit" class="ldp-obsidian-primary">保存设置</button>
          </div>
        </form>`;
      document.body.appendChild(overlay);
      const form = overlay.querySelector('form');
      const modeInput = overlay.querySelector('#ldp-obsidian-mode');
      const apiUrlInput = overlay.querySelector('#ldp-obsidian-api-url');
      const apiKeyInput = overlay.querySelector('#ldp-obsidian-api-key');
      const vaultInput = overlay.querySelector('#ldp-obsidian-vault');
      const folderInput = overlay.querySelector('#ldp-obsidian-folder');
      const restFields = overlay.querySelector('[data-ldp-rest-fields]');
      const uriFields = overlay.querySelector('[data-ldp-uri-fields]');
      const status = overlay.querySelector('.ldp-obsidian-dialog-status');
      const testButton = overlay.querySelector('.ldp-obsidian-test');
      modeInput.value = settings.mode;
      apiUrlInput.value = settings.apiUrl;
      apiKeyInput.value = settings.apiKey;
      vaultInput.value = settings.vaultName;
      folderInput.value = settings.baseFolder;

      function updateModeFields() {
        restFields.hidden = modeInput.value !== 'rest';
        uriFields.hidden = modeInput.value !== 'uri';
      }
      function setStatus(message, type) {
        status.textContent = message || '';
        status.dataset.type = type || 'info';
      }
      function close(result) {
        if (closed) return;
        closed = true;
        overlay.remove();
        document.removeEventListener('keydown', onKeyDown, true);
        if (CURRENT_OBSIDIAN_DIALOG_CLOSE === close) CURRENT_OBSIDIAN_DIALOG_CLOSE = null;
        if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') {
          returnFocus.focus({ preventScroll: true });
        }
        resolve(result);
      }
      function onKeyDown(event) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        close(false);
      }
      CURRENT_OBSIDIAN_DIALOG_CLOSE = close;
      modeInput.addEventListener('change', updateModeFields);
      updateModeFields();
      overlay.querySelector('.ldp-obsidian-dialog-close').addEventListener('click', () => close(false));
      overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => close(false));
      overlay.addEventListener('click', (event) => { if (event.target === overlay) close(false); });
      document.addEventListener('keydown', onKeyDown, true);
      testButton.addEventListener('click', async () => {
        testButton.disabled = true;
        setStatus('正在测试连接…');
        try {
          await testObsidianRest(apiUrlInput.value, apiKeyInput.value);
          setStatus('服务连接成功。', 'success');
        } catch (error) {
          setStatus(obsidianErrorMessage(error), 'error');
        } finally {
          testButton.disabled = false;
        }
      });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          const nextSettings = {
            mode: modeInput.value,
            apiUrl: apiUrlInput.value.trim(),
            apiKey: apiKeyInput.value.trim(),
            vaultName: vaultInput.value.trim(),
            baseFolder: folderInput.value.trim() || OBSIDIAN_DEFAULT_SETTINGS.baseFolder,
          };
          if (nextSettings.mode === 'rest') {
            nextSettings.apiUrl = validateObsidianApiUrl(nextSettings.apiUrl);
            if (!nextSettings.apiKey) throw new Error('请填写 Local REST API Key');
          }
          await persistObsidianSettings(nextSettings);
          close(true);
        } catch (error) {
          setStatus(obsidianErrorMessage(error), 'error');
        }
      });
      modeInput.focus({ preventScroll: true });
    });
  }

  function confirmObsidianUpdate(vaultPath) {
    if (CURRENT_OBSIDIAN_DIALOG_CLOSE) CURRENT_OBSIDIAN_DIALOG_CLOSE(false);
    const returnFocus = document.activeElement;
    return new Promise((resolve) => {
      let closed = false;
      const overlay = document.createElement('div');
      overlay.className = 'ldp-obsidian-dialog-overlay';
      overlay.innerHTML = `
        <div class="ldp-obsidian-dialog ldp-obsidian-confirm" role="dialog" aria-modal="true"
          aria-labelledby="ldp-obsidian-confirm-title">
          <div class="ldp-obsidian-confirm-icon" aria-hidden="true">↻</div>
          <h2 id="ldp-obsidian-confirm-title">检测到已保存的帖子</h2>
          <p class="ldp-obsidian-confirm-copy">此帖子已经保存到 Obsidian。继续后会更新原笔记，不会创建重复文件。</p>
          <code class="ldp-obsidian-confirm-path"></code>
          <div class="ldp-obsidian-dialog-actions">
            <button type="button" class="ldp-obsidian-secondary" data-action="cancel">取消</button>
            <button type="button" class="ldp-obsidian-primary" data-action="update">更新原笔记</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.querySelector('.ldp-obsidian-confirm-path').textContent = vaultPath;
      const updateButton = overlay.querySelector('[data-action="update"]');

      function close(result) {
        if (closed) return;
        closed = true;
        overlay.remove();
        document.removeEventListener('keydown', onKeyDown, true);
        if (CURRENT_OBSIDIAN_DIALOG_CLOSE === close) CURRENT_OBSIDIAN_DIALOG_CLOSE = null;
        if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') {
          returnFocus.focus({ preventScroll: true });
        }
        resolve(result);
      }
      function onKeyDown(event) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        close(false);
      }
      CURRENT_OBSIDIAN_DIALOG_CLOSE = close;
      overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => close(false));
      updateButton.addEventListener('click', () => close(true));
      overlay.addEventListener('click', (event) => { if (event.target === overlay) close(false); });
      document.addEventListener('keydown', onKeyDown, true);
      updateButton.focus({ preventScroll: true });
    });
  }

  function makeObsidianAbsoluteUrl(value) {
    if (!value || /^(?:#|data:|mailto:|obsidian:)/i.test(value)) return value;
    try { return new URL(value, BASE + '/').href; }
    catch (error) { return value; }
  }

  function normalizeObsidianCodeLanguage(language, value) {
    const normalized = String(language || '').toLowerCase();
    if (normalized && normalized !== 'auto') return normalized;
    if (/\b(?:irm|invoke-restmethod)\b|\|\s*iex\b|\$env:/i.test(value)) return 'powershell';
    if (/^\s*(?:#!.*\b(?:bash|sh)|(?:sudo\s+)?(?:bash|sh|curl|wget)\b)/im.test(value)) return 'bash';
    const trimmed = String(value || '').trim();
    if (trimmed && /^[\[{]/.test(trimmed)) {
      try { JSON.parse(trimmed); return 'json'; }
      catch (error) { /* 继续按纯文本处理 */ }
    }
    return 'text';
  }

  function quoteObsidianMarkdown(markdown, prefix) {
    const actualPrefix = prefix || '> ';
    return String(markdown || '').split('\n')
        .map((line) => line ? actualPrefix + line : actualPrefix.trimEnd()).join('\n');
  }

  function cookedHtmlToObsidianMarkdown(cooked) {
    const container = document.createElement('div');
    container.innerHTML = cooked || '';
    container.querySelectorAll('script,style,iframe,object,embed,form,button,.lightbox-wrapper .meta')
        .forEach((node) => node.remove());
    container.querySelectorAll('img.emoji').forEach((image) => {
      image.replaceWith(document.createTextNode(image.getAttribute('alt') || ''));
    });
    container.querySelectorAll('a.anchor').forEach((anchor) => anchor.remove());
    const codeBlocks = new Map();
    let codeBlockIndex = 0;

    function renderChildren(element) {
      return Array.from(element.childNodes).map((node) => renderNode(node)).join('');
    }
    function renderList(element, ordered) {
      const items = Array.from(element.children).filter((child) => child.tagName === 'LI');
      return items.map((item, index) => {
        const nestedLists = Array.from(item.children).filter((child) => child.tagName === 'UL' || child.tagName === 'OL');
        const body = Array.from(item.childNodes).filter((node) => !nestedLists.includes(node))
            .map((node) => renderNode(node)).join('').trim().replace(/\n{2,}/g, '\n');
        const marker = ordered ? `${index + 1}. ` : '- ';
        const renderedBody = body.split('\n')
            .map((line, lineIndex) => lineIndex === 0 ? marker + line : '  ' + line).join('\n');
        const renderedNested = nestedLists.map((nested) => renderNode(nested).trim()).filter(Boolean)
            .map((nested) => nested.split('\n').map((line) => '  ' + line).join('\n')).join('\n');
        return [renderedBody, renderedNested].filter(Boolean).join('\n');
      }).join('\n') + '\n\n';
    }
    function renderTable(element) {
      const rows = Array.from(element.rows || []);
      if (!rows.length) return '';
      const values = rows.map((row) => Array.from(row.cells).map((cell) => renderChildren(cell)
          .trim().replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' / ')));
      const width = Math.max(...values.map((row) => row.length));
      const normalized = values.map((row) => row.concat(Array.from({ length: width - row.length }, () => '')));
      return [
        `| ${normalized[0].join(' | ')} |`,
        `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
        ...normalized.slice(1).map((row) => `| ${row.join(' | ')} |`),
        '',
      ].join('\n');
    }
    function renderNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return String(node.nodeValue || '').replace(/[\t\r\n ]+/g, ' ');
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const element = node;
      const tag = element.tagName;
      const body = () => renderChildren(element).trim();
      if (tag === 'BR') return '\n';
      if (/^H[1-6]$/.test(tag)) return `${'#'.repeat(Math.min(Number(tag.slice(1)) + 2, 6))} ${body()}\n\n`;
      if (['P', 'DIV', 'SECTION', 'ARTICLE', 'FIGURE', 'FIGCAPTION'].includes(tag)) {
        const content = body();
        return content ? content + '\n\n' : '';
      }
      if (tag === 'STRONG' || tag === 'B') return `**${body()}**`;
      if (tag === 'EM' || tag === 'I') return `*${body()}*`;
      if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return `~~${body()}~~`;
      if (tag === 'MARK') return `==${body()}==`;
      if (tag === 'A') {
        const href = makeObsidianAbsoluteUrl(element.getAttribute('href') || '');
        const label = body() || href;
        return href ? `[${label}](${href})` : label;
      }
      if (tag === 'IMG') {
        const source = element.getAttribute('data-orig-src') || element.getAttribute('data-large-uri')
            || element.getAttribute('data-src') || element.getAttribute('src');
        if (!source) return element.getAttribute('alt') || '';
        const alt = String(element.getAttribute('alt') || '图片').replace(/[\[\]]/g, '');
        return `![${alt}](<${makeObsidianAbsoluteUrl(source)}>)`;
      }
      if (tag === 'PRE') {
        const code = element.querySelector('code');
        const value = String((code && code.textContent) || element.textContent || '').replace(/^\n|\n$/g, '');
        const className = (code && code.className) || element.className || '';
        const match = className.match(/(?:lang(?:uage)?-)([\w+-]+)/i);
        const language = match && match[1];
        const runs = Array.from(value.matchAll(/`+/g), (item) => item[0].length + 1);
        const fence = '`'.repeat(Math.max(3, ...runs));
        const token = `LDP_OBSIDIAN_CODE_${codeBlockIndex}_PLACEHOLDER`;
        codeBlockIndex += 1;
        codeBlocks.set(token, `${fence}${normalizeObsidianCodeLanguage(language, value)}\n${value}\n${fence}`);
        return `\n\n${token}\n\n`;
      }
      if (tag === 'CODE') {
        const value = element.textContent || '';
        const runs = Array.from(value.matchAll(/`+/g), (item) => item[0].length + 1);
        const fence = '`'.repeat(Math.max(1, ...runs));
        return `${fence}${value}${fence}`;
      }
      if (tag === 'ASIDE' && element.classList.contains('quote')) {
        const titleElement = element.querySelector('.quote-title__text-content a')
            || element.querySelector('.title a') || element.querySelector('.title');
        const title = String((titleElement && titleElement.textContent) || '引用').replace(/\s+/g, ' ').trim();
        const quoted = element.querySelector('blockquote');
        const content = quoted ? renderChildren(quoted).trim() : body();
        return [`> [!quote] ${title}`, quoteObsidianMarkdown(content), ''].join('\n') + '\n';
      }
      if (tag === 'BLOCKQUOTE') return quoteObsidianMarkdown(body()) + '\n\n';
      if (tag === 'UL') return renderList(element, false);
      if (tag === 'OL') return renderList(element, true);
      if (tag === 'TABLE') return renderTable(element);
      if (tag === 'HR') return '\n---\n\n';
      if (tag === 'KBD') return `\`${element.textContent || ''}\``;
      return renderChildren(element);
    }

    let markdown = renderChildren(container).replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    for (const [token, codeBlock] of codeBlocks) markdown = markdown.replace(token, codeBlock);
    return markdown;
  }

  function formatObsidianDateTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value || '');
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      second: '2-digit', hour12: false,
    }).format(date).replaceAll('/', '-');
  }

  function sanitizeObsidianPathSegment(value, fallback) {
    const sanitized = String(value || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
        .replace(/\.{2,}/g, '.').replace(/\s+/g, ' ').replace(/[. ]+$/g, '').trim();
    return (sanitized || fallback || '').slice(0, 90);
  }

  function obsidianSiteInfo() {
    if (location.hostname === 'idcflare.com') {
      return { directory: 'IDC Flare', source: 'idcflare.com', tag: 'idc-flare' };
    }
    return { directory: 'LINUX DO', source: 'linux.do', tag: 'linux-do' };
  }

  async function getObsidianCategoryName(topic) {
    const direct = String((topic.category && topic.category.name) || topic.category_name || '').trim();
    if (direct) return direct;
    if (!topic.category_id) return '未分类';
    try {
      if (!CATEGORY_SITE_CACHE) {
        CATEGORY_SITE_CACHE = await fetchJSON(`${BASE}/site.json`, { cache: 'force-cache' });
      }
      const categories = CATEGORY_SITE_CACHE.categories || [];
      const category = categories.find((item) => Number(item.id) === Number(topic.category_id));
      return String((category && category.name) || '').trim() || '未分类';
    } catch (error) {
      return '未分类';
    }
  }

  async function loadObsidianTopic(topicId, suppliedTopic) {
    let topic = suppliedTopic && String(suppliedTopic.id) === String(topicId) ? suppliedTopic : null;
    if (!topic) topic = await fetchJSON(`${BASE}/t/${topicId}.json`, { cache: 'no-store' });
    let firstPost = topic._opPost || ((topic.post_stream && topic.post_stream.posts) || [])
        .find((post) => Number(post.post_number) === 1);
    if (!firstPost) {
      const anchor = await fetchJSON(`${BASE}/t/${topicId}.json?post_number=1`, { cache: 'no-store' });
      firstPost = ((anchor.post_stream && anchor.post_stream.posts) || [])
          .find((post) => Number(post.post_number) === 1);
    }
    if (!firstPost || !firstPost.cooked) throw new Error('没有读取到楼主首帖，可能是帖子权限不足');
    topic._obsidianFirstPost = firstPost;
    topic._obsidianCategoryName = await getObsidianCategoryName(topic);
    return topic;
  }

  function buildObsidianVaultPath(settings, topic, duplicateIndex) {
    const baseSegments = String(settings.baseFolder || OBSIDIAN_DEFAULT_SETTINGS.baseFolder).split('/')
        .map((segment) => sanitizeObsidianPathSegment(segment, '')).filter(Boolean);
    const site = obsidianSiteInfo();
    const title = sanitizeObsidianPathSegment(topic.title, '未命名主题');
    const suffix = duplicateIndex > 1 ? `-${duplicateIndex}` : '';
    const filename = `${title}${suffix}.md`;
    return baseSegments.concat(site.directory, filename).join('/');
  }

  async function resolveObsidianVaultTarget(settings, topic) {
    const stored = await getGMMethod('getValue')(OBSIDIAN_TOPIC_PATHS_KEY, {});
    const topicPaths = stored && typeof stored === 'object' ? stored : {};
    const baseFolderKey = String(settings.baseFolder || OBSIDIAN_DEFAULT_SETTINGS.baseFolder).split('/')
        .map((segment) => sanitizeObsidianPathSegment(segment, '')).filter(Boolean).join('/');
    const site = obsidianSiteInfo();
    const key = `${site.source}|${baseFolderKey}|${topic.id}`;
    if (typeof topicPaths[key] === 'string' && topicPaths[key]) {
      return { key, path: topicPaths[key], topicPaths, isUpdate: true, shouldRemember: false };
    }

    const occupiedPaths = new Set(Object.values(topicPaths).filter((value) => typeof value === 'string'));
    let duplicateIndex = 1;
    let path = buildObsidianVaultPath(settings, topic, duplicateIndex);
    while (true) {
      if (!occupiedPaths.has(path) && settings.mode === 'rest') {
        const pathState = await inspectObsidianRestPath(settings, path, topic.id);
        if (pathState === 'same-topic') {
          return { key, path, topicPaths, isUpdate: true, shouldRemember: true };
        }
        if (pathState === 'available') break;
      } else if (!occupiedPaths.has(path)) {
        break;
      }
      duplicateIndex += 1;
      path = buildObsidianVaultPath(settings, topic, duplicateIndex);
    }
    return { key, path, topicPaths, isUpdate: false, shouldRemember: true };
  }

  async function rememberObsidianVaultTarget(target) {
    if (!target.shouldRemember) return;
    target.topicPaths[target.key] = target.path;
    await getGMMethod('setValue')(OBSIDIAN_TOPIC_PATHS_KEY, target.topicPaths);
  }

  function buildObsidianMarkdown(topic, snapshotDate) {
    const firstPost = topic._obsidianFirstPost;
    const site = obsidianSiteInfo();
    const sourceUrl = `${BASE}/t/${topic.slug || 'topic'}/${topic.id}`;
    const sourceTags = Array.isArray(topic.tags)
      ? topic.tags.map((tag) => typeof tag === 'string' ? tag : tag && tag.name).filter(Boolean)
      : [];
    const tags = Array.from(new Set([site.tag].concat(sourceTags)));
    const author = firstPost.username || firstPost.display_username || 'unknown';
    const tagLine = tags.map((tag) => {
      const normalized = String(tag || '').trim().replace(/^#+/, '').replace(/\s+/g, '-');
      return normalized ? `#${normalized}` : '';
    }).filter(Boolean).join(' ');
    const body = cookedHtmlToObsidianMarkdown(firstPost.cooked);
    const information = [
      '> [!info] 帖子信息',
      `> - **原帖链接**：[打开原帖](${sourceUrl})`,
      `> - **站点**：${site.directory}`,
      `> - **帖子 ID**：${topic.id}`,
      `> - **分类**：${topic._obsidianCategoryName || '未分类'}`,
      `> - **楼主**：@${author}`,
      `> - **发布时间**：${formatObsidianDateTime(firstPost.created_at || topic.created_at)}`,
      `> - **更新时间**：${formatObsidianDateTime(firstPost.updated_at || firstPost.created_at)}`,
      `> - **保存时间**：${formatObsidianDateTime(snapshotDate.toISOString())}`,
    ].join('\n');
    return [information, '', `**标签**： ${tagLine}`, '', '## 主帖', '', body, '',
      `— [返回原帖](${sourceUrl})`, ''].join('\n');
  }

  async function saveTopicToObsidian(topicId, suppliedTopic) {
    if (OBSIDIAN_SAVING) return;
    setObsidianSaveState('准备中…', true);
    try {
      let settings = await loadObsidianSettings();
      if (settings.mode === 'rest' && !String(settings.apiKey || '').trim()) {
        setObsidianSaveState('等待配置…', true);
        const configured = await showObsidianSettings();
        if (!configured) return;
        settings = await loadObsidianSettings();
      }
      setObsidianSaveState('读取首帖…', true);
      const topic = await loadObsidianTopic(topicId, suppliedTopic);
      setObsidianSaveState('转换 Markdown…', true);
      const snapshotDate = new Date();
      const markdown = buildObsidianMarkdown(topic, snapshotDate);
      const vaultTarget = await resolveObsidianVaultTarget(settings, topic);
      const vaultPath = vaultTarget.path;
      if (vaultTarget.isUpdate) {
        setObsidianSaveState('等待确认…', true);
        const shouldUpdate = await confirmObsidianUpdate(vaultPath);
        if (!shouldUpdate) {
          showObsidianToast('已取消更新 Obsidian 笔记', 'info');
          return;
        }
      }
      if (settings.mode === 'rest') {
        setObsidianSaveState('写入 Obsidian…', true);
        await saveObsidianWithRest(markdown, vaultPath, settings);
        await rememberObsidianVaultTarget(vaultTarget);
        showObsidianToast(`${vaultTarget.isUpdate ? '已更新' : '已保存'} Obsidian 笔记：${vaultPath}`, 'success');
      } else {
        setObsidianSaveState('打开 Obsidian…', true);
        await saveObsidianWithUri(markdown, vaultPath, settings, vaultTarget.isUpdate);
        await rememberObsidianVaultTarget(vaultTarget);
        showObsidianToast(`Markdown 已复制，正在${vaultTarget.isUpdate ? '更新' : '创建'} Obsidian 笔记：${vaultPath}`, 'success');
      }
    } catch (error) {
      showObsidianToast(obsidianErrorMessage(error), 'error');
    } finally {
      setObsidianSaveState('保存到 Obsidian', false);
    }
  }

  function syncObsidianPageActions() {
    const parsed = parseTopicHref(location.href);
    const existing = document.querySelector('.ldp-obsidian-page-actions');
    if (!parsed) {
      if (existing) existing.remove();
      return;
    }
    const title = document.querySelector('#topic-title h1, #topic-title .fancy-title, .topic-title h1');
    if (!title) return;
    const host = title.closest('.title-wrapper') || title.parentElement;
    if (!host) return;
    if (existing && existing.parentElement === host && existing.dataset.topicId === String(parsed.topicId)) return;
    if (existing) existing.remove();
    host.appendChild(createObsidianActionGroup(parsed.topicId, null, 'ldp-obsidian-page-actions'));
  }

  function scheduleObsidianPageActions() {
    if (OBSIDIAN_PAGE_ACTIONS_RAF) return;
    OBSIDIAN_PAGE_ACTIONS_RAF = requestAnimationFrame(() => {
      OBSIDIAN_PAGE_ACTIONS_RAF = 0;
      syncObsidianPageActions();
    });
  }

  function startObsidianPageActions() {
    scheduleObsidianPageActions();
    const observer = new MutationObserver(scheduleObsidianPageActions);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('popstate', scheduleObsidianPageActions);
    window.addEventListener('hashchange', scheduleObsidianPageActions);
  }

  /* ============ 2.6 Boosts 气泡渲染辅助 ============ */
  /* ============ 2.55 Emoji Picker ============ */
  const EMOJI_CACHE_KEY = 'ldp_recent_emojis';
  const EMOJI_RECENT_MAX = 10;
  const EMOJI_CDN_BASE = location.hostname === 'linux.do' ? 'https://cdn.ldstatic.com' : BASE;
  let emojiDataCache = null;
  let emojiDataLoading = null;
  let _emojiSet = 'twemoji';
  function detectEmojiSet() {
    const img = document.querySelector && document.querySelector('img.emoji[src*="/images/emoji/"]');
    if (img) {
      const m = img.src.match(/\/images\/emoji\/([^/]+)\//);
      if (m) _emojiSet = m[1];
    }
  }
  onDomReady(detectEmojiSet);
  const emojiUrlMap = new Map();

  function getRecentEmojis() {
    try { return JSON.parse(localStorage.getItem(EMOJI_CACHE_KEY)) || []; }
    catch (e) { return []; }
  }

  function addRecentEmoji(name) {
    let list = getRecentEmojis().filter((n) => n !== name);
    list.unshift(name);
    if (list.length > EMOJI_RECENT_MAX) list = list.slice(0, EMOJI_RECENT_MAX);
    try { localStorage.setItem(EMOJI_CACHE_KEY, JSON.stringify(list)); } catch (e) {}
  }

  function emojiUrl(name) {
    if (emojiUrlMap.has(name)) return emojiUrlMap.get(name);
    return `${EMOJI_CDN_BASE}/images/emoji/${_emojiSet}/${name}.png`;
  }

  async function fetchEmojiData() {
    if (emojiDataCache) return emojiDataCache;
    if (emojiDataLoading) return emojiDataLoading;
    emojiDataLoading = (async () => {
      const CACHE_NAME = 'ldp-emoji-v2';
      const CACHE_URL = `${BASE}/emojis.json`;
      let raw;
      try {
        const cache = await caches.open(CACHE_NAME);
        let cached = await cache.match(CACHE_URL);
        if (!cached) {
          const res = await fetch(CACHE_URL, { credentials: 'include' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          await cache.put(CACHE_URL, res.clone());
          cached = res;
        }
        raw = await cached.json();
      } catch (e) {
        const res = await fetch(CACHE_URL, { credentials: 'include' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        raw = await res.json();
      }
      const groups = {};
      for (const [gKey, arr] of Object.entries(raw || {})) {
        if (!Array.isArray(arr)) continue;
        groups[gKey] = arr.map((entry) => {
          const name = (entry && entry.name) ? entry.name : String(entry);
          if (entry && entry.url) {
            let url = entry.url;
            if (url.startsWith('//')) url = 'https:' + url;
            else if (!url.startsWith('http')) url = BASE + url;
            if (location.hostname === 'linux.do') {
              url = url.replace('https://linux.do', 'https://cdn.ldstatic.com');
            }
            emojiUrlMap.set(name, url);
          }
          return name;
        });
      }
      emojiDataCache = groups;
      emojiDataLoading = null;
      refreshCustomReactionImages();
      return groups;
    })().catch((err) => { emojiDataLoading = null; throw err; });
    return emojiDataLoading;
  }

  function buildEmojiPanel(onPick, options) {
    const opts = options || {};
    const panel = document.createElement('div');
    panel.className = 'ldp-emoji-panel';
    if (Array.isArray(opts.quickReactions) && opts.quickReactions.length) {
      const quickWrap = document.createElement('div');
      quickWrap.className = 'ldp-emoji-quick';
      const current = normalizeEmojiId(opts.currentReaction);
      opts.quickReactions.slice(0, 12).forEach((rawId) => {
        const id = normalizeEmojiId(rawId);
        if (!id) return;
        const qBtn = document.createElement('button');
        qBtn.type = 'button';
        qBtn.className = 'ldp-emoji-quick-btn' + (current === id ? ' selected' : '');
        qBtn.title = ':' + id + ':';
        const fallbackName = id === '+1' ? 'thumbsup' : id;
        qBtn.innerHTML = `<img class="ldp-reaction-img" data-emoji-name="${escAttr(id)}" src="${escAttr(emojiUrl(fallbackName))}" alt=":${escAttr(id)}:" loading="lazy">`;
        qBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          addRecentEmoji(id);
          onPick(':' + id + ':', id);
        });
        quickWrap.appendChild(qBtn);
      });
      panel.appendChild(quickWrap);
    }
    const searchWrap = document.createElement('div');
    searchWrap.className = 'ldp-emoji-search';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = opts.placeholder || '搜索表情…';
    searchWrap.appendChild(searchInput);
    panel.appendChild(searchWrap);
    const tabsWrap = document.createElement('div');
    tabsWrap.className = 'ldp-emoji-tabs';
    panel.appendChild(tabsWrap);
    const grid = document.createElement('div');
    grid.className = 'ldp-emoji-grid';
    panel.appendChild(grid);
    let currentGroup = 'recent';
    let allGroups = null;
    function renderGrid(names, groupKey) {
      grid.innerHTML = '';
      if (!names || !names.length) {
        grid.innerHTML = '<div class="ldp-emoji-empty">' +
          (groupKey === 'recent' ? '暂无最近使用的表情' : '没有找到表情') + '</div>';
        return;
      }
      const frag = document.createDocumentFragment();
      for (const name of names) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ldp-emoji-item';
        btn.title = ':' + name + ':';
        btn.innerHTML = `<img src="${escAttr(emojiUrl(name))}" alt="${escAttr(name)}" loading="lazy">`;
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          addRecentEmoji(name);
          onPick(':' + name + ':', name);
        });
        frag.appendChild(btn);
      }
      grid.appendChild(frag);
    }
    function switchTab(groupKey) {
      currentGroup = groupKey;
      tabsWrap.querySelectorAll('.ldp-emoji-tab').forEach((t) => t.classList.toggle('active', t.dataset.group === groupKey));
      if (groupKey === 'recent') renderGrid(getRecentEmojis(), 'recent');
      else if (allGroups && allGroups[groupKey]) renderGrid(allGroups[groupKey], groupKey);
    }
    function doSearch(q) {
      if (!allGroups) return;
      q = q.toLowerCase().trim();
      if (!q) { switchTab(currentGroup); return; }
      tabsWrap.querySelectorAll('.ldp-emoji-tab').forEach((t) => t.classList.remove('active'));
      const results = [];
      for (const [gk, names] of Object.entries(allGroups)) {
        for (const n of names) {
          if (n.toLowerCase().includes(q)) results.push({ name: n, group: gk });
        }
      }
      renderGrid(results.map((r) => r.name), 'search');
    }
    grid.innerHTML = '<div class="ldp-emoji-empty">加载中…</div>';
    fetchEmojiData().then((groups) => {
      allGroups = groups;
      const RECENT_ICON = `${EMOJI_CDN_BASE}/images/emoji/twemoji/star.png?v=15`;
      const tabList = [{ key: 'recent', label: '最近', iconUrl: RECENT_ICON }];
      for (const gKey of Object.keys(groups)) {
        if (!groups[gKey].length) continue;
        tabList.push({ key: gKey, label: gKey, first: groups[gKey][0] });
      }
      tabsWrap.innerHTML = '';
      for (const g of tabList) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'ldp-emoji-tab' + (g.key === 'recent' ? ' active' : '');
        tab.dataset.group = g.key;
        tab.title = g.label;
        const img = document.createElement('img');
        img.src = g.iconUrl || emojiUrl(g.first);
        img.alt = g.label;
        img.loading = 'lazy';
        tab.appendChild(img);
        tab.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          searchInput.value = '';
          switchTab(g.key);
        });
        tabsWrap.appendChild(tab);
      }
      switchTab('recent');
    }).catch(() => {
      grid.innerHTML = '<div class="ldp-emoji-empty">表情加载失败</div>';
    });
    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => doSearch(searchInput.value), 200);
    });
    return panel;
  }

  let hoverReactionOpenTimer = 0;
  let hoverReactionCloseTimer = 0;
  let activeHoverReactionBtn = null;

  function clearHoverReactionTimers() {
    clearTimeout(hoverReactionOpenTimer);
    clearTimeout(hoverReactionCloseTimer);
    hoverReactionOpenTimer = 0;
    hoverReactionCloseTimer = 0;
    activeHoverReactionBtn = null;
  }

  function closeReactionHoverBar() {
    clearHoverReactionTimers();
    let closed = false;
    document.querySelectorAll('.ldp-reaction-hover-bar').forEach((bar) => {
      if (bar._ownerBtn) bar._ownerBtn._ldpReactionBar = null;
      bar.remove();
      closed = true;
    });
    return closed;
  }

  function closeEmojiPanels() {
    let closed = closeReactionHoverBar();
    document.querySelectorAll('.ldp-emoji-panel').forEach((panel) => {
      if (panel._ownerBtn) panel._ownerBtn._ldpEmojiPanel = null;
      panel.remove();
      closed = true;
    });
    return closed;
  }

  function toggleEmojiPanel(triggerBtn, inputEl) {
    const existing = triggerBtn._ldpEmojiPanel;
    if (existing && existing.parentNode) {
      existing.remove();
      triggerBtn._ldpEmojiPanel = null;
      return;
    }
    closeEmojiPanels();
    const panel = buildEmojiPanel((code) => {
      if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') {
        const start = inputEl.selectionStart || 0;
        const end = inputEl.selectionEnd || 0;
        const val = inputEl.value;
        const before = val.substring(0, start);
        const prev = before.slice(-1);
        const insertion = prev && !/[\s\u200b\p{P}]/u.test(prev) ? ' ' + code : code;
        inputEl.value = before + insertion + val.substring(end);
        inputEl.selectionStart = inputEl.selectionEnd = start + insertion.length;
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.focus();
      }
      panel.remove();
      triggerBtn._ldpEmojiPanel = null;
    });
    mountFloatingEmojiPanel(triggerBtn, panel, { autoFocus: true });
  }

  function mountFloatingEmojiPanel(triggerBtn, panel, options) {
    const opts = options || {};
    panel._ownerBtn = triggerBtn;
    panel.style.position = 'fixed';
    document.body.appendChild(panel);
    triggerBtn._ldpEmojiPanel = panel;
    const panelW = 320, panelH = panel.offsetHeight || 380, gap = 6;
    const btnRect = triggerBtn.getBoundingClientRect();
    const modal = triggerBtn.closest('.ldp-modal');
    const bounds = modal ? modal.getBoundingClientRect()
      : { top: 8, left: 8, bottom: window.innerHeight - 8, right: window.innerWidth - 8 };
    let top = (btnRect.top - panelH - gap >= bounds.top) ? (btnRect.top - panelH - gap) : (btnRect.bottom + gap);
    if (top + panelH > bounds.bottom) top = bounds.bottom - panelH;
    if (top < bounds.top) top = bounds.top;
    let left = btnRect.left;
    if (left + panelW > bounds.right) left = btnRect.right - panelW;
    if (left < bounds.left) left = bounds.left;
    if (left + panelW > bounds.right) left = bounds.right - panelW;
    panel.style.top = top + 'px';
    panel.style.left = left + 'px';
    setTimeout(() => {
      const closer = (e) => {
        if (panel.contains(e.target) || triggerBtn.contains(e.target)) return;
        panel.remove();
        triggerBtn._ldpEmojiPanel = null;
        document.removeEventListener('mousedown', closer, true);
      };
      document.addEventListener('mousedown', closer, true);
    }, 0);
    if (opts.autoFocus !== false) {
      const si = panel.querySelector('.ldp-emoji-search input');
      if (si) setTimeout(() => si.focus(), 50);
    }
  }

  function renderBoosts(boosts) {
    if (!boosts || !boosts.length) return '';
    return boosts.map((b) => {
      const bAvatar = b.user && resolveAvatar(b.user.avatar_template, 36);
      const bUsername = (b.user && b.user.username) || '';
      const bName = (b.user && (b.user.name || b.user.display_name)) || bUsername;
      const bProfileUrl = bUsername ? userProfileUrl(bUsername) : '';
      const canDel = !!b.can_delete;
      const avatarHtml = bAvatar ? (bProfileUrl
        ? `<a class="ldp-boost-avatar-link" href="${escAttr(bProfileUrl)}" target="_blank" rel="noopener noreferrer" title="${escAttr(bName || '@' + bUsername)}" data-username="${escAttr(bUsername)}"><img class="ldp-b-avatar" src="${escAttr(bAvatar)}" alt="" data-username="${escAttr(bUsername)}"></a>`
        : `<img class="ldp-b-avatar" src="${escAttr(bAvatar)}" alt="">`) : '';
      return `<div class="ldp-boost-bubble" data-boost-id="${b.id}">` +
          avatarHtml +
          `<p>${b.cooked || ''}</p>` +
          (canDel ? `<button class="ldp-boost-del" title="删除此Boost">×</button>` : '') +
          `</div>`;
    }).join('');
  }

  /* ============ 3. 单图灯箱 ============ */
  function openLightbox(src) {
    if (!src) return;
    const returnFocus = document.activeElement;
    const lb = document.createElement('div');
    lb.className = 'ldp-lightbox';
    lb.setAttribute('role', 'dialog');
    lb.setAttribute('aria-modal', 'true');
    lb.setAttribute('aria-label', '图片预览');
    lb.innerHTML = `
      <button type="button" class="ldp-lb-x" title="关闭（Esc）" aria-label="关闭图片预览">×</button>
      <div class="ldp-lb-stage"><img alt=""></div>`;
    const stage = lb.querySelector('.ldp-lb-stage');
    const img = lb.querySelector('.ldp-lb-stage img');
    const closeBtn = lb.querySelector('.ldp-lb-x');
    img.src = src;
    const close = () => {
      lb.remove();
      document.removeEventListener('keydown', onKey);
      if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') {
        returnFocus.focus({ preventScroll: true });
      }
    };
    function onKey(e) { if (e.key === 'Escape') close(); }
    closeBtn.addEventListener('click', close);
    img.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    stage.addEventListener('click', (e) => { if (e.target === stage) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(lb);
    closeBtn.focus({ preventScroll: true });
  }

  function absoluteUrl(url) {
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith('//')) return `${location.protocol}${url}`;
    return BASE + (url.startsWith('/') ? url : `/${url}`);
  }

  function userProfileUrl(username) {
    return `${BASE}/u/${encodeURIComponent(username || '')}`;
  }

  function openUserProfile(username) {
    if (!username) return;
    window.open(userProfileUrl(username), '_blank', 'noopener');
  }

  function closeUserCard() {
    if (!CURRENT_USER_CARD) return;
    const { el, cleanup } = CURRENT_USER_CARD;
    CURRENT_USER_CARD = null;
    if (typeof cleanup === 'function') cleanup();
    el.remove();
  }

  function positionUserCard(card, anchor) {
    if (!card || !anchor) return;
    if (!anchor.isConnected) {
      closeUserCard();
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const gap = 8;
    const margin = 12;
    const width = card.offsetWidth || 390;
    const height = card.offsetHeight || 280;
    let left = rect.left;
    let top = rect.bottom + gap;
    if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin;
    if (top + height > window.innerHeight - margin) top = rect.top - height - gap;
    card.style.left = `${Math.max(margin, left)}px`;
    card.style.top = `${Math.max(margin, top)}px`;
  }

  function formatCount(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return '';
    if (num >= 10000) return `${(num / 1000).toFixed(num >= 100000 ? 0 : 1)}k`;
    return String(num);
  }

  function userCardStat(label, value) {
    const text = formatCount(value);
    return text ? `<div class="ldp-user-card-stat"><strong>${esc(text)}</strong><span>${esc(label)}</span></div>` : '';
  }

  const TRUST_LEVEL_LABELS = {
    0: '新用户',
    1: '基本用户',
    2: '成员',
    3: '活跃用户',
    4: '领导者',
  };

  function userTrustLevelText(user) {
    const rawLevel = user && user.trust_level;
    const numericLevel = rawLevel === null || rawLevel === undefined || rawLevel === ''
      ? null : Number(rawLevel);
    const level = Number.isInteger(numericLevel) && numericLevel >= 0 ? numericLevel : null;
    const suppliedLabel = String(
      (user && (user.trust_level_name || user.trust_level_label || user.trust_level_title)) || ''
    ).trim();
    const label = suppliedLabel || (level !== null ? TRUST_LEVEL_LABELS[level] : '') || '';
    return [level !== null ? `Lv${level}` : '', label].filter(Boolean).join(' · ');
  }

  function fmtReadDuration(seconds) {
    const total = Math.floor(Number(seconds) || 0);
    if (total <= 0) return '';
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const mins = Math.max(1, Math.round((total % 3600) / 60));
    if (days >= 1) return `${days} 天` + (hours ? ` ${hours} 小时` : '');
    if (hours >= 1) return `${hours} 小时`;
    return `${mins} 分钟`;
  }

  function renderUserCardV2(user, summaryData, badgeData, username, loading) {
    const summary = (summaryData && (summaryData.user_summary || summaryData.summary)) || summaryData || {};
    const badges = (badgeData && badgeData.user_badges) || [];
    const profileUsername = user.username || username;
    const avatar = user._instantAvatar || resolveAvatar(user.avatar_template, 160);
    const cover = absoluteUrl(user.card_background_upload_url || user.profile_background_upload_url || '');
    const name = user.name || profileUsername;
    const bio = stripHtml(user.bio_excerpt || user.bio_cooked || user.bio_raw || '');
    const trust = userTrustLevelText(user);
    const website = user.website || user.website_name || '';
    const websiteUrl = website && (/^https?:\/\//i.test(website) ? website : `https://${website}`);
    const canFollow = ME_STATE === 'authenticated' && profileUsername !== ME_USERNAME && user.can_follow !== false;
    const badgeMap = new Map(((badgeData && badgeData.badges) || []).map((b) => [Number(b.id), b]));
    const badgeHtml = badges.slice(0, 6).map((entry) => {
      const badge = entry.badge || badgeMap.get(Number(entry.badge_id)) || entry;
      const imgUrl = absoluteUrl(badge.image_url || '');
      return `<span class="ldp-user-badge" title="${escAttr(badge.description || '')}">${imgUrl ? `<img src="${escAttr(imgUrl)}" alt="" loading="lazy">` : ''}<span>${esc(badge.name || '徽章')}</span></span>`;
    }).join('');
    const readTimeText = fmtReadDuration(summary.time_read);
    const statsHtml = [
      userCardStat('帖子', summary.post_count ?? user.post_count),
      userCardStat('主题', summary.topic_count ?? user.topic_count),
      userCardStat('获赞', summary.likes_received ?? user.likes_received),
    ].filter(Boolean).join('');
    return `<div class="ldp-user-card-layout${cover ? '' : ' ldp-user-card-no-cover'}">
      <div class="ldp-user-card-body">
        <div class="ldp-user-card-main">
          <button type="button" class="ldp-user-card-avatar" data-profile-username="${escAttr(profileUsername)}" title="打开用户主页">
            ${avatar ? `<img src="${escAttr(avatar)}" alt="">` : ''}
          </button>
          <div class="ldp-user-card-name">
            <strong>${esc(name)}</strong><span>@${esc(profileUsername)}</span>
            ${trust ? `<span class="ldp-user-level">${esc(trust)}</span>` : ''}
          </div>
        </div>
        ${bio ? `<div class="ldp-user-card-bio">${esc(bio.slice(0, 180))}${bio.length > 180 ? '…' : ''}</div>` : ''}
        <div class="ldp-user-card-meta">
          ${user.title ? `<div>头衔：${esc(user.title)}</div>` : ''}
          ${user.location ? `<div>位置：${esc(user.location)}</div>` : ''}
          ${website ? `<div>网站：<a href="${escAttr(websiteUrl)}" target="_blank" rel="noopener">${esc(website.replace(/^https?:\/\//i, ''))}</a></div>` : ''}
          ${user.last_seen_at ? `<div>活跃：${esc(fmtTime(user.last_seen_at))}${readTimeText ? ` · 阅读 ${esc(readTimeText)}` : ''}</div>` : (readTimeText ? `<div>阅读：${esc(readTimeText)}</div>` : '')}
          ${user.created_at ? `<div>加入：${esc(fmtTime(user.created_at))}</div>` : ''}
          ${loading ? '<div class="ldp-user-card-phase">正在补充资料与统计…</div>' : ''}
        </div>
        ${statsHtml ? `<div class="ldp-user-card-stats">${statsHtml}</div>` : ''}
        ${badgeHtml ? `<div class="ldp-user-badges">${badgeHtml}</div>` : ''}
        <div class="ldp-user-card-actions">
          <a href="${escAttr(userProfileUrl(profileUsername))}" target="_blank" rel="noopener">主页</a>
          ${ME_STATE === 'authenticated' && profileUsername !== ME_USERNAME ? `<a href="${BASE}/new-message?username=${encodeURIComponent(profileUsername)}" target="_blank" rel="noopener">私信</a>` : ''}
          ${canFollow ? `<button type="button" data-user-action="follow">${user.is_followed ? '取消关注' : '关注'}</button>` : ''}
          ${ME_STATE === 'authenticated' && ME_USER && ME_USER.id && profileUsername !== ME_USERNAME ? `<select class="ldp-user-notify" data-user-action="notify" aria-label="通知设置">
            <option value="normal"${!user.muted && !user.ignored ? ' selected' : ''}>常规</option>
            <option value="mute"${user.muted ? ' selected' : ''}>免打扰</option>
            <option value="ignore"${user.ignored ? ' selected' : ''}>忽略 30 天</option>
          </select>` : ''}
          <a href="${BASE}/u/${encodeURIComponent(profileUsername)}/badges" target="_blank" rel="noopener">徽章</a>
        </div>
      </div>
      <div class="ldp-user-card-cover"${cover ? ` style="background-image:url('${escAttr(cover)}')"` : ''}></div>
    </div>`;
  }

  async function openUserCardV2(username, anchor) {
    if (!username || !anchor) return;
    closeUserCard();
    const cacheKey = String(username).toLowerCase();
    const cached = USER_CARD_CACHE.get(cacheKey);
    const cacheFresh = !!(cached && cached.complete && cached.updatedAt
      && Date.now() - cached.updatedAt < USER_CARD_CACHE_TTL);
    const controller = new AbortController();
    const card = document.createElement('div');
    card.className = 'ldp-user-card ldp-user-card-v2';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', `${username} 的个人详情`);
    const instantAvatar = (anchor.querySelector('img') || {}).src || '';
    let user = Object.assign({ username, _instantAvatar: instantAvatar }, cached && cached.user);
    let summary = (cached && cached.summary) || null;
    let badges = (cached && cached.badges) || null;
    let renderRaf = 0;
    let positionRaf = 0;
    let pendingRequests = cacheFresh ? 0 : 3;
    let profileLoaded = !!(cached && cached.user);
    let summaryLoaded = !!(cached && cached.summary);
    let badgesLoaded = !!(cached && cached.badges);
    card.innerHTML = renderUserCardV2(user, summary, badges, username, pendingRequests > 0);
    card.classList.toggle('has-cover', !!(user.card_background_upload_url || user.profile_background_upload_url));
    document.body.appendChild(card);
    positionUserCard(card, anchor);

    const closeOnOutside = (event) => {
      if (!card.contains(event.target) && !anchor.contains(event.target)) closeUserCard();
    };
    const closeOnEsc = (event) => { if (event.key === 'Escape') closeUserCard(); };
    const reposition = () => {
      if (positionRaf) return;
      positionRaf = requestAnimationFrame(() => {
        positionRaf = 0;
        if (CURRENT_USER_CARD && CURRENT_USER_CARD.el === card) positionUserCard(card, anchor);
      });
    };
    let outsideTimer = 0;
    const cleanup = () => {
      controller.abort();
      if (outsideTimer) clearTimeout(outsideTimer);
      outsideTimer = 0;
      cancelAnimationFrame(renderRaf);
      cancelAnimationFrame(positionRaf);
      document.removeEventListener('click', closeOnOutside, true);
      document.removeEventListener('keydown', closeOnEsc);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
    CURRENT_USER_CARD = { el: card, cleanup };
    outsideTimer = setTimeout(() => {
      outsideTimer = 0;
      if (CURRENT_USER_CARD && CURRENT_USER_CARD.el === card) {
        document.addEventListener('click', closeOnOutside, true);
      }
    }, 0);
    document.addEventListener('keydown', closeOnEsc);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);

    const render = () => {
      if (!CURRENT_USER_CARD || CURRENT_USER_CARD.el !== card) return;
      card.classList.toggle('has-cover', !!(user.card_background_upload_url || user.profile_background_upload_url));
      card.innerHTML = renderUserCardV2(user, summary, badges, username, pendingRequests > 0);
      reposition();
    };
    const scheduleRender = () => {
      if (renderRaf || controller.signal.aborted) return;
      renderRaf = requestAnimationFrame(() => {
        renderRaf = 0;
        render();
      });
    };
    const finishRequest = () => {
      pendingRequests = Math.max(0, pendingRequests - 1);
      scheduleRender();
    };

    card.addEventListener('click', async (event) => {
      const avatarButton = event.target.closest('.ldp-user-card-avatar');
      if (avatarButton) {
        openUserProfile(username);
        closeUserCard();
        return;
      }
      const follow = event.target.closest('[data-user-action="follow"]');
      if (!follow) return;
      follow.disabled = true;
      try {
        await apiSend(`${BASE}/follow/${encodeURIComponent(username)}.json`, user.is_followed ? 'DELETE' : 'PUT');
        user.is_followed = !user.is_followed;
        const entry = USER_CARD_CACHE.get(cacheKey) || {};
        USER_CARD_CACHE.set(cacheKey, Object.assign({}, entry, { user: Object.assign({}, user) }));
        render();
      } catch (error) { alert('关注操作失败：' + error.message); }
      finally { if (follow.isConnected) follow.disabled = false; }
    });
    card.addEventListener('change', async (event) => {
      const select = event.target.closest('[data-user-action="notify"]');
      if (!select) return;
      select.disabled = true;
      const level = select.value;
      const params = { notification_level: level, acting_user_id: (ME_USER && ME_USER.id) || '' };
      if (level === 'ignore') params.expiring_at = new Date(Date.now() + 30 * 86400000).toISOString();
      try {
        await apiSend(`${BASE}/u/${encodeURIComponent(username)}/notification_level.json`, 'PUT', params);
        user.muted = level === 'mute'; user.ignored = level === 'ignore';
      } catch (error) { alert('通知设置失败：' + error.message); }
      finally { select.disabled = false; }
    });

    if (cacheFresh) return;
    const encoded = encodeURIComponent(username);
    const requestOptions = (priority) => ({ priority, signal: controller.signal });
    const profilePromise = fetchJSON(`${BASE}/u/${encoded}.json`, requestOptions('target'))
      .then((data) => { user = Object.assign(user, data.user || data); profileLoaded = true; scheduleRender(); })
      .catch((error) => { if (!error || error.name !== 'AbortError') console.warn('[LinuxDo Reader] 用户资料读取失败', error); })
      .finally(finishRequest);
    const summaryPromise = fetchJSON(`${BASE}/u/${encoded}/summary.json`, requestOptions('visible'))
      .then((data) => { summary = data; summaryLoaded = true; scheduleRender(); })
      .catch((error) => { if (!error || error.name !== 'AbortError') console.warn('[LinuxDo Reader] 用户统计读取失败', error); })
      .finally(finishRequest);
    const badgesPromise = fetchJSON(`${BASE}/user-badges/${encoded}.json`, requestOptions('background'))
      .then((data) => { badges = data; badgesLoaded = true; scheduleRender(); })
      .catch((error) => { if (!error || error.name !== 'AbortError') console.warn('[LinuxDo Reader] 用户徽章读取失败', error); })
      .finally(finishRequest);
    await Promise.allSettled([profilePromise, summaryPromise, badgesPromise]);
    if (controller.signal.aborted) return;
    USER_CARD_CACHE.set(cacheKey, {
      user: Object.assign({}, user), summary, badges, updatedAt: Date.now(),
      complete: profileLoaded && summaryLoaded && badgesLoaded,
    });
    render();
  }

  function isElement(node) {
    return node && node.nodeType === Node.ELEMENT_NODE;
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}月 ${d.getDate()}日`;
  }

  function closestElement(node, selector) {
    const el = isElement(node) ? node : node && node.parentElement;
    return el ? el.closest(selector) : null;
  }

  function isImageAnchor(anchor) {
    if (!anchor) return false;
    const href = anchor.getAttribute('href') || anchor.getAttribute('data-download-href') || '';
    return anchor.classList.contains('lightbox') ||
      anchor.hasAttribute('data-download-href') ||
      /\.(png|jpe?g|gif|webp|bmp|avif)(\?|#|$)/i.test(href);
  }

  function resolveOriginalSrc(sourceEl) {
    const anchorSelector = 'a[href], a[data-download-href]';
    const anchor = sourceEl.matches(anchorSelector) ? sourceEl : sourceEl.closest(anchorSelector);
    const imgEl = sourceEl.matches('img') ? sourceEl :
      (anchor && anchor.querySelector('img'));
    if (isImageAnchor(anchor)) {
      const href = anchor.getAttribute('href') || anchor.getAttribute('data-download-href');
      if (href) return href;
    }
    return imgEl && (imgEl.getAttribute('data-large-src') || imgEl.currentSrc || imgEl.src);
  }

  function findImagePreviewSource(target, root) {
    const content = closestElement(target, '.ldp-content');
    if (!content || !root.contains(content)) return null;
    if (closestElement(target, '.ldp-spoiler.ldp-spoiler-blurred')) return null;
    if (closestElement(target, '.video-placeholder-container[data-video-src]')) return null;
    if (closestElement(target, '.ldp-poll')) return null;

    const anchor = closestElement(target, 'a[href], a[data-download-href]');
    if (anchor && content.contains(anchor) && isImageAnchor(anchor)) return anchor;

    const img = closestElement(target, 'img');
    if (img && content.contains(img)) {
      if (img.classList && img.classList.contains('emoji')) return null;
      return img;
    }

    const wrapper = closestElement(target, '.lightbox-wrapper, .image-wrapper, .image-container, .lazyYT-container');
    if (!wrapper || !content.contains(wrapper)) return null;

    const wrapperAnchor = wrapper.querySelector('a.lightbox, a[data-download-href], a[href]');
    if (isImageAnchor(wrapperAnchor)) return wrapperAnchor;

    const wrapperImg = wrapper.querySelector('img');
    if (wrapperImg && wrapperImg.classList && wrapperImg.classList.contains('emoji')) return null;
    return wrapperImg;
  }

  function interceptImagePreviewClick(e, root) {
    const source = findImagePreviewSource(e.target, root);
    if (!source) return false;
    const src = resolveOriginalSrc(source);
    if (!src) return false;

    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    openLightbox(src);
    return true;
  }

  function activateVideoPlaceholder(container) {
    if (!container) return null;
    const existingVideo = container.querySelector('video');
    if (existingVideo) return existingVideo;
    const src = container.dataset.videoSrc;
    if (!src) return null;
    const video = document.createElement('video');
    video.src = src;
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.style.display = 'block';
    video.style.width = '100%';
    video.style.maxHeight = '70vh';
    video.style.background = '#000';
    container.classList.add('video-container', 'ldp-video-ready');
    container.style.cursor = '';
    container.replaceChildren(video);
    const playPromise = video.play();
    if (playPromise && playPromise.catch) playPromise.catch(() => {});
    return video;
  }

  /* ============ 3.5 Base64 解码 ============ */
  function decodeBase64ToUnicode(raw) {
    const normalized = String(raw || '').trim().replace(/\s+/g, '');
    if (!normalized) return null;
    try {
      const binary = atob(normalized);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
      return null;
    }
  }

  function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      Object.assign(textarea.style, {
        position: 'fixed', left: '-9999px', top: '0', opacity: '0',
      });
      document.body.appendChild(textarea);
      textarea.select();
      try {
        if (!document.execCommand('copy')) throw new Error('copy failed');
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        textarea.remove();
      }
    });
  }

  function createDecodedBlock(decodedText) {
    const wrapper = document.createElement('div');
    wrapper.className = 'md-codeblock ldp-base64-result';
    wrapper.setAttribute('data-base64-decoded', 'true');

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = decodedText;
    pre.appendChild(code);

    const toolbar = document.createElement('div');
    toolbar.className = 'codeblock-button-wrapper ldp-base64-toolbar';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn nohighlight btn-flat ldp-base64-copy';
    const copyIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z"/></svg>';
    copyBtn.innerHTML = copyIcon;
    copyBtn.title = '复制解码文本';
    copyBtn.setAttribute('aria-label', '复制解码文本');
    copyBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyBtn.disabled = true;
      try {
        await copyText(decodedText);
        copyBtn.textContent = '已复制';
        copyBtn.classList.add('copied');
        copyBtn.title = '已复制';
        setTimeout(() => {
          if (!copyBtn.isConnected) return;
          copyBtn.innerHTML = copyIcon;
          copyBtn.classList.remove('copied');
          copyBtn.title = '复制解码文本';
          copyBtn.disabled = false;
        }, 2000);
      } catch (err) {
        copyBtn.disabled = false;
        alert('复制失败，请手动复制');
      }
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn nohighlight btn-flat ldp-base64-close';
    closeBtn.textContent = '×';
    closeBtn.title = '关闭';
    closeBtn.setAttribute('aria-label', '关闭解码结果');
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      wrapper.remove();
    });

    toolbar.append(copyBtn, closeBtn);
    wrapper.append(pre, toolbar);
    return wrapper;
  }

  function enhanceCodeBlocks(root) {
    if (!root) return;
    root.querySelectorAll('.ldp-content pre').forEach((pre) => {
      if (pre.closest('.ldp-base64-result')) return;
      if (pre.parentElement && pre.parentElement.querySelector(':scope > .codeblock-button-wrapper')) return;

      const code = pre.querySelector('code');
      const codeText = (code || pre).textContent || '';
      let host = pre.parentElement;
      if (!host || (!host.classList.contains('md-codeblock') && !host.classList.contains('highlight'))) {
        host = document.createElement('div');
        pre.insertAdjacentElement('beforebegin', host);
        host.appendChild(pre);
      }
      host.classList.add('ldp-codeblock-host');

      const toolbar = document.createElement('div');
      toolbar.className = 'codeblock-button-wrapper ldp-codeblock-toolbar';
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'btn nohighlight btn-flat ldp-code-copy';
      copyBtn.title = '复制代码';
      copyBtn.setAttribute('aria-label', '复制代码');
      const copyIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z"/></svg>';
      const copiedIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 16.2-3.5-3.5-1.4 1.4L9 19 20.3 7.7l-1.4-1.4L9 16.2Z"/></svg>';
      copyBtn.innerHTML = copyIcon;
      copyBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        copyBtn.disabled = true;
        try {
          await copyText(codeText);
          copyBtn.innerHTML = copiedIcon;
          copyBtn.title = '已复制';
          setTimeout(() => {
            if (!copyBtn.isConnected) return;
            copyBtn.innerHTML = copyIcon;
            copyBtn.title = '复制代码';
            copyBtn.disabled = false;
          }, 2000);
        } catch (err) {
          copyBtn.disabled = false;
          alert('复制失败，请手动复制');
        }
      });

      toolbar.appendChild(copyBtn);
      host.appendChild(toolbar);
    });
  }

  function insertDecodedBlock(decodedText, range) {
    if (!range || !range.commonAncestorContainer || !range.commonAncestorContainer.isConnected) return null;
    const wrapper = createDecodedBlock(decodedText);
    const endEl = isElement(range.endContainer) ? range.endContainer : range.endContainer.parentElement;
    const contentRoot = endEl && endEl.closest('.ldp-content, .topic-post .cooked, article .cooked');
    const block = endEl && endEl.closest('p, pre, blockquote');

    if (contentRoot && block && contentRoot.contains(block)) {
      block.insertAdjacentElement('afterend', wrapper);
    } else if (contentRoot) {
      let anchor = endEl;
      while (anchor && anchor.parentElement && anchor.parentElement !== contentRoot) {
        anchor = anchor.parentElement;
      }
      if (anchor && anchor.parentElement === contentRoot) {
        if (anchor.tagName === 'LI') anchor.appendChild(wrapper);
        else anchor.insertAdjacentElement('afterend', wrapper);
      } else {
        contentRoot.appendChild(wrapper);
      }
    } else {
      const insertionRange = range.cloneRange();
      insertionRange.collapse(false);
      insertionRange.insertNode(wrapper);
    }

    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
    wrapper.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return wrapper;
  }

  function getSelectionSnapshot(requiredRoot) {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || selection.isCollapsed) return null;
    const raw = selection.toString().trim();
    if (!raw) return null;
    const range = selection.getRangeAt(0);
    if (requiredRoot) {
      const startEl = isElement(range.startContainer) ? range.startContainer : range.startContainer.parentElement;
      const endEl = isElement(range.endContainer) ? range.endContainer : range.endContainer.parentElement;
      const startContent = startEl && startEl.closest('.ldp-content');
      const endContent = endEl && endEl.closest('.ldp-content');
      if (!startContent || startContent !== endContent || !requiredRoot.contains(startContent)) return null;
    }
    return { raw, range: range.cloneRange() };
  }

  function decodeSelectionSnapshot(snapshot) {
    if (!snapshot) {
      alert('请先选中一段 Base64 文本');
      return false;
    }
    const decoded = decodeBase64ToUnicode(snapshot.raw);
    if (decoded === null) {
      alert('解码失败，请确认内容是有效的 Base64 编码');
      return false;
    }
    return !!insertDecodedBlock(decoded, snapshot.range);
  }

  function addBase64DecodeButton(menu) {
    if (!menu) return;
    const existingButton = Array.from(menu.querySelectorAll('button')).find((button) =>
      button.classList.contains('ldp-base64-decode-btn') ||
      button.title === 'Base64 解码' ||
      (button.querySelector('.d-button-label') || {}).textContent === 'Base64解码'
    );
    if (existingButton) {
      menu.dataset.base64DecodeAdded = 'true';
      return;
    }
    const buttons = menu.querySelector('.quote-button .buttons') || menu.querySelector('.buttons');
    if (!buttons) return;

    menu.dataset.base64DecodeAdded = 'true';
    const decodeBtn = document.createElement('button');
    decodeBtn.type = 'button';
    decodeBtn.className = 'btn btn-icon-text btn-flat ldp-base64-decode-btn';
    decodeBtn.title = 'Base64 解码';
    decodeBtn.innerHTML = '<span class="fa d-icon" aria-hidden="true">🔓</span><span class="d-button-label">Base64解码</span>';

    let snapshot = null;
    decodeBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      snapshot = getSelectionSnapshot();
    });
    decodeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      decodeSelectionSnapshot(snapshot || getSelectionSnapshot());
      snapshot = null;
    });
    buttons.appendChild(decodeBtn);
  }

  function startBase64MenuObserver() {
    const portal = document.getElementById('d-menu-portals');
    if (!portal) {
      setTimeout(startBase64MenuObserver, 500);
      return;
    }

    portal.querySelectorAll('div.fk-d-menu').forEach(addBase64DecodeButton);
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (!isElement(node)) return;
          const parentMenu = node.matches('div.fk-d-menu') ? node : node.closest('div.fk-d-menu');
          if (parentMenu) addBase64DecodeButton(parentMenu);
          node.querySelectorAll('div.fk-d-menu').forEach(addBase64DecodeButton);
        });
      });
    });
    observer.observe(portal, { childList: true, subtree: true });
  }

  function bindModalBase64Selection(modal) {
    const menu = document.createElement('div');
    menu.className = 'ldp-base64-selection-menu';
    menu.hidden = true;
    menu.innerHTML = '<button type="button" title="Base64 解码"><span aria-hidden="true">🔓</span><span>Base64解码</span></button>';
    document.body.appendChild(menu);

    const button = menu.querySelector('button');
    const scrollRoot = modal.querySelector('.ldp-body');
    let snapshot = null;
    let frame = 0;

    const hide = () => {
      menu.hidden = true;
      snapshot = null;
    };
    const show = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const current = getSelectionSnapshot(modal);
        if (!current) {
          hide();
          return;
        }
        snapshot = current;
        const rect = current.range.getBoundingClientRect();
        if (!rect || (!rect.width && !rect.height)) {
          hide();
          return;
        }
        menu.hidden = false;
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        const left = Math.max(8, Math.min(window.innerWidth - width - 8,
          rect.left + (rect.width / 2) - (width / 2)));
        let top = rect.top - height - 8;
        if (top < 8) top = Math.min(window.innerHeight - height - 8, rect.bottom + 8);
        menu.style.left = `${left}px`;
        menu.style.top = `${Math.max(8, top)}px`;
      });
    };
    const onPointerDown = (e) => {
      if (menu.contains(e.target)) return;
      hide();
    };
    const onKeyDown = (e) => {
      if (e.key !== 'Escape' || menu.hidden) return;
      e.preventDefault();
      e.stopPropagation();
      hide();
    };
    const onKeyUp = (e) => {
      if (e.shiftKey || e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') show();
    };

    button.addEventListener('pointerdown', (e) => e.preventDefault());
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const current = snapshot;
      hide();
      decodeSelectionSnapshot(current);
    });
    modal.addEventListener('mouseup', show);
    modal.addEventListener('keyup', onKeyUp);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', hide);
    if (scrollRoot) scrollRoot.addEventListener('scroll', hide, { passive: true });

    return () => {
      cancelAnimationFrame(frame);
      menu.remove();
      modal.removeEventListener('mouseup', show);
      modal.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', hide);
      if (scrollRoot) scrollRoot.removeEventListener('scroll', hide);
    };
  }

  /* ============ 4. 已读追踪器 ============ */
  function createReadTracker(topicId, scrollRoot) {
    const dwell = new Map();
    const reported = new Map();
    const visible = new Set();
    let readWaterline = 1;
    let lastTick = Date.now();
    let tickTimer = null, flushTimer = null;

    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        const pn = +en.target.dataset.postNumber;
        if (!pn) return;
        if (en.isIntersecting && en.intersectionRatio >= 0.5) visible.add(pn);
        else visible.delete(pn);
      });
    }, { root: scrollRoot, threshold: [0, 0.5, 1] });

    const tick = () => {
      const now = Date.now();
      const delta = now - lastTick;
      lastTick = now;
      if (document.visibilityState === 'visible') {
        visible.forEach((pn) => dwell.set(pn, (dwell.get(pn) || 0) + delta));
      }
    };

    const markReadThrough = (pn) => {
      readWaterline = Math.max(readWaterline, Number(pn) || 1);
      scrollRoot.querySelectorAll('.ldp-post[data-post-number]').forEach((node) => {
        const nodePn = +node.dataset.postNumber;
        if (!nodePn || nodePn > readWaterline) return;
        node.classList.add('ldp-read');
        node.classList.remove('ldp-unread');
      });
    };

    const flush = async () => {
      const params = { topic_id: topicId };
      let total = 0, any = false;
      dwell.forEach((ms, pn) => {
        if (ms < READ_THRESHOLD) return;
        const inc = ms - (reported.get(pn) || 0);
        if (inc <= 0) return;
        params[`timings[${pn}]`] = inc;
        total += inc;
        reported.set(pn, ms);
        any = true;
      });
      if (!any) return;
      params.topic_time = total;
      try {
        await apiSend(`${BASE}/topics/timings`, 'POST', params, { 'X-SILENCE-LOGGER': 'true' });
        let maxReadPostNumber = 0;
        Object.keys(params).forEach((k) => {
          const m = k.match(/^timings\[(\d+)\]$/);
          if (m) maxReadPostNumber = Math.max(maxReadPostNumber, +m[1]);
        });
        if (maxReadPostNumber) markReadThrough(maxReadPostNumber);
      } catch (e) {
        Object.keys(params).forEach((k) => {
          const m = k.match(/^timings\[(\d+)\]$/);
          if (m) reported.set(+m[1], (reported.get(+m[1]) || 0) - params[k]);
        });
      }
    };

    return {
      getReadWaterline() { return readWaterline; },
      setReadWaterline(pn) { readWaterline = Math.max(1, Number(pn) || 0); },
      observe(node) { if (node) io.observe(node); },
      unobserve(node) { if (node) { io.unobserve(node); visible.delete(+node.dataset.postNumber); } },
      start() {
        lastTick = Date.now();
        tickTimer = setInterval(tick, 1000);
        flushTimer = setInterval(flush, FLUSH_INTERVAL);
      },
      stop() {
        clearInterval(tickTimer);
        clearInterval(flushTimer);
        io.disconnect();
        tick();
        flush();
      },
    };
  }

  /* ============ 6.8 投票与数学公式渲染 ============ */
  function isRenderablePoll(poll) {
    if (!poll || (poll.type !== 'regular' && poll.type !== 'multiple')) return false;
    if (!Array.isArray(poll.options) || !poll.options.length) return false;
    return poll.options.every((option) =>
      option && option.id != null && String(option.id) !== '' && typeof option.html === 'string');
  }

  function pollResultsVisible(poll) {
    return Array.isArray(poll.options) && poll.options.length > 0
      && poll.options.every((option) =>
        option && typeof option.votes === 'number' && Number.isFinite(option.votes));
  }

  function isPollClosed(poll) {
    if (poll.status === 'closed') return true;
    const close = typeof poll.close === 'string' ? Date.parse(poll.close) : NaN;
    return Number.isFinite(close) && close <= Date.now();
  }

  function canVotePoll(poll) {
    return !isPollClosed(poll) && poll.can_vote !== false && poll.canVote !== false;
  }

  function pollBounds(poll) {
    const optionCount = poll.options.length;
    const minValue = Number(poll.min);
    const maxValue = Number(poll.max);
    const min = Number.isFinite(minValue) && minValue > 0 ? Math.floor(minValue) : 1;
    const max = Number.isFinite(maxValue) && maxValue > 0 ? Math.min(Math.floor(maxValue), optionCount) : optionCount;
    return { min, max };
  }

  function currentPollVotes(post, pollName) {
    const votes = post && post.polls_votes && post.polls_votes[pollName];
    return Array.isArray(votes) ? votes.map((optionId) => String(optionId)) : [];
  }

  function renderPoll(poll, post, titleHtml) {
    const node = document.createElement('div');
    const selectedVotes = currentPollVotes(post, poll.name);
    const closed = isPollClosed(poll);
    const canVote = canVotePoll(poll);
    const resultsVisible = pollResultsVisible(poll);
    const { min, max } = pollBounds(poll);

    node.className = 'ldp-poll';
    node.dataset.pollName = String(poll.name);
    node.dataset.type = poll.type;
    node.dataset.votable = canVote ? '1' : '0';
    node.dataset.closed = closed ? '1' : '0';

    const title = document.createElement('div');
    title.className = 'ldp-poll-title';
    if (titleHtml) title.innerHTML = titleHtml;
    else if (typeof poll.title === 'string' && poll.title) title.textContent = poll.title;
    if (titleHtml || (typeof poll.title === 'string' && poll.title)) node.appendChild(title);

    const meta = document.createElement('div');
    const metaItems = [];
    if (poll.type === 'multiple') metaItems.push(`多选（可选 ${min}-${max} 项）`);
    if (closed) metaItems.push('已关闭');
    if (resultsVisible && Number.isFinite(Number(poll.voters))) {
      metaItems.push(`${Number(poll.voters)} 人投票`);
    } else if (selectedVotes.length) {
      metaItems.push('已选择');
    }
    meta.className = 'ldp-poll-meta';
    meta.textContent = metaItems.join(' · ');
    node.appendChild(meta);

    const optionList = document.createElement('div');
    optionList.className = 'ldp-poll-options';
    poll.options.forEach((option) => {
      const optionId = String(option.id);
      const selected = selectedVotes.includes(optionId);
      const voters = Number(poll.voters);
      const percent = resultsVisible && Number.isFinite(voters) && voters > 0
        ? Math.round((option.votes / voters) * 100) : 0;

      const optionButton = document.createElement('button');
      optionButton.type = 'button';
      optionButton.className = 'ldp-poll-option' + (selected ? ' selected' : '');
      optionButton.dataset.optionId = optionId;
      optionButton.setAttribute('aria-pressed', String(selected));
      optionButton.disabled = !canVote;

      const content = document.createElement('span');
      content.className = 'ldp-poll-option-content';
      const optionHtml = document.createElement('span');
      optionHtml.className = 'ldp-poll-option-html';
      optionHtml.innerHTML = option.html;
      content.appendChild(optionHtml);
      if (resultsVisible) {
        const optionMeta = document.createElement('span');
        optionMeta.className = 'ldp-poll-option-meta';
        optionMeta.textContent = `${option.votes} 票 · ${percent}%`;
        content.appendChild(optionMeta);
      }
      optionButton.appendChild(content);
      if (resultsVisible) {
        const bar = document.createElement('span');
        bar.className = 'ldp-poll-bar';
        bar.style.width = `${percent}%`;
        optionButton.appendChild(bar);
      }
      optionList.appendChild(optionButton);
    });
    node.appendChild(optionList);

    const actions = document.createElement('div');
    actions.className = 'ldp-poll-actions';
    if (poll.type === 'multiple') {
      const submit = document.createElement('button');
      submit.type = 'button';
      submit.className = 'ldp-poll-submit';
      submit.textContent = selectedVotes.length ? '更新投票' : '投票';
      submit.disabled = !canVote || selectedVotes.length < min || selectedVotes.length > max;
      actions.appendChild(submit);

      const selectedCount = document.createElement('span');
      selectedCount.className = 'ldp-poll-selected-count';
      selectedCount.textContent = `已选 ${selectedVotes.length}/${max} 项`;
      actions.appendChild(selectedCount);
    }
    if (selectedVotes.length && canVote) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ldp-poll-remove';
      remove.textContent = '撤销投票';
      remove.disabled = !canVote;
      actions.appendChild(remove);
    }
    node.appendChild(actions);

    const status = document.createElement('div');
    status.className = 'ldp-poll-status';
    node.appendChild(status);
    return node;
  }

  function renderPolls(content, post) {
    if (!content || !post || !Array.isArray(post.polls)) return;
    content.querySelectorAll('.poll').forEach((placeholder) => {
      const pollName = placeholder.dataset.pollName || 'poll';
      const poll = post.polls.find((item) => item && item.name === pollName);
      if (!isRenderablePoll(poll)) return;
      const titleNode = placeholder.querySelector('.poll-title');
      placeholder.replaceWith(renderPoll(poll, post, titleNode ? titleNode.innerHTML : ''));
    });
  }

  function updateMultiplePollState(pollNode, poll) {
    const selectedCount = pollNode.querySelectorAll('.ldp-poll-option[aria-pressed="true"]').length;
    const { min, max } = pollBounds(poll);
    const submit = pollNode.querySelector('.ldp-poll-submit');
    if (submit) {
      submit.disabled = pollNode.dataset.votable !== '1' || selectedCount < min || selectedCount > max;
    }
    const count = pollNode.querySelector('.ldp-poll-selected-count');
    if (count) count.textContent = `已选 ${selectedCount}/${max} 项`;
  }

  function setPollLoading(pollNode, text) {
    pollNode.dataset.loading = 'true';
    pollNode.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    const status = pollNode.querySelector('.ldp-poll-status');
    if (status) {
      status.classList.remove('ldp-poll-error');
      status.textContent = text;
    }
  }

  function finishPollLoading(pollNode, poll, errorMessage) {
    delete pollNode.dataset.loading;
    const canVote = pollNode.dataset.votable === '1';
    pollNode.querySelectorAll('.ldp-poll-option, .ldp-poll-remove')
      .forEach((button) => { button.disabled = !canVote; });
    if (poll && poll.type === 'multiple') updateMultiplePollState(pollNode, poll);
    const status = pollNode.querySelector('.ldp-poll-status');
    if (status) {
      status.classList.toggle('ldp-poll-error', !!errorMessage);
      status.textContent = errorMessage ? `投票失败：${errorMessage}` : '';
    }
  }

  function showPollStatus(pollNode, text, isError) {
    const status = pollNode.querySelector('.ldp-poll-status');
    if (!status) return;
    status.classList.toggle('ldp-poll-error', !!isError);
    status.textContent = text;
  }

  function findPostForNode(postNode, ctx) {
    if (!postNode || !ctx) return null;
    const postId = postNode.dataset.postId;
    if (ctx.loader && postId) {
      const cached = ctx.loader.getPostById(postId);
      if (cached) return cached;
    }
    if (Number(postNode.dataset.postNumber) === 1 && ctx.topic && ctx.topic._opPost) {
      return ctx.topic._opPost;
    }
    return null;
  }

  function findPollForNode(post, pollNode) {
    const pollName = pollNode.dataset.pollName;
    return (post.polls || []).find((poll) => poll && poll.name === pollName) || null;
  }

  function responseVoteOptions(vote) {
    const options = Array.isArray(vote) ? vote : vote && vote.options;
    return Array.isArray(options) ? options.map((optionId) => String(optionId)) : null;
  }

  function updatePostPoll(post, poll, response, removeVote) {
    const polls = Array.isArray(post.polls) ? post.polls.slice() : [];
    const index = polls.findIndex((item) => item && item.name === poll.name);
    const nextPoll = Object.assign({}, poll, response.poll);
    if (index >= 0) polls[index] = nextPoll;
    else polls.push(nextPoll);
    post.polls = polls;

    const votes = Object.assign({}, post.polls_votes || {});
    if (removeVote) delete votes[poll.name];
    else votes[poll.name] = responseVoteOptions(response.vote) || [];
    post.polls_votes = votes;
    return nextPoll;
  }

  async function requestPollVote(pollNode, post, poll, optionIds, removeVote, ctx, modal) {
    setPollLoading(pollNode, removeVote ? '取消投票中…' : '投票中…');
    try {
      const params = removeVote
        ? { post_id: post.id, poll_name: poll.name }
        : { post_id: post.id, poll_name: poll.name, options: optionIds };
      const data = await apiSend(`${BASE}/polls/vote`, removeVote ? 'DELETE' : 'PUT', params);
      if (!data || !data.poll) throw new Error('响应缺少投票数据');
      if (!removeVote && !responseVoteOptions(data.vote)) {
        throw new Error('响应缺少投票选择');
      }

      const titleNode = pollNode.querySelector('.ldp-poll-title');
      const titleHtml = titleNode ? titleNode.innerHTML : '';
      const nextPoll = updatePostPoll(post, poll, data, removeVote);
      if (ctx && ctx.loader) {
        ctx.loader.updatePost(post.id, {
          polls: post.polls.map((item) => Object.assign({}, item)),
          polls_votes: Object.assign({}, post.polls_votes),
        });
      }
      if (ctx && ctx.topicId) invalidateTopicSnapshot(ctx.topicId).catch(() => {});
      const root = modal || pollNode.getRootNode();
      const selector = `[data-post-id="${CSS.escape(String(post.id))}"] .ldp-poll[data-poll-name="${CSS.escape(String(poll.name))}"]`;
      const targets = root && root.querySelectorAll ? Array.from(root.querySelectorAll(selector)) : [pollNode];
      if (!targets.includes(pollNode)) targets.push(pollNode);
      targets.forEach((targetPoll) => {
        const ownerPost = targetPoll.closest('.ldp-post');
        targetPoll.replaceWith(renderPoll(nextPoll, post, titleHtml));
        if (ownerPost && ctx && ctx.refreshRenderRevision) ctx.refreshRenderRevision(ownerPost);
      });
    } catch (err) {
      finishPollLoading(pollNode, poll, err.message);
    }
  }

  async function handlePollControl(control, ctx, modal) {
    const pollNode = control.closest('.ldp-poll');
    const postNode = control.closest('.ldp-embedded-reply, .ldp-post');
    if (!pollNode || !postNode) return;
    const post = findPostForNode(postNode, ctx);
    if (!post) {
      showPollStatus(pollNode, '投票失败：未找到帖子数据', true);
      return;
    }
    const poll = findPollForNode(post, pollNode);
    if (!poll) {
      showPollStatus(pollNode, '投票失败：未找到投票数据', true);
      return;
    }
    if (control.classList.contains('ldp-poll-option')) {
      if (poll.type === 'multiple') {
        const selected = control.getAttribute('aria-pressed') === 'true';
        const selectedCount = pollNode.querySelectorAll('.ldp-poll-option[aria-pressed="true"]').length;
        const { max } = pollBounds(poll);
        if (!selected && selectedCount >= max) {
          showPollStatus(pollNode, `最多可选 ${max} 项`, false);
          return;
        }
        control.classList.toggle('selected', !selected);
        control.setAttribute('aria-pressed', String(!selected));
        showPollStatus(pollNode, '', false);
        updateMultiplePollState(pollNode, poll);
        return;
      }
      const optionId = control.dataset.optionId;
      const currentVotes = currentPollVotes(post, poll.name);
      const cancelling = currentVotes.includes(optionId);
      await requestPollVote(pollNode, post, poll, cancelling ? null : [optionId], cancelling, ctx, modal);
      return;
    }
    if (control.classList.contains('ldp-poll-submit')) {
      const optionIds = Array.from(
        pollNode.querySelectorAll('.ldp-poll-option[aria-pressed="true"]')
      ).map((option) => option.dataset.optionId);
      await requestPollVote(pollNode, post, poll, optionIds, false, ctx, modal);
      return;
    }
    if (control.classList.contains('ldp-poll-remove')) {
      await requestPollVote(pollNode, post, poll, null, true, ctx, modal);
    }
  }

  const KATEX_CDN_CSS = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';
  const KATEX_CDN_JS = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js';
  const KATEX_CDN_MHCHEM = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/mhchem.min.js';
  let katexLoading = null;

  function getKatex() {
    return (PAGE_WIN && PAGE_WIN.katex) || window.katex || null;
  }

  function loadAsset(kind, url) {
    return new Promise((resolve, reject) => {
      if (kind === 'css') {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = url;
        link.onload = () => resolve();
        link.onerror = () => reject(new Error('CSS 加载失败: ' + url));
        document.head.appendChild(link);
      } else {
        const script = document.createElement('script');
        script.src = url;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('JS 加载失败: ' + url));
        document.head.appendChild(script);
      }
    });
  }

  function loadKatex() {
    if (getKatex()) return Promise.resolve(getKatex());
    if (katexLoading) return katexLoading;
    katexLoading = (async () => {
      let loaded = false;
      try {
        await loadAsset('css', `${BASE}/plugins/discourse-math/katex/katex.min.css`);
        await loadAsset('js', `${BASE}/plugins/discourse-math/katex/katex.min.js`);
        await loadAsset('js', `${BASE}/plugins/discourse-math/katex/mhchem.min.js`);
        loaded = !!getKatex();
      } catch (err) {
        loaded = false;
      }
      if (!loaded) {
        await loadAsset('css', KATEX_CDN_CSS);
        await loadAsset('js', KATEX_CDN_JS);
        await loadAsset('js', KATEX_CDN_MHCHEM);
      }
      const katex = getKatex();
      if (!katex) throw new Error('KaTeX 加载失败');
      return katex;
    })();
    katexLoading.catch(() => { katexLoading = null; });
    return katexLoading;
  }

  function renderMath(root) {
    if (!root) return;
    const mathEls = root.querySelectorAll('.math');
    if (!mathEls.length) return;
    loadKatex().then((katex) => {
      mathEls.forEach((el) => {
        if (el.dataset.appliedKatex) return;
        el.dataset.appliedKatex = '1';
        const isBlock = el.tagName === 'DIV';
        el.classList.add('math-container', isBlock ? 'block-math' : 'inline-math', 'katex-math');
        const text = el.textContent;
        el.textContent = '';
        try {
          katex.render(text, el, {
            trust: (context) => ['\\htmlId', '\\href'].includes(context.command),
            macros: {
              '\\eqref': '\\href{###1}{(\\text{#1})}',
              '\\ref': '\\href{###1}{\\text{#1}}',
              '\\label': '\\htmlId{#1}{}',
            },
            displayMode: isBlock,
            throwOnError: false,
          });
        } catch (err) {
          el.textContent = text;
        }
      });
    }).catch((err) => {
      console.warn('[LinuxDo 增强阅读] KaTeX 加载失败，公式将以文本显示:', err);
    });
  }

  /* ============ 7. 渲染单条 ============ */
  function renderPost(p, isReply, ctx) {
    const isDeleted = Boolean(p.deleted_at || p.user_deleted === true || (!p.username && !p.cooked));
    const username = p.username || '';
    const displayName = p.name || p.display_name || p.display_username || username;
    const avatar = resolveAvatar(p.avatar_template, 48);
    const { count, acted, canAct } = likeInfo(p);
    const isOP = ctx.op && username && username === ctx.op;
    const isME = ME_USERNAME && username && username === ME_USERNAME;
    const time = fmtTime(p.created_at);
    const profileUrl = username ? userProfileUrl(username) : '';

    const cooked = isDeleted
      ? '<p class="ldp-deleted">（帖子已被作者删除）</p>'
      : (p.cooked || '');

    const boostsHtml = isDeleted ? '' : renderBoosts(p.boosts || []);
    const canBoost = !isDeleted && p.can_boost === true;
    const canDelete = !isDeleted && isME && Number(p.post_number) !== 1;
    const likeView = getPostLikeView(p);

    const lastReadPostNumber = Math.max(1, Number(
      ctx.tracker && ctx.tracker.getReadWaterline ? ctx.tracker.getReadWaterline() : ctx.lastReadPostNumber
    ) || 0);
    const isUnread = !p._ldpSkipUnread && p.post_number > lastReadPostNumber;

    const actionsHtml = isDeleted
      ? ''
      : `<div class="ldp-actions">
        <button type="button" class="ldp-btn ldp-like ${likeView.acted ? 'liked' : ''}"
          data-acted="${likeView.acted ? '1' : '0'}"
          data-current-reaction="${escAttr(likeView.currentReaction)}"
          ${likeView.canInteract ? '' : 'disabled'} title="点赞（悬停选择表情）">
          <span class="ldp-like-icon">${likeView.isCustomReaction
            ? reactionIconHtml(likeView.currentReaction)
            : `<svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:currentColor;vertical-align:middle;">${ICONS.like}</svg>`}</span>
          <span class="ldp-like-count">${likeView.count}</span>
        </button>
        <button class="ldp-btn ldp-replybtn" title="回复">
            <svg viewBox="0 0 1024 1024" style="width:12px;height:12px;fill:currentColor;vertical-align:middle;">${ICONS.reply}</svg>
        </button>
        <button class="ldp-btn ldp-post-bookmark ${p.bookmarked ? 'bookmarked' : ''}"
          data-bookmark-id="${escAttr(String(p.bookmark_id || ''))}" title="收藏楼层" aria-label="收藏楼层">
          <svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:currentColor;vertical-align:middle;">${ICONS.bookmark}</svg>
        </button>
        <button class="ldp-btn ldp-boost-btn" ${canBoost ? '' : 'disabled'} title="Boost">
          <svg viewBox="0 0 1024 1024" style="width:12px;height:12px;fill:currentColor;vertical-align:middle;">${ICONS.boost}</svg>
        </button>
        ${canDelete ? `<button type="button" class="ldp-btn ldp-deletebtn" title="删除" aria-label="删除">${TRASH_BTN_ICON}</button>` : ''}
      </div>`;
    const userIdentityHtml = username
      ? `<a class="ldp-user-link" href="${escAttr(profileUrl)}" target="_blank" rel="noopener noreferrer" data-username="${escAttr(username)}"><span class="ldp-author">${esc(displayName)}</span><span class="ldp-user">@${esc(username)}</span></a>`
      : (displayName ? `<span class="ldp-author">${esc(displayName)}</span>` : '');

    const node = document.createElement('div');
    node.className = 'ldp-post' + (isReply ? ' ldp-reply' : '') + (isUnread ? ' ldp-unread' : '');
    node.dataset.postId = p.id;
    node.dataset.postNumber = p.post_number;
    node.dataset.createdAt = p.created_at || '';
    node.dataset.replyToPostNumber = p.reply_to_post_number || 0;
    node.dataset.windowEpoch = String(ctx.windowEpoch || 0);
    node.innerHTML = `
      <div class="ldp-post-head">
        ${avatar && username ? `<button type="button" class="ldp-avatar-btn" title="查看 ${escAttr(username)} 的个人详情" aria-label="查看 ${escAttr(username)} 的个人详情" data-username="${escAttr(username)}"><img class="ldp-avatar" src="${escAttr(avatar)}" alt="" loading="lazy" decoding="async"></button>` : (avatar ? `<img class="ldp-avatar" src="${escAttr(avatar)}" alt="" loading="lazy" decoding="async">` : '')}
        ${userIdentityHtml}
        ${p.trust_level != null && p.trust_level !== '' ? `<span class="ldp-level">Lv.${esc(String(p.trust_level))}</span>` : ''}
        ${isOP ? '<span class="ldp-op">OP</span>' : ''}
        ${isME ? '<span class="ldp-me">ME</span>' : ''}
        ${time ? `<span class="ldp-time">· ${esc(time)}</span>` : ''}
        <span class="ldp-floor">#${p.post_number}</span>
        <span class="ldp-unread-dot" title="未读" aria-label="未读"></span>
      </div>
      <div class="ldp-content">${cooked}</div>
      ${isDeleted ? '' : `<div class="ldp-boosts-list">${boostsHtml}</div>
      <div class="ldp-boost-input-wrap">
        <input type="text" class="ldp-boost-input" maxlength="50"
          placeholder="Boost ${esc(username)}… (最多${getBoostCharLimits().max}字符)">
        <button class="ldp-emoji-btn ldp-boost-emoji" type="button" title="表情">${EMOJI_BTN_ICON}</button>
        <button class="ldp-boost-submit" type="button" title="发送">✓</button>
        <span class="ldp-char-counter ldp-boost-counter is-short">0/${getBoostCharLimits().max}</span>
        <button class="ldp-boost-cancel" type="button" title="取消">×</button>
      </div>`}
      ${actionsHtml}
      <div class="ldp-children"></div>
      <div class="ldp-sub-loading">加载楼中楼中…</div>
      <div class="ldp-sub-actions"><button type="button" class="ldp-btn ldp-load-more-replies">展示更多回复 ↓</button></div>
    `;
    const boostInput = node.querySelector(':scope > .ldp-boost-input-wrap .ldp-boost-input');
    const boostCounter = node.querySelector(':scope > .ldp-boost-input-wrap .ldp-boost-counter');
    if (boostInput && boostCounter) {
      const syncBoostCount = () => {
        const limits = getBoostCharLimits();
        const len = countInputChars(boostInput.value);
        boostCounter.textContent = `${len}/${limits.max}`;
        boostCounter.classList.toggle('is-short', len < limits.min || len > limits.max);
      };
      boostInput.addEventListener('input', syncBoostCount);
      syncBoostCount();
    }
    const content = node.querySelector('.ldp-content');
    content.querySelectorAll('a[href]').forEach((anchor) => {
      if (!isImageAnchor(anchor) && !anchor.getAttribute('target')) anchor.setAttribute('target', '_blank');
    });
    content.querySelectorAll('img').forEach((img) => {
      if (!img.hasAttribute('loading')) img.setAttribute('loading', 'lazy');
      if (!img.hasAttribute('decoding')) img.setAttribute('decoding', 'async');
    });
    content.querySelectorAll('iframe').forEach((iframe) => {
      if (!iframe.hasAttribute('loading')) iframe.setAttribute('loading', 'lazy');
    });
    if (Number(ctx.highlightPostId) === Number(p.id) && Date.now() < Number(ctx.highlightUntil || 0)) {
      node.classList.add('ldp-flash');
    }
    if (!isDeleted) {
      renderPolls(content, p);
      prepareSpoilers(content);
      renderMath(node);
      enhanceCodeBlocks(node);
    }
    return node;
  }

  function markPostDeleted(postId, modal, ctx) {
    const deletedAt = new Date().toISOString();
    if (ctx && ctx.loader) {
      ctx.loader.updatePost(postId, { deleted_at: deletedAt, user_deleted: true });
    }
    if (!modal) return;
    const escapedId = CSS.escape(String(postId));
    modal.querySelectorAll(`.ldp-post[data-post-id="${escapedId}"]`).forEach((node) => {
      const content = node.querySelector(':scope > .ldp-content');
      if (content) content.innerHTML = '<p class="ldp-deleted">（帖子已被作者删除）</p>';
      node.querySelectorAll(':scope > .ldp-boosts-list, :scope > .ldp-boost-input-wrap, :scope > .ldp-replybox, :scope > .ldp-actions, :scope > .ldp-op-reactions').forEach((el) => el.remove());
      if (ctx && ctx.refreshRenderRevision) ctx.refreshRenderRevision(node);
    });
  }

  function syncRenderedPostState(root, post) {
    if (!root || !post || !post.id) return;
    const likeView = getPostLikeView(post);
    root.querySelectorAll(`.ldp-post[data-post-id="${CSS.escape(String(post.id))}"]`).forEach((node) => {
      const like = node.querySelector(':scope > .ldp-actions .ldp-like');
      if (like) {
        like.classList.toggle('liked', likeView.acted);
        like.dataset.acted = likeView.acted ? '1' : '0';
        like.dataset.currentReaction = likeView.currentReaction;
        like.disabled = !likeView.canInteract;
        const iconNode = like.querySelector('.ldp-like-icon');
        if (iconNode) {
          iconNode.innerHTML = likeView.isCustomReaction
            ? reactionIconHtml(likeView.currentReaction)
            : `<svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:currentColor;vertical-align:middle;">${ICONS.like}</svg>`;
        }
        const countNode = like.querySelector('.ldp-like-count');
        if (countNode) countNode.textContent = String(likeView.count);
      }
      const bookmark = node.querySelector(':scope > .ldp-actions .ldp-post-bookmark');
      if (bookmark) {
        bookmark.classList.toggle('bookmarked', !!post.bookmarked);
        bookmark.dataset.bookmarkId = String(post.bookmark_id || '');
      }
    });
  }

  async function togglePostReaction(postId, rawReactionId, ctx, syncRoot) {
    const reactionId = normalizeEmojiId(rawReactionId);
    if (!postId || !reactionId) return;
    try {
      const res = await apiSend(
        `${BASE}/discourse-reactions/posts/${postId}/custom-reactions/${encodeURIComponent(reactionId)}/toggle.json`,
        'PUT',
      );
      if (ctx && ctx.loader) {
        ctx.loader.updatePost(postId, (post) => {
          if (res && (Array.isArray(res.reactions) || Array.isArray(res.actions_summary))) {
            if (Array.isArray(res.reactions)) post.reactions = res.reactions;
            if ('current_user_reaction' in res) post.current_user_reaction = res.current_user_reaction;
            if (Array.isArray(res.actions_summary)) post.actions_summary = res.actions_summary;
            return post;
          }
          const previous = normalizeEmojiId(post.current_user_reaction && post.current_user_reaction.id);
          const selected = previous !== reactionId;
          const reactions = Array.isArray(post.reactions) ? post.reactions.map((item) => Object.assign({}, item)) : [];
          const adjust = (id, delta) => {
            if (!id) return;
            let item = reactions.find((entry) => normalizeEmojiId(entry.id) === id);
            if (!item && delta > 0) { item = { id, type: 'emoji', count: 0 }; reactions.push(item); }
            if (item) item.count = Math.max(0, Number(item.count || 0) + delta);
          };
          if (previous) adjust(previous, -1);
          if (selected) adjust(reactionId, 1);
          post.reactions = reactions.filter((item) => Number(item.count) > 0);
          post.current_user_reaction = selected ? { id: reactionId, type: 'emoji', can_undo: true } : null;
          const actions = Array.isArray(post.actions_summary) ? post.actions_summary.map((item) => Object.assign({}, item)) : [];
          let like = actions.find((item) => Number(item.id) === 2);
          if (!like) { like = { id: 2, can_act: true, count: 0 }; actions.push(like); }
          if (!previous && selected) like.count = Math.max(0, Number(like.count || 0) + 1);
          else if (previous && !selected) like.count = Math.max(0, Number(like.count || 0) - 1);
          like.acted = selected;
          post.actions_summary = actions;
          return post;
        });
      }
      const updated = ctx && ctx.loader && ctx.loader.getPostById(postId);
      if (updated && syncRoot) syncRenderedPostState(syncRoot, updated);
      invalidateCollectionCache('responses').catch(() => {});
      if (ctx && ctx.topicId) invalidateTopicSnapshot(ctx.topicId).catch(() => {});
    } catch (err) {
      if (err && err.status === 404) {
        REACTIONS_AVAILABLE = false;
        if (reactionId === 'heart') {
          await performDefaultHeartLike(postId, ctx, syncRoot);
        }
      } else {
        alert('表情点赞失败：' + err.message);
      }
    }
  }

  async function performDefaultHeartLike(postId, ctx, syncRoot) {
    const post = (ctx && ctx.loader && ctx.loader.getPostById(postId))
      || (ctx && ctx.topic && Number(ctx.topic._opPost?.id) === Number(postId) ? ctx.topic._opPost : null);
    const view = getPostLikeView(post);
    if (view.isCustomReaction && REACTIONS_AVAILABLE !== false) {
      await togglePostReaction(postId, view.currentReaction, ctx, syncRoot);
      return;
    }
    const nextActed = !view.acted;
    if (nextActed) {
      await apiSend(`${BASE}/post_actions`, 'POST', { id: postId, post_action_type_id: 2, flag_topic: false });
    } else {
      try {
        await apiSend(`${BASE}/post_actions/${postId}?post_action_type_id=2`, 'DELETE');
      } catch (err) {
        if (REACTIONS_AVAILABLE !== false && view.currentReaction === 'heart') {
          await togglePostReaction(postId, 'heart', ctx, syncRoot);
          return;
        }
        throw err;
      }
    }
    if (ctx && ctx.loader) {
      ctx.loader.updatePost(postId, (current) => {
        const actions = Array.isArray(current.actions_summary)
          ? current.actions_summary.map((item) => Object.assign({}, item)) : [];
        let like = actions.find((item) => Number(item.id) === 2);
        if (!like) { like = { id: 2, can_act: true, count: 0 }; actions.push(like); }
        like.acted = nextActed;
        like.count = Math.max(0, Number(view.count) + (nextActed ? 1 : -1));
        current.actions_summary = actions;
        if (Array.isArray(current.reactions)) {
          const reactions = current.reactions.map((item) => Object.assign({}, item));
          let heart = reactions.find((entry) => normalizeEmojiId(entry.id) === 'heart');
          if (nextActed) {
            if (!heart) { heart = { id: 'heart', type: 'emoji', count: 0 }; reactions.push(heart); }
            heart.count = Math.max(0, Number(heart.count || 0) + 1);
          } else if (heart) {
            heart.count = Math.max(0, Number(heart.count || 0) - 1);
          }
          current.reactions = reactions.filter((item) => Number(item.count) > 0);
        }
        current.current_user_reaction = nextActed ? { id: 'heart', type: 'emoji', can_undo: true } : null;
        return current;
      });
    }
    const updated = ctx && ctx.loader && ctx.loader.getPostById(postId);
    if (updated && syncRoot) syncRenderedPostState(syncRoot, updated);
    invalidateCollectionCache('responses').catch(() => {});
    if (ctx && ctx.topicId) invalidateTopicSnapshot(ctx.topicId).catch(() => {});
  }

  const LIKE_HOVER_OPEN_DELAY = 320;
  const LIKE_HOVER_CLOSE_DELAY = 260;

  function scheduleHoverReactionPanelClose(bar) {
    clearTimeout(hoverReactionCloseTimer);
    hoverReactionCloseTimer = setTimeout(() => {
      hoverReactionCloseTimer = 0;
      if (!bar || !bar.isConnected) return;
      if (bar.matches(':hover') || (bar._ownerBtn && bar._ownerBtn.isConnected && bar._ownerBtn.matches(':hover'))) {
        return;
      }
      if (bar._ownerBtn) bar._ownerBtn._ldpReactionBar = null;
      bar.remove();
    }, LIKE_HOVER_CLOSE_DELAY);
  }

  function openHoverReactionPanel(triggerBtn, postId, ctx, syncRoot) {
    if (!triggerBtn || !triggerBtn.isConnected || triggerBtn.disabled || REACTIONS_AVAILABLE === false) return;
    if (triggerBtn._ldpReactionBar && triggerBtn._ldpReactionBar.isConnected) return;
    closeReactionHoverBar();
    const post = (ctx && ctx.loader && ctx.loader.getPostById(postId))
      || (ctx && ctx.topic && Number(ctx.topic._opPost?.id) === Number(postId) ? ctx.topic._opPost : null);
    const reactionIds = validReactionIds(ctx && ctx.topic, post);
    if (!reactionIds.length) return;
    const currentReaction = normalizeEmojiId(
      (post && post.current_user_reaction && post.current_user_reaction.id) || triggerBtn.dataset.currentReaction || '',
    );
    if (!emojiDataCache && !emojiDataLoading) {
      fetchEmojiData().then(refreshCustomReactionImages).catch(() => {});
    }
    const bar = document.createElement('div');
    bar.className = 'ldp-reaction-hover-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '选择点赞表情');
    reactionIds.forEach((id) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'ldp-reaction-hover-item' + (currentReaction === id ? ' selected' : '');
      item.title = ':' + id + ':';
      const fallbackName = id === '+1' ? 'thumbsup' : id;
      item.innerHTML = `<img class="ldp-reaction-img" data-emoji-name="${escAttr(id)}" src="${escAttr(emojiUrl(fallbackName))}" alt=":${escAttr(id)}:" loading="lazy">`;
      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeReactionHoverBar();
        togglePostReaction(postId, id, ctx, syncRoot);
      });
      bar.appendChild(item);
    });

    bar._ownerBtn = triggerBtn;
    document.body.appendChild(bar);
    triggerBtn._ldpReactionBar = bar;
    const btnRect = triggerBtn.getBoundingClientRect();
    const barW = bar.offsetWidth || (reactionIds.length * 36 + 16);
    const barH = bar.offsetHeight || 44;
    const gap = 6;
    const modal = triggerBtn.closest('.ldp-modal');
    const bounds = modal ? modal.getBoundingClientRect()
      : { top: 8, left: 8, bottom: window.innerHeight - 8, right: window.innerWidth - 8 };
    let top = (btnRect.top - barH - gap >= bounds.top) ? (btnRect.top - barH - gap) : (btnRect.bottom + gap);
    if (top + barH > bounds.bottom) top = bounds.bottom - barH;
    if (top < bounds.top) top = bounds.top;
    let left = btnRect.left + (btnRect.width - barW) / 2;
    if (left < bounds.left + 4) left = bounds.left + 4;
    if (left + barW > bounds.right - 4) left = bounds.right - barW - 4;
    bar.style.top = `${Math.round(top)}px`;
    bar.style.left = `${Math.round(left)}px`;

    bar.addEventListener('mouseenter', () => {
      clearTimeout(hoverReactionCloseTimer);
      hoverReactionCloseTimer = 0;
    });
    bar.addEventListener('mouseleave', (e) => {
      if (triggerBtn.contains(e.relatedTarget)) return;
      scheduleHoverReactionPanelClose(bar);
    });
    setTimeout(() => {
      const closer = (e) => {
        if (!bar.isConnected) {
          document.removeEventListener('mousedown', closer, true);
          return;
        }
        if (bar.contains(e.target) || triggerBtn.contains(e.target)) return;
        if (bar._ownerBtn) bar._ownerBtn._ldpReactionBar = null;
        bar.remove();
        document.removeEventListener('mousedown', closer, true);
      };
      document.addEventListener('mousedown', closer, true);
    }, 0);
  }

  function bindHoverLikeReaction(container, selector, resolvePostId, ctx, syncRoot) {
    if (!container) return;
    container.addEventListener('mouseover', (e) => {
      const btn = e.target.closest(selector);
      if (!btn || btn.disabled || REACTIONS_AVAILABLE === false) return;
      if (btn._ldpReactionBar && btn._ldpReactionBar.isConnected) {
        clearTimeout(hoverReactionCloseTimer);
        hoverReactionCloseTimer = 0;
        return;
      }
      if (activeHoverReactionBtn === btn && hoverReactionOpenTimer) return;
      clearTimeout(hoverReactionOpenTimer);
      activeHoverReactionBtn = btn;
      hoverReactionOpenTimer = setTimeout(() => {
        hoverReactionOpenTimer = 0;
        if (activeHoverReactionBtn === btn) activeHoverReactionBtn = null;
        if (!btn.isConnected || btn.disabled || !btn.matches(':hover')) return;
        const pid = resolvePostId(btn);
        if (pid) openHoverReactionPanel(btn, pid, ctx, syncRoot);
      }, LIKE_HOVER_OPEN_DELAY);
    });
    container.addEventListener('mouseout', (e) => {
      const btn = e.target.closest(selector);
      if (!btn || btn.contains(e.relatedTarget)) return;
      if (activeHoverReactionBtn === btn) {
        clearTimeout(hoverReactionOpenTimer);
        hoverReactionOpenTimer = 0;
        activeHoverReactionBtn = null;
      }
      const bar = btn._ldpReactionBar;
      if (bar && bar.isConnected && !bar.contains(e.relatedTarget)) {
        scheduleHoverReactionPanelClose(bar);
      }
    });
  }

  /* ============ 8. 回复框 ============ */
  function ensureReplyBox(post, topic) {
    let box = post.querySelector(':scope > .ldp-replybox');
    if (box) {
      if (typeof box._syncReplyCounter === 'function') box._syncReplyCounter(topic);
      return box;
    }
    const username = (post.querySelector(':scope > .ldp-post-head .ldp-user')?.textContent || '').replace(/^@/, '');
    const initialMin = getMinReplyLength(topic);
    box = document.createElement('div');
    box.className = 'ldp-replybox';
    box.innerHTML = `<textarea placeholder="回复 @${esc(username)} …（最少 ${initialMin} 个字符）"></textarea><div class="ldp-reply-tools"><div class="ldp-insert-wrap"><button class="ldp-emoji-btn ldp-reply-insert" type="button" title="插入模板" aria-haspopup="true" aria-expanded="false">${INSERT_BTN_ICON}</button><div class="ldp-insert-menu" hidden><button class="ldp-insert-item ldp-reply-details" type="button">${DETAILS_ICON}<span>隐藏详细信息</span></button><button class="ldp-insert-item ldp-reply-spoiler" type="button">${SPOILER_ICON}<span>模糊剧透</span></button></div></div><button class="ldp-emoji-btn ldp-reply-emoji" type="button" title="表情">${EMOJI_BTN_ICON}</button><button class="ldp-send" type="button">发送</button><span class="ldp-char-counter ldp-reply-counter is-short">0/${initialMin}</span><span class="ldp-reply-tip">✓ 已发送</span></div>`;

    const textarea = box.querySelector('textarea');
    const counterEl = box.querySelector('.ldp-reply-counter');
    let activeTopic = topic || null;
    const syncReplyCounter = (nextTopic) => {
      if (nextTopic) activeTopic = nextTopic;
      const minLen = getMinReplyLength(activeTopic);
      const len = countInputChars(textarea.value);
      counterEl.textContent = `${len}/${minLen}`;
      counterEl.classList.toggle('is-short', len < minLen);
      textarea.placeholder = `回复 @${username} …（最少 ${minLen} 个字符）`;
    };
    box._syncReplyCounter = syncReplyCounter;
    textarea.addEventListener('input', () => syncReplyCounter());
    syncReplyCounter();
    bindPasteEvent(textarea);
    const emojiBtn = box.querySelector('.ldp-reply-emoji');
    emojiBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleEmojiPanel(emojiBtn, textarea);
    });
    const insertBtn = box.querySelector('.ldp-reply-insert');
    const insertMenu = box.querySelector('.ldp-insert-menu');
    const onInsertMenuOutside = (e) => {
      if (!insertMenu.contains(e.target) && !insertBtn.contains(e.target)) closeInsertMenu();
    };
    const closeInsertMenu = () => {
      insertMenu.hidden = true;
      insertBtn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onInsertMenuOutside, true);
    };
    insertBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (insertMenu.hidden) {
        insertMenu.hidden = false;
        insertBtn.setAttribute('aria-expanded', 'true');
        document.addEventListener('mousedown', onInsertMenuOutside, true);
      } else {
        closeInsertMenu();
      }
    });
    box.querySelector('.ldp-reply-details').addEventListener('click', () => {
      insertAtCursor(textarea, '[details="总结"]\n此文本将被隐藏\n[/details]');
      closeInsertMenu();
    });
    box.querySelector('.ldp-reply-spoiler').addEventListener('click', () => {
      insertAtCursor(textarea, '[spoiler]此文本将被模糊处理[/spoiler]');
      closeInsertMenu();
    });

    const actions = post.querySelector(':scope > .ldp-actions');
    if (actions) actions.after(box);
    else post.appendChild(box);
    return box;
  }

  /* ============ 文件粘贴上传（大图压缩 + 分片直传 + 标准回退） ============ */
  const MULTIPART_UPLOAD_CONCURRENCY = 6;
  const MULTIPART_RETRY_DELAYS = [0, 1000, 3000, 5000];
  const HUGE_FILE_CHECKSUM_LIMIT = 100 * 1024 * 1024;
  const DISCOURSE_IMAGE_SIZE_LIMIT = 4 * 1024 * 1024;
  const OFFICIAL_MEDIA_WORKER_URL = 'https://cdn3.ldstatic.com/assets/br/chunk-bgg7iqfw.digested.js';
  const IMAGE_MAGICK_CDN = 'https://cdn.jsdelivr.net/npm/@imagemagick/magick-wasm@0.0.43/dist/index.js';
  const IMAGE_MAGICK_WASM = 'https://cdn.jsdelivr.net/npm/@imagemagick/magick-wasm@0.0.43/dist/x86/magick.wasm';
  const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'svg', 'ico', 'webp', 'avif', 'heic', 'heif', 'jxl']);
  const AUDIO_EXTENSIONS = new Set(['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'm4b', 'm4p', 'm4r', 'aac', 'flac']);
  const VIDEO_EXTENSIONS = new Set(['mov', 'mp4', 'webm', 'ogv', 'm4v', '3gp', 'avi', 'mpeg']);

  function fileExtension(filename) {
    const match = (filename || '').match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : '';
  }

  async function fileSha1(file) {
    if (!window.isSecureContext || !file.arrayBuffer || !window.crypto?.subtle?.digest) return '';
    if (file.size > HUGE_FILE_CHECKSUM_LIMIT) return '';
    try {
      const buffer = await file.arrayBuffer();
      const digest = await window.crypto.subtle.digest('SHA-1', buffer);
      return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    } catch (err) {
      return '';
    }
  }

  function multipartChunkSize(fileSize) {
    if (fileSize >= 500 * 1024 * 1024) return 20 * 1024 * 1024;
    if (fileSize >= 100 * 1024 * 1024) return 10 * 1024 * 1024;
    return 5 * 1024 * 1024;
  }

  function webpFileName(fileName) {
    const baseName = (fileName || 'clipboard-file').replace(/\.[^.]+$/, '');
    return `${baseName || 'clipboard-file'}.webp`;
  }

  let imageMagickReady = null;

  async function ensureImageMagick() {
    if (!imageMagickReady) {
      imageMagickReady = (async () => {
        const { initializeImageMagick } = await import(IMAGE_MAGICK_CDN);
        await initializeImageMagick(new URL(IMAGE_MAGICK_WASM));
      })();
      imageMagickReady.catch(() => { imageMagickReady = null; });
    }
    return imageMagickReady;
  }

  async function convertAnimatedGifWithOfficialWorker(file) {
    if (location.hostname !== 'linux.do') return null;
    const input = await file.arrayBuffer();
    const worker = new Worker(URL.createObjectURL(new Blob([
      `import '${OFFICIAL_MEDIA_WORKER_URL}';`,
    ], { type: 'text/javascript' })), { type: 'module' });

    try {
      return await new Promise((resolve, reject) => {
        worker.onmessage = (event) => {
          const message = event.data;
          if (message.type === 'file') {
            const blob = new Blob([message.file], { type: message.outputType });
            resolve(blob.size < file.size && blob.size <= DISCOURSE_IMAGE_SIZE_LIMIT
              ? new File([blob], webpFileName(file.name), { type: message.outputType })
              : null);
          } else if (message.type === 'skipped') {
            resolve(null);
          } else {
            reject(new Error('官方图片处理 Worker 返回异常'));
          }
        };
        worker.onerror = () => reject(new Error('官方图片处理 Worker 加载失败'));
        worker.onmessageerror = () => reject(new Error('官方图片处理 Worker 消息解析失败'));
        worker.postMessage({
          type: 'convertAnimated',
          file: input,
          fileName: file.name || 'clipboard-file',
          fileId: `${file.name}-${file.size}`,
          originalFileSize: file.size,
          settings: { encode_quality: 75, debug_mode: false },
        }, [input]);
      });
    } finally {
      worker.terminate();
    }
  }

  async function preprocessImage(file) {
    if (file.size <= DISCOURSE_IMAGE_SIZE_LIMIT) return file;
    if (!file.type.startsWith('image/') && !IMAGE_EXTENSIONS.has(fileExtension(file.name))) return file;

    if (file.type === 'image/gif' || fileExtension(file.name) === 'gif') {
      try {
        const converted = await convertAnimatedGifWithOfficialWorker(file);
        if (converted) return converted;
      } catch (err) {
        console.warn('[LinuxDo 增强阅读] 官方 GIF 预处理失败，将回退 ImageMagick:', err);
      }
    }

    try {
      await ensureImageMagick();
      const { ImageMagick, MagickFormat } = await import(IMAGE_MAGICK_CDN);
      const input = new Uint8Array(await file.arrayBuffer());
      const output = await ImageMagick.readCollection(input, async (images) => {
        images.forEach((image) => { image.quality = 75; });
        return await images.write(MagickFormat.WebP, (data) => data);
      });
      const blob = new Blob([output], { type: 'image/webp' });
      if (blob.size >= file.size || blob.size > DISCOURSE_IMAGE_SIZE_LIMIT) return file;
      return new File([blob], webpFileName(file.name), { type: 'image/webp' });
    } catch (err) {
      console.warn('[LinuxDo 增强阅读] 图片 ImageMagick 预处理失败，将尝试上传原文件:', err);
      return file;
    }
  }

  async function createMultipartUpload(file) {
    const params = new URLSearchParams();
    params.set('file_name', file.name || 'clipboard-file');
    params.set('file_size', String(file.size));
    params.set('upload_type', 'composer');
    const sha1 = await fileSha1(file);
    if (sha1) params.set('metadata[sha1-checksum]', sha1);
    return apiSend(`${BASE}/uploads/create-multipart.json`, 'POST', params);
  }

  async function presignMultipartParts(uniqueIdentifier, partNumbers) {
    const params = new URLSearchParams();
    params.set('unique_identifier', uniqueIdentifier);
    partNumbers.forEach((partNumber) => params.append('part_numbers[]', String(partNumber)));
    return apiSend(`${BASE}/uploads/batch-presign-multipart-parts.json`, 'POST', params);
  }

  async function uploadMultipartPart(file, partNumber, start, end, url) {
    for (let attempt = 0; attempt < MULTIPART_RETRY_DELAYS.length; attempt++) {
      try {
        const res = await fetch(url, { method: 'PUT', body: file.slice(start, end) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const etag = res.headers.get('ETag');
        if (!etag) throw new Error('S3 未返回 ETag');
        return { part_number: partNumber, etag };
      } catch (err) {
        if (attempt === MULTIPART_RETRY_DELAYS.length - 1) throw err;
        await sleep(MULTIPART_RETRY_DELAYS[attempt + 1]);
      }
    }
    return null;
  }

  async function uploadMultipartParts(file, uniqueIdentifier) {
    const chunkSize = multipartChunkSize(file.size);
    const totalParts = Math.ceil(Math.max(1, file.size) / chunkSize);
    const parts = new Array(totalParts);
    for (let partNumber = 1; partNumber <= totalParts; partNumber += MULTIPART_UPLOAD_CONCURRENCY) {
      const batchNumbers = [];
      for (let n = partNumber; n < Math.min(partNumber + MULTIPART_UPLOAD_CONCURRENCY, totalParts + 1); n++) {
        batchNumbers.push(n);
      }
      const { presigned_urls: presignedUrls } = await presignMultipartParts(uniqueIdentifier, batchNumbers);
      const uploadedParts = await Promise.all(batchNumbers.map((n) => uploadMultipartPart(
        file,
        n,
        (n - 1) * chunkSize,
        Math.min(n * chunkSize, file.size),
        presignedUrls[n],
      )));
      uploadedParts.forEach((part) => { parts[part.part_number - 1] = part; });
    }
    return parts;
  }

  async function completeMultipartUpload(uniqueIdentifier, parts) {
    const res = await fetch(`${BASE}/uploads/complete-multipart.json`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json; charset=UTF-8',
        'X-CSRF-Token': csrfToken(),
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({ unique_identifier: uniqueIdentifier, parts, pasted: true }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json().catch(() => ({}));
  }

  async function abortMultipartUpload(uploadId) {
    return apiSend(`${BASE}/uploads/abort-multipart.json`, 'POST', {
      external_upload_identifier: uploadId,
    });
  }

  async function uploadDirectFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('type', 'composer');
    formData.append('synchronous', 'true');
    return apiSend(`${BASE}/uploads.json`, 'POST', formData);
  }

  async function uploadFile(file) {
    let uploadId;
    try {
      const created = await createMultipartUpload(file);
      if (!created?.unique_identifier || !created?.external_upload_identifier) {
        throw new Error('上传初始化返回数据异常');
      }
      uploadId = created.external_upload_identifier;
      const parts = await uploadMultipartParts(file, created.unique_identifier);
      return await completeMultipartUpload(created.unique_identifier, parts);
    } catch (err) {
      if (uploadId) await abortMultipartUpload(uploadId).catch(() => {});
      if (!uploadId && err && (err.status === 404 || err.status === 405 || err.status === 422)) {
        return await uploadDirectFile(file);
      }
      throw err;
    }
  }

  function uploadMarkdown(res) {
    const label = (res.original_filename || '附件').replace(/[\[\]\|]/g, '');
    const extension = fileExtension(res.original_filename);
    if (IMAGE_EXTENSIONS.has(extension)) {
      return res.width && res.height
        ? `![${label}|${res.width}x${res.height}](${res.short_url})`
        : `![${label}](${res.short_url})`;
    }
    if (AUDIO_EXTENSIONS.has(extension)) return `![${label}|audio](${res.short_url})`;
    if (VIDEO_EXTENSIONS.has(extension)) return `![${label}|video](${res.short_url})`;
    return `[${label}|attachment](${res.short_url})${res.human_filesize ? ` (${res.human_filesize})` : ''}`;
  }

  function insertAtCursor(textarea, text) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const val = textarea.value;
    textarea.value = val.substring(0, start) + text + val.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
  }

  function bindPasteEvent(textarea) {
    textarea.addEventListener('paste', async (e) => {
      const items = (e.clipboardData || (e.originalEvent && e.originalEvent.clipboardData) || {}).items || [];
      for (const item of items) {
        if (item.kind === 'file') {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;
          const placeholder = `[正在上传文件 ${file.name} ...]`;
          insertAtCursor(textarea, placeholder);
          textarea.classList.add('uploading');
          try {
            const uploadableFile = await preprocessImage(file);
            const res = await uploadFile(uploadableFile);
            if (res && res.short_url) {
              textarea.value = textarea.value.replace(placeholder, uploadMarkdown(res));
              textarea.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
              throw new Error('上传返回数据异常');
            }
          } catch (err) {
            textarea.value = textarea.value.replace(placeholder, `[文件上传失败: ${err.message}]`);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
          } finally {
            textarea.classList.remove('uploading');
          }
        }
      }
    });
  }

  /* ============ 9. 默认楼中楼嵌套渲染（与脚本 b 一致，按需补全） ============ */
  function mergeSubReplyState(postNumber, replies, ctx, targetPostId) {
    const key = Number(postNumber);
    const existing = ctx.subReplyState.get(key);
    const byId = new Map();
    [...((existing && existing.all) || []), ...(replies || [])].forEach((reply) => {
      if (!reply || !reply.id || Number(reply.reply_to_post_number) !== key) return;
      const canonical = (ctx.loader && ctx.loader.getPostById(reply.id)) || reply;
      byId.set(Number(canonical.id), canonical);
    });
    const state = existing || { all: [], renderedCount: 0, targetIds: new Set() };
    state.all = Array.from(byId.values()).sort((a, b) => Number(a.post_number) - Number(b.post_number));
    if (!(state.targetIds instanceof Set)) state.targetIds = new Set(state.targetIds || []);
    if (targetPostId) state.targetIds.add(Number(targetPostId));
    state.renderedCount = Math.max(Number(state.renderedCount) || 0, Math.min(SUB_REPLY_INITIAL_SIZE, state.all.length));
    ctx.subReplyState.set(key, state);
    return state;
  }

  function clearRenderedReplyChildren(children, ctx) {
    if (!children) return;
    children.querySelectorAll('.ldp-post[data-post-id]').forEach((node) => {
      ctx.tracker.unobserve(node);
      if (ctx.repliesIO && ctx.repliesIO.clearNode) ctx.repliesIO.clearNode(node);
      const postNumber = Number(node.dataset.postNumber);
      if (ctx.nodeMap.get(postNumber) === node) ctx.nodeMap.delete(postNumber);
    });
    children.replaceChildren();
  }

  function renderSubReplyStateInto(parentNode, postNumber, ctx, depth, ancestry) {
    const state = ctx.subReplyState.get(Number(postNumber));
    if (!state || !parentNode) return;
    const children = parentNode.querySelector(':scope > .ldp-children');
    if (!children) return;
    const seenAncestry = ancestry instanceof Set ? ancestry : new Set([Number(parentNode.dataset.postId)]);
    clearRenderedReplyChildren(children, ctx);
    const selected = [];
    state.all.forEach((reply, index) => {
      if (index < state.renderedCount || state.targetIds.has(Number(reply.id))) selected.push({ reply, index });
    });
    let previousIndex = -1;
    selected.forEach(({ reply, index }) => {
      if (index - previousIndex > 1) {
        const gap = document.createElement('div');
        gap.className = 'ldp-reply-gap';
        gap.textContent = `省略 ${index - previousIndex - 1} 条回复`;
        children.appendChild(gap);
      }
      previousIndex = index;
      const canonical = ctx.loader.getPostById(reply.id) || reply;
      if (seenAncestry.has(Number(canonical.id))) return;
      const copy = renderPost(canonical, true, ctx);
      const nextDepth = Math.max(1, Number(depth) || 1);
      copy.classList.add('ldp-post-copy');
      copy.dataset.replyDepth = String(nextDepth);
      if (nextDepth >= 4) copy.classList.add('ldp-reply-depth-capped');
      copy.setAttribute('aria-label', `#${canonical.post_number} 的楼中楼回复`);
      children.appendChild(copy);
      ctx.nodeMap.set(Number(canonical.post_number), copy);
      ctx.tracker.observe(copy);
      if (ctx.repliesIO && Number(canonical.reply_count) > 0) ctx.repliesIO.observe(copy);

      const knownChildren = ctx.loader.getKnownChildren(canonical.post_number);
      if (knownChildren.length) {
        const childState = mergeSubReplyState(canonical.post_number, knownChildren, ctx);
        if (!childState.renderedCount) childState.renderedCount = Math.min(SUB_REPLY_INITIAL_SIZE, childState.all.length);
        const nextAncestry = new Set(seenAncestry);
        nextAncestry.add(Number(canonical.id));
        renderSubReplyStateInto(copy, canonical.post_number, ctx, nextDepth + 1, nextAncestry);
      }
    });
    if (state.all.length - previousIndex > 1 && state.targetIds.size) {
      const gap = document.createElement('div');
      gap.className = 'ldp-reply-gap';
      gap.textContent = `省略 ${state.all.length - previousIndex - 1} 条回复`;
      children.appendChild(gap);
    }
    const actionEl = parentNode.querySelector(':scope > .ldp-sub-actions');
    const btnEl = actionEl && actionEl.querySelector('.ldp-load-more-replies');
    const parentPost = ctx.loader.getPostById(parentNode.dataset.postId);
    const expectedTotal = Math.max(state.all.length, Number(parentPost && parentPost.reply_count) || 0);
    const remaining = Math.max(0, expectedTotal - state.renderedCount);
    if (remaining > 0) {
      if (actionEl) actionEl.style.display = 'block';
      if (btnEl) btnEl.textContent = `展示更多回复（还剩 ${remaining} 条） ↓`;
    } else if (actionEl) {
      actionEl.style.display = 'none';
    }
  }

  function renderSubReplyState(postNumber, ctx) {
    const parentNode = ctx.nodeMap.get(Number(postNumber))
      || ctx.topicEl.querySelector(`.ldp-post[data-post-number="${postNumber}"]`);
    if (!parentNode) return;
    const mutate = () => renderSubReplyStateInto(parentNode, postNumber, ctx, 1, new Set([Number(parentNode.dataset.postId)]));
    if (ctx.withViewportAnchor) ctx.withViewportAnchor(mutate);
    else mutate();
    if (ctx.refreshRenderRevision) ctx.refreshRenderRevision(parentNode);
    if (ctx.onPostsChanged) ctx.onPostsChanged();
  }

  async function renderSubReplyBatch(postNode, ctx) {
    if (!postNode) return;
    const postNumber = Number(postNode.dataset.postNumber);
    const postId = String(postNode.dataset.postId || '');
    const btn = postNode.querySelector(':scope > .ldp-sub-actions .ldp-load-more-replies');
    if (!ctx.subReplyCache.has(postId) && ctx.repliesIO) {
      if (btn) { btn.disabled = true; btn.textContent = '加载回复中…'; }
      try { await ctx.repliesIO.loadForNode(postNode, { priority: 'target' }); }
      catch (e) {}
      finally { if (btn && btn.isConnected) btn.disabled = false; }
    }
    const state = ctx.subReplyState.get(postNumber);
    if (!state) return;
    state.renderedCount = Math.min(state.all.length, (Number(state.renderedCount) || 0) + SUB_REPLY_PAGE_SIZE);
    renderSubReplyState(postNumber, ctx);
  }

  /* ============ 10. 事件委托 ============ */
  function bindActions(modal, ctx) {
    bindHoverLikeReaction(
      modal,
      '.ldp-like',
      (btn) => btn.closest('.ldp-post')?.dataset.postId,
      ctx,
      modal,
    );
    if (ctx.scrollRoot) {
      ctx.scrollRoot.addEventListener('scroll', () => {
        if (hoverReactionOpenTimer || document.querySelector('.ldp-emoji-panel, .ldp-reaction-hover-bar')) {
          closeEmojiPanels();
        }
      }, { passive: true });
    }
    // 先于站点和浏览器默认链接行为接管 Discourse 图片、黑色信息条和右下角放大控件。
    modal.addEventListener('click', (e) => {
      interceptImagePreviewClick(e, modal);
    }, true);

    modal.addEventListener('click', async (e) => {
      const spoiler = e.target.closest('.ldp-spoiler');
      if (spoiler && spoiler.classList.contains('ldp-spoiler-blurred')) {
        e.preventDefault();
        e.stopPropagation();
        setSpoilerState(spoiler, false);
        return;
      }
      if (spoiler && spoiler.classList.contains('ldp-spoiler-expanded')
          && !e.target.closest('a, button, input, video, img')) {
        e.preventDefault();
        e.stopPropagation();
        setSpoilerState(spoiler, true);
        return;
      }

      const videoPlaceholder = e.target.closest('.video-placeholder-container[data-video-src]');
      if (videoPlaceholder && !videoPlaceholder.querySelector('video')) {
        e.preventDefault();
        e.stopPropagation();
        if (ctx.withViewportAnchor) ctx.withViewportAnchor(() => activateVideoPlaceholder(videoPlaceholder));
        else activateVideoPlaceholder(videoPlaceholder);
        return;
      }

      // 图片本体及其文件名/尺寸/右下角放大控件统一使用脚本灯箱，避免跳转到 CDN 原图页
      if (interceptImagePreviewClick(e, modal)) return;

      const avatarBtn = e.target.closest('.ldp-avatar-btn');
      if (avatarBtn) {
        e.preventDefault();
        e.stopPropagation();
        openUserCardV2(avatarBtn.dataset.username, avatarBtn);
        return;
      }

      const userCardTrigger = e.target.closest('.ldp-user-link, .ldp-boost-avatar-link, .ldp-b-avatar');
      if (userCardTrigger && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
        const uname = userCardTrigger.dataset.username;
        if (uname) {
          e.preventDefault();
          e.stopPropagation();
          openUserCardV2(uname, userCardTrigger);
          return;
        }
      }

      // 允许内容区 <a target="_blank"> 正常跳转
      const anchor = e.target.closest('a');
      if (anchor && anchor.target === '_blank') return;

      const pollControl = e.target.closest('.ldp-poll-option, .ldp-poll-submit, .ldp-poll-remove');
      if (pollControl) {
        e.preventDefault();
        e.stopPropagation();
        if (pollControl.disabled || pollControl.closest('.ldp-poll')?.hasAttribute('data-loading')) return;
        await handlePollControl(pollControl, ctx, modal);
        return;
      }
      const embeddedJump = e.target.closest('.ldp-embedded-jump');
      if (embeddedJump && ctx.virtualFlow) {
        e.preventDefault();
        await ctx.virtualFlow.seekToPost(Number(embeddedJump.dataset.postNumber));
        return;
      }

      const threadToggle = e.target.closest('.ldp-thread-toggle');
      if (threadToggle) {
        const summary = threadToggle.closest('.ldp-reply-summary');
        const expanded = summary.classList.toggle('expanded');
        threadToggle.textContent = `${threadToggle.textContent.split('·')[0].trim()} · ${expanded ? '收起' : '展开'}`;
        return;
      }

      // 楼中楼“展示更多回复”按钮
      const moreBtn = e.target.closest('.ldp-load-more-replies');
      if (moreBtn) {
        const post = moreBtn.closest('.ldp-post');
        await renderSubReplyBatch(post, ctx);
        return;
      }

      const postNode = e.target.closest('.ldp-post');
      if (!postNode) return;
      const postId = postNode.dataset.postId, postNumber = +postNode.dataset.postNumber;

      const syncCopies = (selector, update) => {
        modal.querySelectorAll(`.ldp-post[data-post-id="${CSS.escape(String(postId))}"] ${selector}`)
          .forEach(update);
      };

      const likeBtn = e.target.closest('.ldp-like');
      if (likeBtn && !likeBtn.disabled) {
        closeEmojiPanels();
        likeBtn.disabled = true;
        try {
          await performDefaultHeartLike(postId, ctx, modal);
        } catch (err) {
          alert('操作失败：' + err.message);
        } finally {
          if (likeBtn.isConnected) {
            const currentPost = ctx.loader && ctx.loader.getPostById(postId);
            likeBtn.disabled = currentPost ? !getPostLikeView(currentPost).canInteract : false;
          }
        }
        return;
      }

      const bookmarkBtn = e.target.closest('.ldp-post-bookmark');
      if (bookmarkBtn && !bookmarkBtn.disabled) {
        bookmarkBtn.disabled = true;
        const bookmarkId = bookmarkBtn.dataset.bookmarkId;
        try {
          let nextId = '';
          if (!bookmarkBtn.classList.contains('bookmarked')) {
            const data = await apiSend(`${BASE}/bookmarks`, 'POST', {
              bookmarkable_id: postId, bookmarkable_type: 'Post',
            });
            nextId = String((data && data.id) || '');
          } else if (bookmarkId) {
            await apiSend(`${BASE}/bookmarks/${bookmarkId}`, 'DELETE');
          }
          syncCopies('.ldp-post-bookmark', (button) => {
            button.classList.toggle('bookmarked', !!nextId);
            button.dataset.bookmarkId = nextId;
          });
          if (ctx.loader) ctx.loader.updatePost(postId, {
            bookmarked: !!nextId, bookmark_id: nextId || null,
          });
          invalidateCollectionCache('bookmarks').catch(() => {});
          invalidateTopicSnapshot(ctx.topicId).catch(() => {});
        } catch (err) { alert('楼层收藏操作失败：' + err.message); }
        finally { syncCopies('.ldp-post-bookmark', (button) => { button.disabled = false; }); }
        return;
      }


      const replyBtn = e.target.closest('.ldp-replybtn');
      if (replyBtn) {
        const box = ensureReplyBox(postNode, ctx.topic);
        box.classList.toggle('open');
        if (box.classList.contains('open')) {
          if (typeof box._syncReplyCounter === 'function') box._syncReplyCounter(ctx.topic);
          box.querySelector('textarea').focus();
        }
        return;
      }

      // Boost按钮：展开/收起输入框
      const boostEmojiBtn = e.target.closest('.ldp-boost-emoji');
      if (boostEmojiBtn) {
        e.preventDefault();
        e.stopPropagation();
        const wrap = boostEmojiBtn.closest('.ldp-boost-input-wrap');
        const input = wrap && wrap.querySelector('.ldp-boost-input');
        if (input) toggleEmojiPanel(boostEmojiBtn, input);
        return;
      }

      // Boost按钮：展开/收起输入框
      const boostBtn = e.target.closest('.ldp-boost-btn');
      if (boostBtn && !boostBtn.disabled) {
        const wrap = postNode.querySelector(':scope > .ldp-boost-input-wrap');
        if (!wrap) return;
        const opening = !wrap.classList.contains('open');
        wrap.classList.toggle('open', opening);
        if (opening) wrap.querySelector('.ldp-boost-input').focus();
        return;
      }

      // 删除自己的回复楼层
      const deleteBtn = e.target.closest('.ldp-deletebtn');
      if (deleteBtn && !deleteBtn.disabled) {
        deleteBtn.disabled = true;
        try {
          await apiSend(`${BASE}/posts/${postId}`, 'DELETE', {
            context: `/t/topic/${ctx.topicId}/${postNumber}`,
          });
          markPostDeleted(postId, modal, ctx);
          invalidateTopicSnapshot(ctx.topicId).catch(() => {});
        } catch (err) {
          alert('删除失败：' + err.message);
          if (deleteBtn.isConnected) deleteBtn.disabled = false;
        }
        return;
      }

      // 🚀 取消发射
      const boostCancel = e.target.closest('.ldp-boost-cancel');
      if (boostCancel) {
        const wrap = boostCancel.closest('.ldp-boost-input-wrap');
        if (wrap) {
          wrap.classList.remove('open');
          const bInput = wrap.querySelector('.ldp-boost-input');
          if (bInput) {
            bInput.value = '';
            bInput.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
        return;
      }

      // 🚀 确认发射
      const boostSubmit = e.target.closest('.ldp-boost-submit');
      if (boostSubmit && !boostSubmit.disabled) {
        const wrap = boostSubmit.closest('.ldp-boost-input-wrap');
        const input = wrap && wrap.querySelector('.ldp-boost-input');
        const raw = input ? input.value.trim() : '';
        const limits = getBoostCharLimits();
        const charCount = countInputChars(raw);
        if (charCount < limits.min) { input && input.focus(); return; }
        if (charCount > limits.max) { alert(`Boost内容不能超过${limits.max}个字符`); return; }
        boostSubmit.disabled = true;
        try {
          const res = await apiSend(`${BASE}/discourse-boosts/posts/${postId}/boosts`, 'POST', { raw });
          if (res && res.id) {
            const listEl = postNode.querySelector(':scope > .ldp-boosts-list');
            if (listEl) {
              const bAvatar = res.user && resolveAvatar(res.user.avatar_template, 36);
              const bUsername = (res.user && res.user.username) || '';
              const bName = (res.user && (res.user.name || res.user.display_name)) || bUsername;
              const bProfileUrl = bUsername ? userProfileUrl(bUsername) : '';
              const newBubble = document.createElement('div');
              newBubble.className = 'ldp-boost-bubble ldp-flash';
              newBubble.dataset.boostId = res.id;
              newBubble.innerHTML =
                (bAvatar ? (bProfileUrl
                  ? `<a class="ldp-boost-avatar-link" href="${escAttr(bProfileUrl)}" target="_blank" rel="noopener noreferrer" title="${escAttr(bName || '@' + bUsername)}" data-username="${escAttr(bUsername)}"><img class="ldp-b-avatar" src="${escAttr(bAvatar)}" alt="" data-username="${escAttr(bUsername)}"></a>`
                  : `<img class="ldp-b-avatar" src="${escAttr(bAvatar)}" alt="">`) : '') +
                `<p>${res.cooked || ''}</p>` +
                `<button class="ldp-boost-del" title="删除此Boost">×</button>`;
              listEl.appendChild(newBubble);
            }
            input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            wrap.classList.remove('open');

            const btn = postNode.querySelector(':scope > .ldp-actions > .ldp-boost-btn');
            if (btn) btn.disabled = true;
            if (postNumber === 1) {
              const fBoost = modal.closest('.ldp-modal')?.querySelector('.ldp-f-boost');
              if (fBoost) fBoost.disabled = true;
            }
            if (ctx.loader) {
              ctx.loader.updatePost(postId, (current) => {
                const boosts = Array.isArray(current.boosts) ? current.boosts.slice() : [];
                boosts.push(Object.assign({ can_delete: true }, res));
                current.boosts = boosts;
                current.can_boost = false;
                return current;
              });
              if (ctx.refreshRenderRevision) ctx.refreshRenderRevision(postNode);
            }
            invalidateTopicSnapshot(ctx.topicId).catch(() => {});
          }
        } catch (err) { alert('发射失败：' + err.message); }
        finally { boostSubmit.disabled = false; }
        return;
      }

      // 删除 Boost 气泡
      const boostDel = e.target.closest('.ldp-boost-del');
      if (boostDel) {
        const bubble = boostDel.closest('.ldp-boost-bubble');
        const boostId = bubble && bubble.dataset.boostId;
        if (!boostId) return;
        try {
          await apiSend(`${BASE}/discourse-boosts/boosts/${boostId}`, 'DELETE');
          bubble.remove();

          const btn = postNode.querySelector(':scope > .ldp-actions > .ldp-boost-btn');
          if (btn) btn.disabled = false;
          if (postNumber === 1) {
            const fBoost = modal.closest('.ldp-modal')?.querySelector('.ldp-f-boost');
            if (fBoost) fBoost.disabled = false;
          }
          if (ctx.loader) {
            ctx.loader.updatePost(postId, (current) => {
              current.boosts = (current.boosts || []).filter((item) => String(item.id) !== String(boostId));
              current.can_boost = true;
              return current;
            });
            if (ctx.refreshRenderRevision) ctx.refreshRenderRevision(postNode);
          }
          invalidateTopicSnapshot(ctx.topicId).catch(() => {});
        } catch (err) { alert('删除失败：' + err.message); }
        return;
      }

      // 发送回复
      const sendBtn = e.target.closest('.ldp-send');
      if (sendBtn) {
        const box = sendBtn.closest('.ldp-replybox'),
            textarea = box.querySelector('textarea'),
            raw = textarea.value.trim();
        if (!raw) return;

        sendBtn.disabled = true;
        sendBtn.textContent = '发送中…';

        try {
          const data = await apiSend(`${BASE}/posts`, 'POST', {
            raw,
            topic_id: ctx.topicId,
            reply_to_post_number: postNumber,
            nested_post: true,
          });

          // 拿到回复数据
          const postData = data && data.post ? data.post : data;

          if (postData && postData.cooked) {
            if (ctx.loader) {
              if (!postData.reply_to_post_number) postData.reply_to_post_number = postNumber;
              postData._ldpSkipUnread = true;
              const canonicalReply = ctx.loader.mergePost(postData) || postData;
              if (postNumber > 1) {
                const parentPost = ctx.loader.getPostByNumber(postNumber);
                if (parentPost) {
                  ctx.loader.updatePost(parentPost.id, {
                    reply_count: Math.max(0, Number(parentPost.reply_count) || 0) + 1,
                  });
                  const cacheKey = String(parentPost.id);
                  if (ctx.subReplyCache.has(cacheKey)) {
                    const replies = [...(ctx.subReplyCache.get(cacheKey) || []), canonicalReply];
                    ctx.subReplyCache.set(cacheKey, replies);
                  }
                }
                const state = mergeSubReplyState(postNumber, [canonicalReply, ...ctx.loader.getKnownChildren(postNumber)], ctx, canonicalReply.id);
                state.renderedCount = Math.max(state.renderedCount, state.all.length);
                renderSubReplyState(postNumber, ctx);
              }
              ctx.highlightPostId = Number(canonicalReply.id) || 0;
              ctx.highlightUntil = Date.now() + 1700;
              ctx.totalComments = (ctx.totalComments || 0) + 1;
              updateCommentsHeader(ctx);
              invalidateTopicSnapshot(ctx.topicId).catch(() => {});
              if (ctx.onMutation) ctx.onMutation(postData);
              box.classList.remove('open');
              textarea.value = '';
              textarea.dispatchEvent(new Event('input', { bubbles: true }));
              if (postNumber === 1 && ctx.virtualFlow) {
                ctx.virtualFlow.seekToPost(Number(canonicalReply.post_number)).catch(() => {});
              }
              return;
            }
            const isTopLevel = postNumber === 1; // 回复楼主帖时按普通顶级评论处理，而非楼中楼
            const newNode = renderPost({
              id: postData.id,
              post_number: postData.post_number,
              username: postData.username || ME_USERNAME,
              name: postData.name,
              avatar_template: postData.avatar_template,
              cooked: postData.cooked,
              created_at: postData.created_at || new Date().toISOString(),
              reply_to_post_number: postNumber,
              actions_summary: [],
              boosts: [],
              can_boost: true,
              _ldpSkipUnread: true,
            }, !isTopLevel, ctx);

            newNode.classList.add('ldp-flash');

            if (isTopLevel) {
              ctx.commentsEl.prepend(newNode);
              newNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else {
              const childrenContainer = postNode.querySelector(':scope > .ldp-children');
              childrenContainer.prepend(newNode);
            }

            ctx.nodeMap.set(postData.post_number, newNode);
            ctx.tracker.observe(newNode);
            ctx.totalComments = (ctx.totalComments || 0) + 1;
            updateCommentsHeader(ctx);
            if (ctx.onPostsChanged) ctx.onPostsChanged();
            invalidateTopicSnapshot(ctx.topicId).catch(() => {});
            if (ctx.onMutation) ctx.onMutation(postData);

            const tip = box.querySelector('.ldp-reply-tip');
            if (tip) {
              tip.classList.add('show');
              setTimeout(() => tip.classList.remove('show'), 1500);
            }

            box.classList.remove('open');
            textarea.value = '';
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } catch (err) {
          alert('回复失败：' + err.message);
        } finally {
          sendBtn.disabled = false;
          sendBtn.textContent = '发送';
        }
        return;
      }
    });

    modal.addEventListener('keydown', (e) => {
      const spoiler = e.target.closest('.ldp-spoiler');
      if (!spoiler || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      spoiler.click();
    });
  }

  /* ============ 11. 楼中楼自动补全（视口懒加载 + 祖先链展开） ============ */
  function createRepliesIO(ctx) {
    const fetched = new Set();
    const inFlight = new Map();
    const hoverTimers = new Map();
    const pendingReplies = new Map();
    const appliedReplyParents = new Set();
    let scrollActive = false;

    const applyReplies = (node, replies, targetPostId, render) => {
      if (!node || !node.isConnected) return null;
      const postId = Number(node.dataset.postId);
      const postNumber = Number(node.dataset.postNumber);
      const existingState = ctx.subReplyState.get(postNumber);
      const canonicalReplies = (replies || [])
        .filter((reply) => reply && Number(reply.reply_to_post_number) === postNumber)
        .map((reply) => ctx.loader.mergePost(reply) || reply);
      const knownReplies = ctx.loader.getKnownChildren(postNumber);
      const merged = [...knownReplies, ...canonicalReplies];
      if (replies) ctx.subReplyCache.set(String(postId), canonicalReplies);
      const state = mergeSubReplyState(postNumber, merged, ctx, targetPostId);
      appliedReplyParents.add(String(postId));
      if (!state.renderedCount) state.renderedCount = Math.min(SUB_REPLY_INITIAL_SIZE, state.all.length);
      const parent = ctx.loader.getPostById(postId);
      if (parent && state.all.length > Number(parent.reply_count || 0)) {
        ctx.loader.updatePost(postId, { reply_count: state.all.length });
      }
      const needsRender = canonicalReplies.length > 0 || !existingState || !!targetPostId;
      if (render !== false && needsRender) {
        renderSubReplyState(postNumber, ctx);
      }
      return state;
    };

    const commitOrQueue = (node, replies, targetPostId, immediate) => {
      if (!node || !node.isConnected) return null;
      const postId = String(node.dataset.postId || '');
      if (!postId) return null;
      ctx.subReplyCache.set(postId, replies || []);
      if (scrollActive && !immediate) {
        pendingReplies.set(postId, {
          postId, postNumber: Number(node.dataset.postNumber), replies: replies || [], targetPostId,
        });
        return null;
      }
      pendingReplies.delete(postId);
      return applyReplies(node, replies, targetPostId);
    };

    const flushPendingReplies = () => {
      if (scrollActive || !pendingReplies.size) return 0;
      const batch = Array.from(pendingReplies.values());
      pendingReplies.clear();
      const renderedParents = [];
      const mutate = () => {
        batch.forEach((entry) => {
          const node = ctx.nodeMap.get(Number(entry.postNumber));
          if (!node || !node.isConnected || String(node.dataset.postId) !== entry.postId) return;
          const needsLayout = entry.replies.length > 0
            || !ctx.subReplyState.has(Number(entry.postNumber)) || !!entry.targetPostId;
          if (applyReplies(node, entry.replies, entry.targetPostId, false) && needsLayout) {
            renderedParents.push(entry.postNumber);
          }
        });
        renderedParents.forEach((postNumber) => {
          const parent = ctx.nodeMap.get(Number(postNumber));
          if (parent && parent.isConnected) {
            renderSubReplyStateInto(parent, postNumber, ctx, 1, new Set([Number(parent.dataset.postId)]));
            if (ctx.refreshRenderRevision) ctx.refreshRenderRevision(parent);
          }
        });
      };
      if (ctx.withViewportAnchor) ctx.withViewportAnchor(mutate); else mutate();
      if (renderedParents.length && ctx.onPostsChanged) ctx.onPostsChanged();
      return renderedParents.length;
    };

    const loadForNode = async (node, options) => {
      if (!node || !node.isConnected) return [];
      const postId = String(node.dataset.postId || '');
      const targetPostId = options && options.targetPostId;
      const immediate = !!(options && options.priority === 'target');
      if (!postId) return [];
      if (ctx.subReplyCache.has(postId)) {
        const cached = ctx.subReplyCache.get(postId) || [];
        if (appliedReplyParents.has(postId) && !targetPostId) return cached;
        commitOrQueue(node, cached, targetPostId, immediate);
        return cached;
      }
      if (inFlight.has(postId)) {
        const replies = await inFlight.get(postId);
        commitOrQueue(node, replies, targetPostId, immediate);
        return replies;
      }
      const loadingEl = node.querySelector(':scope > .ldp-sub-loading');
      if (loadingEl && immediate) {
        const showLoading = () => { loadingEl.style.display = 'block'; };
        if (ctx.withViewportAnchor) ctx.withViewportAnchor(showLoading); else showLoading();
      }
      const request = fetchJSON(`${BASE}/posts/${postId}/replies.json`, {
        signal: ctx.signal,
        priority: immediate ? 'target' : 'visible',
        dedupeKey: `direct-replies:${BASE}:${postId}`,
      }).then((items) => Array.isArray(items) ? items : []);
      inFlight.set(postId, request);
      try {
        const replies = await request;
        fetched.add(postId);
        ctx.subReplyCache.set(postId, replies);
        if (node.isConnected) commitOrQueue(node, replies, targetPostId, immediate);
        return replies;
      } finally {
        inFlight.delete(postId);
        if (loadingEl && loadingEl.isConnected) {
          const hideLoading = () => { loadingEl.style.display = 'none'; };
          if (ctx.withViewportAnchor) ctx.withViewportAnchor(hideLoading); else hideLoading();
        }
      }
    };

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        const postId = String(en.target.dataset.postId || '');
        if (!postId) return;
        if (en.isIntersecting) {
          if (ctx.subReplyCache.has(postId)) {
            commitOrQueue(en.target, ctx.subReplyCache.get(postId), null, false);
            return;
          }
          if (fetched.has(postId) || hoverTimers.has(postId)) return;
          const timer = setTimeout(() => {
            hoverTimers.delete(postId);
            if (!en.target.isConnected) return;
            loadForNode(en.target).catch(() => { fetched.delete(postId); });
          }, REPLIES_HOVER_DELAY);
          hoverTimers.set(postId, timer);
        } else if (hoverTimers.has(postId)) {
          clearTimeout(hoverTimers.get(postId));
          hoverTimers.delete(postId);
        }
      });
    }, { root: ctx.scrollRoot, rootMargin: '220px', threshold: 0.05 });

    const clearNode = (node) => {
      if (!node) return;
      observer.unobserve(node);
      const postId = node.dataset.postId;
      if (postId && hoverTimers.has(postId)) {
        clearTimeout(hoverTimers.get(postId));
        hoverTimers.delete(postId);
      }
    };
    const nativeDisconnect = observer.disconnect.bind(observer);
    return {
      observe(node) { if (node) observer.observe(node); },
      unobserve(node) { if (node) observer.unobserve(node); },
      clearNode,
      loadForNode,
      setScrollActive(active) { scrollActive = !!active; },
      flushPendingReplies,
      revealPath(path) {
        const posts = (path || []).filter(Boolean);
        if (posts.length < 2) return null;
        const mutate = () => {
          for (let index = 0; index < posts.length - 1; index++) {
            const parent = posts[index], child = posts[index + 1];
            const parentNode = ctx.nodeMap.get(Number(parent.post_number));
            mergeSubReplyState(parent.post_number, [child, ...ctx.loader.getKnownChildren(parent.post_number)], ctx, child.id);
            const state = ctx.subReplyState.get(Number(parent.post_number));
            if (state && !state.renderedCount) state.renderedCount = Math.min(SUB_REPLY_INITIAL_SIZE, state.all.length);
            if (parentNode) {
              renderSubReplyStateInto(
                parentNode,
                parent.post_number,
                ctx,
                index + 1,
                new Set(posts.slice(0, index + 1).map((post) => Number(post.id))),
              );
            }
          }
        };
        if (ctx.withViewportAnchor) ctx.withViewportAnchor(mutate); else mutate();
        posts.slice(0, -1).forEach((post) => {
          const node = ctx.nodeMap.get(Number(post.post_number));
          if (node && Number(post.reply_count) > 0) {
            loadForNode(node, { priority: 'target', targetPostId: posts[posts.length - 1].id }).catch(() => {});
          }
        });
        return ctx.nodeMap.get(Number(posts[posts.length - 1].post_number)) || null;
      },
      disconnect() {
        hoverTimers.forEach((timer) => clearTimeout(timer));
        hoverTimers.clear();
        pendingReplies.clear();
        appliedReplyParents.clear();
        inFlight.clear();
        nativeDisconnect();
      },
    };
  }

  /* ============ 12. 收藏 ============ */
  function bindBookmarks(buttons, topic) {
    const targets = Array.from(buttons || []).filter(Boolean);
    let bookmarked = !!topic.bookmarked, bookmarkId = topic.bookmark_id || null;
    const sync = () => {
      targets.forEach((button) => {
        button.classList.toggle('bookmarked', bookmarked);
        button.setAttribute('aria-pressed', bookmarked ? 'true' : 'false');
      });
    };
    sync();
    const toggle = async () => {
      targets.forEach((button) => { button.disabled = true; });
      try {
        if (!bookmarked) {
          const data = await apiSend(`${BASE}/bookmarks`, 'POST', { bookmarkable_id: topic.id, bookmarkable_type: 'Topic' });
          bookmarkId = data && data.id ? data.id : bookmarkId; bookmarked = true;
        } else if (bookmarkId) {
          await apiSend(`${BASE}/bookmarks/${bookmarkId}`, 'DELETE'); bookmarked = false; bookmarkId = null;
        } else { await apiSend(`${BASE}/t/${topic.id}/remove_bookmarks`, 'PUT'); bookmarked = false; }
        topic.bookmarked = bookmarked; topic.bookmark_id = bookmarkId;
        sync();
        invalidateCollectionCache('bookmarks').catch(() => {});
        invalidateTopicSnapshot(topic.id).catch(() => {});
      } catch (err) { alert('收藏操作失败：' + err.message); }
      finally { targets.forEach((button) => { button.disabled = false; }); }
    };
    targets.forEach((button) => button.addEventListener('click', toggle));
  }

  function bindReaderFooter(footer, ctx, topic, opNode) {
    if (!footer || !opNode || !topic._opPost) return;
    const likeButton = footer.querySelector('.ldp-f-like');
    const likeIconSlot = footer.querySelector('.ldp-f-like-icon');
    const likeCount = footer.querySelector('.ldp-f-like-count');
    const replyCount = footer.querySelector('.ldp-f-reply-count');
    const replyButton = footer.querySelector('.ldp-f-reply');
    const boostButton = footer.querySelector('.ldp-f-boost');
    const opId = Number(topic._opPost.id);
    const shellEl = opNode.closest('.ldp-shell') || opNode.parentElement;
    ctx.footerReplyCountEl = replyCount;
    updateCommentsHeader(ctx);

    const syncOpFooterState = (post) => {
      if (!post || Number(post.id) !== opId) return;
      const likeView = getPostLikeView(post);
      likeCount.textContent = String(likeView.count);
      likeButton.classList.toggle('liked', likeView.acted);
      likeButton.dataset.acted = likeView.acted ? '1' : '0';
      likeButton.dataset.currentReaction = likeView.currentReaction;
      likeButton.disabled = !likeView.canInteract;
      if (likeIconSlot) {
        likeIconSlot.innerHTML = likeView.isCustomReaction
          ? reactionIconHtml(likeView.currentReaction)
          : `<svg viewBox="0 0 24 24">${ICONS.like}</svg>`;
      }
    };
    syncOpFooterState(ctx.loader.getPostById(opId) || topic._opPost);
    ctx.loader.subscribePosts((posts) => posts.forEach(syncOpFooterState));
    bindHoverLikeReaction(footer, '.ldp-f-like', () => opId, ctx, shellEl);

    likeButton.addEventListener('click', async () => {
      if (likeButton.disabled) return;
      closeEmojiPanels();
      likeButton.disabled = true;
      try {
        await performDefaultHeartLike(opId, ctx, shellEl);
      } catch (error) {
        syncOpFooterState(ctx.loader.getPostById(opId) || topic._opPost);
        alert('操作失败：' + error.message);
      }
    });
    replyButton.addEventListener('click', () => {
      const box = ensureReplyBox(opNode, ctx.topic || topic);
      box.classList.toggle('open');
      if (box.classList.contains('open')) {
        box.querySelector('textarea').focus({ preventScroll: true });
        box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
    const inlineBoost = opNode.querySelector(':scope > .ldp-actions .ldp-boost-btn');
    boostButton.disabled = !inlineBoost || inlineBoost.disabled;
    boostButton.addEventListener('click', () => {
      const wrap = opNode.querySelector(':scope > .ldp-boost-input-wrap');
      if (!wrap) return;
      const opening = !wrap.classList.contains('open');
      wrap.classList.toggle('open', opening);
      if (opening) {
        wrap.querySelector('.ldp-boost-input').focus({ preventScroll: true });
        wrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
  }

  function updateCommentsHeader(ctx) {
    if (ctx.countEl) ctx.countEl.textContent = ctx.totalComments ? `（${ctx.totalComments}）` : '';
    if (ctx.emptyEl) ctx.emptyEl.style.display = ctx.totalComments ? 'none' : '';
    if (ctx.footerReplyCountEl) ctx.footerReplyCountEl.textContent = ctx.totalComments || 0;
  }

  function bindTimeline(modal, ctx, topic, controls) {
    const rail = modal.querySelector('.ldp-timeline');
    if (!rail) return { refresh() {}, destroy() {} };

    const body = ctx.scrollRoot;
    const topDateBtn = rail.querySelector('.ldp-tl-top-date');
    const bottomDateBtn = rail.querySelector('.ldp-tl-bottom-date');
    const currentText = rail.querySelector('.ldp-tl-current-post');
    const currentDate = rail.querySelector('.ldp-tl-current-date');
    const track = rail.querySelector('.ldp-tl-track');
    const fill = rail.querySelector('.ldp-tl-fill');
    const thumb = rail.querySelector('.ldp-tl-thumb');
    const getTotalPosts = () => Math.max(1, controls.getTotalPosts ? controls.getTotalPosts()
      : (topic.highest_post_number || topic.posts_count || ctx.totalComments + 1));
    const getStreamLength = () => Math.max(0, controls.getStreamLength());
    let raf = 0;
    let seeking = false;
    let cachedPosts = [];
    let currentPost = null;
    let trackHeight = Math.max(1, track.clientHeight - 16);
    let lastRatio = -1;
    let lastPercent = -1;
    let lastPostNumber = -1;
    let lastTotalPosts = -1;
    let lastDate = null;
    let lastSeeking = null;
    let seekToken = 0;
    let destroyed = false;

    topDateBtn.textContent = fmtDate(topic.created_at) || '顶部';
    bottomDateBtn.textContent = fmtDate(topic.last_posted_at || topic.bumped_at) || '底部';
    track.setAttribute('aria-valuemin', '1');
    track.setAttribute('aria-valuemax', String(getTotalPosts()));

    const computeScrollProgress = () => {
      const totalPosts = getTotalPosts();
      const streamLength = getStreamLength();
      if (!cachedPosts.length) {
        return { post: null, postNumber: 1, ratio: 0, totalPosts, atBottom: false };
      }
      const topSpacer = body.querySelector('.ldp-virtual-spacer-top');
      const bottomSpacer = body.querySelector('.ldp-virtual-spacer-bottom');
      const topSpacerHeight = topSpacer ? topSpacer.offsetHeight : 0;
      const bottomSpacerHeight = bottomSpacer ? bottomSpacer.offsetHeight : 0;
      const windowNode = body.querySelector('.ldp-virtual-window');
      const commentsReady = streamLength === 0 || !!(windowNode && windowNode.children.length > 0);
      const maxScroll = Math.max(0, body.scrollHeight - body.clientHeight);

      // 无滚动条场景（一页内已完整展示全部楼层）：进度条直接满格并显示末尾总楼层
      if (commentsReady && topSpacerHeight <= 4 && bottomSpacerHeight <= 4 && maxScroll <= 2) {
        currentPost = cachedPosts[cachedPosts.length - 1];
        return { post: currentPost, postNumber: totalPosts, ratio: 1, totalPosts, atBottom: true };
      }

      // 有滚动条且已滚动到真实底部
      if (commentsReady && bottomSpacerHeight <= 4 && maxScroll > 2 && (maxScroll - body.scrollTop <= 6)) {
        currentPost = cachedPosts[cachedPosts.length - 1];
        return { post: currentPost, postNumber: totalPosts, ratio: 1, totalPosts, atBottom: true };
      }

      // 有滚动条且位于顶部
      if (body.scrollTop <= 2) {
        currentPost = cachedPosts[0];
        return { post: currentPost, postNumber: 1, ratio: 0, totalPosts, atBottom: false };
      }

      const bodyRect = body.getBoundingClientRect();
      const baseOffset = Math.min(bodyRect.height * 0.28, 160);
      const tailRange = Math.min(maxScroll, Math.max(120, bodyRect.height * 0.9));
      const tailProgress = (bottomSpacerHeight <= 4 && maxScroll > 2 && tailRange > 0)
        ? Math.max(0, Math.min(1, (body.scrollTop - (maxScroll - tailRange)) / tailRange))
        : 0;
      const probeY = bodyRect.top + baseOffset + tailProgress * Math.max(0, bodyRect.height - baseOffset - 8);

      let matched = null;
      for (let i = 0; i < cachedPosts.length; i++) {
        const candidate = cachedPosts[i];
        if (!candidate.isConnected) continue;
        const rect = candidate.getBoundingClientRect();
        if (rect.height <= 0) continue;
        if (rect.top <= probeY + 2) matched = candidate;
        else if (!matched) { matched = candidate; break; }
      }
      if (matched) currentPost = matched;
      if (!currentPost || !currentPost.isConnected) {
        currentPost = cachedPosts[cachedPosts.length - 1];
      }

      let rootPost = currentPost;
      while (rootPost && rootPost.parentElement && rootPost.parentElement.classList.contains('ldp-children')) {
        const parentPost = rootPost.parentElement.closest('.ldp-post[data-post-number]');
        if (!parentPost) break;
        rootPost = parentPost;
      }

      let postNumber = currentPost ? (+currentPost.dataset.postNumber || 1) : 1;
      const rootNumber = rootPost ? (+rootPost.dataset.postNumber || 1) : postNumber;
      const streamIndex = rootNumber <= 1 ? -1 : controls.getStreamIndex(rootPost.dataset.postId);
      let baseRatio = 0;
      if (streamLength > 0) {
        if (streamIndex >= 0) {
          let intra = 0.5;
          if (rootPost) {
            const rRect = rootPost.getBoundingClientRect();
            if (rRect.height > 1) intra = Math.max(0, Math.min(1, (probeY - rRect.top) / rRect.height));
          }
          baseRatio = Math.max(0, Math.min(1, (streamIndex + intra) / streamLength));
        } else if (totalPosts > 1) {
          baseRatio = Math.max(0, Math.min(1, (postNumber - 1) / (totalPosts - 1)));
        }
      } else if (maxScroll > 2) {
        baseRatio = Math.max(0, Math.min(1, body.scrollTop / maxScroll));
      }
      const ratio = tailProgress > 0
        ? Math.max(baseRatio, baseRatio + (1 - baseRatio) * tailProgress)
        : baseRatio;
      if (tailProgress > 0.65 && totalPosts > postNumber) {
        const highestMounted = cachedPosts.reduce((m, n) => Math.max(m, +n.dataset.postNumber || 1), postNumber);
        if (tailProgress > 0.92) postNumber = Math.max(postNumber, highestMounted);
      }
      return { post: currentPost, postNumber: Math.min(totalPosts, postNumber), ratio, totalPosts, atBottom: false };
    };

    const setProgress = () => {
      const { post, postNumber, ratio, totalPosts, atBottom } = computeScrollProgress();
      track.setAttribute('aria-valuemax', String(totalPosts));
      if (atBottom && controls.onReachBottom) controls.onReachBottom();
      if (Math.abs(ratio - lastRatio) >= 0.0005) {
        fill.style.transform = `translateX(-50%) scaleY(${ratio})`;
        thumb.style.transform = `translate(-50%,-50%) translateY(${ratio * trackHeight}px)`;
        lastRatio = ratio;
      }
      const percent = Math.round(ratio * 100);
      if (percent !== lastPercent) {
        track.setAttribute('aria-valuenow', String(postNumber));
        lastPercent = percent;
      }

      if (postNumber !== lastPostNumber || totalPosts !== lastTotalPosts) {
        currentText.textContent = `${postNumber} / ${totalPosts}`;
        lastPostNumber = postNumber;
        lastTotalPosts = totalPosts;
      }
      const date = seeking ? '正在定位…' : (post ? (fmtDate(post.dataset.createdAt) || '当前') : '当前');
      if (date !== lastDate) {
        currentDate.textContent = date;
        lastDate = date;
      }
      if (seeking !== lastSeeking) {
        rail.setAttribute('aria-busy', seeking ? 'true' : 'false');
        track.setAttribute('aria-busy', seeking ? 'true' : 'false');
        lastSeeking = seeking;
      }
    };

    const schedule = () => {
      if (destroyed || raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setProgress();
      });
    };

    const seek = async (index, targetPostNumber) => {
      const token = ++seekToken;
      seeking = true;
      rail.classList.add('ldp-tl-loading');
      currentDate.textContent = '正在定位…';
      schedule();
      try {
        if (Number(targetPostNumber) <= 1 && controls.scrollToTop) await controls.scrollToTop();
        else await controls.seekToIndex(index, targetPostNumber);
      } catch (err) {
        if (!(err && err.name === 'AbortError')) throw err;
      } finally {
        if (token !== seekToken) return;
        seeking = false;
        rail.classList.remove('ldp-tl-loading');
        lastDate = null;
        schedule();
      }
    };

    const jumpTop = () => seek(0, 1);
    const jumpBottom = () => seek(Math.max(0, getStreamLength() - 1));
    const jumpByRatio = (ratio) => {
      const safeRatio = Math.max(0, Math.min(1, ratio));
      const streamLength = getStreamLength();
      if (!streamLength || safeRatio <= 0) return jumpTop();
      const index = Math.max(0, Math.min(streamLength - 1, Math.round(safeRatio * streamLength) - 1));
      return seek(index);
    };

    let dragTip = track.querySelector('.ldp-tl-drag-tip');
    if (!dragTip) {
      dragTip = document.createElement('span');
      dragTip.className = 'ldp-tl-drag-tip';
      track.appendChild(dragTip);
    }
    let dragging = false;
    let dragMoved = false;
    let dragStartY = 0;
    let dragRatio = 0;
    let suppressNextClick = false;

    const paintDrag = (ratio) => {
      const safeRatio = Math.max(0, Math.min(1, ratio));
      const totalPosts = getTotalPosts();
      const previewFloor = Math.max(1, Math.min(totalPosts, Math.round(1 + safeRatio * (totalPosts - 1))));
      const y = safeRatio * trackHeight;
      fill.style.transform = `translateX(-50%) scaleY(${safeRatio})`;
      thumb.style.transform = `translate(-50%,-50%) translateY(${y}px)`;
      dragTip.textContent = `#${previewFloor}`;
      dragTip.style.top = `${8 + y}px`;
      dragTip.classList.add('show');
      currentText.textContent = `${previewFloor} / ${totalPosts}`;
      lastPostNumber = -1;
      lastRatio = -1;
    };

    const onPointerMove = (e) => {
      if (!dragging) return;
      if (!dragMoved && Math.abs(e.clientY - dragStartY) < 3) return;
      dragMoved = true;
      e.preventDefault();
      const rect = track.getBoundingClientRect();
      dragRatio = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
      paintDrag(dragRatio);
    };

    const onPointerUp = () => {
      if (!dragging) return;
      dragging = false;
      thumb.classList.remove('dragging');
      dragTip.classList.remove('show');
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      if (dragMoved) {
        suppressNextClick = true;
        setTimeout(() => { suppressNextClick = false; }, 50);
        jumpByRatio(dragRatio);
      } else {
        schedule();
      }
    };

    const onThumbPointerDown = (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true;
      dragMoved = false;
      dragStartY = e.clientY;
      const rect = track.getBoundingClientRect();
      dragRatio = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
      thumb.classList.add('dragging');
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    };

    const onTrackClick = (e) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      const rect = track.getBoundingClientRect();
      jumpByRatio((e.clientY - rect.top) / Math.max(1, rect.height));
    };

    const onTrackKeydown = (e) => {
      if (e.key === 'Home') { e.preventDefault(); jumpTop(); }
      else if (e.key === 'End') { e.preventDefault(); jumpBottom(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); jumpByRatio((lastRatio < 0 ? 0 : lastRatio) - 1 / Math.max(1, getStreamLength())); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); jumpByRatio((lastRatio < 0 ? 0 : lastRatio) + 1 / Math.max(1, getStreamLength())); }
      else if (e.key === 'PageUp') { e.preventDefault(); body.scrollBy({ top: -body.clientHeight * 0.8, behavior: 'smooth' }); }
      else if (e.key === 'PageDown') { e.preventDefault(); body.scrollBy({ top: body.clientHeight * 0.8, behavior: 'smooth' }); }
    };

    const refresh = () => {
      cachedPosts = Array.from(body.querySelectorAll('.ldp-post[data-post-number]'))
        .sort((a, b) => (+a.dataset.postNumber || 0) - (+b.dataset.postNumber || 0));
      if (!currentPost || !currentPost.isConnected) currentPost = cachedPosts[0] || null;
      if (!dragging) schedule();
    };

    const resizeObserver = new ResizeObserver(() => {
      trackHeight = Math.max(1, track.clientHeight - 16);
      lastRatio = -1;
      if (!dragging) schedule();
    });

    topDateBtn.addEventListener('click', jumpTop);
    bottomDateBtn.addEventListener('click', jumpBottom);
    thumb.addEventListener('pointerdown', onThumbPointerDown);
    track.addEventListener('click', onTrackClick);
    track.addEventListener('keydown', onTrackKeydown);
    body.addEventListener('scroll', schedule, { passive: true });
    resizeObserver.observe(track);
    resizeObserver.observe(body);
    resizeObserver.observe(ctx.topicEl);
    resizeObserver.observe(ctx.commentsEl);
    refresh();

    return {
      refresh,
      destroy() {
        destroyed = true;
        dragging = false;
        cancelAnimationFrame(raf);
        resizeObserver.disconnect();
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        topDateBtn.removeEventListener('click', jumpTop);
        bottomDateBtn.removeEventListener('click', jumpBottom);
        thumb.removeEventListener('pointerdown', onThumbPointerDown);
        track.removeEventListener('click', onTrackClick);
        track.removeEventListener('keydown', onTrackKeydown);
        body.removeEventListener('scroll', schedule);
      },
    };
  }

  /* 骨架屏 HTML */
  const SKELETON_HTML = `
    <div class="ldp-sk-head">
      <div class="ldp-sk ldp-sk-avatar"></div>
      <div class="ldp-sk ldp-sk-line ldp-sk-w40"></div>
    </div>
    <div class="ldp-sk-para">
      <div class="ldp-sk ldp-sk-line ldp-sk-w100"></div>
      <div class="ldp-sk ldp-sk-line ldp-sk-w90"></div>
      <div class="ldp-sk ldp-sk-line ldp-sk-w80"></div>
      <div class="ldp-sk ldp-sk-line ldp-sk-w60"></div>
    </div>
    <div class="ldp-sk-divider"></div>
    <div class="ldp-sk-comment">
      <div class="ldp-sk ldp-sk-avatar"></div>
      <div class="ldp-sk-cbody ldp-sk-para">
        <div class="ldp-sk ldp-sk-line ldp-sk-w30"></div>
        <div class="ldp-sk ldp-sk-line ldp-sk-w90"></div>
        <div class="ldp-sk ldp-sk-line ldp-sk-w60"></div>
      </div>
    </div>`;

  function waitForScrollEnd(el, timeoutMs) {
    const limit = timeoutMs || 1200;
    return new Promise((resolve) => {
      let lastTop = el.scrollTop;
      let stableSince = Date.now();
      const started = Date.now();
      const check = () => {
        const current = el.scrollTop;
        if (Math.abs(current - lastTop) < 1) {
          if (Date.now() - stableSince >= 120 || Date.now() - started >= limit) {
            resolve();
            return;
          }
        } else {
          lastTop = current;
          stableSince = Date.now();
        }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  }

  async function locatePost(targetPostNumber, ctx, options) {
    const behavior = options && options.behavior === 'smooth' ? 'smooth' : 'auto';
    if (!targetPostNumber || targetPostNumber <= 1) {
      if (behavior === 'smooth') {
        ctx.scrollRoot.scrollTo({ top: 0, behavior });
        await waitForScrollEnd(ctx.scrollRoot);
      } else {
        ctx.scrollRoot.scrollTop = 0;
      }
      return true;
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const node = ctx.nodeMap.get(Number(targetPostNumber));
    if (!node) return false;
    node.scrollIntoView({ behavior, block: 'center' });
    if (behavior === 'smooth') await waitForScrollEnd(ctx.scrollRoot);
    node.classList.remove('ldp-flash');
    void node.offsetWidth;
    node.classList.add('ldp-flash');
    setTimeout(() => node.classList.remove('ldp-flash'), 1700);
    return true;
  }

  /* ============ 13. 2.0 加载器与虚拟楼层流 ============ */
  function createLoaderV2(topicId, signal) {
    let topic = null;
    let stream = [];
    let streamIndex = new Map();
    const cache = new Map();
    const postRevisions = new Map();
    const postIdByNumber = new Map();
    const parentNumberByPostId = new Map();
    const childrenByParentNumber = new Map();
    const orphanReplyIds = new Set();
    const streamListeners = new Set();
    const postListeners = new Set();
    const projectionListeners = new Set();
    let prefetchedAnchor = null;
    let refreshPromise = null;
    let streamRevision = 0;
    let snapshotTimer = 0;
    let snapshotMaxTimer = 0;
    let snapshotDirty = false;
    let snapshotSuspended = 0;
    let snapshotWriting = false;
    let projectionRevision = 0;
    let projectionScheduled = false;

    const bumpPostRevision = (postId) => {
      const id = Number(postId);
      postRevisions.set(id, (postRevisions.get(id) || 0) + 1);
    };

    const emitProjection = () => {
      if (projectionScheduled) return;
      projectionScheduled = true;
      queueMicrotask(() => {
        projectionScheduled = false;
        projectionRevision += 1;
        const ids = getRootStreamIds();
        projectionListeners.forEach((listener) => listener(ids, projectionRevision));
      });
    };

    const indexPost = (post) => {
      if (!post || !post.id) return false;
      const id = Number(post.id);
      const postNumber = Number(post.post_number) || 0;
      const previousParent = parentNumberByPostId.get(id) || 0;
      const nextParent = Number(post.reply_to_post_number) > 1 ? Number(post.reply_to_post_number) : 0;
      if (postNumber > 0) postIdByNumber.set(postNumber, id);
      if (previousParent && previousParent !== nextParent) {
        const previousChildren = childrenByParentNumber.get(previousParent);
        if (previousChildren) {
          previousChildren.delete(id);
          if (!previousChildren.size) childrenByParentNumber.delete(previousParent);
        }
      }
      if (nextParent) {
        parentNumberByPostId.set(id, nextParent);
        if (!childrenByParentNumber.has(nextParent)) childrenByParentNumber.set(nextParent, new Set());
        childrenByParentNumber.get(nextParent).add(id);
      } else {
        parentNumberByPostId.delete(id);
        orphanReplyIds.delete(id);
      }
      return previousParent !== nextParent;
    };

    const rebuildReplyIndex = () => {
      postIdByNumber.clear(); parentNumberByPostId.clear(); childrenByParentNumber.clear();
      cache.forEach(indexPost);
    };

    const cachePosts = (posts, emit) => {
      let projectionChanged = false;
      const changed = (posts || []).filter((post) => post && post.id).map((post) => {
        const id = Number(post.id);
        const next = Object.assign({}, cache.get(id) || {}, post);
        cache.set(id, next);
        bumpPostRevision(id);
        projectionChanged = indexPost(next) || projectionChanged;
        return next;
      });
      if (emit) emitPosts(changed);
      if (projectionChanged) emitProjection();
      return changed;
    };

    function isNestedPostId(postId) {
      const id = Number(postId);
      return parentNumberByPostId.has(id) && !orphanReplyIds.has(id);
    }

    function getRootStreamIds() {
      return stream.filter((id) => !isNestedPostId(id));
    }
    function getPostByNumber(postNumber) {
      const id = postIdByNumber.get(Number(postNumber));
      return id ? cache.get(id) || null : null;
    }

    function getKnownChildren(parentPostNumber) {
      return Array.from(childrenByParentNumber.get(Number(parentPostNumber)) || [])
        .map((id) => cache.get(Number(id))).filter(Boolean)
        .sort((a, b) => Number(a.post_number) - Number(b.post_number));
    }

    const emitPosts = (posts) => {
      const changed = (posts || []).filter(Boolean);
      if (!changed.length) return;
      postListeners.forEach((listener) => listener(changed));
    };

    const replaceStream = (nextStream) => {
      const seen = new Set();
      const normalized = (nextStream || []).map(Number).filter((id) => id > 0 && !seen.has(id) && seen.add(id));
      const unchanged = normalized.length === stream.length && normalized.every((id, index) => id === stream[index]);
      if (unchanged) return false;
      stream = normalized;
      streamIndex = new Map(stream.map((id, index) => [String(id), index]));
      streamRevision += 1;
      streamListeners.forEach((listener) => listener(stream.slice(), streamRevision));
      return true;
    };

    const flushSnapshot = async () => {
      if (snapshotTimer) clearTimeout(snapshotTimer);
      if (snapshotMaxTimer) clearTimeout(snapshotMaxTimer);
      snapshotTimer = snapshotMaxTimer = 0;
      if (!snapshotDirty || snapshotSuspended || snapshotWriting || !topic) return;
      snapshotDirty = false;
      snapshotWriting = true;
      const writePromise = writeTopicSnapshot(topicId, topic, cache.entries());
      TOPIC_SNAPSHOT_WRITES.set(String(topicId), writePromise);
      try { await writePromise; }
      finally {
        if (TOPIC_SNAPSHOT_WRITES.get(String(topicId)) === writePromise) {
          TOPIC_SNAPSHOT_WRITES.delete(String(topicId));
        }
        snapshotWriting = false;
        if (snapshotDirty) scheduleSnapshotWrite();
      }
    };

    const scheduleSnapshotWrite = (immediate) => {
      snapshotDirty = true;
      if (snapshotSuspended || snapshotWriting) return;
      if (immediate) { flushSnapshot().catch(() => {}); return; }
      if (snapshotTimer) clearTimeout(snapshotTimer);
      snapshotTimer = setTimeout(() => flushSnapshot().catch(() => {}), 1000);
      if (!snapshotMaxTimer) snapshotMaxTimer = setTimeout(() => flushSnapshot().catch(() => {}), 3000);
    };

    const hydrate = (data, cachedEntries) => {
      if (!data) return null;
      topic = data;
      (cachedEntries || []).forEach((entry) => {
        if (Array.isArray(entry) && entry[1]) {
          cache.set(Number(entry[0]), entry[1]);
          bumpPostRevision(entry[0]);
        }
      });
      const initialPosts = (data.post_stream && data.post_stream.posts) || [];
      initialPosts.forEach((post) => {
        cache.set(Number(post.id), Object.assign({}, cache.get(Number(post.id)) || {}, post));
        bumpPostRevision(post.id);
      });
      rebuildReplyIndex();
      const opPost = initialPosts.find((post) => Number(post.post_number) === 1)
        || Array.from(cache.values()).find((post) => Number(post.post_number) === 1) || null;
      replaceStream(((data.post_stream && data.post_stream.stream) || [])
        .filter((id) => Number(id) !== Number(opPost && opPost.id)));
      topic._opPost = opPost;
      topic._opUsername = (topic.details && topic.details.created_by && topic.details.created_by.username)
        || (opPost && opPost.username) || null;
      return topic;
    };

    const mergeTopicResponse = (data) => {
      hydrate(data, []);
      scheduleSnapshotWrite();
      return topic;
    };

    function fetchTopic(priority) {
      return fetchJSON(`${BASE}/t/${topicId}.json?track_visit=true&forceLoad=true`, {
        cache: 'no-store', priority: priority || 'target', signal,
        dedupeKey: `topic:${BASE}:${topicId}`,
        headers: {
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          'Discourse-Present': 'true', 'Discourse-Track-View': 'true',
          'Discourse-Track-View-Topic-Id': String(topicId),
        },
      });
    }

    function fetchAnchor(postNumber) {
      if (!(Number(postNumber) > 1)) return Promise.resolve(null);
      return fetchJSON(`${BASE}/t/${topicId}.json?post_number=${Number(postNumber)}`, {
        signal, priority: 'target', dedupeKey: `anchor:${BASE}:${topicId}:${Number(postNumber)}`,
      }).catch((error) => {
        if (error && error.name === 'AbortError') throw error;
        return null;
      });
    }

    async function init(targetPostNumber, options) {
      const forceNetwork = !!(options && options.forceNetwork);
      const snapshotPromise = forceNetwork ? Promise.resolve(null) : readTopicSnapshot(topicId, signal);
      const anchorPromise = fetchAnchor(targetPostNumber);
      const snapshot = await snapshotPromise;
      prefetchedAnchor = anchorPromise;

      if (snapshot && snapshot.payload && snapshot.payload.topic) {
        hydrate(snapshot.payload.topic, snapshot.payload.posts);
        if (!snapshot.fresh) {
          refreshPromise = fetchTopic('background').then(mergeTopicResponse).catch(() => null);
        }
        return topic;
      }

      const data = await fetchTopic('target');
      return mergeTopicResponse(data);
    }

    async function fetchIds(ids, priority, requestSignal) {
      const missing = ids.filter((id) => !cache.has(Number(id)));
      if (!missing.length) return;
      const chunks = [];
      for (let index = 0; index < missing.length; index += PAGE_SIZE) {
        chunks.push(missing.slice(index, index + PAGE_SIZE));
      }
      await Promise.all(chunks.map(async (chunk) => {
        const qs = chunk.map((id) => `post_ids[]=${encodeURIComponent(id)}`).join('&');
        const part = await fetchJSON(`${BASE}/t/${topicId}/posts.json?${qs}`, {
          signal: requestSignal || signal, priority: priority || 'visible',
          dedupeKey: `posts:${BASE}:${topicId}:${chunk.join(',')}`,
        });
        cachePosts((part.post_stream && part.post_stream.posts) || [], true);
      }));
      if (topic) scheduleSnapshotWrite();
    }

    async function fetchRange(start, end, priority, requestSignal) {
      const safeStart = Math.max(0, Math.min(stream.length, Number(start) || 0));
      const safeEnd = Math.max(safeStart, Math.min(stream.length, Number(end) || 0));
      const ids = stream.slice(safeStart, safeEnd);
      await fetchIds(ids, priority, requestSignal);
      return ids.map((id) => cache.get(Number(id))).filter(Boolean);
    }

    function nearestPost(posts, requested) {
      const target = Number(requested) || 1;
      return posts.slice().sort((a, b) => a.post_number - b.post_number)
        .find((post) => Number(post.post_number) === target)
        || posts.slice().sort((a, b) => Math.abs(a.post_number - target) - Math.abs(b.post_number - target))[0]
        || null;
    }

    async function resolveTarget(targetPostNumber, requestSignal) {
      const target = Math.max(1, Number(targetPostNumber) || 1);
      if (target <= 1 || !stream.length) return { index: 0, postNumber: 1 };
      const cachedTarget = Array.from(cache.values()).find((post) => Number(post.post_number) === target);
      const cachedIndex = cachedTarget && streamIndex.get(String(cachedTarget.id));
      if (cachedIndex !== undefined) {
        const start = Math.max(0, cachedIndex - SLICE_RADIUS);
        const end = Math.min(stream.length, start + PAGE_SIZE);
        const posts = await fetchRange(start, end, 'target', requestSignal);
        return { index: cachedIndex, postNumber: target, start, end, posts };
      }
      let anchor = prefetchedAnchor ? await prefetchedAnchor : await fetchAnchor(target);
      prefetchedAnchor = null;
      const anchorPosts = (anchor && anchor.post_stream && anchor.post_stream.posts) || [];
      cachePosts(anchorPosts, true);
      const nearest = nearestPost(anchorPosts, target);
      let indexed = nearest && streamIndex.get(String(nearest.id));
      if (indexed === undefined && nearest && Number(nearest.id) > 0) {
        const estimated = Math.max(0, Math.min(stream.length, Number(nearest.post_number) - 2));
        const nextStream = stream.slice();
        nextStream.splice(estimated, 0, Number(nearest.id));
        replaceStream(nextStream);
        indexed = streamIndex.get(String(nearest.id));
      }
      const index = indexed === undefined
        ? Math.max(0, Math.min(stream.length - 1, target - 2)) : indexed;
      const start = Math.max(0, index - SLICE_RADIUS);
      const end = Math.min(stream.length, start + PAGE_SIZE);
      const posts = await fetchRange(start, end, 'target', requestSignal);
      const resolved = nearestPost(posts, nearest ? nearest.post_number : target);
      return { index, postNumber: resolved ? resolved.post_number : target, start, end, posts };
    }

    function markOrphanReply(postId) {
      const id = Number(postId);
      if (!parentNumberByPostId.has(id) || orphanReplyIds.has(id)) return;
      orphanReplyIds.add(id);
      emitProjection();
    }

    async function resolveExactPost(postNumber, requestSignal) {
      const expected = Math.max(1, Number(postNumber) || 1);
      let post = getPostByNumber(expected);
      if (post) return post;
      await resolveTarget(expected, requestSignal);
      post = getPostByNumber(expected);
      return post && Number(post.post_number) === expected ? post : null;
    }

    async function resolveThreadTarget(targetPostNumber, requestSignal) {
      const requested = Math.max(1, Number(targetPostNumber) || 1);
      if (requested <= 1) {
        return { index: 0, postNumber: 1, targetPostNumber: 1, rootPostId: null, targetPostId: null, path: [] };
      }
      const resolved = await resolveTarget(requested, requestSignal);
      const targetPost = getPostByNumber(requested)
        || getPostByNumber(resolved.postNumber)
        || cache.get(Number(stream[resolved.index])) || null;
      if (!targetPost) return Object.assign({}, resolved, { targetPostNumber: requested, path: [] });

      const reversePath = [targetPost];
      const visited = new Set([Number(targetPost.id)]);
      let current = targetPost;
      for (let depth = 0; depth < 64 && Number(current.reply_to_post_number) > 1; depth++) {
        const parent = await resolveExactPost(current.reply_to_post_number, requestSignal);
        if (!parent || visited.has(Number(parent.id))) {
          markOrphanReply(current.id);
          break;
        }
        reversePath.push(parent);
        visited.add(Number(parent.id));
        current = parent;
      }
      const path = reversePath.reverse();
      const rootPost = path[0] || targetPost;
      const rootIndex = streamIndex.get(String(rootPost.id));
      return {
        index: rootIndex === undefined ? resolved.index : rootIndex,
        postNumber: Number(rootPost.post_number) || resolved.postNumber,
        rootPostId: Number(rootPost.id) || null,
        targetPostId: Number(targetPost.id) || null,
        targetPostNumber: Number(targetPost.post_number) || requested,
        path,
      };
    }

    async function loadAll(requestSignal, onBatch) {
      snapshotSuspended += 1;
      try {
        for (let start = 0; start < stream.length; start += PAGE_SIZE * REQUEST_MAX_CONCURRENCY) {
          throwIfAborted(requestSignal);
          const groups = [];
          for (let offset = 0; offset < PAGE_SIZE * REQUEST_MAX_CONCURRENCY; offset += PAGE_SIZE) {
            if (start + offset >= stream.length) break;
            groups.push(fetchRange(start + offset, start + offset + PAGE_SIZE, 'background', requestSignal));
          }
          await Promise.all(groups);
          if (onBatch) onBatch(Math.min(stream.length, start + PAGE_SIZE * REQUEST_MAX_CONCURRENCY), stream.length);
        }
        return Array.from(cache.values());
      } finally {
        snapshotSuspended = Math.max(0, snapshotSuspended - 1);
        if (!snapshotSuspended) scheduleSnapshotWrite(true);
      }
    }

    function updatePost(postId, updater) {
      const id = Number(postId);
      const current = cache.get(id);
      if (!current) return null;
      const next = typeof updater === 'function' ? updater(Object.assign({}, current)) : Object.assign({}, current, updater || {});
      if (!next) return current;
      cache.set(id, next);
      bumpPostRevision(id);
      if (indexPost(next)) emitProjection();
      emitPosts([next]);
      scheduleSnapshotWrite();
      return next;
    }

    function mergePost(post) {
      if (!post || !post.id) return null;
      const id = Number(post.id);
      const next = Object.assign({}, cache.get(id) || {}, post);
      if (Number(next.post_number) > 1 && !streamIndex.has(String(id))) {
        const nextStream = stream.slice();
        const estimated = Math.max(0, Math.min(nextStream.length, Number(next.post_number) - 2));
        nextStream.splice(estimated, 0, id);
        replaceStream(nextStream);
      }
      cachePosts([next], true);
      scheduleSnapshotWrite();
      return next;
    }

    function syncLatestTopic(latestData) {
      if (!latestData || !topic) return { addedIds: [] };
      const opId = Number((topic._opPost && topic._opPost.id) || 0);
      const previousSet = new Set(stream.map(Number));
      const incomingPosts = (latestData.post_stream && latestData.post_stream.posts) || [];
      if (incomingPosts.length) cachePosts(incomingPosts, true);
      const nextStream = ((latestData.post_stream && latestData.post_stream.stream) || [])
        .map(Number)
        .filter((id) => id > 0 && id !== opId);
      const addedIds = nextStream.filter((id) => !previousSet.has(id));
      topic = Object.assign({}, topic, {
        title: latestData.title || topic.title,
        posts_count: Math.max(Number(topic.posts_count) || 1, Number(latestData.posts_count) || 1),
        highest_post_number: Math.max(Number(topic.highest_post_number) || 1, Number(latestData.highest_post_number) || 1),
        views: Math.max(Number(topic.views) || 0, Number(latestData.views) || 0),
        last_posted_at: latestData.last_posted_at || topic.last_posted_at,
        bumped_at: latestData.bumped_at || topic.bumped_at,
      });
      if (nextStream.length && replaceStream(nextStream)) emitProjection();
      scheduleSnapshotWrite();
      return { addedIds, topic };
    }

    return {
      init, resolveTarget, resolveThreadTarget, fetchRange, fetchIds, loadAll, updatePost, mergePost, syncLatestTopic, flushSnapshot,
      get streamLength() { return stream.length; },
      get streamRevision() { return streamRevision; },
      get topic() { return topic; },
      get refreshPromise() { return refreshPromise; },
      getStreamId(index) { return stream[index]; },
      getStreamIndex(postId) {
        const index = streamIndex.get(String(postId));
        return index === undefined ? -1 : index;
      },
      getCachedByIndex(index) { return cache.get(Number(stream[index])) || null; },
      getPostById(postId) { return cache.get(Number(postId)) || null; },
      getPostRevision(postId) { return postRevisions.get(Number(postId)) || 0; },
      getPostByNumber,
      getStreamIds() { return stream.slice(); },
      getRootStreamIds,
      getKnownChildren,
      isNestedPostId,
      getCachedPosts() { return Array.from(cache.values()); },
      subscribeStream(listener) { streamListeners.add(listener); return () => streamListeners.delete(listener); },
      subscribePosts(listener) { postListeners.add(listener); return () => postListeners.delete(listener); },
      subscribeProjection(listener) { projectionListeners.add(listener); return () => projectionListeners.delete(listener); },
      destroy() {
        clearTimeout(snapshotTimer);
        clearTimeout(snapshotMaxTimer);
        snapshotTimer = snapshotMaxTimer = 0;
        streamListeners.clear(); postListeners.clear(); projectionListeners.clear();
        if (snapshotDirty) flushSnapshot().catch(() => {});
      },
    };
  }

  function createVirtualFlow(loader, ctx) {
    const DEFAULT_HEIGHT = 184;
    const OVERSCAN_SCREENS = 1.25;
    const KEEPALIVE_SCREENS = 0.5;
    const HEIGHT_EPSILON = 1;
    const SEEK_QUIET_MS = 120;
    const SEEK_MAX_MS = 500;
    const MANUAL_SCROLL_QUIET_MS = 180;
    const USER_SCROLL_IDLE_MS = 350;
    const DISCONTINUOUS_SCROLL_SCREENS = 1.5;
    const displayStreamIds = () => onlyOp
      ? loader.getStreamIds().filter((id) => (loader.getPostById(id) || {}).username === ctx.op)
      : loader.getRootStreamIds();
    let logicalIds = loader.getRootStreamIds();
    const heightByPostId = new Map();
    let positionByPostId = new Map();
    let heights = logicalIds.map((id) => heightByPostId.get(id) || DEFAULT_HEIGHT);
    let prefix = [0];
    let mountedStart = -1;
    let mountedEnd = -1;
    let logicalRevision = 0;
    let scrollRaf = 0;
    let resizeRaf = 0;
    let interactionRevision = 0;
    let destroyed = false;
    let onlyOp = false;
    let onlyOpController = null;
    let pinnedAnchor = null;
    let seekQuietTimer = 0;
    let seekMaxTimer = 0;
    let seekingScroll = false;
    let committing = false;
    let mountSequence = 0;
    let latestMountSequence = 0;
    let activeMount = null;
    let queuedMount = null;
    let pendingResizeAnchor = null;
    let manualScrollAnchor = null;
    let manualScrollTimer = 0;
    let manualScrollActive = false;
    let lastObservedScrollTop = ctx.scrollRoot.scrollTop;
    let viewportWasAtBottom = false;
    let stableViewportAnchor = null;
    let preferredFocusPostId = 0;
    let preferredViewportAnchor = null;
    let preferredProtectedUntil = 0;
    let userScrollActive = false;
    let userScrollTimer = 0;
    let pendingProjectionReconcile = false;
    let projectionReconcileQueued = false;
    let projectionReconcileRunning = false;
    let explicitSeekDepth = 0;
    const pendingResizeHeights = new Map();
    const resizeObserver = new ResizeObserver((entries) => {
      if (destroyed || committing || !entries.length) return;
      entries.forEach((entry) => {
        if (!entry.target.isConnected) return;
        const postId = Number(entry.target.dataset.streamPostId);
        const position = positionByPostId.get(postId);
        if (position === undefined) return;
        const next = Math.max(56, entry.borderBoxSize && entry.borderBoxSize[0]
          ? entry.borderBoxSize[0].blockSize : entry.contentRect.height);
        if (Math.abs((heights[position] || DEFAULT_HEIGHT) - next) >= HEIGHT_EPSILON) {
          pendingResizeHeights.set(postId, next);
        }
      });
      if (!pendingResizeHeights.size) {
        if (!resizeRaf) pendingResizeAnchor = null;
        return;
      }
      if (!pendingResizeAnchor) {
        const preferredNode = preferredFocusPostId
          ? windowEl.querySelector(`.ldp-post[data-post-id="${Number(preferredFocusPostId)}"]`) : null;
        pendingResizeAnchor = pinnedAnchor || preferredViewportAnchor || stableViewportAnchor
          || captureNodeViewportAnchor(preferredNode) || captureViewportAnchor();
      }
      if (resizeRaf) return;
      if (pinnedAnchor) notePinnedActivity();
      resizeRaf = requestAnimationFrame(applyResizeUpdates);
    });

    ctx.commentsEl.innerHTML = `
      <div class="ldp-virtual-spacer ldp-virtual-spacer-top" aria-hidden="true"></div>
      <div class="ldp-virtual-window"></div>
      <div class="ldp-virtual-spacer ldp-virtual-spacer-bottom" aria-hidden="true"></div>`;
    const topSpacer = ctx.commentsEl.querySelector('.ldp-virtual-spacer-top');
    const windowEl = ctx.commentsEl.querySelector('.ldp-virtual-window');
    const bottomSpacer = ctx.commentsEl.querySelector('.ldp-virtual-spacer-bottom');

    function rebuildPrefix() {
      positionByPostId = new Map(logicalIds.map((id, index) => [Number(id), index]));
      prefix = new Array(heights.length + 1);
      prefix[0] = 0;
      for (let index = 0; index < heights.length; index++) prefix[index + 1] = prefix[index] + (heights[index] || DEFAULT_HEIGHT);
    }

    function lowerBound(value) {
      let low = 0, high = Math.max(0, prefix.length - 1);
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (prefix[mid] < value) low = mid + 1;
        else high = mid;
      }
      return Math.max(0, Math.min(heights.length - 1, low - (prefix[low] > value ? 1 : 0)));
    }

    function contentTop() {
      return ctx.commentsEl.offsetTop;
    }

    function isAtBottom() {
      return ctx.scrollRoot.scrollHeight - ctx.scrollRoot.clientHeight - ctx.scrollRoot.scrollTop <= 2;
    }

    function currentAnchor() {
      if (!logicalIds.length) return { aboveContent: true, scrollTop: ctx.scrollRoot.scrollTop };
      if (ctx.scrollRoot.scrollTop < contentTop()) {
        return { aboveContent: true, scrollTop: ctx.scrollRoot.scrollTop };
      }
      const y = Math.max(0, ctx.scrollRoot.scrollTop - contentTop());
      const position = lowerBound(y);
      return { position, postId: logicalIds[position], offset: y - prefix[position] };
    }

    function restoreAnchor(anchor) {
      if (!anchor || !heights.length) return;
      if (anchor.aboveContent) {
        ctx.scrollRoot.scrollTop = Math.max(0, Number(anchor.scrollTop) || 0);
        viewportWasAtBottom = isAtBottom();
        stableViewportAnchor = anchor;
        return;
      }
      const mapped = positionByPostId.get(Number(anchor.postId));
      const position = mapped === undefined ? Math.min(anchor.position, heights.length - 1) : mapped;
      ctx.scrollRoot.scrollTop = contentTop() + prefix[position] + anchor.offset;
      viewportWasAtBottom = isAtBottom();
      stableViewportAnchor = captureViewportAnchor();
    }

    function captureNodeViewportAnchor(visible) {
      if (!visible || !visible.isConnected) return null;
      const rootRect = ctx.scrollRoot.getBoundingClientRect();
      let rootNode = visible;
      while (rootNode.parentElement && rootNode.parentElement !== windowEl) rootNode = rootNode.parentElement;
      const postId = Number(rootNode.dataset.streamPostId);
      const focusPostId = Number(visible.dataset.postId);
      const position = positionByPostId.get(postId);
      if (position === undefined) return null;
      const post = loader.getPostById(focusPostId || postId);
      return {
        postId, focusPostId, position, postNumber: post && Number(post.post_number),
        viewportOffset: visible.getBoundingClientRect().top - rootRect.top,
        offset: ctx.scrollRoot.scrollTop - contentTop() - prefix[position],
      };
    }

    function captureViewportAnchor() {
      if (!logicalIds.length || ctx.scrollRoot.scrollTop < contentTop()) return currentAnchor();
      const rootRect = ctx.scrollRoot.getBoundingClientRect();
      const nodes = Array.from(windowEl.querySelectorAll('.ldp-post[data-post-id]'));
      const visibleNodes = nodes.filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.bottom > rootRect.top + 1 && rect.top < rootRect.bottom - 1;
      });
      const atBottom = viewportWasAtBottom || isAtBottom();
      const probeY = rootRect.top + Math.min(24, rootRect.height * 0.1);
      const probeNodes = visibleNodes.filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.top <= probeY && rect.bottom > probeY;
      });
      const visible = (atBottom && visibleNodes.length ? visibleNodes[visibleNodes.length - 1] : null)
        || probeNodes[probeNodes.length - 1] || visibleNodes[0];
      if (!visible) return currentAnchor();
      return captureNodeViewportAnchor(visible) || currentAnchor();
    }

    function restoreViewportAnchor(anchor) {
      if (!anchor || !heights.length) return;
      if (anchor.aboveContent) {
        ctx.scrollRoot.scrollTop = Math.max(0, Number(anchor.scrollTop) || 0);
        viewportWasAtBottom = isAtBottom();
        stableViewportAnchor = anchor;
        return;
      }
      const mapped = positionByPostId.get(Number(anchor.postId));
      const position = mapped === undefined
        ? Math.max(0, Math.min(heights.length - 1, Number(anchor.position) || 0)) : mapped;
      const rootNode = Array.from(windowEl.children)
        .find((item) => Number(item.dataset.streamPostId) === Number(logicalIds[position]));
      const focusNode = Number(anchor.focusPostId) && rootNode
        ? rootNode.querySelector(`.ldp-post[data-post-id="${Number(anchor.focusPostId)}"]`)
        : null;
      const node = focusNode || rootNode;
      if (node && Number.isFinite(Number(anchor.viewportOffset))) {
        const rootTop = ctx.scrollRoot.getBoundingClientRect().top;
        const delta = node.getBoundingClientRect().top - rootTop - Number(anchor.viewportOffset);
        if (Math.abs(delta) >= 0.5) ctx.scrollRoot.scrollTop += delta;
        viewportWasAtBottom = isAtBottom();
        stableViewportAnchor = captureNodeViewportAnchor(node) || captureViewportAnchor();
        if (preferredFocusPostId && Number(anchor.focusPostId) === Number(preferredFocusPostId)) {
          preferredViewportAnchor = stableViewportAnchor;
        }
        return;
      }
      const offset = Number.isFinite(Number(anchor.offset)) ? Number(anchor.offset) : -Number(anchor.viewportOffset || 0);
      ctx.scrollRoot.scrollTop = Math.max(0, contentTop() + prefix[position] + offset);
      viewportWasAtBottom = isAtBottom();
      stableViewportAnchor = captureViewportAnchor();
    }

    function syncSpacers() {
      const top = mountedStart < 0 ? 0 : prefix[mountedStart];
      const bottom = mountedEnd < 0 ? prefix[prefix.length - 1] : prefix[prefix.length - 1] - prefix[mountedEnd];
      topSpacer.style.height = `${Math.max(0, top)}px`;
      bottomSpacer.style.height = `${Math.max(0, bottom)}px`;
    }

    function unregisterRootNode(rootNode) {
      if (!rootNode) return;
      resizeObserver.unobserve(rootNode);
      rootNode.querySelectorAll('.ldp-post[data-post-id]').forEach((node) => {
        ctx.tracker.unobserve(node);
        if (ctx.repliesIO && ctx.repliesIO.clearNode) ctx.repliesIO.clearNode(node);
        const postNumber = Number(node.dataset.postNumber);
        if (ctx.nodeMap.get(postNumber) === node) ctx.nodeMap.delete(postNumber);
      });
      if (rootNode.matches && rootNode.matches('.ldp-post[data-post-id]')) {
        ctx.tracker.unobserve(rootNode);
        if (ctx.repliesIO && ctx.repliesIO.clearNode) ctx.repliesIO.clearNode(rootNode);
        const postNumber = Number(rootNode.dataset.postNumber);
        if (ctx.nodeMap.get(postNumber) === rootNode) ctx.nodeMap.delete(postNumber);
      }
    }

    function clearWindow() {
      Array.from(windowEl.children).forEach(unregisterRootNode);
      ctx.windowEpoch += 1;
      ctx.nodeMap.clear();
      windowEl.replaceChildren();
    }

    function measureWindowHeights() {
      let changed = false;
      Array.from(windowEl.children).forEach((node) => {
        const postId = Number(node.dataset.streamPostId);
        const position = positionByPostId.get(postId);
        if (position === undefined) return;
        const next = Math.max(56, node.getBoundingClientRect().height);
        if (Math.abs((heights[position] || DEFAULT_HEIGHT) - next) < HEIGHT_EPSILON) return;
        heights[position] = next;
        heightByPostId.set(postId, next);
        changed = true;
      });
      if (changed) rebuildPrefix();
      return changed;
    }

    function applyResizeUpdates() {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = 0;
      if (destroyed || !pendingResizeHeights.size) {
        pendingResizeHeights.clear();
        pendingResizeAnchor = null;
        return;
      }
      const anchor = pendingResizeAnchor;
      pendingResizeAnchor = null;
      let changed = false;
      let beforeAnchorDelta = 0;
      const anchorPosition = anchor && positionByPostId.get(Number(anchor.postId));
      pendingResizeHeights.forEach((next, postId) => {
        const position = positionByPostId.get(Number(postId));
        if (position === undefined || Math.abs((heights[position] || DEFAULT_HEIGHT) - next) < HEIGHT_EPSILON) return;
        if (anchorPosition !== undefined && position < anchorPosition) {
          beforeAnchorDelta += next - (heights[position] || DEFAULT_HEIGHT);
        }
        heights[position] = next;
        heightByPostId.set(Number(postId), next);
        changed = true;
      });
      pendingResizeHeights.clear();
      if (!changed) return;
      rebuildPrefix();
      syncSpacers();
      if (Math.abs(beforeAnchorDelta) >= 0.5) {
        ctx.scrollRoot.scrollTop += beforeAnchorDelta;
        viewportWasAtBottom = isAtBottom();
        stableViewportAnchor = anchor || stableViewportAnchor;
      } else if (!userScrollActive && anchor && (anchor.pinned || Number.isFinite(Number(anchor.viewportOffset)))) {
        restoreViewportAnchor(anchor);
      } else if (!userScrollActive) {
        restoreAnchor(anchor);
      }
    }

    function withViewportAnchor(mutator) {
      if (typeof mutator !== 'function') return undefined;
      if (destroyed || committing) return mutator();
      if (resizeRaf || pendingResizeHeights.size) applyResizeUpdates();
      const anchor = pinnedAnchor || captureViewportAnchor();
      committing = true;
      try {
        return mutator();
      } finally {
        measureWindowHeights();
        syncSpacers();
        restoreViewportAnchor(anchor);
        committing = false;
        if (pinnedAnchor) notePinnedActivity();
      }
    }

    function prepareReplyState(post) {
      const knownChildren = loader.getKnownChildren(post.post_number);
      if (knownChildren.length) {
        const state = mergeSubReplyState(post.post_number, knownChildren, ctx);
        if (!state.renderedCount) state.renderedCount = Math.min(SUB_REPLY_INITIAL_SIZE, state.all.length);
      }
    }

    function renderTreeRevision(post, ancestry) {
      if (!post || !post.id) return 'missing';
      const id = Number(post.id);
      const seen = ancestry || new Set();
      if (seen.has(id)) return `${id}:cycle`;
      const nextSeen = new Set(seen);
      nextSeen.add(id);
      const state = ctx.subReplyState.get(Number(post.post_number));
      const targets = state && state.targetIds instanceof Set
        ? Array.from(state.targetIds).sort((a, b) => a - b).join(',') : '';
      const children = loader.getKnownChildren(post.post_number)
        .map((child) => renderTreeRevision(child, nextSeen)).join(';');
      return `${onlyOp ? 'op' : 'all'}:${id}:${loader.getPostRevision(id)}:${Number(state && state.renderedCount) || 0}:${targets}[${children}]`;
    }
    function rebuildNodeMap() {
      ctx.nodeMap.clear();
      windowEl.querySelectorAll('.ldp-post[data-post-number]').forEach((node) => {
        ctx.nodeMap.set(Number(node.dataset.postNumber), node);
      });
    }

    function renderWindow(entries) {
      const previous = new Map(Array.from(windowEl.children).map((node) => [String(node.dataset.streamPostId || ''), node]));
      const retained = new Set();
      const fragment = document.createDocumentFragment();
      entries.forEach(({ id, post }) => {
        if (!post) {
          let placeholder = previous.get(String(id));
          if (!placeholder || !placeholder.classList.contains('ldp-missing-post')) {
            placeholder = document.createElement('div');
            placeholder.className = 'ldp-missing-post';
          }
          placeholder.dataset.streamPostId = String(id);
          placeholder.setAttribute('aria-hidden', 'true');
          retained.add(placeholder);
          fragment.appendChild(placeholder);
          return;
        }
        if (!onlyOp && loader.isNestedPostId(id)) return;
        prepareReplyState(post);
        const revision = renderTreeRevision(post);
        const previousNode = previous.get(String(id));
        let node = previousNode && previousNode.classList.contains('ldp-post')
          && previousNode.dataset.renderRevision === revision ? previousNode : null;
        if (!node) {
          if (previousNode) unregisterRootNode(previousNode);
          node = renderPost(post, false, ctx);
          node.dataset.renderRevision = revision;
          ctx.tracker.observe(node);
          if (ctx.repliesIO && Number(post.reply_count) > 0) ctx.repliesIO.observe(node);
        }
        node.dataset.streamPostId = String(id);
        node.dataset.windowEpoch = String(ctx.windowEpoch + 1);
        if (Number(ctx.highlightPostId) === Number(post.id) && Date.now() < Number(ctx.highlightUntil || 0)) {
          node.classList.add('ldp-flash');
        }
        retained.add(node);
        fragment.appendChild(node);
      });
      previous.forEach((node) => {
        if (!retained.has(node)) unregisterRootNode(node);
      });
      ctx.windowEpoch += 1;
      windowEl.replaceChildren(fragment);
      rebuildNodeMap();
      entries.forEach(({ post }) => {
        if (!post) return;
        const parent = ctx.nodeMap.get(Number(post.post_number));
        if (!parent || onlyOp) return;
        if (parent.dataset.renderRevision === renderTreeRevision(post)
          && ctx.subReplyState.has(Number(post.post_number))
          && !parent.querySelector(':scope > .ldp-children > .ldp-post-copy')) {
          renderSubReplyStateInto(parent, post.post_number, ctx, 1, new Set([Number(post.id)]));
        }
      });
      rebuildNodeMap();
    }

    function settleMountRequest(request, value, error) {
      request.waiters.forEach(({ resolve, reject }) => error ? reject(error) : resolve(value));
      request.waiters.length = 0;
    }

    function startNextMount() {
      if (destroyed || activeMount || !queuedMount) return;
      const request = queuedMount;
      queuedMount = null;
      activeMount = request;
      (async () => {
        const groups = [];
        for (let index = 0; index < request.source.length; index += PAGE_SIZE) {
          groups.push(loader.fetchIds(request.source.slice(index, index + PAGE_SIZE), request.priority, ctx.signal));
        }
        await Promise.all(groups);
        if (destroyed) return false;
        if (request.interactionRevision !== interactionRevision) return false;
        let commitStart = request.start;
        let commitEnd = request.end;
        if (request.logicalRevision !== logicalRevision) {
          const currentPositions = request.source
            .map((id) => positionByPostId.get(Number(id)))
            .filter((position) => position !== undefined);
          const contiguous = currentPositions.length > 0
            && currentPositions.every((position, index) => position === currentPositions[0] + index);
          if (!contiguous) return false;
          commitStart = currentPositions[0];
          commitEnd = currentPositions[currentPositions.length - 1] + 1;
        }
        if (!request.forceCommit && request.sequence < latestMountSequence) return false;
        const entries = request.source.map((id) => ({ id, post: loader.getPostById(id) }));
        const anchor = request.anchorOverride || manualScrollAnchor
          || (request.preserveAnchor ? captureViewportAnchor() : null);
        committing = true;
        try {
          if (resizeRaf) cancelAnimationFrame(resizeRaf);
          resizeRaf = 0;
          pendingResizeHeights.clear();
          pendingResizeAnchor = null;
          mountedStart = commitStart;
          mountedEnd = commitEnd;
          renderWindow(entries);
          measureWindowHeights();
          syncSpacers();
          if (anchor) restoreViewportAnchor(anchor);
          Array.from(windowEl.children).forEach((node) => resizeObserver.observe(node));
        } finally {
          committing = false;
        }
        if (ctx.onPostsChanged) ctx.onPostsChanged();
        return true;
      })().then((committed) => {
        settleMountRequest(request, committed);
        if (committed && request.forceCommit && queuedMount && !queuedMount.forceCommit) {
          settleMountRequest(queuedMount, false);
          queuedMount = null;
        }
      }).catch((error) => settleMountRequest(request, false, error)).finally(() => {
        activeMount = null;
        queueMicrotask(startNextMount);
      });
    }

    function mount(start, end, priority, options) {
      if (destroyed || !logicalIds.length) return Promise.resolve(false);
      const safeStart = Math.max(0, Math.min(logicalIds.length - 1, start));
      const safeEnd = Math.max(safeStart + 1, Math.min(logicalIds.length, end));
      const force = !!(options && options.force);
      if (!force && safeStart === mountedStart && safeEnd === mountedEnd) return Promise.resolve(true);
      const source = logicalIds.slice(safeStart, safeEnd);
      const same = (request) => request && request.start === safeStart && request.end === safeEnd
        && request.logicalRevision === logicalRevision
        && request.interactionRevision === interactionRevision
        && request.source.length === source.length && request.source.every((id, index) => Number(id) === Number(source[index]));
      return new Promise((resolve, reject) => {
        const forceCommit = !!(options && options.forceCommit);
        if (same(activeMount) && (!forceCommit || activeMount.forceCommit)) {
          if (options && options.anchorOverride) activeMount.anchorOverride = options.anchorOverride;
          activeMount.waiters.push({ resolve, reject });
          return;
        }
        if (same(queuedMount)) {
          if (options && options.anchorOverride) queuedMount.anchorOverride = options.anchorOverride;
          if (forceCommit) {
            queuedMount.forceCommit = true;
            queuedMount.priority = priority || 'target';
            queuedMount.preserveAnchor = !options || options.preserveAnchor !== false;
            queuedMount.anchorOverride = options && options.anchorOverride;
          }
          queuedMount.waiters.push({ resolve, reject });
          return;
        }
        const request = {
          start: safeStart, end: safeEnd, source,
          logicalRevision, interactionRevision,
          priority: priority || 'visible', sequence: ++mountSequence,
          preserveAnchor: !options || options.preserveAnchor !== false,
          anchorOverride: options && options.anchorOverride,
          forceCommit,
          waiters: [{ resolve, reject }],
        };
        latestMountSequence = request.sequence;
        if (queuedMount) settleMountRequest(queuedMount, false);
        queuedMount = request;
        startNextMount();
      });
    }

    function desiredWindow(force) {
      const relativeTop = Math.max(0, ctx.scrollRoot.scrollTop - contentTop());
      const viewport = Math.max(1, ctx.scrollRoot.clientHeight);
      if (!force && mountedStart >= 0 && mountedEnd > mountedStart) {
        const before = mountedStart === 0 ? Infinity : relativeTop - prefix[mountedStart];
        const after = mountedEnd >= logicalIds.length ? Infinity : prefix[mountedEnd] - (relativeTop + viewport);
        if (before >= viewport * KEEPALIVE_SCREENS && after >= viewport * KEEPALIVE_SCREENS) return null;
      }
      const first = lowerBound(Math.max(0, relativeTop - viewport * OVERSCAN_SCREENS));
      let last = lowerBound(relativeTop + viewport * (1 + OVERSCAN_SCREENS)) + 1;
      last = Math.min(logicalIds.length, Math.max(first + 1, last));
      if (last - first > MAX_RENDERED_POSTS) last = first + MAX_RENDERED_POSTS;
      return { start: first, end: last };
    }

    function windowAroundPosition(position) {
      const start = Math.max(0, Math.min(position - SLICE_RADIUS, Math.max(0, logicalIds.length - PAGE_SIZE)));
      return { start, end: Math.min(logicalIds.length, Math.max(start + PAGE_SIZE, position + 1)) };
    }

    function visibleRenderedPost() {
      const rect = ctx.scrollRoot.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width * 0.5, rect.top + rect.height * 0.35);
      const node = hit && hit.closest ? hit.closest('.ldp-post[data-post-id]') : null;
      return node && ctx.scrollRoot.contains(node) ? loader.getPostById(node.dataset.postId) : null;
    }

    function requestProjectionReconcile() {
      pendingProjectionReconcile = true;
      if (destroyed || userScrollActive || explicitSeekDepth > 0 || projectionReconcileQueued || projectionReconcileRunning) return;
      projectionReconcileQueued = true;
      queueMicrotask(async () => {
        projectionReconcileQueued = false;
        if (destroyed || userScrollActive || !pendingProjectionReconcile) return;
        pendingProjectionReconcile = false;
        projectionReconcileRunning = true;
        try {
          await reconcileStream(displayStreamIds());
        } catch (error) {
          if (!error || error.name !== 'AbortError') console.warn('[LinuxDo Reader] 回复投影更新失败', error);
        } finally {
          projectionReconcileRunning = false;
          if (pendingProjectionReconcile) requestProjectionReconcile();
        }
      });
    }

    function setUserScrollActive(active) {
      const next = !!active;
      if (userScrollActive === next) return;
      userScrollActive = next;
      if (ctx.repliesIO && ctx.repliesIO.setScrollActive) ctx.repliesIO.setScrollActive(next);
      if (!next) {
        if (!destroyed && ctx.repliesIO && ctx.repliesIO.flushPendingReplies) ctx.repliesIO.flushPendingReplies();
        if (!destroyed && pendingProjectionReconcile) requestProjectionReconcile();
      }
    }

    function noteUserScroll() {
      if (destroyed || committing || seekingScroll) return;
      setUserScrollActive(true);
      if (userScrollTimer) clearTimeout(userScrollTimer);
      userScrollTimer = setTimeout(() => {
        userScrollTimer = 0;
        setUserScrollActive(false);
      }, USER_SCROLL_IDLE_MS);
    }

    function onScroll(event) {
      const nextScrollTop = ctx.scrollRoot.scrollTop;
      const viewport = Math.max(1, ctx.scrollRoot.clientHeight);
      const syntheticScroll = !!(event && event.isTrusted === false);
      if (syntheticScroll && !seekingScroll) beginManualScroll();
      const discontinuous = !committing && !seekingScroll && !pinnedAnchor
        && Math.abs(nextScrollTop - lastObservedScrollTop) > viewport * DISCONTINUOUS_SCROLL_SCREENS;
      const treatAsManual = manualScrollActive
        || (discontinuous && (syntheticScroll
          || (!preferredViewportAnchor && performance.now() >= preferredProtectedUntil)));
      if (treatAsManual && !seekingScroll) noteUserScroll();
      if (treatAsManual && !seekingScroll) {
        preferredFocusPostId = 0;
        preferredViewportAnchor = null;
      }
      lastObservedScrollTop = nextScrollTop;
      if (manualScrollActive || discontinuous || seekingScroll || pinnedAnchor) {
        viewportWasAtBottom = isAtBottom();
        stableViewportAnchor = pinnedAnchor || preferredViewportAnchor
          || (manualScrollActive || discontinuous ? currentAnchor() : captureViewportAnchor());
      }
      if (pinnedAnchor && !seekingScroll) {
        const focusNode = Number(pinnedAnchor.focusPostId)
          ? windowEl.querySelector(`.ldp-post[data-post-id="${Number(pinnedAnchor.focusPostId)}"]`) : null;
        if (focusNode) {
          const rootTop = ctx.scrollRoot.getBoundingClientRect().top;
          if (Math.abs(focusNode.getBoundingClientRect().top - rootTop - pinnedAnchor.viewportOffset) > 2) clearPinnedAnchor();
        } else {
          const mapped = positionByPostId.get(Number(pinnedAnchor.postId));
          const position = mapped === undefined ? pinnedAnchor.position : mapped;
          const expected = contentTop() + prefix[position] - pinnedAnchor.viewportOffset;
          if (Math.abs(ctx.scrollRoot.scrollTop - expected) > 2) clearPinnedAnchor();
        }
      }
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        if (treatAsManual) {
          manualScrollActive = true;
          manualScrollAnchor = currentAnchor();
          scheduleManualScrollRelease();
        }
        const desired = desiredWindow(false);
        if (desired) {
          mount(desired.start, desired.end, 'visible', {
            anchorOverride: manualScrollAnchor,
          }).catch(() => {});
        }
        const anchor = currentAnchor();
        const post = visibleRenderedPost() || (anchor.aboveContent ? null : loader.getPostById(logicalIds[anchor.position]));
        if (post && loader.topic) rememberTopicHistory(loader.topic, post.post_number);
      });
    }

    function clearPinnedAnchor() {
      if (!committing && pendingResizeAnchor && pendingResizeAnchor.pinned) {
        if (pendingResizeHeights.size) applyResizeUpdates();
        else pendingResizeAnchor = null;
      }
      pinnedAnchor = null;
      if (seekQuietTimer) clearTimeout(seekQuietTimer);
      if (seekMaxTimer) clearTimeout(seekMaxTimer);
      seekQuietTimer = seekMaxTimer = 0;
    }

    function notePinnedActivity() {
      if (!pinnedAnchor) return;
      if (seekQuietTimer) clearTimeout(seekQuietTimer);
      seekQuietTimer = setTimeout(clearPinnedAnchor, SEEK_QUIET_MS);
      if (!seekMaxTimer) seekMaxTimer = setTimeout(clearPinnedAnchor, SEEK_MAX_MS);
    }

    function clearManualScrollAnchor() {
      manualScrollActive = false;
      manualScrollAnchor = null;
      if (manualScrollTimer) clearTimeout(manualScrollTimer);
      manualScrollTimer = 0;
    }

    function scheduleManualScrollRelease() {
      if (manualScrollTimer) clearTimeout(manualScrollTimer);
      manualScrollTimer = setTimeout(clearManualScrollAnchor, MANUAL_SCROLL_QUIET_MS);
    }

    function beginManualScroll() {
      clearPinnedAnchor();
      preferredFocusPostId = 0;
      preferredViewportAnchor = null;
      preferredProtectedUntil = 0;
      interactionRevision += 1;
      manualScrollActive = true;
      noteUserScroll();
      scheduleManualScrollRelease();
    }

    async function performSeekResolvedTarget(target, options) {
      preferredFocusPostId = Number(target && target.targetPostId) || Number(target && target.rootPostId) || 0;
      preferredViewportAnchor = null;
      preferredProtectedUntil = performance.now() + SEEK_MAX_MS;
      if (!logicalIds.length) {
        ctx.scrollRoot.scrollTop = 0;
        return true;
      }
      if (Number(target && target.targetPostNumber) <= 1) return scrollToTop();
      await reconcileStream(displayStreamIds(), { forceCommit: true });
      const rootPostId = Number(target && target.rootPostId)
        || Number(loader.getStreamId(Number(target && target.index) || 0));
      let position = positionByPostId.get(rootPostId);
      if (position === undefined) {
        const fallbackPost = loader.getPostByNumber(target && target.postNumber);
        position = fallbackPost ? positionByPostId.get(Number(fallbackPost.id)) : undefined;
      }
      if (position === undefined) position = Math.max(0, Math.min(logicalIds.length - 1, Number(target && target.index) || 0));
      let targetWindow = windowAroundPosition(position);
      const local = position >= mountedStart && position < mountedEnd;
      let mounted = await mount(targetWindow.start, targetWindow.end, 'target', {
        preserveAnchor: false, forceCommit: true,
      });
      for (let attempt = 0; !mounted && !destroyed && attempt < MAX_RENDERED_POSTS; attempt++) {
        await Promise.resolve();
        position = positionByPostId.get(rootPostId);
        if (position === undefined) position = Math.max(0, Math.min(logicalIds.length - 1, Number(target && target.index) || 0));
        targetWindow = windowAroundPosition(position);
        mounted = await mount(targetWindow.start, targetWindow.end, 'target', {
          force: true, preserveAnchor: false, forceCommit: true,
        });
      }
      if (!mounted || destroyed) return false;
      position = positionByPostId.get(rootPostId);
      if (position === undefined) position = 0;
      const behavior = local && options && options.smooth ? 'smooth' : 'auto';
      const top = contentTop() + prefix[position];
      const viewportOffset = ctx.scrollRoot.clientHeight * 0.3;
      let node = ctx.nodeMap.get(Number(target && target.postNumber));
      clearPinnedAnchor();
      pinnedAnchor = { position, postId: logicalIds[position], viewportOffset, pinned: true };
      seekingScroll = true;
      try {
        if (node && (!target || !Array.isArray(target.path) || target.path.length <= 1)) {
          node.scrollIntoView({ block: 'center', behavior });
        } else {
          ctx.scrollRoot.scrollTo({ top: Math.max(0, top - viewportOffset), behavior });
        }
        if (behavior === 'smooth') await waitForScrollEnd(ctx.scrollRoot);
        else await new Promise((resolve) => requestAnimationFrame(resolve));
        lastObservedScrollTop = ctx.scrollRoot.scrollTop;
      } finally {
        seekingScroll = false;
      }
      viewportWasAtBottom = isAtBottom();
      stableViewportAnchor = captureViewportAnchor();
      notePinnedActivity();
      if (target && Array.isArray(target.path) && target.path.length > 1 && ctx.repliesIO) {
        node = ctx.repliesIO.revealPath(target.path) || node;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        node = ctx.nodeMap.get(Number(target.targetPostNumber)) || node;
        if (node) {
          preferredFocusPostId = Number(node.dataset.postId) || preferredFocusPostId;
          preferredProtectedUntil = performance.now() + SEEK_MAX_MS;
          clearPinnedAnchor();
          seekingScroll = true;
          node.scrollIntoView({ block: 'center', behavior: 'auto' });
          stableViewportAnchor = captureNodeViewportAnchor(node) || captureViewportAnchor();
          preferredViewportAnchor = stableViewportAnchor;
          pinnedAnchor = Object.assign({}, stableViewportAnchor, { pinned: true });
          pendingResizeAnchor = stableViewportAnchor;
          await new Promise((resolve) => requestAnimationFrame(resolve));
          lastObservedScrollTop = ctx.scrollRoot.scrollTop;
          stableViewportAnchor = captureNodeViewportAnchor(node) || captureViewportAnchor();
          preferredViewportAnchor = stableViewportAnchor;
          pinnedAnchor = Object.assign({}, stableViewportAnchor, { pinned: true });
          if (pendingResizeAnchor || pendingResizeHeights.size || resizeRaf) {
            pendingResizeAnchor = stableViewportAnchor;
          }
          seekingScroll = false;
          notePinnedActivity();
        }
      }
      if (node) {
        ctx.highlightPostId = Number(node.dataset.postId) || Number(target && target.targetPostId) || 0;
        ctx.highlightUntil = Date.now() + 1700;
        const applyHighlight = () => {
          if (!ctx.highlightPostId || Date.now() >= ctx.highlightUntil) return;
          windowEl.querySelectorAll(`.ldp-post[data-post-id="${Number(ctx.highlightPostId)}"]`)
            .forEach((item) => item.classList.add('ldp-flash'));
        };
        applyHighlight();
        requestAnimationFrame(() => requestAnimationFrame(applyHighlight));
        setTimeout(() => {
          if (Number(ctx.highlightPostId) !== Number(node.dataset.postId) || Date.now() < ctx.highlightUntil) return;
          windowEl.querySelectorAll(`.ldp-post[data-post-id="${Number(ctx.highlightPostId)}"]`)
            .forEach((item) => item.classList.remove('ldp-flash'));
          ctx.highlightPostId = 0;
          ctx.highlightUntil = 0;
        }, 1710);
      }
      return true;
    }

    async function seekResolvedTarget(target, options) {
      explicitSeekDepth += 1;
      try {
        return await performSeekResolvedTarget(target, options);
      } finally {
        explicitSeekDepth = Math.max(0, explicitSeekDepth - 1);
        if (!destroyed && explicitSeekDepth === 0 && pendingProjectionReconcile) requestProjectionReconcile();
      }
    }

    async function seekToIndex(streamIndex, desiredPostNumber, options) {
      const safeIndex = Math.max(0, Math.min(loader.streamLength - 1, Number(streamIndex) || 0));
      const streamId = loader.getStreamId(safeIndex);
      if (streamId && !loader.getPostById(streamId)) await loader.fetchIds([streamId], 'target', ctx.signal);
      const streamPost = loader.getPostById(streamId);
      const postNumber = Number(desiredPostNumber) || Number(streamPost && streamPost.post_number) || safeIndex + 2;
      const target = await loader.resolveThreadTarget(postNumber, ctx.signal);
      return seekResolvedTarget(target, options);
    }

    async function seekToPost(postNumber) {
      const target = await loader.resolveThreadTarget(postNumber, ctx.signal);
      return seekResolvedTarget(target, { smooth: false });
    }

    async function scrollToTop() {
      clearPinnedAnchor();
      preferredFocusPostId = 0;
      preferredViewportAnchor = null;
      preferredProtectedUntil = 0;
      viewportWasAtBottom = false;
      stableViewportAnchor = { aboveContent: true, scrollTop: 0 };
      ctx.scrollRoot.scrollTo({ top: 0, behavior: 'auto' });
      onScroll();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (destroyed) return false;
      ctx.scrollRoot.scrollTop = 0;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (!destroyed) ctx.scrollRoot.scrollTop = 0;
      return !destroyed;
    }

    async function setOnlyOp(enabled) {
      onlyOp = !!enabled;
      if (onlyOpController) onlyOpController.abort();
      onlyOpController = null;
      await reconcileStream(displayStreamIds(), { forceCommit: true });
      if (!onlyOp) return;
      onlyOpController = new AbortController();
      const controller = onlyOpController;
      const abortScan = () => controller.abort();
      ctx.signal.addEventListener('abort', abortScan, { once: true });
      loader.loadAll(controller.signal, () => {
        if (!destroyed && onlyOp && !controller.signal.aborted) reconcileStream(displayStreamIds()).catch(() => {});
      }).then(() => {
        if (!destroyed && onlyOp && !controller.signal.aborted) return reconcileStream(displayStreamIds());
      }).catch((error) => {
        if (!error || error.name !== 'AbortError') console.warn('[LinuxDo Reader] 只看楼主加载失败', error);
      }).finally(() => ctx.signal.removeEventListener('abort', abortScan));
    }

    async function reconcileStream(nextIds, options) {
      if (destroyed) return;
      const reconciliationInteractionRevision = interactionRevision;
      const preferredNode = preferredFocusPostId
        ? windowEl.querySelector(`.ldp-post[data-post-id="${Number(preferredFocusPostId)}"]`) : null;
      const anchor = logicalIds.length
        ? (pinnedAnchor || manualScrollAnchor || preferredViewportAnchor || captureNodeViewportAnchor(preferredNode)
          || stableViewportAnchor || captureViewportAnchor()) : null;
      const nextLogicalIds = (nextIds || displayStreamIds())
        .filter((id) => !onlyOp || (loader.getPostById(id) || {}).username === ctx.op);
      const streamChanged = nextLogicalIds.length !== logicalIds.length
        || nextLogicalIds.some((id, index) => Number(id) !== Number(logicalIds[index]));
      if (streamChanged) {
        logicalIds = nextLogicalIds;
        heights = logicalIds.map((id) => heightByPostId.get(Number(id)) || DEFAULT_HEIGHT);
        logicalRevision += 1;
        rebuildPrefix();
        mountedStart = mountedEnd = -1;
      }
      const revision = logicalRevision;
      if (!logicalIds.length) {
        withViewportAnchor(() => clearWindow());
        syncSpacers();
        return;
      }
      if (!streamChanged && mountedStart >= 0 && mountedEnd > mountedStart) return;
      let position = anchor && positionByPostId.get(Number(anchor.postId));
      if (position === undefined && anchor && anchor.postNumber) {
        let distance = Infinity;
        logicalIds.forEach((id, index) => {
          const post = loader.getPostById(id);
          const nextDistance = post ? Math.abs(Number(post.post_number) - anchor.postNumber) : Infinity;
          if (nextDistance < distance) { distance = nextDistance; position = index; }
        });
      }
      if (position === undefined) position = Math.max(0, Math.min(logicalIds.length - 1, Number(anchor && anchor.position) || 0));
      const desired = windowAroundPosition(position);
      const committed = await mount(desired.start, desired.end, 'visible', {
        force: true, forceCommit: !!(options && options.forceCommit),
        preserveAnchor: true, anchorOverride: anchor,
      });
      if (committed || destroyed || revision !== logicalRevision
        || reconciliationInteractionRevision !== interactionRevision) return;
      const retryPosition = positionByPostId.get(Number(anchor && anchor.postId));
      const retryWindow = windowAroundPosition(retryPosition === undefined ? position : retryPosition);
      await mount(retryWindow.start, retryWindow.end, 'visible', {
        force: true, forceCommit: true,
        preserveAnchor: true, anchorOverride: anchor,
      });
    }

    rebuildPrefix();
    syncSpacers();
    ctx.withViewportAnchor = withViewportAnchor;
    ctx.refreshRenderRevision = (node) => {
      if (!node || !node.isConnected) return;
      let rootNode = node;
      while (rootNode.parentElement && rootNode.parentElement !== windowEl) rootNode = rootNode.parentElement;
      const post = loader.getPostById(rootNode.dataset.postId);
      if (post) rootNode.dataset.renderRevision = renderTreeRevision(post);
    };
    const unsubscribeStream = loader.subscribeStream(() => requestProjectionReconcile());
    const unsubscribeProjection = loader.subscribeProjection(() => {
      if (!onlyOp) requestProjectionReconcile();
    });
    const unsubscribePosts = loader.subscribePosts((posts) => {
      const root = ctx.commentsEl.closest('.ldp-shell') || ctx.commentsEl;
      posts.forEach((post) => syncRenderedPostState(root, post));
      if (onlyOp && posts.some((post) => post && post.username === ctx.op)) reconcileStream(displayStreamIds()).catch(() => {});
    });
    const releasePinnedAnchor = () => beginManualScroll();
    const releasePinnedOnPointer = (event) => {
      if (event.target === ctx.scrollRoot) beginManualScroll();
      else clearPinnedAnchor();
    };
    const releasePinnedOnKey = (event) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar'].includes(event.key)) {
        beginManualScroll();
      }
    };
    ctx.scrollRoot.addEventListener('scroll', onScroll, { passive: true });
    ctx.scrollRoot.addEventListener('wheel', releasePinnedAnchor, { passive: true });
    ctx.scrollRoot.addEventListener('touchmove', releasePinnedAnchor, { passive: true });
    ctx.scrollRoot.addEventListener('pointerdown', releasePinnedOnPointer, { passive: true });
    document.addEventListener('keydown', releasePinnedOnKey, true);
    return {
      async mountInitial(target) {
        if (Number(target && target.targetPostNumber) <= 1) {
          const initialWindow = windowAroundPosition(0);
          await mount(initialWindow.start, initialWindow.end, 'target', {
            preserveAnchor: false, forceCommit: true,
          });
          return scrollToTop();
        }
        return seekResolvedTarget(target, { smooth: false });
      },
      seekToIndex, seekToPost, scrollToTop, setOnlyOp,
      isNearBottom() {
        return bottomSpacer.offsetHeight <= 4
          && ctx.scrollRoot.scrollHeight - ctx.scrollRoot.clientHeight - ctx.scrollRoot.scrollTop <= Math.max(120, ctx.scrollRoot.clientHeight * 0.35);
      },
      getCurrentPost() {
        const anchor = currentAnchor();
        return visibleRenderedPost() || loader.getPostById(logicalIds[anchor.position]);
      },
      refresh() { onScroll(); },
      destroy() {
        destroyed = true;
        if (onlyOpController) onlyOpController.abort();
        unsubscribeStream(); unsubscribeProjection(); unsubscribePosts();
        cancelAnimationFrame(scrollRaf);
        cancelAnimationFrame(resizeRaf);
        clearTimeout(userScrollTimer);
        userScrollTimer = 0;
        setUserScrollActive(false);
        clearPinnedAnchor();
        clearManualScrollAnchor();
        if (queuedMount) settleMountRequest(queuedMount, false);
        queuedMount = null;
        resizeObserver.disconnect();
        ctx.scrollRoot.removeEventListener('scroll', onScroll);
        ctx.scrollRoot.removeEventListener('wheel', releasePinnedAnchor);
        ctx.scrollRoot.removeEventListener('touchmove', releasePinnedAnchor);
        ctx.scrollRoot.removeEventListener('pointerdown', releasePinnedOnPointer);
        document.removeEventListener('keydown', releasePinnedOnKey, true);
        if (ctx.withViewportAnchor === withViewportAnchor) ctx.withViewportAnchor = null;
        if (ctx.refreshRenderRevision) ctx.refreshRenderRevision = null;
        clearWindow();
      },
    };
  }

  /* ============ 13. 弹窗主体 + 双向分片加载 ============ */
  let CURRENT_OVERLAY = null;
  let CURRENT_MODAL_CLOSE = null;

  function readerIcon(path, viewBox) {
    return `<svg viewBox="${viewBox || '0 0 24 24'}" aria-hidden="true">${path}</svg>`;
  }

  const READER_ICONS = {
    history: readerIcon('<path d="M12 2a10 10 0 1 1-8.4 4.58L2 5v5h5L5.05 8.05A7.5 7.5 0 1 0 12 4.5V2Zm-1 5h2v5.4l3.4 2-1 1.72L11 13.5V7Z"/>'),
    collection: readerIcon('<path d="M4 4h6a3 3 0 0 1 2 1.05A3 3 0 0 1 14 4h6a2 2 0 0 1 2 2v13a1 1 0 0 1-1 1h-7a2 2 0 0 0-2 2 2 2 0 0 0-2-2H3a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2Zm0 2v12h6a4 4 0 0 1 1 .13V7a1 1 0 0 0-1-1H4Zm10 0a1 1 0 0 0-1 1v11.13a4 4 0 0 1 1-.13h6V6h-6Z"/>'),
    bookmark: readerIcon(ICONS.bookmark),
    filter: readerIcon('<path d="M4 5h16v2H4V5Zm3 6h10v2H7v-2Zm3 6h4v2h-4v-2Z"/>'),
    refresh: readerIcon('<path d="M17.65 6.35A8 8 0 1 0 20 12h-2.5a5.5 5.5 0 1 1-1.46-3.73L13 11h7V4l-2.35 2.35Z"/>'),
    autoSync: readerIcon('<path d="M12 3a9 9 0 0 1 8.48 6h-2.18A7 7 0 0 0 6.34 7.88L9 10.5H3v-6l1.92 1.92A8.96 8.96 0 0 1 12 3Zm9 10.5v6l-1.92-1.92A8.96 8.96 0 0 1 12 21a9 9 0 0 1-8.48-6h2.18a7 7 0 0 0 11.96 1.12L15 13.5h6Z"/>'),
    close: readerIcon('<path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z"/>'),
    trash: readerIcon('<path d="M8 3h8l1 2h4v2H3V5h4l1-2Zm-2 6h12l-1 12H7L6 9Zm3 2 .5 8h2L11 11H9Zm4 0-.5 8h2l.5-8h-2Z"/>'),
  };

  function isAutoLoadRepliesEnabled() {
    try {
      const raw = localStorage.getItem(AUTO_LOAD_REPLIES_KEY);
      return raw === null ? true : raw !== '0';
    } catch (e) { return true; }
  }

  function setAutoLoadRepliesEnabled(enabled) {
    try { localStorage.setItem(AUTO_LOAD_REPLIES_KEY, enabled ? '1' : '0'); } catch (e) {}
  }

  function closeReaderPanel(app) {
    if (!app) return;
    if (app.panelAbort) app.panelAbort.abort();
    app.panelAbort = null;
    const panel = app.modal && app.modal.querySelector('.ldp-reader-panel');
    if (panel) panel.remove();
    if (panel && typeof app.onPanelClosed === 'function') app.onPanelClosed();
  }

  function panelItemHtml(item, type) {
    const target = collectionItemTarget(item);
    const title = item.title || item.topic_title || (item.topic && item.topic.title)
      || item.name || `主题 ${target.topicId || ''}`;
    const username = item.username || (item.user && item.user.username) || '';
    const avatarTemplate = item.avatar_template || (item.user && item.user.avatar_template) || '';
    const avatar = avatarTemplate ? resolveAvatar(avatarTemplate, 48) : '';
    const meta = type === 'responses'
      ? `${item._reactionType === 'reaction' ? '自定义回应' : '点赞'} · ${fmtTime(item.created_at || item.acted_at)}`
      : `${target.postNumber > 1 ? `#${target.postNumber}` : '整帖'} · ${username ? `@${username}` : fmtTime(item.created_at)}`;
    return `<div class="ldp-panel-item" data-topic-id="${escAttr(target.topicId || '')}" data-post-number="${target.postNumber}"
      data-record-id="${escAttr(String(item.id || item.bookmark_id || ''))}" data-reaction-type="${escAttr(item._reactionType || '')}"
      data-post-id="${escAttr(String(item.post_id || (String(item.bookmarkable_type).toLowerCase() === 'post' ? item.bookmarkable_id : '') || item.id || ''))}" data-reaction-id="${escAttr(String(item.reaction_id || item.reaction_value || item.reaction || ''))}">
      ${avatar ? `<img class="ldp-panel-avatar" src="${escAttr(avatar)}" alt="">` : '<span class="ldp-panel-avatar"></span>'}
      <button type="button" class="ldp-panel-item-main"><span class="ldp-panel-item-title">${esc(title)}</span><span class="ldp-panel-item-meta">${esc(meta)}</span></button>
      <button type="button" class="ldp-panel-delete" title="移除" aria-label="移除">${READER_ICONS.trash}</button>
    </div>`;
  }

  function showHistoryPanel(app) {
    closeReaderPanel(app);
    const panel = document.createElement('section');
    panel.className = 'ldp-reader-panel';
    panel.innerHTML = `<div class="ldp-panel-head"><strong>浏览历史</strong><button class="ldp-panel-close" title="关闭">×</button></div>
      <input class="ldp-panel-search" type="search" placeholder="搜索标题或作者" aria-label="搜索浏览历史">
      <div class="ldp-panel-list"></div>
      <div class="ldp-panel-foot"><button type="button" data-panel-action="clear">清空历史</button><span></span><div><button type="button" data-panel-action="prev">上一页</button> <button type="button" data-panel-action="next">下一页</button></div></div>`;
    app.modal.appendChild(panel);
    let page = 0;
    const pageSize = 20;
    const search = panel.querySelector('.ldp-panel-search');
    const list = panel.querySelector('.ldp-panel-list');
    const pageText = panel.querySelector('.ldp-panel-foot span');
    const render = () => {
      const query = search.value.trim().toLowerCase();
      const entries = getHistoryEntries().filter((item) => !query
        || `${item.title} ${item.username}`.toLowerCase().includes(query));
      const pages = Math.max(1, Math.ceil(entries.length / pageSize));
      page = Math.max(0, Math.min(pages - 1, page));
      const slice = entries.slice(page * pageSize, (page + 1) * pageSize);
      list.innerHTML = slice.length ? slice.map((item) => panelItemHtml({
        id: item.topicId, topic_id: item.topicId, post_number: item.lastPostNumber,
        title: item.title, username: item.username, avatar_template: item.avatar,
        created_at: new Date(item.lastViewedAt).toISOString(),
      }, 'history')).join('') : '<div class="ldp-panel-empty">暂无浏览历史</div>';
      pageText.textContent = `${page + 1} / ${pages}`;
    };
    panel.querySelector('.ldp-panel-close').addEventListener('click', () => closeReaderPanel(app));
    search.addEventListener('input', () => { page = 0; render(); });
    panel.addEventListener('click', (event) => {
      const row = event.target.closest('.ldp-panel-item');
      if (event.target.closest('.ldp-panel-item-main') && row) {
        closeReaderPanel(app);
        app.loadTopic(row.dataset.topicId, Number(row.dataset.postNumber));
      } else if (event.target.closest('.ldp-panel-delete') && row) {
        saveHistoryEntries(getHistoryEntries().filter((item) => String(item.topicId) !== row.dataset.topicId));
        render();
      } else if (event.target.closest('[data-panel-action="clear"]')) {
        if (confirm('清空当前账号在本站的全部浏览历史？')) { saveHistoryEntries([]); render(); }
      } else if (event.target.closest('[data-panel-action="prev"]')) { page -= 1; render(); }
      else if (event.target.closest('[data-panel-action="next"]')) { page += 1; render(); }
    });
    render();
    search.focus({ preventScroll: true });
  }

  function showCollectionPanel(app) {
    closeReaderPanel(app);
    const controller = new AbortController();
    app.panelAbort = controller;
    const panel = document.createElement('section');
    panel.className = 'ldp-reader-panel';
    panel.innerHTML = `<div class="ldp-panel-head"><strong>收藏与回应</strong><button class="ldp-panel-close" title="关闭">×</button></div>
      <input class="ldp-panel-search" type="search" placeholder="搜索收藏与回应" aria-label="搜索收藏与回应">
      <div class="ldp-panel-tabs">
        <button class="ldp-panel-tab active" data-tab="responses">回应</button>
        <button class="ldp-panel-tab" data-tab="topics">帖子</button>
        <button class="ldp-panel-tab" data-tab="posts">楼层</button>
      </div><div class="ldp-panel-list"><div class="ldp-panel-loading">正在读取…</div></div>
      <div class="ldp-panel-foot"><span></span><div><button type="button" data-panel-action="prev">上一页</button> <button type="button" data-panel-action="next">下一页</button></div></div>`;
    app.modal.appendChild(panel);
    const state = { tab: 'responses', page: 0, bookmarks: null, responses: null };
    let tabController = null;
    const pageSize = 20;
    const list = panel.querySelector('.ldp-panel-list');
    const search = panel.querySelector('.ldp-panel-search');
    const pageText = panel.querySelector('.ldp-panel-foot span');

    const itemsForTab = () => {
      if (state.tab === 'responses') return state.responses || [];
      return (state.bookmarks || []).filter((item) => {
        const target = collectionItemTarget(item);
        const isPost = String(item.bookmarkable_type || '').toLowerCase() === 'post' || target.postNumber > 1;
        return state.tab === 'posts' ? isPost : !isPost;
      });
    };
    const render = () => {
      const query = search.value.trim().toLowerCase();
      const items = itemsForTab().filter((item) => !query || JSON.stringify([
        item.title, item.topic_title, item.username, item.name,
      ]).toLowerCase().includes(query));
      const pages = Math.max(1, Math.ceil(items.length / pageSize));
      state.page = Math.max(0, Math.min(pages - 1, state.page));
      const slice = items.slice(state.page * pageSize, (state.page + 1) * pageSize);
      list.innerHTML = slice.length ? slice.map((item) => panelItemHtml(item, state.tab === 'responses' ? 'responses' : 'bookmarks')).join('')
        : '<div class="ldp-panel-empty">此分类暂无内容</div>';
      pageText.textContent = `${state.page + 1} / ${pages}`;
    };
    const loadTab = async () => {
      if (tabController) tabController.abort();
      tabController = new AbortController();
      const activeController = tabController;
      const abortTab = () => activeController.abort();
      controller.signal.addEventListener('abort', abortTab, { once: true });
      list.innerHTML = '<div class="ldp-panel-loading">正在读取…</div>';
      try {
        if (state.tab === 'responses' && !state.responses) state.responses = await loadResponsesCollection(activeController.signal);
        if (state.tab !== 'responses' && !state.bookmarks) state.bookmarks = await loadBookmarksCollection(activeController.signal);
        if (activeController.signal.aborted) return;
        render();
      } catch (error) {
        if (error && error.name === 'AbortError') return;
        list.innerHTML = `<div class="ldp-panel-error">读取失败：${esc(error.message)}</div>`;
      } finally { controller.signal.removeEventListener('abort', abortTab); }
    };
    panel.querySelector('.ldp-panel-close').addEventListener('click', () => closeReaderPanel(app));
    panel.querySelector('.ldp-panel-tabs').addEventListener('click', (event) => {
      const tab = event.target.closest('[data-tab]');
      if (!tab) return;
      state.tab = tab.dataset.tab; state.page = 0;
      panel.querySelectorAll('.ldp-panel-tab').forEach((button) => button.classList.toggle('active', button === tab));
      loadTab();
    });
    search.addEventListener('input', () => { state.page = 0; render(); });
    panel.addEventListener('click', async (event) => {
      const row = event.target.closest('.ldp-panel-item');
      if (event.target.closest('.ldp-panel-item-main') && row && row.dataset.topicId) {
        closeReaderPanel(app); app.loadTopic(row.dataset.topicId, Number(row.dataset.postNumber)); return;
      }
      if (event.target.closest('.ldp-panel-delete') && row) {
        const button = event.target.closest('.ldp-panel-delete'); button.disabled = true;
        try {
          if (state.tab === 'responses') {
            if (row.dataset.reactionType === 'like') {
              await apiSend(`${BASE}/post_actions/${row.dataset.postId}?post_action_type_id=2`, 'DELETE');
              if (app.loader) app.loader.updatePost(row.dataset.postId, (post) => {
                const actions = Array.isArray(post.actions_summary) ? post.actions_summary.map((item) => Object.assign({}, item)) : [];
                const like = actions.find((item) => Number(item.id) === 2);
                if (like) { like.acted = false; like.count = Math.max(0, Number(like.count || 0) - 1); }
                post.actions_summary = actions; return post;
              });
            } else if (row.dataset.postId && row.dataset.reactionId) {
              await apiSend(`${BASE}/discourse-reactions/posts/${row.dataset.postId}/custom-reactions/${encodeURIComponent(row.dataset.reactionId)}/toggle.json`, 'PUT');
              if (app.loader) app.loader.updatePost(row.dataset.postId, (post) => {
                const reactions = Array.isArray(post.reactions) ? post.reactions.map((item) => Object.assign({}, item)) : [];
                const reaction = reactions.find((item) => String(item.id) === row.dataset.reactionId);
                if (reaction) reaction.count = Math.max(0, Number(reaction.count || 0) - 1);
                post.reactions = reactions.filter((item) => Number(item.count) > 0);
                post.current_user_reaction = null; return post;
              });
            }
            state.responses = (state.responses || []).filter((item) => {
              const postId = String(item.post_id || item.id || '');
              const reactionId = String(item.reaction_id || item.reaction_value || item.reaction || '');
              return postId !== row.dataset.postId || reactionId !== String(row.dataset.reactionId || '');
            });
            await invalidateCollectionCache('responses');
          } else if (row.dataset.recordId) {
            await apiSend(`${BASE}/bookmarks/${row.dataset.recordId}`, 'DELETE');
            if (app.loader && row.dataset.postId) app.loader.updatePost(row.dataset.postId, {
              bookmarked: false, bookmark_id: null,
            });
            state.bookmarks = (state.bookmarks || []).filter((item) => String(item.id || item.bookmark_id) !== row.dataset.recordId);
            await invalidateCollectionCache('bookmarks');
          }
          render();
        } catch (error) { alert('移除失败：' + error.message); }
        finally { if (button.isConnected) button.disabled = false; }
      } else if (event.target.closest('[data-panel-action="prev"]')) { state.page -= 1; render(); }
      else if (event.target.closest('[data-panel-action="next"]')) { state.page += 1; render(); }
    });
    loadTab();
  }

  let READER_APP = null;
  function createReaderApp() {
    const overlay = document.createElement('div');
    overlay.className = 'ldp-overlay ldp-v2';
    overlay.innerHTML = `<div class="ldp-modal" role="dialog" aria-modal="true" aria-labelledby="ldp-reader-title">
      <header class="ldp-header">
        <div class="ldp-header-line">
          <img class="ldp-site-mark" src="${escAttr(document.querySelector('link[rel="icon"]')?.href || 'https://cdn3.ldstatic.com/optimized/4X/6/a/6/6a6affc7b1ce8140279e959d32671304db06d5ab_2_180x180.png')}" alt="">
          <div class="ldp-header-main"><div class="ldp-title-lockup">
            <div class="ldp-title-copy"><h2 class="ldp-title" id="ldp-reader-title"><span class="ldp-sk ldp-sk-title"></span></h2>
              <div class="ldp-meta"><span class="ldp-sk ldp-sk-meta"></span><span class="ldp-topic-taxonomy"></span></div></div></div></div>
          <button class="ldp-close ldp-header-close" title="关闭" aria-label="关闭">${READER_ICONS.close}</button>
        </div>
        <div class="ldp-toolbar">
          <div class="ldp-toolbar-group">
            <button class="ldp-toolbtn" data-reader-action="only-op" title="只看楼主">${READER_ICONS.filter}</button>
            <button class="ldp-toolbtn ${isAutoLoadRepliesEnabled() ? 'active' : ''}" data-reader-action="auto-load" title="自动载入新回复（${isAutoLoadRepliesEnabled() ? '已开启' : '已暂停'}）">${READER_ICONS.autoSync}</button>
          </div>
          <div class="ldp-head-btns">
            <button class="ldp-toolbtn" data-reader-action="history" title="浏览历史">${READER_ICONS.history}</button>
            <button class="ldp-toolbtn ldp-collections-tool" data-reader-action="collections" title="收藏与回应">${READER_ICONS.collection}</button>
            <span class="ldp-tool-separator"></span>
            <span class="ldp-obsidian-host"></span>
            <button class="ldp-toolbtn" data-reader-action="refresh" title="清除当前主题缓存并刷新">${READER_ICONS.refresh}</button>
            <span class="ldp-settings-host"></span>
          </div>
        </div>
      </header><div class="ldp-shell-host"></div>
      <footer class="ldp-footer" hidden>
        <button class="ldp-fbtn ldp-f-like" disabled title="点赞（悬停选择表情）"><span class="ldp-f-like-icon"><svg viewBox="0 0 24 24">${ICONS.like}</svg></span><span class="ldp-f-like-count">0</span></button>
        <button class="ldp-fbtn ldp-f-reply" title="回复帖子"><svg viewBox="0 0 1024 1024">${ICONS.reply}</svg><span class="ldp-f-reply-count">0</span></button>
        <button class="ldp-fbtn ldp-f-boost" title="给楼主发送 Boost"><svg viewBox="0 0 1024 1024">${ICONS.boost}</svg><span>Boost</span></button>
        <button class="ldp-fbtn ldp-f-bookmark" title="收藏本帖"><svg viewBox="0 0 24 24">${ICONS.bookmark}</svg><span>收藏</span></button>
        <a class="ldp-fbtn ldp-f-open" href="#" target="_blank" rel="noopener" title="打开原帖"><svg viewBox="0 0 24 24">${ICONS.newTab}</svg><span>原帖</span></a>
      </footer>
      <button class="ldp-new-posts" hidden></button></div>`;
    document.body.appendChild(overlay);
    const modal = overlay.querySelector('.ldp-modal');
    const app = {
      overlay, modal, topicId: null, targetPostNumber: 1, topic: null, loader: null,
      controller: null, virtualFlow: null, tracker: null, timeline: null, stopBase64: null,
      repliesIO: null, refreshTimer: null, stopLiveSync: null, panelAbort: null,
      onlyOp: false, autoLoadReplies: isAutoLoadRepliesEnabled(), closed: false,
      loadTopic: null, close: null,
    };

    const cleanupTopic = () => {
      clearInterval(app.refreshTimer); app.refreshTimer = null;
      if (app.stopLiveSync) { app.stopLiveSync(); app.stopLiveSync = null; }
      if (app.controller) app.controller.abort();
      if (app.virtualFlow) app.virtualFlow.destroy();
      if (app.repliesIO) app.repliesIO.disconnect();
      if (app.timeline) app.timeline.destroy();
      if (app.tracker) app.tracker.stop();
      if (app.loader) app.loader.destroy();
      if (app.stopBase64) app.stopBase64();
      closeEmojiPanels();
      app.controller = app.virtualFlow = app.timeline = app.tracker = app.repliesIO = app.loader = app.stopBase64 = null;
      flushHistoryEntries();
    };

    app.close = () => {
      if (app.closed) return;
      app.closed = true;
      closeEmojiPanels(); closeReaderPanel(app); closeUserCard(); cleanupTopic();
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      if (CURRENT_OVERLAY === overlay) CURRENT_OVERLAY = null;
      if (CURRENT_MODAL_CLOSE === app.close) CURRENT_MODAL_CLOSE = null;
      if (READER_APP === app) READER_APP = null;
    };
    function onKeyDown(event) {
      if (event.key !== 'Escape' || document.querySelector('.ldp-lightbox') || CURRENT_USER_CARD) return;
      if (closeEmojiPanels()) return;
      if (modal.querySelector('.ldp-reader-panel')) closeReaderPanel(app); else app.close();
    }
    document.addEventListener('keydown', onKeyDown);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) app.close(); });
    modal.querySelector('.ldp-close').addEventListener('click', app.close);

    modal.querySelector('.ldp-toolbar').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-reader-action]');
      if (!button) return;
      const action = button.dataset.readerAction;
      if (action === 'history') showHistoryPanel(app);
      else if (action === 'collections') showCollectionPanel(app);
      else if (action === 'only-op' && app.virtualFlow) {
        button.disabled = true;
        app.onlyOp = !app.onlyOp;
        button.classList.toggle('active', app.onlyOp);
        try { await app.virtualFlow.setOnlyOp(app.onlyOp); }
        finally { button.disabled = false; }
      } else if (action === 'auto-load') {
        app.autoLoadReplies = !app.autoLoadReplies;
        setAutoLoadRepliesEnabled(app.autoLoadReplies);
        button.classList.toggle('active', app.autoLoadReplies);
        button.title = `自动载入新回复（${app.autoLoadReplies ? '已开启' : '已暂停'}）`;
      } else if (action === 'refresh' && app.topicId) {
        const id = app.topicId, target = (app.virtualFlow && app.virtualFlow.getCurrentPost() || {}).post_number || app.targetPostNumber;
        await invalidateTopicSnapshot(id); app.loadTopic(id, target, { forceNetwork: true });
      }
    });

    modal.querySelector('.ldp-new-posts').addEventListener('click', () => {
      const notice = modal.querySelector('.ldp-new-posts');
      const target = Number(notice.dataset.postNumber) || 1;
      notice.hidden = true;
      if (app.virtualFlow) {
        app.virtualFlow.seekToPost(target).catch(() => {});
      } else {
        app.loadTopic(app.topicId, target, { forceNetwork: true });
      }
    });

    app.loadTopic = async (topicId, targetPostNumber, options) => {
      cleanupTopic(); closeReaderPanel(app); closeUserCard();
      app.topicId = String(topicId); app.targetPostNumber = Number(targetPostNumber) || 0; app.onlyOp = false;
      modal.querySelector('[data-reader-action="only-op"]').classList.remove('active');
      modal.querySelector('.ldp-title').innerHTML = '<span class="ldp-sk ldp-sk-title"></span>';
      modal.querySelector('.ldp-meta').innerHTML = '<span class="ldp-sk ldp-sk-meta"></span><span class="ldp-topic-taxonomy"></span>';
      modal.querySelector('.ldp-new-posts').hidden = true;
      modal.querySelectorAll('.ldp-f-open').forEach((link) => { link.href = `${BASE}/t/${topicId}`; });
      modal.querySelector('.ldp-footer').hidden = true;
      const shellHost = modal.querySelector('.ldp-shell-host');
      shellHost.innerHTML = `<div class="ldp-shell"><div class="ldp-body"><div class="ldp-topic"></div>
        <div class="ldp-comments-header">回应<span class="ldp-comments-count"></span></div><div class="ldp-comments"></div>
        <div class="ldp-loadmask">${SKELETON_HTML}</div></div>
        <aside class="ldp-timeline" aria-label="帖子时间轴"><button class="ldp-tl-date ldp-tl-top-date">顶部</button>
          <div class="ldp-tl-current"><strong class="ldp-tl-current-post">1 / 1</strong><span class="ldp-tl-current-date">当前</span></div>
          <button class="ldp-tl-track" role="slider" aria-label="滚动位置"><span class="ldp-tl-fill"></span><span class="ldp-tl-thumb"></span></button>
          <button class="ldp-tl-date ldp-tl-bottom-date">底部</button></aside></div>`;
      const shell = shellHost.querySelector('.ldp-shell');
      const body = shell.querySelector('.ldp-body');
      const topicEl = shell.querySelector('.ldp-topic');
      const commentsEl = shell.querySelector('.ldp-comments');
      const mask = shell.querySelector('.ldp-loadmask');
      const controller = new AbortController();
      app.controller = controller;
      const loader = createLoaderV2(topicId, controller.signal);
      app.loader = loader;
      const tracker = createReadTracker(topicId, body);
      app.tracker = tracker;
      const ctx = {
        topicId, op: null, topicEl, commentsEl, countEl: shell.querySelector('.ldp-comments-count'), emptyEl: null,
        scrollRoot: body, nodeMap: new Map(), pending: [], tracker, totalComments: 0,
        subReplyState: new Map(), subReplyCache: new Map(), windowEpoch: 1,
        onPostsChanged: null, onMutation: () => { if (app.timeline) app.timeline.refresh(); },
        signal: controller.signal, loader, topic: null, repliesIO: null, virtualFlow: null,
      };
      ctx.repliesIO = createRepliesIO(ctx);
      app.repliesIO = ctx.repliesIO;
      try {
        const topic = await loader.init(targetPostNumber, options);
        if (controller.signal.aborted) return;
        app.topic = topic;
        ctx.topic = topic;
        ctx.op = topic._opUsername;
        ctx.totalComments = Math.max(0, Number(topic.posts_count || topic.highest_post_number || 1) - 1);
        ctx.lastReadPostNumber = Number(topic.last_read_post_number) || 0;
        tracker.setReadWaterline(ctx.lastReadPostNumber);
        modal.querySelector('.ldp-title').textContent = topic.title || `主题 ${topicId}`;
        const resolveDomCategoryName = (catId) => {
          if (!catId) return '';
          const badge = document.querySelector(`.badge-category[data-category-id="${CSS.escape(String(catId))}"] .badge-category__name`);
          return badge ? badge.textContent.trim() : '';
        };
        const renderTaxonomy = (categoryName, tagList) => {
          const taxonomy = [];
          if (categoryName && categoryName !== '未分类') {
            taxonomy.push(`<span class="ldp-topic-chip ldp-topic-category-chip">${esc(categoryName)}</span>`);
          }
          (tagList || []).forEach((tag) => {
            const tagName = typeof tag === 'string' ? tag : (tag && tag.name);
            if (tagName) taxonomy.push(`<span class="ldp-topic-chip">#${esc(tagName)}</span>`);
          });
          const target = modal.querySelector('.ldp-topic-taxonomy');
          if (target) target.innerHTML = taxonomy.join('');
        };
        const category = topic.category_name || (topic.category && topic.category.name) || resolveDomCategoryName(topic.category_id);
        modal.querySelector('.ldp-meta').innerHTML = `<span>${Number(topic.posts_count) || 1} 帖 · ${Number(topic.views) || 0} 浏览 · 楼主 @${esc(ctx.op || '?')}</span><span class="ldp-topic-taxonomy"></span>`;
        renderTaxonomy(category, topic.tags);
        if (!category && topic.category_id) {
          getObsidianCategoryName(topic).then((name) => {
            if (!controller.signal.aborted && String(app.topicId) === String(topicId)) renderTaxonomy(name, (app.topic && app.topic.tags) || topic.tags);
          }).catch(() => {});
        }
        shell.querySelector('.ldp-comments-count').textContent = `（${ctx.totalComments}）`;
        let opNode = null;
        if (topic._opPost) {
          opNode = renderPost(topic._opPost, false, ctx);
          topicEl.appendChild(opNode); tracker.observe(opNode);
        }
        const obsidianHost = modal.querySelector('.ldp-obsidian-host');
        const obsidianActions = createObsidianActionGroup(topicId, () => app.topic);
        const settingsButton = obsidianActions.querySelector('.ldp-obsidian-settings');
        obsidianHost.replaceChildren(obsidianActions);
        modal.querySelector('.ldp-settings-host').replaceChildren(settingsButton);
        const oldFooter = modal.querySelector('.ldp-footer');
        const footer = oldFooter.cloneNode(true); oldFooter.replaceWith(footer);
        bindBookmarks([footer.querySelector('.ldp-f-bookmark')], topic);
        app.stopBase64 = bindModalBase64Selection(shell);
        bindActions(shell, ctx);
        if (opNode) bindReaderFooter(footer, ctx, topic, opNode);
        footer.hidden = false;
        tracker.start();
        const target = await loader.resolveThreadTarget(resolveInitialTarget(topic, targetPostNumber), controller.signal);
        if (controller.signal.aborted) return;
        const virtualFlow = createVirtualFlow(loader, ctx);
        app.virtualFlow = virtualFlow;
        ctx.virtualFlow = virtualFlow;
        const noticeEl = modal.querySelector('.ldp-new-posts');
        const controls = {
          getStreamLength: () => loader.streamLength,
          getTotalPosts: () => Number((loader.topic && (loader.topic.highest_post_number || loader.topic.posts_count)) || ctx.totalComments + 1),
          getStreamIndex: (postId) => loader.getStreamIndex(postId),
          scrollToTop: () => virtualFlow.scrollToTop(),
          onReachBottom: () => { if (noticeEl && !noticeEl.hidden) noticeEl.hidden = true; },
          seekToIndex: async (index, postNumber) => {
            if (Number(postNumber) <= 1) return virtualFlow.scrollToTop();
            return virtualFlow.seekToIndex(index, postNumber, { smooth: true });
          },
        };
        app.timeline = bindTimeline(shell, ctx, topic, controls);
        ctx.onPostsChanged = app.timeline.refresh;
        await virtualFlow.mountInitial(target);
        app.timeline.refresh();
        requestAnimationFrame(() => { if (app.timeline) app.timeline.refresh(); });
        if (controller.signal.aborted) return;
        mask.classList.add('hide'); setTimeout(() => mask.remove(), 260);
        rememberTopicHistory(topic, target.targetPostNumber || target.postNumber);
        if (loader.refreshPromise) loader.refreshPromise.then((latest) => {
          if (!latest || controller.signal.aborted || String(app.topicId) !== String(topicId)) return;
          app.topic = latest; ctx.topic = latest; ctx.op = latest._opUsername || ctx.op;
          ctx.totalComments = Math.max(0, Number(latest.posts_count || latest.highest_post_number || 1) - 1);
          modal.querySelector('.ldp-title').textContent = latest.title || `主题 ${topicId}`;
          const meta = modal.querySelector('.ldp-meta > span:first-child');
          if (meta) meta.textContent = `${Number(latest.posts_count) || 1} 帖 · ${Number(latest.views) || 0} 浏览 · 楼主 @${ctx.op || '?'}`;
          shell.querySelector('.ldp-comments-count').textContent = `（${ctx.totalComments}）`;
          const categoryName = latest.category_name || (latest.category && latest.category.name) || resolveDomCategoryName(latest.category_id);
          renderTaxonomy(categoryName, latest.tags);
        }).catch(() => {});

        let syncingNewReplies = false;
        let pendingNoticeCount = 0;
        const syncNewReplies = async () => {
          if (!app.autoLoadReplies || syncingNewReplies || document.visibilityState !== 'visible' || controller.signal.aborted) return;
          syncingNewReplies = true;
          try {
            const latest = await fetchJSON(`${BASE}/t/${topicId}.json?track_visit=false`, {
              signal: controller.signal,
              cache: 'no-store',
              priority: 'background',
              dedupeKey: `auto-sync:${BASE}:${topicId}:${Math.floor(Date.now() / 3000)}`,
            });
            if (controller.signal.aborted || String(app.topicId) !== String(topicId)) return;
            const wasNearBottom = virtualFlow.isNearBottom();
            const opId = Number((topic._opPost && topic._opPost.id) || 0);
            const existingSet = new Set(loader.getStreamIds().map(Number));
            const latestStream = ((latest.post_stream && latest.post_stream.stream) || [])
              .map(Number)
              .filter((id) => id > 0 && id !== opId);
            const missingNewIds = latestStream.filter((id) => !existingSet.has(id));
            if (!missingNewIds.length) {
              const currentTopic = loader.topic || topic;
              const nextViews = Number(latest.views) || 0;
              if (nextViews > (Number(currentTopic.views) || 0)) {
                loader.syncLatestTopic(latest);
                const meta = modal.querySelector('.ldp-meta > span:first-child');
                if (meta && loader.topic) {
                  meta.textContent = `${Number(loader.topic.posts_count) || 1} 帖 · ${Number(loader.topic.views) || 0} 浏览 · 楼主 @${ctx.op || '?'}`;
                }
              }
              return;
            }

            // 自动拉取新增回复实体并无刷新注入虚拟流与楼中楼
            await loader.fetchIds(missingNewIds, 'background', controller.signal);
            if (controller.signal.aborted || String(app.topicId) !== String(topicId)) return;
            const { topic: syncedTopic } = loader.syncLatestTopic(latest);
            if (syncedTopic) { app.topic = syncedTopic; ctx.topic = syncedTopic; }

            let newestPostNumber = Number((syncedTopic && syncedTopic.highest_post_number) || 1);
            missingNewIds.forEach((id) => {
              const newPost = loader.getPostById(id);
              if (!newPost) return;
              newestPostNumber = Math.max(newestPostNumber, Number(newPost.post_number) || 1);
              const parentNum = Number(newPost.reply_to_post_number) || 0;
              if (parentNum > 1) {
                const parentPost = loader.getPostByNumber(parentNum);
                if (parentPost) {
                  const known = loader.getKnownChildren(parentNum);
                  loader.updatePost(parentPost.id, {
                    reply_count: Math.max(Number(parentPost.reply_count) || 0, known.length),
                  });
                  const cacheKey = String(parentPost.id);
                  if (ctx.subReplyCache.has(cacheKey)) {
                    const prev = ctx.subReplyCache.get(cacheKey) || [];
                    if (!prev.some((r) => Number(r.id) === Number(newPost.id))) {
                      ctx.subReplyCache.set(cacheKey, [...prev, newPost]);
                    }
                  }
                  const state = mergeSubReplyState(parentNum, known, ctx);
                  if (state.renderedCount >= Math.max(0, state.all.length - missingNewIds.length)) {
                    state.renderedCount = state.all.length;
                  }
                  renderSubReplyState(parentNum, ctx);
                }
              }
            });

            const updatedTopic = loader.topic || topic;
            ctx.totalComments = Math.max(0, Number(updatedTopic.posts_count || updatedTopic.highest_post_number || 1) - 1);
            updateCommentsHeader(ctx);
            const meta = modal.querySelector('.ldp-meta > span:first-child');
            if (meta) {
              meta.textContent = `${Number(updatedTopic.posts_count) || 1} 帖 · ${Number(updatedTopic.views) || 0} 浏览 · 楼主 @${ctx.op || '?'}`;
            }
            const bottomDateBtn = shell.querySelector('.ldp-tl-bottom-date');
            if (bottomDateBtn && updatedTopic.last_posted_at) {
              bottomDateBtn.textContent = fmtDate(updatedTopic.last_posted_at) || '底部';
            }
            if (app.timeline) app.timeline.refresh();
            virtualFlow.refresh();

            if (!wasNearBottom && noticeEl) {
              pendingNoticeCount = (noticeEl.hidden ? 0 : pendingNoticeCount) + missingNewIds.length;
              noticeEl.textContent = `已自动载入 ${pendingNoticeCount} 条新回复 · 点击查看 ↓`;
              noticeEl.dataset.postNumber = String(newestPostNumber);
              noticeEl.hidden = false;
            } else if (noticeEl) {
              pendingNoticeCount = 0;
              noticeEl.hidden = true;
            }
          } catch (error) { /* 后台自动同步失败不打断阅读 */ }
          finally { syncingNewReplies = false; }
        };

        let liveDebounceTimer = 0;
        const onLiveTopicMessage = (liveTopicId, payload) => {
          if (String(liveTopicId) !== String(topicId) || !app.autoLoadReplies) return;
          if (payload && (payload.type === 'created' || payload.type === 'revised' || payload.id)) {
            clearTimeout(liveDebounceTimer);
            liveDebounceTimer = setTimeout(syncNewReplies, 400);
          }
        };
        const onVisibilityChange = () => {
          if (document.visibilityState === 'visible') syncNewReplies();
        };
        TOPIC_LIVE_LISTENERS.add(onLiveTopicMessage);
        document.addEventListener('visibilitychange', onVisibilityChange);
        app.stopLiveSync = () => {
          clearTimeout(liveDebounceTimer);
          TOPIC_LIVE_LISTENERS.delete(onLiveTopicMessage);
          document.removeEventListener('visibilitychange', onVisibilityChange);
        };
        app.refreshTimer = setInterval(syncNewReplies, AUTO_REFRESH_INTERVAL);
      } catch (error) {
        if (error && error.name === 'AbortError') return;
        mask.remove(); body.innerHTML = `<div class="ldp-error">加载失败：${esc(error.message)}</div>`;
      }
    };

    CURRENT_OVERLAY = overlay;
    CURRENT_MODAL_CLOSE = app.close;
    return app;
  }

  function openModalV2(topicId, targetPostNumber) {
    closeUserCard();
    if (!READER_APP || READER_APP.closed || !READER_APP.overlay.isConnected) READER_APP = createReaderApp();
    return READER_APP.loadTopic(topicId, targetPostNumber);
  }

  let PAGE_COLLECTION_MENU = null;
  function disposePageCollectionMenu() {
    const current = PAGE_COLLECTION_MENU;
    if (!current) return;
    PAGE_COLLECTION_MENU = null;
    if (current.app.panelAbort) current.app.panelAbort.abort();
    current.button.setAttribute('aria-expanded', 'false');
    current.button.classList.remove('active');
    current.host.remove();
    document.removeEventListener('pointerdown', current.onPointerDown, true);
    document.removeEventListener('keydown', current.onKeyDown, true);
    window.removeEventListener('resize', current.position);
  }

  function openPageCollectionMenu(button) {
    if (!button) return;
    if (PAGE_COLLECTION_MENU && PAGE_COLLECTION_MENU.button === button) {
      closeReaderPanel(PAGE_COLLECTION_MENU.app);
      return;
    }
    disposePageCollectionMenu();
    const host = document.createElement('div');
    host.className = 'ldp-page-collection-host';
    document.body.appendChild(host);
    const app = {
      modal: host,
      panelAbort: null,
      onPanelClosed: disposePageCollectionMenu,
      loadTopic(topicId, postNumber) {
        disposePageCollectionMenu();
        openModalV2(topicId, postNumber);
      },
    };
    Object.defineProperty(app, 'loader', {
      get() { return READER_APP && !READER_APP.closed ? READER_APP.loader : null; },
    });
    showCollectionPanel(app);
    const panel = host.querySelector('.ldp-reader-panel');
    if (!panel) {
      disposePageCollectionMenu();
      return;
    }
    panel.classList.add('ldp-page-collection-panel');
    const position = () => {
      if (!button.isConnected || !panel.isConnected) {
        disposePageCollectionMenu();
        return;
      }
      const rect = button.getBoundingClientRect();
      const top = Math.max(8, Math.round(rect.bottom + 8));
      panel.style.top = `${top}px`;
      panel.style.height = `${Math.max(240, Math.min(560, window.innerHeight - top - 12))}px`;
      if (window.innerWidth <= 560) {
        panel.style.left = '8px';
        panel.style.right = '8px';
        panel.style.width = 'auto';
      } else {
        panel.style.left = 'auto';
        const panelWidth = Math.min(420, window.innerWidth - 16);
        const desiredRight = Math.round(window.innerWidth - rect.right);
        const maxRight = Math.max(8, window.innerWidth - panelWidth - 8);
        panel.style.right = `${Math.max(8, Math.min(maxRight, desiredRight))}px`;
        panel.style.width = 'min(420px, calc(100vw - 16px))';
      }
    };
    const onPointerDown = (event) => {
      if (!host.contains(event.target) && !button.contains(event.target)) closeReaderPanel(app);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') closeReaderPanel(app);
    };
    PAGE_COLLECTION_MENU = { app, host, button, panel, position, onPointerDown, onKeyDown };
    button.setAttribute('aria-expanded', 'true');
    button.classList.add('active');
    position();
    setTimeout(() => {
      if (PAGE_COLLECTION_MENU && PAGE_COLLECTION_MENU.app === app) {
        document.addEventListener('pointerdown', onPointerDown, true);
      }
    }, 0);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', position);
  }

  function startPageCollectionAction() {
    let scheduled = false;
    const ensureButton = () => {
      scheduled = false;
      const icons = document.querySelector('.d-header-icons');
      const language = icons && icons.querySelector(':scope > .language-switcher');
      const signedIn = icons && icons.querySelector(':scope > #current-user');
      if (!icons || !signedIn) {
        document.querySelectorAll('.ldp-page-collections-item').forEach((item) => item.remove());
        if (PAGE_COLLECTION_MENU && !PAGE_COLLECTION_MENU.button.isConnected) disposePageCollectionMenu();
        return;
      }
      let item = icons.querySelector(':scope > .ldp-page-collections-item');
      if (!item) {
        item = document.createElement('li');
        item.className = 'header-dropdown-toggle ldp-page-collections-item';
        item.innerHTML = `<button type="button" class="btn no-text btn-icon icon btn-flat ldp-page-collections-button"
          title="收藏与回应" aria-label="收藏与回应" aria-haspopup="dialog" aria-expanded="false">${READER_ICONS.collection}</button>`;
        icons.insertBefore(item, language || icons.firstElementChild);
        item.querySelector('button').addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openPageCollectionMenu(event.currentTarget);
        });
      } else if (language && item.nextElementSibling !== language) {
        icons.insertBefore(item, language);
      }
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(ensureButton);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    schedule();
  }

  /* ============ 14. 拦截标题 / 通知点击 ============ */
  document.addEventListener('click', function (e) {
    const a = e.target.closest('a.title, a.raw-topic-link, a.search-link, a.search-result-topic, a[href*="/t/"]');
    if (!a || a.classList.contains('ldp-link-open') || a.classList.contains('ldp-f-open')) return;
    const inMenu = !!a.closest(MENU_PANEL_SEL), inSearch = !!a.closest(SEARCH_SEL);
    const isTitle = a.classList.contains('title') || a.classList.contains('raw-topic-link') || a.classList.contains('search-link') || a.classList.contains('search-result-topic');
    if (!isTitle && !inMenu && !inSearch) return;
    const parsed = parseTopicHref(a.getAttribute('href') || '');
    if (!parsed) return;
    e.preventDefault(); e.stopPropagation();
    const directTarget = inMenu && parsed.targetPostNumber ? parsed.targetPostNumber : 0;
    openModalV2(parsed.topicId, directTarget);
  }, true);

  /* ============ 15. 话题列表“发帖时间列”（整合自 linux.do 发帖时间列） ============ */
  function startTopicCreatedColumn() {
    if (window.top !== window.self) return;

    const pad2 = (n) => (n < 10 ? '0' : '') + n;
    const formatCreatedInfo = (d, now) => {
      const dayMs = 86400000;
      const dayOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
      const diffDays = Math.max(0, Math.round((dayOf(now) - dayOf(d)) / dayMs));
      let text;
      if (diffDays <= 0) text = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      else if (diffDays === 1) text = '昨天';
      else if (diffDays === 2) text = '前天';
      else if (diffDays < 7) text = diffDays + '天前';
      else if (d.getFullYear() === now.getFullYear()) text = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      else text = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      return {
        text,
        ageBucket: diffDays < 7 ? String(diffDays) : '',
      };
    };
    const fmtFullCreated = (d) => (
      `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    );

    const applyCreatedCell = (el, filledKey, info, fullTitle) => {
      if (!el || el.dataset.filled === filledKey) return;
      el.textContent = info.text;
      el.title = fullTitle;
      if (info.ageBucket !== '') el.dataset.ageBucket = info.ageBucket;
      else delete el.dataset.ageBucket;
      el.dataset.filled = filledKey;
    };

    const harvestPreloaded = () => {
      const el = document.getElementById('data-preloaded');
      if (!el || !el.dataset.preloaded) return;
      let data;
      try { data = JSON.parse(el.dataset.preloaded); } catch (e) { return; }
      if (data.siteSettings && !cachedDiscourseSiteSettings) {
        try {
          cachedDiscourseSiteSettings = typeof data.siteSettings === 'string'
            ? JSON.parse(data.siteSettings) : data.siteSettings;
        } catch (e) {}
      }
      for (const key of Object.keys(data)) {
        if (!/^topic/.test(key)) continue;
        let v = data[key];
        if (typeof v === 'string') {
          try { v = JSON.parse(v); } catch (e) { continue; }
        }
        harvestTopicCreatedData(v);
      }
    };

    const currentThemeMode = () => {
      const m = document.querySelector('meta[name="discourse_theme_id"]');
      if (!m || !m.content) return 'classic';
      const ids = m.content.split(',');
      for (let i = 0; i < ids.length; i++) {
        const mode = CREATED_AT_THEME_MODES[String(parseInt(ids[i], 10))];
        if (mode) return mode;
      }
      return 'classic';
    };

    const ensureHeader = (table) => {
      const headRow = table.tHead && table.tHead.querySelector('tr');
      if (!headRow || headRow.querySelector('th.' + CREATED_AT_COL_CLASS)) return;
      const th = document.createElement('th');
      th.className = 'topic-list-data num ' + CREATED_AT_COL_CLASS;
      th.setAttribute('scope', 'col');
      th.textContent = CREATED_AT_COL_LABEL;
      headRow.insertBefore(th, headRow.querySelector('th.activity'));
    };

    let refetchedUrl = '';
    const sweep = () => {
      const tables = document.querySelectorAll('table.topic-list');
      if (!tables.length) return;
      const now = new Date();
      const todayStamp = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
      const mode = currentThemeMode();
      const rootCls = document.documentElement.classList;
      if (mode === 'horizon') rootCls.add('ldc-horizon');
      else rootCls.remove('ldc-horizon');

      for (let i = 0; i < tables.length; i++) {
        const table = tables[i];
        const horizon = mode === 'horizon' && !!table.querySelector('.topic-activity__time, td.topic-activity-data');
        if (!horizon) ensureHeader(table);

        const rows = table.querySelectorAll('tr.topic-list-item[data-topic-id]');
        for (let j = 0; j < rows.length; j++) {
          const row = rows[j];
          const id = row.getAttribute('data-topic-id');
          let td = null;
          if (!horizon) {
            td = row.querySelector('td.' + CREATED_AT_COL_CLASS);
            if (!td) {
              td = document.createElement('td');
              td.className = 'topic-list-data num ' + CREATED_AT_COL_CLASS;
              const anchor = row.querySelector('td.activity');
              if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(td, anchor);
              else row.appendChild(td);
            }
          }

          const target = row.querySelector('.topic-item-stats .num.activity') || row.querySelector('.topic-activity__time');
          const created = topicCreatedMap.get(id);
          if (!created) continue;
          const ts = Date.parse(created);
          if (!Number.isFinite(ts)) continue;
          const d = new Date(ts);
          const filledKey = `${id}:${todayStamp}`;
          const info = formatCreatedInfo(d, now);
          const fullTitle = fmtFullCreated(d);
          if (td) applyCreatedCell(td, filledKey, info, fullTitle);
          if (target) {
            let inline = row.querySelector('.' + CREATED_AT_COL_CLASS + '-inline');
            if (!inline) {
              inline = document.createElement('span');
              inline.className = CREATED_AT_COL_CLASS + '-inline';
              target.insertBefore(inline, target.firstChild);
            }
            applyCreatedCell(inline, filledKey, info, fullTitle);
          }
        }
      }

      const allRows = document.querySelectorAll('tr.topic-list-item[data-topic-id]');
      if (allRows.length && refetchedUrl !== location.href) {
        let missing = 0;
        for (let k = 0; k < allRows.length; k++) {
          if (!topicCreatedMap.has(allRows[k].getAttribute('data-topic-id'))) missing++;
        }
        if (missing * 3 > allRows.length) {
          refetchedUrl = location.href;
          const url = (location.pathname.replace(/\/+$/, '') || '/latest') + '.json' + location.search;
          fetch(url, { credentials: 'same-origin' })
            .then((res) => (res.ok ? res.json() : null))
            .then((json) => { if (json) harvestTopicCreatedData(json); })
            .catch(() => {});
        }
      }
    };

    let sweepScheduled = false;
    scheduleTopicCreatedSweep = () => {
      if (sweepScheduled) return;
      sweepScheduled = true;
      setTimeout(() => { sweepScheduled = false; sweep(); }, 120);
    };

    harvestPreloaded();
    sweep();
    if (document.body) {
      new MutationObserver(scheduleTopicCreatedSweep).observe(document.body, { childList: true, subtree: true });
    }
    setInterval(sweep, 1500);
  }

  onDomReady(() => {
    if (window.top !== window.self) return;
    startBase64MenuObserver();
    startObsidianPageActions();
    startPageCollectionAction();
    startTopicCreatedColumn();
  });
})();
