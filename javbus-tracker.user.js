// ==UserScript==
// @name         JavBus 影视追踪助手
// @namespace    http://tampermonkey.net/
// @version      2.7.1
// @description  自动检索JavBus页面影视列表显示浏览状态，并集成原 JAV老司机 的瀑布流、排版优化及多站评分。
// @author       Antengye
// @include        *://*javbus.com/*
// @include        *://www.*bus*/*
// @include        *://www.*javsee*/*
// @include        *://www.*seejav*/*
// @include        *://*javdb*.com/*
// @require      https://cdn.jsdelivr.net/npm/jquery@2.2.4/dist/jquery.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @connect      f.bigorange.work
// @connect      *
// @run-at       document-idle
// ==/UserScript==


// ==================== 影视追踪助手 ====================
(function () {
    'use strict';

    // ==================== 配置 ====================
    const CONFIG = {
        API_BASE: 'https://f.bigorange.work',
        CACHE_EXPIRY_DAYS: 30,
        BATCH_SIZE: 50,          // 每批次查询的番号数量
        DEBOUNCE_DELAY: 500,     // 防抖延迟（毫秒）
        OBSERVER_THROTTLE: 1000, // MutationObserver 节流时间（毫秒）
        ENABLE_CONSOLE_LOG: true,
        CLICK_REFRESH_DELAY: 5000,
        RETRY_BASE_DELAY: 5000,
        RETRY_MAX_DELAY: 60000,
        PENDING_TRACK_PREFIX: 'jt_pending_track_'
    };

    function normalizeCode(code) {
        if (typeof code !== 'string') return null;
        const normalized = code.trim().toUpperCase();
        return /^[A-Z]+-\d+$/.test(normalized) ? normalized : null;
    }

    function retryDelay(attempts) {
        const exponent = Math.max(0, Number(attempts || 1) - 1);
        return Math.min(CONFIG.RETRY_BASE_DELAY * (2 ** exponent), CONFIG.RETRY_MAX_DELAY);
    }

    function pendingTrackKey(code) {
        const normalized = normalizeCode(code);
        return normalized ? `${CONFIG.PENDING_TRACK_PREFIX}${normalized}` : null;
    }

    function createStrategyLogger(enabled, target = console) {
        const write = (method, message, ...args) => {
            if (!enabled) return;
            const output = typeof target[method] === 'function' ? target[method] : target.log;
            if (typeof output === 'function') {
                output.call(target, `[JavBus Tracker] ${message}`, ...args);
            }
        };
        return {
            log: (message, ...args) => write('log', message, ...args),
            warn: (message, ...args) => write('warn', message, ...args),
            error: (message, ...args) => write('error', message, ...args)
        };
    }

    const strategyLog = createStrategyLogger(CONFIG.ENABLE_CONSOLE_LOG);

    function createGMStorage() {
        return {
            get: (key, fallback = null) => GM_getValue(key, fallback),
            set: (key, value) => GM_setValue(key, value),
            remove: (key) => GM_deleteValue(key),
            list: () => GM_listValues()
        };
    }

    function errorMessage(error) {
        const message = error && typeof error.message === 'string'
            ? error.message
            : String(error || 'unknown error');
        return message.slice(0, 200);
    }

    function batchItems(result) {
        return result && Array.isArray(result.items) ? result.items : [];
    }

    function getLargePreviewImageUrl(url) {
        if (typeof url !== 'string' || url.length === 0) return url;

        return url
            .replace(/\/ps\.jpg(?=([?#].*)?$)/i, '/pl.jpg')
            .replace(/\/([^/?#]+)-(\d+)\.jpg(?=([?#].*)?$)/i, (match, prefix, index) => {
                return prefix.toLowerCase().endsWith('jp') ? match : `/${prefix}jp-${index}.jpg`;
            });
    }

    function isPreviewImageUrl(url) {
        return typeof url === 'string' && /\.(jpe?g|png|webp|avif|gif)(?=([?#].*)?$)/i.test(url);
    }

    function resolveLargePreviewImageUrl(imageUrl, linkUrl) {
        if (isPreviewImageUrl(linkUrl)) {
            return /\/pics\.dmm\.co\.jp\//i.test(linkUrl) ? getLargePreviewImageUrl(linkUrl) : linkUrl;
        }

        const largeLinkUrl = getLargePreviewImageUrl(linkUrl);
        if (largeLinkUrl && largeLinkUrl !== linkUrl && isPreviewImageUrl(largeLinkUrl)) return largeLinkUrl;
        return getLargePreviewImageUrl(imageUrl);
    }

    globalThis.__JAVBUS_TRACKER_GET_LARGE_PREVIEW_IMAGE_URL__ = getLargePreviewImageUrl;
    globalThis.__JAVBUS_TRACKER_IS_PREVIEW_IMAGE_URL__ = isPreviewImageUrl;
    globalThis.__JAVBUS_TRACKER_RESOLVE_LARGE_PREVIEW_IMAGE_URL__ = resolveLargePreviewImageUrl;

    function createTrackOutbox({
        storage,
        request,
        now = Date.now,
        schedule = setTimeout,
        cancel = clearTimeout,
        logger
    }) {
        let retryTimer = null;

        const listRecords = () => storage.list()
            .filter((key) => key.startsWith(CONFIG.PENDING_TRACK_PREFIX))
            .map((key) => ({ key, value: storage.get(key, null) }));

        const isValid = ({ key, value }) => value &&
            pendingTrackKey(value.code) === key &&
            Number.isFinite(value.createdAt) &&
            Number.isFinite(value.attempts) &&
            Number.isFinite(value.nextRetryAt);

        const armNextRetry = () => {
            if (retryTimer) cancel(retryTimer);
            const next = listRecords()
                .filter(isValid)
                .reduce((minimum, item) => Math.min(minimum, item.value.nextRetryAt), Infinity);
            retryTimer = Number.isFinite(next)
                ? schedule(() => retryDue(), Math.max(0, next - now()))
                : null;
        };

        const sendRecord = async (record, historical) => {
            try {
                await request(record.code);
                storage.remove(pendingTrackKey(record.code));
                logger.log(historical
                    ? `检测到上一次有上传失败数据，已成功重试: ${record.code}`
                    : `已上报查看: ${record.code}`);
                return true;
            } catch (error) {
                const attempts = Number(record.attempts || 0) + 1;
                const delay = retryDelay(attempts);
                storage.set(pendingTrackKey(record.code), {
                    ...record,
                    updatedAt: now(),
                    attempts,
                    nextRetryAt: now() + delay,
                    lastError: errorMessage(error)
                });
                logger.warn(`网络异常，已保存待补报记录，将在 ${delay / 1000} 秒后重试: ${record.code}`);
                return false;
            }
        };

        const retryDue = async () => {
            const records = listRecords();
            const due = [];

            for (const item of records) {
                if (!isValid(item)) {
                    storage.remove(item.key);
                    logger.warn(`已清理损坏的待补报记录: ${item.key}`);
                } else if (item.value.nextRetryAt <= now()) {
                    due.push(item.value);
                }
            }

            if (due.length > 0) {
                logger.log(`检测到 ${due.length} 条历史上传失败记录，开始重试`);
            }
            await Promise.all(due.map((record) => sendRecord(record, true)));
            armNextRetry();
        };

        const enqueueAndSend = async (code) => {
            const normalized = normalizeCode(code);
            if (!normalized) return false;

            const key = pendingTrackKey(normalized);
            const existing = storage.get(key, null);
            const record = existing && pendingTrackKey(existing.code) === key ? existing : {
                code: normalized,
                createdAt: now(),
                updatedAt: now(),
                attempts: 0,
                nextRetryAt: now(),
                lastError: ''
            };

            storage.set(key, record);
            const success = await sendRecord(record, false);
            armNextRetry();
            return success;
        };

        return { enqueueAndSend, retryDue };
    }

    function createReadRefreshCoordinator({
        query,
        apply,
        schedule = setTimeout,
        cancel = clearTimeout,
        logger
    }) {
        const queued = new Set();
        let timer = null;
        let refreshing = false;
        let failures = 0;

        const arm = (delay = CONFIG.CLICK_REFRESH_DELAY) => {
            if (timer) cancel(timer);
            timer = schedule(flush, delay);
        };

        const flush = async () => {
            timer = null;
            if (refreshing || queued.size === 0) return;

            refreshing = true;
            const batch = [...queued];
            batch.forEach((code) => queued.delete(code));
            logger.log(`5 秒内无新增点击，批量刷新 ${batch.length} 条已读状态`);

            try {
                const results = await query(batch);
                const requested = new Set(batch);
                const returned = new Set();

                for (const item of Array.isArray(results) ? results : []) {
                    const code = normalizeCode(item && item.code);
                    if (!code || !requested.has(code)) continue;
                    returned.add(code);
                    apply({ ...item, code });
                }

                for (const code of batch) {
                    if (!returned.has(code)) queued.add(code);
                }
                failures = returned.size === batch.length ? 0 : failures + 1;
            } catch (error) {
                batch.forEach((code) => queued.add(code));
                failures += 1;
            } finally {
                refreshing = false;
                if (queued.size > 0) {
                    const delay = retryDelay(failures);
                    logger.warn(`列表状态刷新失败，将在 ${delay / 1000} 秒后重试 ${queued.size} 条记录`);
                    arm(delay);
                }
            }
        };

        const collect = (code) => {
            const normalized = normalizeCode(code);
            if (!normalized) return;
            queued.add(normalized);
            arm();
        };

        return { collect, flush, pending: () => [...queued] };
    }

    // ==================== 样式定义 ====================
    const STYLES = `
        .jt-badge-container {
            position: absolute;
            top: 5px;
            left: 5px;
            display: flex;
            flex-direction: column;
            gap: 3px;
            z-index: 100;
            pointer-events: none;
        }

        .jt-badge {
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: bold;
            color: #fff;
            text-shadow: 0 1px 2px rgba(0,0,0,0.3);
            box-shadow: 0 1px 3px rgba(0,0,0,0.2);
            white-space: nowrap;
        }

        .jt-badge-viewed {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }

        .jt-badge-exists {
            background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
        }

        .jt-badge-score {
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
        }

        .jt-badge-score.high {
            background: linear-gradient(135deg, #fa709a 0%, #fee140 100%);
        }

        .jt-item-viewed {
            position: relative;
        }

        .jt-item-viewed::after {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(102, 126, 234, 0.15);
            pointer-events: none;
            border-radius: 4px;
        }

        .jt-item-exists::after {
            background: rgba(17, 153, 142, 0.15) !important;
        }

        /* 详情页样式 */
        .jt-detail-info {
            margin: 10px 0;
            padding: 10px 15px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 8px;
            color: #fff;
            font-size: 14px;
            box-shadow: 0 2px 10px rgba(102, 126, 234, 0.3);
        }

        .jt-detail-info.exists {
            background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
        }

        .jt-detail-info .jt-info-row {
            display: flex;
            align-items: center;
            gap: 15px;
            flex-wrap: wrap;
        }

        .jt-detail-info .jt-info-item {
            display: flex;
            align-items: center;
            gap: 5px;
        }

        .jt-detail-info .jt-label {
            opacity: 0.8;
        }

        .jt-detail-info .jt-value {
            font-weight: bold;
        }

        .jt-loading {
            opacity: 0.5;
        }
    `;

    // ==================== 工具函数 ====================

    /**
     * 注入样式到页面
     */
    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = STYLES;
        document.head.appendChild(style);
    }

    /**
     * 生成缓存键
     */
    function getCacheKey(code) {
        return `jt_cache_${code.toUpperCase()}`;
    }

    /**
     * 获取缓存数据
     */
    function getCache(code) {
        const key = getCacheKey(code);
        const cached = GM_getValue(key, null);

        if (!cached) return null;

        // 检查是否过期
        const expiry = CONFIG.CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
        if (Date.now() - cached.timestamp > expiry) {
            return null;
        }

        return cached.data;
    }

    /**
     * 设置缓存数据
     */
    function setCache(code, data) {
        const key = getCacheKey(code);
        GM_setValue(key, {
            timestamp: Date.now(),
            data: data
        });
    }

    /**
     * 清除指定番号的缓存（用于更新后刷新）
     */
    function clearCache(code) {
        const key = getCacheKey(code);
        GM_setValue(key, null);
    }

    /**
     * 发起API请求
     */
    function apiRequest(path, data) {
        const url = `${CONFIG.API_BASE}${path}`;
        strategyLog.log(`请求: ${url}`, data);

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: url,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                data: JSON.stringify(data),
                timeout: 30000,
                onload: (response) => {
                    strategyLog.log(`响应状态: ${response.status}`, response);

                    // 检查HTTP状态码
                    if (response.status < 200 || response.status >= 300) {
                        strategyLog.error(`HTTP错误: ${response.status}`, response.responseText?.substring(0, 500));
                        reject(new Error(`HTTP Error: ${response.status}`));
                        return;
                    }

                    try {
                        const result = JSON.parse(response.responseText);
                        if (result.code === 0) {
                            resolve(result.data);
                        } else {
                            reject(new Error(`API Error: ${result.code}`));
                        }
                    } catch (e) {
                        strategyLog.error('JSON解析失败:', response.responseText?.substring(0, 500));
                        reject(new Error(`JSON Parse Error: ${e.message}`));
                    }
                },
                onerror: (error) => {
                    strategyLog.error('请求失败:', error);
                    reject(error);
                },
                ontimeout: () => {
                    strategyLog.error('请求超时');
                    reject(new Error('Request timeout'));
                }
            });
        });
    }

    const trackOutbox = createTrackOutbox({
        storage: createGMStorage(),
        request: (code) => apiRequest('/api/film/track', { code }),
        logger: strategyLog
    });

    /**
     * 批量查询番号状态
     */
    async function batchQueryStatus(codes) {
        if (codes.length === 0) return [];

        try {
            const result = await apiRequest('/api/film/batch-status', { codes });
            return batchItems(result);
        } catch (e) {
            strategyLog.error('批量查询失败:', e);
            return [];
        }
    }

    /**
     * 上报查看记录
     */
    async function trackView(code) {
        const success = await trackOutbox.enqueueAndSend(code);
        if (success) {
            clearCache(code);
        }
        return success;
    }

    /**
     * 防抖函数
     */
    function debounce(func, wait) {
        let timeout;
        return function (...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    /**
     * 节流函数
     */
    function throttle(func, limit) {
        let inThrottle;
        return function (...args) {
            if (!inThrottle) {
                func.apply(this, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    }

    // ==================== 页面解析 ====================

    /**
     * 从URL或元素中提取番号
     */
    function extractCode(element) {
        // 尝试从链接中提取
        const link = element.querySelector('a[href]') || element.closest('a[href]');
        if (link) {
            const match = link.href.match(/\/([A-Za-z]+-\d+)/);
            if (match) return match[1].toUpperCase();
        }

        // 尝试从图片alt属性提取
        const img = element.querySelector('img[title]');
        if (img) {
            const code = img.title.split(' ')[0];
            if (/^[A-Za-z]+-\d+$/.test(code)) return code.toUpperCase();
        }

        // 尝试从文本中提取
        const text = element.textContent;
        const textMatch = text.match(/([A-Za-z]+-\d+)/);
        if (textMatch) return textMatch[1].toUpperCase();

        return null;
    }

    function addMovieItem(items, code, element) {
        const normalized = normalizeCode(code);
        if (!normalized || !element) return;

        let elements = items.get(normalized);
        if (!elements) {
            elements = new Set();
            items.set(normalized, elements);
        }

        // 同一张卡片会同时命中 .item、.movie-box 和 .photo-frame。
        // 保留最外层的卡片节点，避免一个卡片重复渲染多个徽章。
        for (const existing of elements) {
            if (existing === element || existing.contains?.(element)) return;
        }

        for (const existing of [...elements]) {
            if (element.contains?.(existing)) elements.delete(existing);
        }

        elements.add(element);
    }

    function forEachMovieItem(movieItems, code, callback) {
        const normalized = normalizeCode(code);
        const elements = normalized ? movieItems.get(normalized) : null;
        if (!elements || elements.size === 0) return false;

        for (const element of elements) callback(element);
        return true;
    }

    function collectPendingMovieCodes(movieItems, processed, pending) {
        for (const [code, elements] of movieItems) {
            // 动态分页可能在番号已处理后追加同番号的新卡片。
            // 任一当前卡片缺少徽章时，都让该番号重新进入处理队列。
            const hasUnrenderedItem = [...elements].some(
                (element) => !element.querySelector('.jt-badge-container')
            );
            if (processed.has(code) && hasUnrenderedItem) {
                processed.delete(code);
            }
            if (!processed.has(code) && !pending.includes(code)) {
                pending.push(code);
            }
        }
    }

    function mutationsContainMovieItems(mutations) {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes || []) {
                if (node.nodeType !== 1) continue;
                if (node.matches?.('.item, .movie-box, .photo-frame') ||
                    node.querySelector?.('.item, .movie-box, .photo-frame')) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * 获取页面上所有影视项
     */
    function getMovieItems() {
        // JavBus 列表页的电影项选择器
        const selectors = [
            '#waterfall .item',           // 主列表
            '.movie-box',                  // 某些页面的格式
            '#waterfall > div.item',      // 瀑布流项
            '.photo-frame'                 // 图片框架
        ];

        const items = new Map(); // 番号 -> 同一番号对应的所有卡片节点

        for (const selector of selectors) {
            document.querySelectorAll(selector).forEach(el => {
                const code = extractCode(el);
                if (code) addMovieItem(items, code, el);
            });
        }

        return items;
    }

    /**
     * 获取当前详情页的番号
     */
    function getDetailPageCode() {
        // 从URL提取
        const urlMatch = window.location.pathname.match(/\/([A-Za-z]+-\d+)/);
        if (urlMatch) return urlMatch[1].toUpperCase();

        // 从页面标题提取
        const titleEl = document.querySelector('.container h3');
        if (titleEl) {
            const match = titleEl.textContent.match(/([A-Za-z]+-\d+)/);
            if (match) return match[1].toUpperCase();
        }

        return null;
    }

    /**
     * 判断是否为详情页
     */
    function isDetailPage() {
        return window.location.pathname.match(/^\/[A-Za-z]+-\d+/);
    }

    // ==================== UI渲染 ====================

    /**
     * 为单个影视项添加状态徽章
     */
    function renderItemBadges(element, status) {
        // 移除旧的徽章
        const oldBadges = element.querySelector('.jt-badge-container');
        if (oldBadges) oldBadges.remove();

        // 移除旧的样式类
        element.classList.remove('jt-item-viewed', 'jt-item-exists');

        // 确保元素有定位
        const computedStyle = window.getComputedStyle(element);
        if (computedStyle.position === 'static') {
            element.style.position = 'relative';
        }

        // 创建徽章容器
        const container = document.createElement('div');
        container.className = 'jt-badge-container';

        // 已浏览徽章
        if (status.viewed) {
            const badge = document.createElement('span');
            badge.className = 'jt-badge jt-badge-viewed';
            badge.textContent = '👁 已看';
            container.appendChild(badge);
            element.classList.add('jt-item-viewed');
        }

        // 已入库徽章
        if (status.exists) {
            const badge = document.createElement('span');
            badge.className = 'jt-badge jt-badge-exists';
            badge.textContent = '📁 已收藏';
            container.appendChild(badge);
            element.classList.add('jt-item-exists');
        }

        // 评分徽章
        if (status.score !== undefined && status.score > 0) {
            const badge = document.createElement('span');
            badge.className = 'jt-badge jt-badge-score' + (status.score >= 80 ? ' high' : '');
            badge.textContent = `⭐ ${status.score.toFixed(1)}`;
            container.appendChild(badge);
        }

        if (container.children.length > 0) {
            element.appendChild(container);
        }
    }

    /**
     * 渲染详情页信息
     */
    function renderDetailInfo(status) {
        // 移除旧的信息
        const oldInfo = document.querySelector('.jt-detail-info');
        if (oldInfo) oldInfo.remove();

        const container = document.createElement('div');
        container.className = 'jt-detail-info' + (status.exists ? ' exists' : '');

        const row = document.createElement('div');
        row.className = 'jt-info-row';

        // 收藏状态
        const existsItem = document.createElement('span');
        existsItem.className = 'jt-info-item';
        existsItem.innerHTML = `
            <span class="jt-label">收藏状态:</span>
            <span class="jt-value">${status.exists ? '✅ 已收藏' : '❌ 未收藏'}</span>
        `;
        row.appendChild(existsItem);

        // 浏览状态
        const viewedItem = document.createElement('span');
        viewedItem.className = 'jt-info-item';
        viewedItem.innerHTML = `
            <span class="jt-label">浏览状态:</span>
            <span class="jt-value">${status.viewed ? '👁 已浏览' : '🆕 首次访问'}</span>
        `;
        row.appendChild(viewedItem);

        // 查看时间
        if (status.view_time) {
            const timeItem = document.createElement('span');
            timeItem.className = 'jt-info-item';
            const date = new Date(status.view_time * 1000);
            timeItem.innerHTML = `
                <span class="jt-label">上次查看:</span>
                <span class="jt-value">${date.toLocaleString('zh-CN')}</span>
            `;
            row.appendChild(timeItem);
        }

        // 评分
        if (status.score !== undefined && status.score > 0) {
            const scoreItem = document.createElement('span');
            scoreItem.className = 'jt-info-item';
            scoreItem.innerHTML = `
                <span class="jt-label">评分:</span>
                <span class="jt-value">⭐ ${status.score.toFixed(1)}</span>
            `;
            row.appendChild(scoreItem);
        }

        container.appendChild(row);

        // 插入到页面
        const target = document.querySelector('.container .row.movie') ||
            document.querySelector('.container h3') ||
            document.querySelector('.container');

        if (target) {
            target.parentNode.insertBefore(container, target.nextSibling);
        }
    }

    // ==================== 核心逻辑 ====================

    // 已处理的番号集合
    const processedCodes = new Set();
    // 待查询的番号队列
    let pendingCodes = [];

    /**
     * 处理待查询队列
     */
    const processPendingQueue = debounce(async () => {
        if (pendingCodes.length === 0) return;

        // 获取需要查询的番号（排除已缓存的）
        const codesToQuery = [];
        const cachedResults = new Map();

        for (const code of pendingCodes) {
            const cached = getCache(code);
            if (cached) {
                cachedResults.set(code, cached);
            } else {
                codesToQuery.push(code);
            }
        }

        // 清空队列
        const currentBatch = [...pendingCodes];
        pendingCodes = [];

        // 应用缓存结果
        const movieItems = getMovieItems();
        for (const [code, status] of cachedResults) {
            if (forEachMovieItem(movieItems, code, (element) => renderItemBadges(element, status))) {
                // 仅在成功渲染后标记处理，避免DOM临时缺失导致后续不再补渲染
                processedCodes.add(code);
            }
        }

        // 分批查询API
        if (codesToQuery.length > 0) {
            for (let i = 0; i < codesToQuery.length; i += CONFIG.BATCH_SIZE) {
                const batch = codesToQuery.slice(i, i + CONFIG.BATCH_SIZE);
                const results = await batchQueryStatus(batch);

                // 处理结果
                for (const item of results) {
                    const code = item.code.toUpperCase();

                    // 缓存结果
                    setCache(code, item);

                    // 渲染UI
                    if (forEachMovieItem(movieItems, code, (element) => renderItemBadges(element, item))) {
                        // 仅在成功渲染后标记处理，避免DOM变更后遗漏
                        processedCodes.add(code);
                    }
                }
            }
        }

    }, CONFIG.DEBOUNCE_DELAY);

    /**
     * 扫描页面并处理新项目
     */
    function scanAndProcess() {
        const movieItems = getMovieItems();
        collectPendingMovieCodes(movieItems, processedCodes, pendingCodes);

        if (pendingCodes.length > 0) {
            processPendingQueue();
        }
    }

    function applyFreshListStatus(item) {
        setCache(item.code, item);
        if (forEachMovieItem(getMovieItems(), item.code, (element) => renderItemBadges(element, item))) {
            processedCodes.add(item.code);
        }
    }

    function setupListReadRefresh() {
        const coordinator = createReadRefreshCoordinator({
            query: batchQueryStatus,
            apply: applyFreshListStatus,
            logger: strategyLog
        });

        document.addEventListener('click', (event) => {
            const link = event.target.closest?.('a[href]');
            const item = link?.closest?.('.item, .movie-box, .photo-frame');
            if (item) coordinator.collect(extractCode(item));
        }, true);

        return coordinator;
    }

    /**
     * 处理详情页
     */
    async function handleDetailPage() {
        const code = getDetailPageCode();
        if (!code) return;

        strategyLog.log(`详情页: ${code}`);

        // 先尝试显示缓存的状态
        const cached = getCache(code);
        if (cached) {
            renderDetailInfo(cached);
        }

        // 先查询之前的状态（在上报之前查询，这样显示的是历史记录）
        const results = await batchQueryStatus([code]);
        if (results.length > 0) {
            setCache(code, results[0]);
            renderDetailInfo(results[0]);
        }

        // 最后上报本次查看记录（不影响当前显示的状态）
        trackView(code);
    }

    /**
     * 设置 MutationObserver 监听动态内容
     */
    function setupObserver() {
        const throttledScan = throttle(scanAndProcess, CONFIG.OBSERVER_THROTTLE);

        const observer = new MutationObserver((mutations) => {
            if (mutationsContainMovieItems(mutations)) {
                throttledScan();
            }
        });

        // 观察整个文档
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        return observer;
    }

    /**
     * 设置滚动监听（备用方案）
     */
    function setupScrollListener() {
        const throttledScan = throttle(scanAndProcess, CONFIG.OBSERVER_THROTTLE);

        window.addEventListener('scroll', () => {
            // 检查是否接近底部
            const scrollTop = window.scrollY;
            const windowHeight = window.innerHeight;
            const docHeight = document.documentElement.scrollHeight;

            if (scrollTop + windowHeight >= docHeight - 500) {
                throttledScan();
            }
        }, { passive: true });
    }

    // ==================== 初始化 ====================

    function init() {
        strategyLog.log('初始化中...');

        // 不阻塞页面初始化，后台恢复历史失败记录。
        trackOutbox.retryDue();

        // 注入样式
        injectStyles();

        if (isDetailPage()) {
            // 详情页处理
            handleDetailPage();
        } else {
            // 列表页处理
            scanAndProcess();
            setupObserver();
            setupScrollListener();
            setupListReadRefresh();
        }

        strategyLog.log('初始化完成');
    }

    if (globalThis.__JAVBUS_TRACKER_TEST_MODE__) {
        globalThis.__JAVBUS_TRACKER_TEST_EXPORTS__ = {
            normalizeCode,
            retryDelay,
            pendingTrackKey,
            createStrategyLogger,
            createTrackOutbox,
            createReadRefreshCoordinator,
            errorMessage,
            batchItems,
            extractCode,
            addMovieItem,
            forEachMovieItem,
            collectPendingMovieCodes,
            mutationsContainMovieItems,
            getMovieItems,
            getLargePreviewImageUrl,
            isPreviewImageUrl,
            resolveLargePreviewImageUrl
        };
        return;
    }

    // 等待DOM完全加载
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();

// ==================== JAV老司机 (排版增强/瀑布流) ====================
/* jshint -W097 */
(function () {
    'use strict';
    const JAVDB_ITEM_SELECTOR = '.movie-list.v.cols-4.vcols-8 .item, .movie-list.v.cols-4.vcols-5 .item, .movie-list.h.cols-4.vcols-8 .item, .movie-list.h.cols-4.vcols-5 .item';
    const JAVDB_DOMAIN = 'javdb.com';
    const MMTV_DOMAIN = '7mmtv.sx';
    const NAS_URL_TEMPLATE_KEY = 'nas_url_template';
    const PREVIEW_SOURCE_KEY = 'preview_image_source';
    const JAVINFO_API_KEY_KEY = 'javinfo_api_key';
    const JAVINFO_PREVIEW_CACHE_PREFIX = 'javinfo_preview_cache_';
    const JAVINFO_PREVIEW_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
    const PREVIEW_SOURCES = Object.freeze({
        javdb: { label: 'JavDB', description: '免费，无需 API Key' },
        javinfo: { label: 'javinfo API', description: '新账号 50 次免费，之后按次计费' }
    });
    const getLargePreviewImageUrl = globalThis.__JAVBUS_TRACKER_GET_LARGE_PREVIEW_IMAGE_URL__ || ((url) => url);
    const isPreviewImageUrl = globalThis.__JAVBUS_TRACKER_IS_PREVIEW_IMAGE_URL__ || ((url) => /\.(jpe?g|png|webp|avif|gif)(?=([?#].*)?$)/i.test(url));
    const resolveLargePreviewImageUrl = globalThis.__JAVBUS_TRACKER_RESOLVE_LARGE_PREVIEW_IMAGE_URL__ || ((imageUrl) => imageUrl);

    function getPreviewSource() {
        const configured = String(GM_getValue(PREVIEW_SOURCE_KEY, 'javdb') || '').toLowerCase();
        return Object.prototype.hasOwnProperty.call(PREVIEW_SOURCES, configured) ? configured : 'javdb';
    }

    function getJavInfoApiKey() {
        return String(GM_getValue(JAVINFO_API_KEY_KEY, '') || '').trim();
    }

    function configureJavInfoApiKey({ required = false } = {}) {
        const current = getJavInfoApiKey();
        const value = window.prompt(
            '设置 javinfo API Key\n\n' +
            `当前状态：${current ? '已配置' : '未配置'}\n` +
            'Key 只会保存在当前浏览器的油猴脚本存储中，不会写入脚本代码。\n' +
            '请输入新的 jvi_ Key；输入 CLEAR 可清除；取消或留空保持不变。',
            ''
        );
        if (value === null || !value.trim()) {
            if (required && !current) window.alert('切换到 javinfo 前需要先配置 API Key');
            return current || null;
        }

        const normalized = value.trim();
        if (normalized.toUpperCase() === 'CLEAR') {
            GM_deleteValue(JAVINFO_API_KEY_KEY);
            window.alert('已清除 javinfo API Key');
            return '';
        }
        if (!/^jvi_\S+$/i.test(normalized)) {
            window.alert('javinfo API Key 应以 jvi_ 开头，且不能包含空格');
            return null;
        }

        GM_setValue(JAVINFO_API_KEY_KEY, normalized);
        window.alert('javinfo API Key 已保存到当前浏览器');
        return normalized;
    }

    function configurePreviewSource() {
        const current = getPreviewSource();
        const next = current === 'javdb' ? 'javinfo' : 'javdb';
        const currentInfo = PREVIEW_SOURCES[current];
        const nextInfo = PREVIEW_SOURCES[next];
        const shouldSwitch = window.confirm(
            `当前预览图来源：${currentInfo.label}（${currentInfo.description}）\n\n` +
            `是否切换为：${nextInfo.label}（${nextInfo.description}）？`
        );
        if (!shouldSwitch) return;

        if (next === 'javinfo' && !getJavInfoApiKey() && !configureJavInfoApiKey({ required: true })) {
            return;
        }

        GM_setValue(PREVIEW_SOURCE_KEY, next);
        window.alert(`预览图来源已切换为 ${nextInfo.label}`);
        window.location.reload();
    }

    function getNasUrlTemplate() {
        return String(GM_getValue(NAS_URL_TEMPLATE_KEY, '') || '').trim();
    }

    function renderNasUrl(template, { magnet, name, code }) {
        const values = {
            '{magnet}': encodeURIComponent(magnet),
            '{magnetRaw}': magnet,
            '{name}': encodeURIComponent(name),
            '{nameRaw}': name,
            '{code}': encodeURIComponent(code),
            '{codeRaw}': code
        };

        return Object.entries(values).reduce(
            (url, [variable, value]) => url.split(variable).join(value),
            template
        );
    }

    function validateNasUrlTemplate(template) {
        if (!/\{magnet(?:Raw)?\}/.test(template)) {
            return '地址模板必须包含 {magnet} 或 {magnetRaw}';
        }

        try {
            const exampleUrl = renderNasUrl(template, {
                magnet: 'magnet:?xt=urn:btih:example&dn=example',
                name: 'example',
                code: 'ABC-123'
            });
            const parsed = new URL(exampleUrl);
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                return 'NAS 地址仅支持 http:// 或 https://';
            }
        } catch (error) {
            return 'NAS 地址模板不是有效的网址';
        }
        return '';
    }

    function configureNasUrlTemplate() {
        const current = getNasUrlTemplate();
        const template = window.prompt(
            '设置一键 NAS 地址模板\n\n' +
            '可用变量：\n' +
            '{magnet}  URL 编码后的磁力链接（推荐）\n' +
            '{magnetRaw}  原始磁力链接\n' +
            '{name} / {nameRaw}  任务名称\n' +
            '{code} / {codeRaw}  当前番号\n\n' +
            '示例：https://nas.example/add?url={magnet}&name={name}',
            current
        );
        if (template === null) return null;

        const normalized = template.trim();
        if (!normalized) {
            GM_setValue(NAS_URL_TEMPLATE_KEY, '');
            window.alert('已清除一键 NAS 地址');
            return '';
        }

        const error = validateNasUrlTemplate(normalized);
        if (error) {
            window.alert(error);
            return null;
        }

        GM_setValue(NAS_URL_TEMPLATE_KEY, normalized);
        window.alert('一键 NAS 地址已保存到当前浏览器');
        return normalized;
    }

    function openNasUrl({ magnet, name, code }) {
        let template = getNasUrlTemplate();
        if (!template) template = configureNasUrlTemplate();
        if (!template) return false;

        const error = validateNasUrlTemplate(template);
        if (error) {
            window.alert(`${error}，请重新设置`);
            template = configureNasUrlTemplate();
            if (!template) return false;
        }

        const nasUrl = renderNasUrl(template, { magnet, name, code });
        window.open(nasUrl, '_blank', 'noopener,noreferrer');
        return true;
    }

    // 瀑布流状态：1：开启、0：关闭
    let waterfallScrollStatus = GM_getValue('scroll_status', 1);

    /**
     * 多线程异步队列 依赖 jQuery 1.8+
     */
    function Queue(n) {
        n = parseInt(n, 10);
        return new Queue.prototype.init((n && n > 0) ? n : 1)
    }

    Queue.prototype = {
        init: function (n) {
            this.threads = [];
            this.taskList = [];
            while (n--) {
                this.threads.push(new this.Thread)
            }
        },
        push: function (callback) {
            if (typeof callback !== 'function') return;
            var index = this.indexOfIdle();
            if (index != -1) {
                this.threads[index].idle(callback);
            } else {
                this.taskList.push(callback);
                for (var i = 0, l = this.threads.length; i < l; i++) {
                    ((thread, self, id) => {
                        thread.idle(() => {
                            if (self.taskList.length > 0) {
                                let promise = self.taskList.shift()();
                                return promise.promise ? promise : $.Deferred().resolve().promise();
                            } else {
                                return $.Deferred().resolve().promise();
                            }
                        })
                    })(this.threads[i], this, i);

                }
            }
        },
        indexOfIdle: function () {
            var threads = this.threads,
                thread = null,
                index = -1;
            for (var i = 0, l = threads.length; i < l; i++) {
                thread = threads[i];
                if (thread.promise.state() === 'resolved') {
                    index = i;
                    break;
                }
            }
            return index;
        },
        Thread: function () {
            this.promise = $.Deferred().resolve().promise();
            this.idle = (callback) => {
                this.promise = this.promise.then(callback)
            }
        }
    };
    Queue.prototype.init.prototype = Queue.prototype;

    class Common {
        static init() {
            const currentJavDbUrl = GM_getValue('javdb_url', undefined);
            if (currentJavDbUrl === undefined || /^(www\.)?javdb368\.com$/i.test(currentJavDbUrl)) {
                GM_setValue('javdb_url', JAVDB_DOMAIN);
            }
            if (GM_getValue('javlib_url', undefined) === undefined) {
                GM_setValue('javlib_url', 'www.javlibrary.com');
            }
            if (GM_getValue('javbus_url', undefined) === undefined) {
                GM_setValue('javbus_url', 'www.javbus.com');
            }

            GM_registerMenuCommand('设置瀑布流状态', () => {
                let current = GM_getValue('scroll_status', 1);
                let next = current === 1 ? 0 : 1;
                if (confirm("当前瀑布流状态：" + (current === 1 ? "开启" : "关闭") + "\n是否切换为：" + (next === 1 ? "开启" : "关闭") + " ?")) {
                    GM_setValue('scroll_status', next);
                    location.reload();
                }
            });

            GM_registerMenuCommand('设置一键 NAS 地址', configureNasUrlTemplate);
            const previewSource = getPreviewSource();
            GM_registerMenuCommand(
                `切换预览图来源（当前：${PREVIEW_SOURCES[previewSource].label}）`,
                configurePreviewSource
            );
            GM_registerMenuCommand(
                `设置 javinfo API Key（${getJavInfoApiKey() ? '已配置' : '未配置'}）`,
                () => configureJavInfoApiKey()
            );
        }

        static parsetext(text) {
            try {
                let doc = document.implementation.createHTMLDocument('');
                doc.documentElement.innerHTML = text;
                return doc;
            } catch (e) {
                console.log('parse error');
            }
        }

        static requestGM_XHR(details) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: details.method ? details.method : "GET",
                    url: details.url,
                    headers: details.headers,
                    timeout: details.timeout > 0 ? details.timeout : 20000,
                    onload: rsp => resolve(rsp),
                    onerror: rsp => {
                        reject(`error`);
                    },
                    ontimeout: rsp => {
                        reject(`timeout`);
                    }
                });
            });
        }

        static getJavDbOrigin() {
            const configured = String(GM_getValue('javdb_url', JAVDB_DOMAIN) || JAVDB_DOMAIN)
                .trim()
                .replace(/^https?:\/\//i, '')
                .replace(/\/.*$/, '');
            return `https://${configured || JAVDB_DOMAIN}`;
        }

        static absoluteUrl(value, baseUrl) {
            try {
                return new URL(value, baseUrl).href;
            } catch (error) {
                return '';
            }
        }

        static normalizeJavDbCode(value) {
            return String(value || '').toUpperCase().replace(/[\s_-]+/g, '');
        }

        static getAvCode(avid) {
            if (avid.match(/-[^0]/g)) return avid;
            if (avid.match(/^[0-9-_]+$/g)) return avid;
            if (avid.match(/^(crazyasia|sm|video_|BrazzersExxtra)+/gi)) return avid;
            avid = avid.replace(/\b(FC2+)/gi, "");
            let letter = avid.match(/[a-z|A-Z]+/gi);
            let num = avid.match(/\d+$/gi)[0];
            if (num.length > 3) {
                num = num.replace(/\b(0+)/gi, "");
                if (num.length < 3) {
                    num = (Array(3).join(0) + num).slice(-3);
                }
            }
            return letter.toString().replace(/,/g, "-") + "-" + num;
        }

        static getDmmId(url) {
            let array = url.split("/");
            let dmmId = array[array.length - 2];
            let num = dmmId.match(/\d+$/gi);
            let prefix = dmmId.replace(num, "");

            if (num) {
                if (!num[0].match(/^00/) && num[0].length < 5) {
                    num = '00' + num;
                }
                return prefix + num;
            } else {
                return null;
            }
        }

        static getOneJavSearchUrl(avid) {
            avid = avid.replace(/-|FC2|PPV/g, "");
            return "https://onejav.com/search/" + avid;
        }

        static getDmmData(dmmIdUrl) {
            if (!dmmIdUrl) return Promise.resolve(null);
            return Common.requestGM_XHR({
                url: dmmIdUrl,
                timeout: 15000,
                headers: {
                    "Accept-Language": "ja-JP",
                    "cookie": "age_check_done=1;"
                },
            }).then((result) => {
                var doc = Common.parsetext(result.responseText);
                let dmmData = {};
                dmmData.collect_num = $(doc).find(".tx-count span").text();
                dmmData.score = $(doc).find(".d-review__average strong").text();
                dmmData.user_num = $(doc).find(".d-review__evaluates strong").text();
                dmmData.url = dmmIdUrl;
                return dmmData;
            }).catch(msg => {
                return {};
            });
        }

        static getJavDbData(avid) {
            const origin = Common.getJavDbOrigin();
            const searchUrl = new URL('/search', origin);
            searchUrl.searchParams.set('f', 'all');
            searchUrl.searchParams.set('q', avid);
            const expectedCode = Common.normalizeJavDbCode(avid);

            return Common.requestGM_XHR({ url: searchUrl.href }).then((result) => {
                const doc = Common.parsetext(result.responseText);
                const item = $(doc).find('.movie-list .item').toArray().find((element) => {
                    const code = $(element).find('.video-title strong').first().text();
                    return Common.normalizeJavDbCode(code) === expectedCode;
                });
                if (!item) throw new Error('JavDB 没查找到此番号');

                const anchor = $(item).find('a.box')[0];
                const href = anchor && anchor.getAttribute('href');
                const url = Common.absoluteUrl(href, origin);
                if (!url) throw new Error('JavDB 详情地址无效');

                return {
                    score: $(item).find('.score>span').text(),
                    url
                };
            });
        }

        static getJavDbPreviewImages(javdbData) {
            if (!javdbData || !javdbData.url) return Promise.resolve([]);

            return Common.requestGM_XHR({ url: javdbData.url, timeout: 15000 }).then((result) => {
                const doc = Common.parsetext(result.responseText);
                const images = [];
                const seen = new Set();

                $(doc).find('.preview-images a.tile-item[href]').each((index, element) => {
                    const large = Common.absoluteUrl(element.getAttribute('href'), javdbData.url);
                    const image = element.querySelector('img');
                    const thumbnail = Common.absoluteUrl(
                        image && (image.getAttribute('src') || image.getAttribute('data-src')),
                        javdbData.url
                    );
                    if (!isPreviewImageUrl(large) || seen.has(large)) return;
                    seen.add(large);
                    images.push({ large, thumbnail: isPreviewImageUrl(thumbnail) ? thumbnail : large });
                });
                return images;
            });
        }

        static getJavInfoPreviewCacheKey(avid) {
            return `${JAVINFO_PREVIEW_CACHE_PREFIX}${Common.normalizeJavDbCode(avid)}`;
        }

        static getJavInfoPreviewCache(avid) {
            const key = Common.getJavInfoPreviewCacheKey(avid);
            const cached = GM_getValue(key, null);
            if (!cached || typeof cached !== 'object' || !Number.isFinite(cached.savedAt)) return null;
            if (Date.now() - cached.savedAt > JAVINFO_PREVIEW_CACHE_TTL) {
                GM_deleteValue(key);
                return null;
            }

            return {
                images: Common.normalizePreviewImages(cached.images),
                provider: String(cached.provider || ''),
                cached: true
            };
        }

        static getPreviewImageValue(value, fields = []) {
            if (typeof value === 'string') return value;
            if (!value || typeof value !== 'object') return '';
            for (const field of fields) {
                if (typeof value[field] === 'string' && value[field]) return value[field];
            }
            return '';
        }

        static normalizePreviewImages(values, thumbnails = [], baseUrl = 'https://api.javinfo.dev/') {
            const imageValues = Array.isArray(values) ? values : [];
            const thumbnailValues = Array.isArray(thumbnails) ? thumbnails : [];
            const images = [];
            const seen = new Set();

            imageValues.forEach((value, index) => {
                const largeValue = Common.getPreviewImageValue(
                    value,
                    ['large', 'full', 'url', 'src', 'image']
                );
                const thumbnailValue = (typeof value === 'object' && Common.getPreviewImageValue(
                    value,
                    ['thumbnail', 'thumb', 'small', 'preview']
                )) || Common.getPreviewImageValue(
                    thumbnailValues[index],
                    ['thumbnail', 'thumb', 'small', 'preview', 'url', 'src', 'image']
                );
                const large = Common.absoluteUrl(largeValue, baseUrl);
                const thumbnail = Common.absoluteUrl(thumbnailValue, baseUrl);
                if (!isPreviewImageUrl(large) || seen.has(large)) return;
                seen.add(large);
                images.push({
                    large,
                    thumbnail: isPreviewImageUrl(thumbnail) ? thumbnail : large
                });
            });
            return images;
        }

        static getJavInfoImagesFromPayload(payload) {
            const record = payload && payload.result;
            if (!record || typeof record !== 'object') {
                throw new Error('javinfo 返回了无效数据');
            }
            const extra = record.extra && typeof record.extra === 'object' ? record.extra : {};
            const baseUrl = extra.pageUrl || extra.url || 'https://api.javinfo.dev/';
            const groups = [
                [record.galleryFull, record.galleryThumb],
                [extra.galleryFull, extra.galleryThumb],
                [record.sampleImages, record.sampleThumbs],
                [extra.sampleImages, extra.sampleThumbs],
                [record.gallery, record.thumbnails],
                [extra.gallery, extra.thumbnails]
            ];
            const images = [];
            const seen = new Set();

            groups.forEach(([largeValues, thumbnailValues]) => {
                Common.normalizePreviewImages(largeValues, thumbnailValues, baseUrl).forEach((image) => {
                    if (seen.has(image.large)) return;
                    seen.add(image.large);
                    images.push(image);
                });
            });
            return images;
        }

        static getJavInfoPreviewImages(avid) {
            const cached = Common.getJavInfoPreviewCache(avid);
            if (cached) return Promise.resolve(cached);

            const apiKey = getJavInfoApiKey();
            if (!apiKey) {
                const error = new Error('尚未配置 javinfo API Key');
                error.code = 'MISSING_API_KEY';
                return Promise.reject(error);
            }

            const url = new URL('/movie', 'https://api.javinfo.dev');
            url.searchParams.set('q', avid);
            url.searchParams.set('providers', 'fanza,dmm,javdatabase,javlibrary');

            return Common.requestGM_XHR({
                url: url.href,
                timeout: 20000,
                headers: {
                    Accept: 'application/json',
                    'x-javinfo-key': apiKey
                }
            }).then((response) => {
                let payload = null;
                try {
                    payload = JSON.parse(response.responseText || response.response || '');
                } catch (error) {
                    if (Number(response.status) === 200) throw new Error('javinfo 返回了无效 JSON');
                }

                const status = Number(response.status || 0);
                if (status !== 200) {
                    const error = new Error(payload && payload.message ? payload.message : `javinfo HTTP ${status || 'error'}`);
                    error.status = status;
                    throw error;
                }

                const returnedCode = payload && payload.result && payload.result.dvdId;
                if (returnedCode && Common.normalizeJavDbCode(returnedCode) !== Common.normalizeJavDbCode(avid)) {
                    throw new Error('javinfo 返回的番号与当前页面不一致');
                }

                const images = Common.getJavInfoImagesFromPayload(payload);
                const result = {
                    images,
                    provider: String(payload.source || ''),
                    cached: false
                };
                GM_setValue(Common.getJavInfoPreviewCacheKey(avid), {
                    savedAt: Date.now(),
                    provider: result.provider,
                    images
                });
                return result;
            });
        }
    };

    class Jav {
        static getAvidAndChgPage() {
            let AVID = $('.header')[0].nextElementSibling.textContent;
            $('.header')[0].nextElementSibling.id = "avid";
            $('#avid').empty().attr("title", "点击复制番号").attr("avid", AVID);
            let a_avid = document.createElement('a');
            $(a_avid).attr("href", "#").append(AVID);
            $(a_avid).click((e) => {
                e.preventDefault();
                GM_setClipboard($('#avid').attr("avid"));
                $(a_avid).text("已复制 ✓");
                setTimeout(() => $(a_avid).text(AVID), 1000);
            });
            $('#avid').append(a_avid);
            $('#avid').after("<span style='color:red;'>(←点击复制)</span>");
            $($('.header')[0]).attr("class", "header_hobby");
            return AVID;
        }

        static waterfallButton() {
            let a3 = document.createElement('a');
            (waterfallScrollStatus > 0) ? $(a3).append('关闭瀑布流&nbsp;&nbsp;') : $(a3).append('开启瀑布流&nbsp;&nbsp;');
            $(a3).css({
                "color": "blue",
                "font": "bold 12px monospace"
            });
            $(a3).attr("href", "#");
            $(a3).click(function (e) {
                e.preventDefault();
                if ((/关闭/g).test($(this).html())) {
                    GM_setValue('scroll_status', 0);
                } else {
                    GM_setValue('scroll_status', 1);
                }
                window.location.reload();
            });
            return a3;
        }

        static enhanceSamplePreviewImages() {
            $('#sample-waterfall>a').each((index, element) => {
                const image = $(element).find('img')[0];
                if (!image) return;

                const sourceUrl = image.currentSrc || image.src || image.getAttribute('data-src');
                const largeSrc = resolveLargePreviewImageUrl(sourceUrl, element.href);
                if (!largeSrc) return;

                element.href = largeSrc;
                element.classList.add('jt-large-preview');
                image.loading = 'lazy';
                image.decoding = 'async';
                if (element.dataset.keepThumbnail === 'true') {
                    const thumbnailSrc = element.dataset.thumbnail;
                    if (isPreviewImageUrl(thumbnailSrc) && thumbnailSrc !== image.src) {
                        image.src = thumbnailSrc;
                    }
                } else if (largeSrc !== image.src) {
                    image.src = largeSrc;
                    image.removeAttribute('srcset');
                    image.removeAttribute('data-src');
                }
            });
        }

        static ensureSamplePreviewContainer() {
            const existing = document.getElementById('sample-waterfall');
            if (existing) return existing;

            const movieRow = document.querySelector('.container .row.movie');
            const host = movieRow && movieRow.closest('.container');
            if (!host) return null;

            const heading = document.createElement('h4');
            heading.className = 'jt-external-preview-heading';
            heading.textContent = '样品图像';

            const container = document.createElement('div');
            container.id = 'sample-waterfall';

            const magnetHeading = Array.from(host.children).find((element) =>
                element.tagName === 'H4' && /磁力|magnet/i.test(element.textContent || '')
            );
            host.insertBefore(heading, magnetHeading || null);
            host.insertBefore(container, magnetHeading || null);
            return container;
        }

        static setPreviewStatus(message, state = '') {
            let status = document.getElementById('jt-preview-status');
            if (!message) {
                if (status) status.remove();
                return;
            }

            const container = this.ensureSamplePreviewContainer();
            if (!container) return;
            if (!status) {
                status = document.createElement('p');
                status.id = 'jt-preview-status';
                container.parentNode.insertBefore(status, container);
            }
            status.className = state ? `jt-preview-status-${state}` : '';
            status.textContent = message;
        }

        static getJavInfoPreviewError(error) {
            if (error && error.code === 'MISSING_API_KEY') {
                return ['尚未配置 javinfo API Key，请在油猴菜单中设置', 'error'];
            }
            const status = Number(error && error.status);
            if (status === 401) return ['javinfo API Key 无效，请在油猴菜单中重新设置', 'error'];
            if (status === 402) return ['javinfo 免费额度或账户余额已用完', 'error'];
            if (status === 404) return ['javinfo 暂无可用预览图', 'empty'];
            if (status === 429) return ['javinfo 请求过快，请稍后重试', 'error'];
            return ['javinfo 预览图加载失败', 'error'];
        }

        static autoLoadPreviewImages(avid, javdbDataPromise) {
            setTimeout(async () => {
                if ($('#sample-waterfall>a').length > 0) {
                    this.enhanceSamplePreviewImages();
                    return;
                }

                const previewSource = getPreviewSource();
                const sourceInfo = PREVIEW_SOURCES[previewSource];
                this.setPreviewStatus(`正在从 ${sourceInfo.label} 查找预览图…`, 'loading');
                try {
                    let previewResult;
                    if (previewSource === 'javinfo') {
                        previewResult = await Common.getJavInfoPreviewImages(avid);
                    } else {
                        const javdbData = await javdbDataPromise;
                        previewResult = {
                            images: await Common.getJavDbPreviewImages(javdbData),
                            provider: 'javdb',
                            cached: false
                        };
                    }
                    const previewImages = previewResult.images;

                    if ($('#sample-waterfall>a').length > 0) {
                        this.enhanceSamplePreviewImages();
                        this.setPreviewStatus('');
                        return;
                    }
                    if (previewImages.length === 0) {
                        this.setPreviewStatus(`${sourceInfo.label} 暂无可用预览图`, 'empty');
                        return;
                    }

                    const container = this.ensureSamplePreviewContainer();
                    if (!container) return;
                    previewImages.forEach(({ large, thumbnail }, index) => {
                        const link = document.createElement('a');
                        link.className = 'sample-box jt-external-preview';
                        link.href = large;
                        link.dataset.source = previewSource;
                        link.dataset.keepThumbnail = 'true';
                        link.dataset.thumbnail = thumbnail;

                        const frame = document.createElement('div');
                        frame.className = 'photo-frame';
                        const image = document.createElement('img');
                        image.src = thumbnail;
                        image.alt = `${avid} ${sourceInfo.label} 预览图 ${index + 1}`;
                        image.title = image.alt;
                        image.loading = 'lazy';
                        image.decoding = 'async';
                        frame.appendChild(image);
                        link.appendChild(frame);
                        container.appendChild(link);
                    });

                    this.enhanceSamplePreviewImages();
                    const provider = previewSource === 'javinfo' && previewResult.provider
                        ? ` / ${previewResult.provider}`
                        : '';
                    const cached = previewResult.cached ? '（本地缓存）' : '';
                    this.setPreviewStatus(
                        `已从 ${sourceInfo.label}${provider} 自动补充 ${previewImages.length} 张预览图${cached}`,
                        'success'
                    );
                } catch (error) {
                    if (previewSource === 'javinfo') {
                        const [message, state] = this.getJavInfoPreviewError(error);
                        this.setPreviewStatus(message, state);
                    } else {
                        this.setPreviewStatus('JavDB 预览图加载失败', 'error');
                    }
                }
            }, 800);
        }

        static collapseMagnetTable() {
            const table = document.getElementById('magnet-table');
            if (!table || document.getElementById('jt-magnet-toggle')) return;

            const button = document.createElement('button');
            button.id = 'jt-magnet-toggle';
            button.type = 'button';
            button.className = 'btn btn-default btn-sm';
            button.textContent = '展开磁力链接';
            button.style.margin = '0 0 10px 0';

            table.style.display = 'none';
            table.parentNode.insertBefore(button, table);

            button.addEventListener('click', () => {
                const hidden = table.style.display === 'none';
                table.style.display = hidden ? '' : 'none';
                button.textContent = hidden ? '隐藏磁力链接' : '展开磁力链接';
            });
        }

        static javBusScript() {
            let a3 = this.waterfallButton();
            if ((/(JavBus|AVMOO|AVSOX)/g).test(document.title) || $("footer:contains('JavBus')").length) {
                GM_addStyle(`
                    .info p {line-height: 18px!important;}
                    .screencap img{	width:100%;	max-width: 1000px;}
                    #sample-waterfall {
                        display: grid !important;
                        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
                        align-items: start;
                        gap: 8px;
                        width: 100%;
                        margin: 0 0 12px;
                    }
                    #sample-waterfall .sample-box.jt-large-preview {
                        display: block !important;
                        width: 100% !important;
                        height: auto !important;
                        margin: 0 !important;
                        float: none !important;
                        overflow: hidden;
                        border-radius: 4px;
                    }
                    #sample-waterfall .sample-box.jt-large-preview .photo-frame {
                        width: 100% !important;
                        height: auto !important;
                        line-height: 0;
                    }
                    #sample-waterfall .sample-box.jt-large-preview img {
                        width: 100% !important;
                        max-width: none !important;
                        height: auto !important;
                        display: block;
                        transition: transform .18s ease;
                    }
                    #sample-waterfall .sample-box.jt-large-preview:hover img {
                        transform: scale(1.025);
                    }
                    #jt-preview-status {
                        margin: -2px 0 8px;
                        color: #777;
                        font-size: 12px;
                    }
                    #jt-preview-status.jt-preview-status-success {color: #3c763d;}
                    #jt-preview-status.jt-preview-status-error {color: #a94442;}
                    .jt-magnet-actions {
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        gap: 8px;
                        white-space: nowrap;
                    }
                    .jt-magnet-actions .nong-nas {font-weight: 600;}
                    @media (max-width: 767px) {
                        #sample-waterfall {
                            grid-template-columns: repeat(2, minmax(0, 1fr));
                            gap: 6px;
                        }
                    }
                `);

                $('#navbar ul.nav.navbar-nav li:eq(0)').after(`<li><a href="https://onejav.com/popular/?amateur=1" target="_blank" style="color: red;">FC2</a></li>`);
                $('#navbar ul.nav.navbar-nav li:eq(0)').after('<li><a href="/search/VR&type=1" style="color: red;">VR</a></li>');

                let li_elem = document.createElement('li');
                $(li_elem).append($(a3));
                $(".visible-md-block").closest(".dropdown").after($(li_elem));
                $(".active").closest(".navbar-nav").append($(li_elem));
                $(".ad-box").remove();

                thirdparty.waterfallScrollInit();

                if ($('.header').length && $('meta[name="keywords"]').length) {
                    let AVID = this.getAvidAndChgPage();

                    $('p.header').before('<p id="zuobiao"></p>');
                    let $p_zuobiao = $('#zuobiao');

                    this.enhanceSamplePreviewImages();

                    let a_imgs = $('#sample-waterfall>a');
                    if (a_imgs.length && !$('a.avatar-box[href*="uncensored"]').length && !location.hostname.includes('javbus.org')
                        && $('#sample-waterfall>a[href*="pics.dmm"]').length) {
                        Common.getDmmData(`https://www.dmm.co.jp/digital/videoa/-/detail/=/cid=${Common.getDmmId(a_imgs[0].href)}/`).then((dmmData) => {
                            if (dmmData.score) {
                                $p_zuobiao.before(`
                                    <p>
                                        <span class="header">
                                            <a target="_blank" href="${dmmData.url}" style="color: blue;">DMM&nbsp;评:</a>
                                        </span>
                                        ${dmmData.score.replace("点", "分")}, ${dmmData.user_num}人评, ${dmmData.collect_num}收藏
                                    </p>
                                `);
                            }
                        });
                    }

                    const javdbDataPromise = Common.getJavDbData(AVID);
                    javdbDataPromise.then((javdbData) => {
                        let score = javdbData.score.trim().replace("由", "").replace("人評價", "人评");
                        $p_zuobiao.after(`
                            <p>
                                <span class="header"><a target="_blank" href="${javdbData.url}" style="color: blue;">javdb评:</a></span>
                                ${score}
                            </p>
                        `);
                    }).catch(() => { });
                    this.autoLoadPreviewImages(AVID, javdbDataPromise);

                    $('.col-md-3.info').append(`
                        <p>
                            <span class="header">在线预览:</span>
                            <a href="https://missav.com/cn/${AVID}" target="_blank" style="color: rgb(204, 0, 0);" title="需解封印">missav&nbsp;</a>
                            <a href="https://${MMTV_DOMAIN}/zh/censored_search/all/${AVID}/1.html" target="_blank" style="color: rgb(204, 0, 0);" title="需解封印">7mmtv&nbsp;</a>
                            <a href="https://supjav.com/zh/?s=${AVID}" target="_blank" style="color: rgb(204, 0, 0);" title="需解封印">supjav&nbsp;</a>
                        </p>
                    `);
                    $('.col-md-3.info').append(`
                        <p id="linkJump">
                            <span class="header">JAV跳转:</span>
                            <a href="https://${GM_getValue('javlib_url')}/cn/vl_searchbyid.php?keyword=${AVID}" target="_blank" style="color: rgb(204, 0, 0);">JavLib&nbsp;</a>
                        </p>
                    `);

                    // 增强磁力表格操作功能
                    const $magnetHeader = $('#magnet-table tbody tr').first();
                    if ($magnetHeader.length && !$magnetHeader.find('.jt-magnet-actions-heading').length) {
                        $magnetHeader.append('<td class="jt-magnet-actions-heading" style="text-align:center;white-space:nowrap">操作</td>');
                    }
                    this.collapseMagnetTable();

                    const enhanceMagnetTable = () => {
                        let tr_array = $('#magnet-table tr[height="35px"]');
                        for (var i = 0; i < tr_array.length; i++) {
                            let trEle = tr_array[i];
                            if ($(trEle).find('.jt-magnet-actions-cell').length > 0) continue;

                            const magnetLink = $(trEle).find('a[href^="magnet:"]')[0];
                            if (!magnetLink) continue;
                            const magnetUrl = magnetLink.href;
                            const taskName = $(trEle).find('td').first().text().trim() || AVID;
                            const cell = document.createElement('td');
                            cell.className = 'jt-magnet-actions-cell';
                            cell.style.textAlign = 'center';

                            const actions = document.createElement('div');
                            actions.className = 'jt-magnet-actions';
                            const copyLink = document.createElement('a');
                            copyLink.className = 'nong-copy';
                            copyLink.href = magnetUrl;
                            copyLink.textContent = '复制';
                            copyLink.addEventListener('click', function (e) {
                                e.preventDefault();
                                GM_setClipboard(magnetUrl);
                                $(this).text("成功");
                                setTimeout(() => $(this).text("复制"), 1000);
                            });

                            const nasLink = document.createElement('a');
                            nasLink.className = 'nong-nas';
                            nasLink.href = '#';
                            nasLink.textContent = '一键NAS';
                            nasLink.title = '使用浏览器中保存的 NAS 地址模板打开此磁力链接';
                            nasLink.addEventListener('click', function (e) {
                                e.preventDefault();
                                if (!openNasUrl({ magnet: magnetUrl, name: taskName, code: AVID })) return;
                                $(this).text('已打开');
                                setTimeout(() => $(this).text('一键NAS'), 1000);
                            });

                            actions.appendChild(copyLink);
                            actions.appendChild(nasLink);
                            cell.appendChild(actions);
                            trEle.appendChild(cell);
                        }
                    };

                    enhanceMagnetTable();
                    const observer = new MutationObserver(() => {
                        enhanceMagnetTable();
                    });
                    const targetNode = document.getElementById('magnet-table');
                    if (targetNode) observer.observe(targetNode, { childList: true });
                }
            }
        }

        static javDBScript() {
            if ((/(JavDB)/g).test(document.title)) {
                if ($('.app-desktop-banner').length) $('.app-desktop-banner').remove();
                if ($('.modal.is-active.over18-modal').length) $('.modal.is-active.over18-modal').remove();

                $('.navbar-dropdown.is-boxed .navbar-item:contains("FC2")')
                    .attr("href", "/advanced_search?type=3&score_min=4.2&score_max=&released_start=&released_end=&actors%5B%5D=&tags%5B%5D=&p=0&d=0&d=1&c=0&s=0&i=0&v=0&commit=檢索&lm=h").attr("style", "color: red;");
                $('.navbar-dropdown.is-boxed .navbar-item:eq(0)')
                    .after('<a class="navbar-item" href="/advanced_search?type=0&score_min=4.2&score_max=&released_start=&released_end=&actors%5B%5D=&tags%5B%5D=&tags%5B%5D=212%7CVR&p=0&d=0&d=1&c=0&s=0&i=0&v=0&commit=檢索&lm=h" style="color: red;">VR</a>');

                thirdparty.waterfallScrollInit();

                if (!$("#waterfall").hasClass("v cols-4 vcols-8")) {
                    if (!$(".tabs.is-boxed").length) {
                        $("#waterfall").before(`<div class="tabs is-boxed" style="justify-content: flex-end;"></div>`);
                    }
                    $(".tabs.is-boxed").before(`<a name="maodian" style="position: relative;top: -60px;"></a>`);
                    $('.tabs.is-boxed').append(`
                        <div style="display: flex;">
                            <div class="is-active" style="border: 1px solid #3273dc;">
                                <a id="javtopusernum" href="#maodian" style="background-color: white;color: #3273dc;font-weight: bold;">
                                    <span>评分人数排序</span>
                                </a>
                            </div>
                            <div class="is-active" style="border: 1px solid #3273dc;">
                                <a id="javtopscore" href="#maodian" style="background-color: white;color: #3273dc;font-weight: bold;">
                                    <span>JAV评分排序</span>
                                </a>
                            </div>
                            <div style="border: 1px solid #3273dc;background-color: #f5f5f5;height: 2.8em;display: flex;">
                                <a href="#maodian" style="color: #3273dc; font-weight: bold;">
                                    <span>屏蔽评分人数&nbsp&lt;&nbsp</span>
                                </a>
                                <input id="offusernum" name="offusernum" class="input" placeholder="0&nbsp人数" min="0" max="9999" type="number"
                                        style="height: 1.5em;width: 5.5em;padding: 2px;margin: 0.6em 1em 0 0;">
                            </div>
                        </div>
                    `);

                    $('#javtopscore').click((e) => {
                        e.preventDefault();
                        let div_array = $(JAVDB_ITEM_SELECTOR);
                        div_array.sort((a, b) => {
                            let a_score = parseFloat($(a).attr("score")) || 0;
                            let b_score = parseFloat($(b).attr("score")) || 0;
                            return b_score - a_score;
                        });
                        div_array.detach().appendTo("#waterfall");
                        $('#javtopscore').css("background-color", "#3273dc").css("color", "white");
                        $('#javtopusernum').css("background-color", "white").css("color", "#3273dc");
                    });

                    $('#javtopusernum').click((e) => {
                        e.preventDefault();
                        let div_array = $(JAVDB_ITEM_SELECTOR);
                        div_array.sort((a, b) => {
                            let a_score = parseFloat($(a).attr("usernum")) || 0;
                            let b_score = parseFloat($(b).attr("usernum")) || 0;
                            return b_score - a_score;
                        });
                        div_array.detach().appendTo("#waterfall");
                        $('#javtopusernum').css("background-color", "#3273dc").css("color", "white");
                        $('#javtopscore').css("background-color", "white").css("color", "#3273dc");
                    });

                    $('#offusernum').change(() => {
                        let offusernum = $('#offusernum').val();
                        if (offusernum) {
                            $(JAVDB_ITEM_SELECTOR).toArray().forEach(e => {
                                parseInt($(e).attr("usernum") || 0) < parseInt(offusernum) ? $(e).hide() : $(e).show();
                            });
                        }
                    });

                    if ($("div.video-detail").length > 0) {
                        $("div.top-meta").remove();
                    }
                }
            }
        }
    }

    var thirdparty = {
        waterfallScrollInit: () => {
            var w = new thirdparty.waterfall({});
            var $pages = $('div#waterfall div.item');
            if ($pages.length) {
                $pages[0].parentElement.parentElement.id = "waterfall_h";
                if ((/(JavBus|AVMOO|AVSOX)/g).test(document.title) || $("footer:contains('JavBus')").length) {
                    w = new thirdparty.waterfall({
                        next: 'a#next',
                        item: 'div#waterfall div.item',
                        cont: '.masonry',
                        pagi: '.pagination-lg',
                    });
                }
                if ((/(AVMOO|AVSOX)/g).test(document.title)) {
                    w = new thirdparty.waterfall({
                        next: 'a[name="nextpage"]',
                        item: 'div#waterfall div.item',
                        cont: '#waterfall',
                        pagi: '.pagination',
                    });
                }
            }

            var $pages4 = $(JAVDB_ITEM_SELECTOR);
            if ($pages4.length) {
                GM_addStyle(`
                            .container {max-width: inherit !important;}
                            .tags{display: block !important;}
                            .tag.hobby{display: block;float: right;color: #fff;line-height: 2em;}
                        `);
                $pages4[0].parentElement.id = "waterfall";
                w = new thirdparty.waterfall({
                    next: '.pagination .pagination-next',
                    item: JAVDB_ITEM_SELECTOR,
                    cont: '#waterfall',
                    pagi: '.pagination',
                });
            }

            w.setSecondCallback((cont, elems) => {
                if (location.pathname.includes('/star/') && elems) {
                    cont.append(elems.slice(1));
                } else {
                    cont.append(elems);
                }
            });

            w.setFourthCallback((elems) => {
                if (((/(JavBus|AVMOO|AVSOX)/g).test(document.title) || $("footer:contains('JavBus')").length) && elems) {
                    if (location.pathname.search('/searchstar|/actresses|/&mdl=favor&sort=4') < 0) {
                        for (let i = 0; i < elems.length; i++) {
                            if ($(elems[i]).find("div.avatar-box").length > 0) continue;
                            let spanEle = $(elems[i]).find("div.photo-info span")[0];
                            if (spanEle && $(spanEle).html().indexOf("<br>") > -1) {
                                let t1 = $(spanEle).html().substr($(spanEle).html().indexOf("<br>") + 4);
                                let t2 = $(spanEle).html().substr(0, $(spanEle).html().indexOf("<br>"));
                                $(spanEle).html(t1 + "<br>" + t2);
                            }
                        }
                    }
                }

                if ((/(JavDB)/g).test(document.title) && elems) {
                    elems.toArray().forEach(e => {
                        $(e).find(".tags.has-addons span:not(.tag.is-success,.tag.is-warning)").remove();
                        if ($(e).find(".tag.is-warning").length) {
                            $(e).find(".tag.is-warning").text("含中字");
                        }
                        let $div = $(e).find(".tags.has-addons").eq(0);
                        let avid = $(e).find(".video-title strong").text();

                        if (!$div.children().length) {
                            $div.append(`<span class="tag is-success" style="background-color:#fff;">.</span>`);
                        }
                        if (!$("#waterfall").hasClass("v cols-4 vcols-8")) {
                            $div.append(`
                                        <a title="无码 JAV资源站" href="https://${GM_getValue('javbus_url')}/${avid}" target="_blank">
                                            <span class="tag hobby" style="margin-right: 5px;background-color:#febe00;">JavBus</span>
                                        </a>
                                        <a title="有码 JAV资源站" href="https://${GM_getValue('javlib_url')}/cn/vl_searchbyid.php?keyword=${avid}" target="_blank">
                                            <span class="tag hobby" style="margin-right: 0px;background-color:#f908bb;">JavLib</span>
                                        </a>
                                        <a title="FC2 JAV资源站" href="${Common.getOneJavSearchUrl(avid)}" target="_blank">
                                            <span class="tag hobby" style="margin-right: 3px;background-color:#00d1b2;">OneJav</span>
                                        </a>
                                    `);

                            let scoresText = $(e).find('.score>span').text();
                            let scoreMatches = scoresText.match(/-?(?:\d+(?:\.\d*)?|\.\d+)/g);
                            if (scoreMatches && scoreMatches.length >= 2) {
                                $(e).attr("score", scoreMatches[0]);
                                $(e).attr("usernum", scoreMatches[1]);
                            }
                        }
                    });
                }
            });

            if ((/(JavBus|AVMOO|AVSOX)/g).test(document.title) || $("footer:contains('JavBus')").length) {
                GM_addStyle(`
                    #waterfall_h {height: initial !important;width: initial !important;flex-direction: row;flex-wrap: wrap;margin: 5px 15px !important;}
                    #waterfall_h .item {position: relative !important;top: initial !important;left: initial !important;float: left;}
                    #waterfall_h .movie-box img {position: absolute; top: -200px; bottom: -200px; left: -200px; right: -200px; margin: auto;}
                    #waterfall_h .movie-box .photo-frame {position: relative;} #waterfall_h .avatar-box .photo-info p {margin: 0 0 2px;}
                    #waterfall_h .avatar-box .photo-info {line-height: 15px; padding: 6px;height: 220px;}
                    #waterfall_h .avatar-box .photo-frame {margin: 10px;text-align: center;}
                    #waterfall_h .avatar-box.text-center {height: 195px;}
                `);

                if (location.pathname.includes('/uncensored') || location.hostname.includes('javbus.org') || (/(AVSOX)/g).test(document.title)) {
                    GM_addStyle(`#waterfall_h .movie-box {width: 354px;} #waterfall_h .movie-box .photo-info {height: 105px;}`);
                } else {
                    GM_addStyle(`#waterfall_h .movie-box {width: 167px;} #waterfall_h .movie-box .photo-info {height: 145px;}`);
                }
            }
        },
        waterfall: (() => {
            function waterfall(selectorcfg = {}) {
                class Lock {
                    constructor(d = false) {
                        this.locked = d;
                    }
                    lock() {
                        this.locked = true;
                    }
                    unlock() {
                        this.locked = false;
                    }
                }
                this.page_queue = new Queue(1);
                this.lock = new Lock();
                this.baseURI = this.getBaseURI();
                this.selector = {
                    next: 'a.next',
                    item: '',
                    cont: '#waterfall',
                    pagi: '.pagination',
                };
                Object.assign(this.selector, selectorcfg);
                this.pagegen = this.fetchSync(location.href);
                this.anchor = $(this.selector.pagi)[0];
                this._count = 0;
                this._1func = (cont, elems) => {
                    cont.empty().append(elems);
                };
                this._2func = (cont, elems) => {
                    cont.append(elems);
                };
                this._4func = (elems) => { };
                if ($(this.selector.item).length) {
                    if (waterfallScrollStatus > 0) {
                        document.addEventListener('scroll', this.scroll.bind(this));
                        document.addEventListener('wheel', this.wheel.bind(this));
                    }
                    this.appendElems(this._1func);
                }
            }

            waterfall.prototype.getBaseURI = () => {
                let _ = location;
                return `${_.protocol}//${_.hostname}${(_.port && `:${_.port}`)}`;
            };
            waterfall.prototype.getNextURL = function (href) {
                let a = document.createElement('a');
                a.href = href;
                return `${this.baseURI}${a.pathname}${a.search}`;
            };
            waterfall.prototype.fetchURL = function (url) {
                let status = 404;
                const fetchwithcookie = fetch(url, { credentials: 'same-origin' });
                return fetchwithcookie.then(response => {
                    status = response.status;
                    return response.text();
                }).then(html => new DOMParser().parseFromString(html, 'text/html'))
                    .then(doc => {
                        let $doc = $(doc);
                        let elems = [];
                        let nextURL;
                        if (status < 300) {
                            let href = $doc.find(this.selector.next).attr('href');
                            nextURL = href ? this.getNextURL(href) : undefined;
                            elems = $doc.find(this.selector.item);
                            for (const elem of elems) {
                                const links = elem.getElementsByTagName('a');
                                for (const link of links) {
                                    link.target = "_blank";
                                }
                            }
                            if ($(JAVDB_ITEM_SELECTOR).length && (this._count !== 0) && url === nextURL) {
                                if ($(`#waterfall>div>a[href="${$(elems[0]).find('a.box')[0].attr('href')}"]`).length > 0) {
                                    nextURL = undefined;
                                    elems = [];
                                }
                            }
                        } else {
                            nextURL = undefined;
                        }
                        return {
                            nextURL,
                            elems
                        };
                    });
            };
            waterfall.prototype.fetchSync = function* (urli) {
                let url = urli;
                do {
                    yield new Promise((resolve, reject) => {
                        if (this.lock.locked) {
                            reject();
                        }
                        else {
                            this.lock.lock();
                            resolve();
                        }
                    }).then(() => {
                        return this.fetchURL(url).then(info => {
                            url = info.nextURL;
                            return info.elems;
                        });
                    }).then(elems => {
                        this.lock.unlock();
                        return elems;
                    }).catch((err) => {
                    });
                } while (url);
            };
            waterfall.prototype.appendElems = function () {
                let nextpage = this.pagegen.next();
                if (!nextpage.done) {
                    nextpage.value.then(elems => {
                        const cb = (this._count === 0) ? this._1func : this._2func;
                        cb($(this.selector.cont), elems);
                        this._count += 1;
                        this._4func(elems);
                    });
                }
                return nextpage.done;
            };
            waterfall.prototype.end = function () {
                document.removeEventListener('scroll', this.scroll.bind(this));
                document.removeEventListener('wheel', this.wheel.bind(this));
                let $end = $(`<h1>The End</h1>`);
                $(this.anchor).replaceWith($end);
            };
            waterfall.prototype.reachBottom = function (elem, limit) {
                if (!elem) return false;
                return (elem.getBoundingClientRect().top - $(window).height()) < limit;
            };
            waterfall.prototype.scroll = function () {
                this.pageQueuePush();
            };
            waterfall.prototype.wheel = function () {
                this.pageQueuePush();
            };
            waterfall.prototype.pageQueuePush = function () {
                this.page_queue.push(() => {
                    let defer = $.Deferred();
                    new Promise(resolve => {
                        if (this.reachBottom(this.anchor, 1200) && this.appendElems(this._2func)) {
                            this.end();
                        }
                        resolve();
                    }).then(() => {
                        setTimeout(() => {
                            defer.resolve();
                        }, 500);
                    });
                    return defer.promise();
                });
            };
            waterfall.prototype.setFirstCallback = function (f) {
                this._1func = f;
            };
            waterfall.prototype.setSecondCallback = function (f) {
                this._2func = f;
            };
            waterfall.prototype.setFourthCallback = function (f) {
                this._4func = f;
            };
            return waterfall;
        })()
    };

    function mainRun() {
        Common.init();

        if ((/(JavBus|AVMOO|AVSOX)/g).test(document.title) || $("footer:contains('JavBus')").length) {
            GM_addStyle(`
                .container {width: 100%;float: left;}
                .col-md-3 {float: left;max-width: 260px;}
                .col-md-9 {width: inherit;}
                .footer {padding: 20px 0;background: #1d1a18;float: left;}
                .header_hobby {font-weight: bold;text-align: right;width: 75px;}
            `);
            Jav.javBusScript();
        }

        Jav.javDBScript();
    }
    mainRun();
})();
