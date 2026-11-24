// ==UserScript==
// @name         DMM Cast Auto-Filler
// @name:en      DMM Cast Auto-Filler
// @namespace    https://github.com/hxbdy/actress-ext
// @version      2.3.0
// @description  素人女優の名前を表示します
// @description:en A feature to add cast members to pages for works with unknown cast members
// @author       hxbdy
// @icon         https://raw.githubusercontent.com/hxbdy/actress-ext/main/icon.png
// @match        https://video.dmm.co.jp/*
// @connect      av-wiki.net
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/hxbdy/actress-ext/main/dmm-cast-auto-filler.user.js
// @updateURL    https://raw.githubusercontent.com/hxbdy/actress-ext/main/dmm-cast-auto-filler.user.js
// ==/UserScript==

(function () {
    "use strict";

    // 開発時は true にするとコンソールに動作ログが出る
    const DEBUG = false;
    const log  = DEBUG ? console.log.bind(console)   : () => {};
    const warn = DEBUG ? console.warn.bind(console)  : () => {};
    const err  = DEBUG ? console.error.bind(console) : () => {};

    // ID
    const MY_AFF_ID = "6dy-990";

    // av-wiki は WordPress の REST API を公開しており、slug 指定で最大100件まとめて取れる。
    // 記事HTMLを丸ごと取るより桁違いに軽い（1件あたり約1KB）。
    const WIKI_API = "https://av-wiki.net/wp-json/wp/v2/posts";
    const WIKI_CHUNK = 100;

    // アフィリエイト化の対象。ジャンルやレーベルのリンクは書き換えない
    const AFF_CONTENT_RE = /\/[a-z]+\/content\/\?[^#]*\bid=/;   // 作品ページ（av / amateur など）
    const AFF_ACTRESS_RE = /\/list\/\?[^#]*\bactress=/;         // 女優別一覧
    const AFF_LINK_SELECTOR = 'a[data-e2eid="title"], a[href*="/content/?id="], a[href*="/list/?actress="]';

    // 一覧カード関連。
    // アフィリエイト化するとリンク先が al.fanza の lurl に包まれて `?id=` の形が消えるため、
    // 変換前・変換後の両方の形を拾えるようにしておく。
    const CARD_LINK_SELECTOR = 'a[href*="/content/?id="], a[href*="content%2F%3Fid%3D"]';
    const ACTRESS_LINK_SELECTOR = 'a[href*="/list/?actress="], a[href*="list%2F%3Factress%3D"]';
    const CARD_SELECTOR = '[data-e2eid="content-card"], li';
    const CARD_WALK_LIMIT = 8;
    const CAST_LABEL_CLASS = "my-cast-label";

    // 一覧ページの絞り込み（ベスト盤を隠す）
    const BEST_FILTER_KEY = "fanza-cast-filler-hide-best";
    const BEST_FILTER_PANEL_ID = "my-best-filter-panel";
    const BEST_HIDDEN_CLASS = "my-best-hidden";
    const BEST_TITLE_RE = /BEST|ＢＥＳＴ|ベスト/i;

    // 作品ページの出演者名の下に並べる、他の出演作（素人作品）のサムネイル
    const WORKS_SHOW_MAX = 12;
    const WORK_THUMB_SIZE = 90;
    const WORKS_SECTION_CLASS = "my-works-section";

    // 女優は av-wiki の WordPress タグとして登録されている（https://av-wiki.net/av-actress/<タグslug>/）
    const WIKI_TAGS_API = "https://av-wiki.net/wp-json/wp/v2/tags";
    const TAG_RE = /^[%0-9a-z_-]{1,200}$/i;
    const AMATEUR_MARK = "av-wiki.net/fanza-shirouto/";

    // ユーザースクリプトマネージャによって公開名が違うため吸収する
    const gmRequest =
        typeof GM_xmlhttpRequest === "function" ? GM_xmlhttpRequest
      : (typeof GM !== "undefined" && GM.xmlHttpRequest) ? GM.xmlHttpRequest.bind(GM)
      : null;

    // 「取得中...」を書き込んだセル。失敗時に元へ戻すために保持する
    let loadingCell = null;
    // 自前で追加した行。失敗時は行ごと消す
    let loadingRow = null;
    // 「取得中...」で上書きする前の内容（`----` 等）。失敗時に書き戻す
    let loadingPrevHtml = "";

    // ---------------------------------------------------------
    // アフィリエイト
    // ---------------------------------------------------------

    // 対象URLをアフィリエイトURLに変換する（変換対象外なら null を返す）
    function toAffiliateUrl(url) {
        // すでにアフィリエイト化されている、または対象外ならスキップ
        if (!url || url.includes("al.fanza.co.jp")) return null;
        if (!AFF_CONTENT_RE.test(url) && !AFF_ACTRESS_RE.test(url)) return null;

        // 余計な計測パラメータ（_gl, _ga, _fplc等）を削除
        const cleaned = url.split('&_gl=')[0]
                           .split('&_ga=')[0]
                           .split('&_fplc=')[0];

        return `https://al.fanza.co.jp/?lurl=${encodeURIComponent(cleaned)}&af_id=${MY_AFF_ID}&ch=api`;
    }

    // 女優名検索ページ（アフィリエイト経由）のURL
    function actressSearchUrl(name) {
        const searchUrl = `https://video.dmm.co.jp/list/?key=${encodeURIComponent(name)}`;
        return `https://al.fanza.co.jp/?lurl=${encodeURIComponent(searchUrl)}&af_id=${MY_AFF_ID}&ch=api`;
    }

    function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, c =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    function castLinksHtml(names) {
        return names
            .map(n => `<a href="${actressSearchUrl(n)}" class="my-actress-link">${escapeHtml(n)}</a>`)
            .join(""); // スペースの代わりに margin-right で間隔を確保
    }

    // ---------------------------------------------------------
    // av-wiki 問い合わせ
    // ---------------------------------------------------------

    // 配信品番(cid)から av-wiki の記事slug候補を作る。
    //   tow057  -> tow-057          （大半はこれ）
    //   fct0225 -> fct-0225, fct-225（先頭ゼロが落ちている記事がある）
    //   sth013  -> sth013           （cidがそのままslugの記事もある）
    function cidToSlugCandidates(cid) {
        const out = [];
        const m = /^([0-9]*[a-z]+)([0-9]+)$/.exec(cid);
        if (m) {
            const prefix = m[1];
            const digits = m[2];
            out.push(`${prefix}-${digits}`);
            const stripped = digits.replace(/^0+/, "");
            if (stripped && stripped !== digits) out.push(`${prefix}-${stripped}`);
        }
        out.push(cid);
        return out.filter((s, i) => out.indexOf(s) === i);
    }

    // 女優名の区切り（半角・全角スペース、カンマ、読点）
    const NAME_SEPARATOR_RE = /[\s,、　 ]+/;

    // 女優リンク https://av-wiki.net/av-actress/<タグslug>/ からタグslugを取り出す。
    // slug は URL エンコードされたまま扱う（REST API の tags?slug= にもその形で渡す）
    function actressTagFromHref(href) {
        const m = /\/av-actress\/([^/?#]+)\/?/.exec(href || "");
        return m ? m[1].toLowerCase() : null;
    }

    // 記事HTMLから「AV女優名」を取り出して [{ name, tag }] で返す。
    // tag は av-wiki の女優タグslug（他の出演作を引くのに使う）。直書きの名前は null
    function extractActresses(html) {
        const doc = new DOMParser().parseFromString(html, "text/html");

        // 全ての <dt> 要素（ラベル部分）から「AV女優名」の項目を探す
        const dts = Array.from(doc.querySelectorAll('dt'));
        const targetDt = dts.find(dt => dt.textContent.includes("AV女優名"));

        if (!targetDt || !targetDt.nextElementSibling) {
            log("Wiki上の項目一覧:", dts.map(dt => dt.textContent.trim()));
            return [];
        }

        // その隣にある <dd> （女優名が入っている場所）を取得
        const dd = targetDt.nextElementSibling;
        const anchorTags = Array.from(dd.querySelectorAll('a'));

        // aタグがある場合はそれぞれのテキストを、無ければ直書きのテキストを使う
        const raw = anchorTags.length > 0
            ? anchorTags.map(a => a.textContent.trim()).join(" ")
            : dd.textContent.trim();

        // 「＊＊＊」などの伏せ字は名前として扱わない
        if (!raw || raw.includes("＊＊＊")) return [];

        if (anchorTags.length === 0) {
            return raw.split(NAME_SEPARATOR_RE).filter(n => n.length > 0).map(name => ({ name, tag: null }));
        }

        const out = [];
        anchorTags.forEach(a => {
            const names = a.textContent.trim().split(NAME_SEPARATOR_RE).filter(n => n.length > 0);
            // 1つのリンクに複数名が入っている場合は、どの名前のタグか判別できないので付けない
            const tag = names.length === 1 ? actressTagFromHref(a.getAttribute("href")) : null;
            names.forEach(name => out.push({ name, tag }));
        });
        return out;
    }

    function namesOf(actresses) {
        return actresses.map(a => a.name);
    }

    function fetchWikiChunk(slugs) {
        const url = `${WIKI_API}?slug=${slugs.map(encodeURIComponent).join(",")}`
                  + `&per_page=${WIKI_CHUNK}&_fields=slug,content`;
        return gmGetJson(url).then(posts => (Array.isArray(posts) ? posts : []));
    }

    // av-wiki の REST API から JSON を取得する
    function gmGetJson(url) {
        return new Promise((resolve, reject) => {
            if (!gmRequest) return reject(new Error("GM_xmlhttpRequest が利用できません"));

            gmRequest({
                method: "GET",
                url,
                onload: (res) => {
                    // fetch と違い 404 でも onload に来るのでステータスを見る
                    if (res.status < 200 || res.status >= 300 || !res.responseText) {
                        return reject(new Error(`av-wiki への問い合わせに失敗: ${res.status}`));
                    }
                    try {
                        resolve(JSON.parse(res.responseText) || []);
                    } catch (e) {
                        reject(new Error("av-wiki の応答を解釈できませんでした"));
                    }
                },
                onerror: () => reject(new Error("av-wiki への通信に失敗しました"))
            });
        });
    }

    // slug の配列を渡すと slug -> [{ name, tag }] の Map を返す
    async function fetchWikiBySlugs(slugs) {
        const found = new Map();
        for (let i = 0; i < slugs.length; i += WIKI_CHUNK) {
            const posts = await fetchWikiChunk(slugs.slice(i, i + WIKI_CHUNK));
            posts.forEach(post => {
                const html = post && post.content && post.content.rendered;
                if (post && post.slug && html) {
                    found.set(post.slug, extractActresses(html));
                }
            });
        }
        return found;
    }

    // cid の配列を渡すと cid -> [{ name, tag }] の Map を返す。
    // 1段目でハイフン形をまとめて引き、取れなかったものだけ2段目の候補に回す。
    async function resolveCastByCids(cids) {
        const result = new Map();
        const slugToCid = new Map();
        const stage1 = [];
        const rest = new Map();

        cids.forEach(cid => {
            const candidates = cidToSlugCandidates(cid);
            slugToCid.set(candidates[0], cid);
            stage1.push(candidates[0]);
            if (candidates.length > 1) rest.set(cid, candidates.slice(1));
        });

        (await fetchWikiBySlugs(stage1)).forEach((names, slug) => {
            const cid = slugToCid.get(slug);
            if (cid) {
                result.set(cid, names);
                rest.delete(cid);
            }
        });

        if (rest.size) {
            const stage2 = [];
            rest.forEach((candidates, cid) => candidates.forEach(slug => {
                slugToCid.set(slug, cid);
                stage2.push(slug);
            }));
            (await fetchWikiBySlugs(stage2)).forEach((names, slug) => {
                const cid = slugToCid.get(slug);
                if (cid && !result.has(cid)) result.set(cid, names);
            });
        }

        return result;
    }

    // ---------------------------------------------------------
    // キャッシュ（同じ作品を何度も問い合わせない）
    // ---------------------------------------------------------

    const CACHE_KEY = "fanza-cast-filler-cache";
    const CACHE_MAX = 2000;
    const TTL_HIT  = 30 * 24 * 60 * 60 * 1000; // 見つかった作品は30日
    const TTL_MISS =  3 * 24 * 60 * 60 * 1000; // 未登録作品は後から載ることがあるので3日

    let cache = null;

    function loadCache() {
        if (cache) return cache;
        try {
            cache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
        } catch (e) {
            cache = {};
        }
        return cache;
    }

    // 見つかった出演者 [{ name, tag }] / 未登録なら空配列 / キャッシュ無しは null。
    // n: 名前の配列、g: 名前と同じ並びのタグslug
    function cacheGet(cid) {
        const entry = loadCache()[cid];
        if (!entry || !entry.t) return null;
        const names = entry.n || [];
        const ttl = names.length ? TTL_HIT : TTL_MISS;
        if (Date.now() - entry.t > ttl) return null;
        // タグを持たない古い形式のキャッシュは、出演作を出せるよう一度だけ取り直す
        if (names.length && !Array.isArray(entry.g)) return null;
        const tags = entry.g || [];
        return names.map((name, i) => ({ name, tag: tags[i] || null }));
    }

    function cacheSet(cid, actresses) {
        loadCache()[cid] = {
            n: namesOf(actresses),
            g: actresses.map(a => a.tag || null),
            t: Date.now()
        };
    }

    function saveCache() {
        if (!cache) return;
        try {
            const keys = Object.keys(cache);
            if (keys.length > CACHE_MAX) {
                keys.sort((a, b) => cache[a].t - cache[b].t)
                    .slice(0, keys.length - CACHE_MAX)
                    .forEach(k => delete cache[k]);
            }
            localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
        } catch (e) {
            warn("⚠️ キャッシュの保存に失敗しました");
        }
    }

    // ---------------------------------------------------------
    // 出演者ごとの他の出演作（素人作品）
    // ---------------------------------------------------------

    const WORKS_KEY = "fanza-cast-filler-works";
    const WORKS_MAX = 200;
    const WORKS_TTL = 3 * 24 * 60 * 60 * 1000;

    // tag -> { w: [{ cid, title }], t }
    let worksCache = null;

    function loadWorksCache() {
        if (worksCache) return worksCache;
        try {
            worksCache = JSON.parse(localStorage.getItem(WORKS_KEY)) || {};
        } catch (e) {
            worksCache = {};
        }
        return worksCache;
    }

    function worksCacheGet(tag) {
        const entry = loadWorksCache()[tag];
        if (!entry || !entry.t || Date.now() - entry.t > WORKS_TTL) return null;
        return entry.w || [];
    }

    function worksCacheSet(tag, works) {
        const wc = loadWorksCache();
        wc[tag] = { w: works, t: Date.now() };
        const keys = Object.keys(wc);
        if (keys.length > WORKS_MAX) {
            keys.sort((a, b) => wc[a].t - wc[b].t)
                .slice(0, keys.length - WORKS_MAX)
                .forEach(k => delete wc[k]);
        }
        try {
            localStorage.setItem(WORKS_KEY, JSON.stringify(wc));
        } catch (e) {
            warn("⚠️ 出演作キャッシュの保存に失敗しました");
        }
    }

    function stripTags(html) {
        return html
            .replace(/<[^>]*>/g, "")
            .replace(/&(amp|lt|gt|quot|#0?39|#8211|#8212|nbsp);/g, (m, e) =>
                ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#039": "'", "#8211": "–", "#8212": "—", nbsp: " " }[e]))
            .replace(/\s+/g, " ")
            .trim();
    }

    // 記事本文の <dt>見出し</dt><dd>値</dd> から値を取り出す
    function dlValue(html, label) {
        const re = new RegExp(`<dt>\\s*${label}\\s*</dt>\\s*<dd>([\\s\\S]*?)</dd>`);
        const m = re.exec(html);
        return m ? stripTags(m[1]) : "";
    }

    // 素人作品の記事なら { cid, title } を返す（それ以外は null）
    function workFromPost(post) {
        const html = post && post.content && post.content.rendered;
        if (typeof html !== "string" || !html.includes(AMATEUR_MARK)) return null;

        const cid = dlValue(html, "FANZA品番").toLowerCase();
        if (!/^[0-9a-z_]{1,40}$/.test(cid)) return null;

        // 作品タイトル欄が無い記事は、冒頭の引用（【品番】タイトル）を使う
        let title = dlValue(html, "作品タイトル");
        if (!title) {
            const first = /<p>([\s\S]*?)<\/p>/.exec(html);
            title = first ? stripTags(first[1]).replace(/^【[^】]*】\s*/, "") : "";
        }
        return { cid, title: title.slice(0, 200) };
    }

    // 女優タグslugから、その女優の素人作品 [{ cid, title }] を返す（新しい順）。
    // タグslug -> タグID -> そのタグの記事一覧、の順に引く
    async function fetchActressWorks(tag) {
        const cached = worksCacheGet(tag);
        if (cached) return cached;
        if (typeof tag !== "string" || !TAG_RE.test(tag)) return [];

        // tag は URL エンコード済みの slug なので、そのまま埋め込む
        const tags = await gmGetJson(`${WIKI_TAGS_API}?slug=${tag}&_fields=id`);
        const id = Array.isArray(tags) && tags[0] && tags[0].id;

        const works = [];
        if (Number.isInteger(id)) {
            const posts = await gmGetJson(`${WIKI_API}?tags=${id}&per_page=${WIKI_CHUNK}&_fields=slug,content`);
            const seen = new Set();
            (Array.isArray(posts) ? posts : []).forEach(p => {
                const w = workFromPost(p);
                if (w && !seen.has(w.cid)) {
                    seen.add(w.cid);
                    works.push(w);
                }
            });
        }

        worksCacheSet(tag, works);
        return works;
    }

    // ---------------------------------------------------------
    // 作品詳細ページ：出演者欄の補完
    // ---------------------------------------------------------

    // 補助：テーブル待機関数（一覧ページなど table が現れないページのために時間切れを設ける）
    async function waitForTable(timeoutMs = 10000) {
        return new Promise((resolve) => {
            const table = document.querySelector('table');
            if (table) return resolve(table);

            const observer = new MutationObserver(() => {
                const table = document.querySelector('table');
                if (table) {
                    clearTimeout(timer);
                    observer.disconnect();
                    resolve(table);
                }
            });
            const timer = setTimeout(() => {
                observer.disconnect();
                resolve(null);
            }, timeoutMs);
            observer.observe(document.body, { childList: true, subtree: true });
        });
    }

    // スタイルの定義（一度だけ追加）
    function ensureStyle() {
        if (document.getElementById("my-actress-style")) return;
        const style = document.createElement("style");
        style.id = "my-actress-style";
        style.innerHTML = `
            .my-actress-link {
                color: #0073e6 !important;
                text-decoration: none !important;
                margin-right: 12px !important;
                display: inline-block;
            }
            .my-actress-link:hover {
                color: #ff0000 !important;
                text-decoration: underline !important;
            }
            .${CAST_LABEL_CLASS} .my-actress-link {
                margin-right: 6px !important;
            }
            .loading-spinner {
                width: 14px;
                height: 14px;
                border: 2px solid #ccc;
                border-top-color: #0073e6;
                border-radius: 50%;
                display: inline-block;
                animation: spin 0.8s linear infinite;
                vertical-align: middle;
                margin-left: 5px;
            }
            @keyframes spin {
              to { transform: rotate(360deg); }
            }
            .${BEST_HIDDEN_CLASS} {
                display: none !important;
            }
            #${BEST_FILTER_PANEL_ID} .my-best-toggle {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                height: 22px;
                padding: 0 8px 0 6px;
                border: 1px solid #bbb;
                border-radius: 11px;
                background: #fff;
                color: #555;
                font-weight: bold;
                cursor: pointer;
                user-select: none;
                white-space: nowrap;
            }
            #${BEST_FILTER_PANEL_ID} .my-best-switch {
                position: relative;
                width: 28px;
                height: 16px;
                border-radius: 8px;
                background: #ccc;
                transition: background 0.15s;
                flex-shrink: 0;
            }
            #${BEST_FILTER_PANEL_ID} .my-best-switch::after {
                content: "";
                position: absolute;
                top: 2px;
                left: 2px;
                width: 12px;
                height: 12px;
                border-radius: 50%;
                background: #fff;
                box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
                transition: transform 0.15s;
            }
            #${BEST_FILTER_PANEL_ID} .my-best-state {
                min-width: 2.2em;
                color: #888;
            }
            #${BEST_FILTER_PANEL_ID} .my-best-toggle[aria-pressed="true"] {
                border-color: #c00;
                background: #fff0f0;
                color: #c00;
            }
            #${BEST_FILTER_PANEL_ID} .my-best-toggle[aria-pressed="true"] .my-best-switch {
                background: #c00;
            }
            #${BEST_FILTER_PANEL_ID} .my-best-toggle[aria-pressed="true"] .my-best-switch::after {
                transform: translateX(12px);
            }
            #${BEST_FILTER_PANEL_ID} .my-best-toggle[aria-pressed="true"] .my-best-state {
                color: #c00;
            }
            #${BEST_FILTER_PANEL_ID} .my-best-count {
                margin-left: 6px;
                color: #666;
            }
            .my-cast-block + .my-cast-block {
                margin-top: 8px;
            }
            .my-works-grid {
                display: flex;
                flex-wrap: wrap;
                gap: 4px;
                margin-top: 4px;
            }
            .my-works-grid:empty {
                display: none;
            }
            .my-works-grid a {
                display: block;
                width: ${WORK_THUMB_SIZE}px;
                line-height: 0;
            }
            .my-works-grid img {
                width: ${WORK_THUMB_SIZE}px;
                height: ${WORK_THUMB_SIZE}px;
                aspect-ratio: 1 / 1;
                object-fit: cover;
                border: 1px solid #ddd;
                background: #f3f3f3;
            }
            .my-works-grid a:hover img {
                border-color: #ff0000;
            }
        `;
        document.head.appendChild(style);
    }

    // 「出演者：」欄のセルを返す。枠が無ければ行ごと新規作成する
    function findOrCreateCastCell() {
        const allCells = Array.from(document.querySelectorAll('td, th'));
        const castLabel = allCells.find(el => el.innerText.trim().replace("：", "") === "出演者");

        if (castLabel) {
            log("✅ 既存の出演者枠を使用します。");
            const row = castLabel.closest('tr');
            return { cell: row ? row.querySelector('td:last-child') : null, created: false, row };
        }

        log("➕ 出演者枠を新規作成します。");
        const tbody = document.querySelector("table tbody");
        if (!tbody) return { cell: null, created: false, row: null };

        const newRow = document.createElement("tr");
        newRow.innerHTML = `
            <td align="right" valign="top" class="nw">出演者：</td>
            <td class="actress-target-cell" style="font-weight: bold; background-color: #fff9c4; padding: 2px 5px;"></td>
        `;
        tbody.appendChild(newRow);
        return { cell: newRow.querySelector('.actress-target-cell'), created: true, row: newRow };
    }

    // 「取得中...」表示を元に戻す
    function clearLoading() {
        if (loadingRow) {
            // 自分で足した行なので丸ごと撤去する
            loadingRow.remove();
        } else if (loadingCell && loadingCell.isConnected) {
            // 元々あった枠なので `----` 等の元の表示に戻す
            loadingCell.innerHTML = loadingPrevHtml;
        }
        loadingCell = null;
        loadingRow = null;
        loadingPrevHtml = "";
    }

    // 素人作品のサムネイル（300×300 の正方形）と作品ページURL（アフィリエイト経由）
    function amateurThumbUrl(cid) {
        return `https://pics.dmm.co.jp/digital/amateur/${cid}/${cid}jp.jpg`;
    }

    function amateurContentUrl(cid) {
        const url = `https://video.dmm.co.jp/amateur/content/?id=${encodeURIComponent(cid)}`;
        return `https://al.fanza.co.jp/?lurl=${encodeURIComponent(url)}&af_id=${MY_AFF_ID}&ch=api`;
    }

    // 出演者名の下に、その出演者の他の素人作品を正方形サムネで並べる
    async function renderActressWorks(grid, tag, currentCid) {
        try {
            const works = (await fetchActressWorks(tag))
                .filter(w => w.cid && w.cid !== currentCid)
                .slice(0, WORKS_SHOW_MAX);
            if (!grid.isConnected) return;

            grid.innerHTML = works.map(w => {
                const title = escapeHtml(w.title || w.cid);
                return `<a href="${amateurContentUrl(w.cid)}" title="${title}">`
                     + `<img src="${amateurThumbUrl(w.cid)}" alt="${title}" loading="lazy"`
                     + ` width="${WORK_THUMB_SIZE}" height="${WORK_THUMB_SIZE}"></a>`;
            }).join("");
            // 画像が無い作品は枠ごと消す
            grid.querySelectorAll("img").forEach(img => {
                img.addEventListener("error", () => img.parentElement && img.parentElement.remove(), { once: true });
            });
        } catch (e) {
            err("❌ " + e.message);
            grid.innerHTML = "";
        }
    }

    // 出演者ごとに「名前」、その下に「他の出演作の正方形サムネ」を並べるHTML
    function castBlocksHtml(actresses) {
        return actresses.map(a =>
            `<div class="my-cast-block">${castLinksHtml([a.name])}`
          + (a.tag ? `<div class="my-works-grid"><span class="loading-spinner"></span></div>` : "")
          + `</div>`
        ).join("");
    }

    // castBlocksHtml で作った枠にサムネを読み込む
    function startWorksRendering(root, actresses, currentCid) {
        const grids = root.querySelectorAll(".my-works-grid");
        actresses.filter(a => a.tag).forEach((a, i) => {
            if (grids[i]) renderActressWorks(grids[i], a.tag, currentCid);
        });
    }

    // DMM 側で出演者が既に埋まっている場合。
    // 元の出演者名と自前の出演者名が二重に並ばないよう、av-wiki で出演作を引ける出演者がいれば
    // セルの中身を自前の表示（名前＋その下に素人作品）に置き換える。引けなければ元の表示のまま
    function replaceFilledCell(cell, actresses, currentCid) {
        if (!actresses || !actresses.some(a => a.tag) || !cell.isConnected) return;
        if (cell.querySelector("." + WORKS_SECTION_CLASS)) return;

        ensureStyle();
        const section = document.createElement("div");
        section.className = WORKS_SECTION_CLASS;
        section.innerHTML = castBlocksHtml(actresses);
        cell.replaceChildren(section);
        startWorksRendering(section, actresses, currentCid);
    }

    // 出演者欄に DMM 側の名前が既に入っていればそのセルを返す（無ければ null）
    function filledCastCell() {
        const { cell, created } = findOrCreateCastCell();
        if (!cell || created) return null;
        const currentText = cell.innerText.trim();
        // ハイフン以外かつ＊＊＊以外が入っていれば、名前が登録済み
        if (currentText !== "" && currentText !== "----" && !currentText.includes("＊＊＊")) return cell;
        return null;
    }

    // DMMの出演者欄に書き込む関数（actresses: [{ name, tag }]）
    function fillActressToDMM(actresses, currentCid) {
        // 名前が取れなかった場合は何もしない
        if (!actresses || !actresses.length) {
            log("⚠️ 有効な女優名ではないため、上書きをスキップします。");
            clearLoading();
            return;
        }

        ensureStyle();

        // 「取得中...」を出したセルが生きていればそこへ、Reactの再描画等で失われていれば探し直す
        const targetCell = (loadingCell && loadingCell.isConnected)
            ? loadingCell
            : findOrCreateCastCell().cell;

        if (targetCell) {
            targetCell.innerHTML = castBlocksHtml(actresses);
            startWorksRendering(targetCell, actresses, currentCid);
        }

        // 書き込みに成功したので行は残す
        loadingCell = null;
        loadingRow = null;
        loadingPrevHtml = "";
    }

    function showLoading() {
        const { cell, created, row } = findOrCreateCastCell();
        if (!cell) return false;

        ensureStyle();
        loadingPrevHtml = created ? "" : cell.innerHTML;
        cell.innerHTML = `取得中... <span class="loading-spinner"></span>`;
        loadingCell = cell;
        loadingRow = created ? row : null;
        return true; // 取得実行OK
    }

    // 情報テーブルから見出し名で値を取り出す
    function tableValueByLabel(label) {
        const th = Array.from(document.querySelectorAll('th'))
            .find(h => h.innerText.trim() === label);
        if (!th) return "";
        const row = th.closest('tr');
        const td = row ? row.querySelector('td') : null;
        return td ? td.innerText.trim() : "";
    }

    // 詳細ページ用の出演者の取得。キャッシュを優先し、無ければ av-wiki に問い合わせる。
    // メーカー品番を優先し、配信品番(cid)も候補にする。[{ name, tag }] を返す（見つからなければ空配列）
    async function lookupCastForDetail(makerId, deliveryId) {
        const cid = (deliveryId || "").toLowerCase();

        // 一覧ページで既に引いていればそれを使う
        const cached = cid ? cacheGet(cid) : null;
        if (cached) {
            log("💾 キャッシュから復元:", namesOf(cached).join(" "));
            return cached;
        }

        const slugs = [];
        if (makerId) slugs.push(makerId.toLowerCase());
        if (cid) cidToSlugCandidates(cid).forEach(s => slugs.push(s));
        const candidates = slugs.filter((s, i) => slugs.indexOf(s) === i);

        const found = await fetchWikiBySlugs(candidates);
        let actresses = [];
        for (const slug of candidates) {
            const hit = found.get(slug);
            if (hit && hit.length) {
                actresses = hit;
                break;
            }
        }

        if (cid) {
            cacheSet(cid, actresses);
            saveCache();
        }
        return actresses;
    }

    // メインロジック（詳細ページの女優名補完）
    async function main() {
        log("🔍 商品情報の読み込みを待機中...");

        try {
            const table = await waitForTable();
            if (!table) {
                log("ℹ️ テーブルが無いページのため補完をスキップします。");
                return;
            }
            log("✅ テーブルの描画を確認しました。");

            const makerId = tableValueByLabel("メーカー品番：");
            const deliveryId = tableValueByLabel("配信品番：");

            if (!makerId && !deliveryId) {
                log("ℹ️ 品番の見出しが無いページのため補完をスキップします。");
                return;
            }

            const currentCid = (deliveryId || "").toLowerCase();
            log("🎯 品番の取得に成功:", makerId || deliveryId);

            // DMM 側で出演者が埋まっているページも、av-wiki の出演者名＋素人作品の表示に置き換える
            const filled = filledCastCell();
            if (filled) {
                log("✅ すでに名前が登録されているため、出演作付きの表示に置き換えます。");
                const actresses = await lookupCastForDetail(makerId, deliveryId);
                // 問い合わせ中に React の再描画でセルが作り直されていたら探し直す
                const cell = filled.isConnected ? filled : filledCastCell();
                if (cell) replaceFilledCell(cell, actresses, currentCid);
                return;
            }

            if (!showLoading()) return;

            try {
                const actresses = await lookupCastForDetail(makerId, deliveryId);
                if (actresses.length) {
                    log("🎯 女優名を発見:", namesOf(actresses).join(" "));
                    fillActressToDMM(actresses, currentCid);
                } else {
                    warn("⚠️ av-wiki に該当する記事が見つかりませんでした。");
                    clearLoading();
                }
            } catch (e) {
                err("❌ " + e.message);
                clearLoading();
            }
        } catch (error) {
            err(error.message);
        }
    }

    // ---------------------------------------------------------
    // 一覧ページ：商品リンクの下に女優名を表示
    // ---------------------------------------------------------

    let castInFlight = new Set();
    let castBackoffUntil = 0;

    function cidFromHref(href) {
        if (!href) return null;
        let url = href;
        // アフィリエイト化済みのリンクは元URLが lurl に入っている
        const lurl = /[?&]lurl=([^&]+)/.exec(href);
        if (lurl) {
            try {
                url = decodeURIComponent(lurl[1]);
            } catch (e) {
                // 壊れたエスケープはそのまま扱う
            }
        }
        const m = /[?&]id=([a-zA-Z0-9_]+)/.exec(url);
        return m ? m[1].toLowerCase() : null;
    }

    // 1カードの範囲を求める。
    // 一覧ページは content-card / li で囲われているが、トップページのカードはdiv構成で
    // 目印が無いため、「別の作品のリンクを含まない範囲」まで親を辿って境界を決める。
    function cardRootOf(link, cid) {
        const known = link.closest(CARD_SELECTOR);
        if (known) return known;

        let node = link;
        for (let i = 0; i < CARD_WALK_LIMIT; i++) {
            const parent = node.parentElement;
            if (!parent || parent === document.body) break;

            const siblings = parent.querySelectorAll(CARD_LINK_SELECTOR);
            let hasOther = false;
            for (let j = 0; j < siblings.length; j++) {
                if (cidFromHref(siblings[j].getAttribute("href")) !== cid) {
                    hasOther = true;
                    break;
                }
            }
            if (hasOther) break;
            node = parent;
        }
        return node;
    }

    // 未処理のカードを集める（1カードにつき商品リンクが複数あるためカード単位でまとめる）
    function collectPendingCards() {
        const cards = new Map();

        document.querySelectorAll(CARD_LINK_SELECTOR).forEach(link => {
            const cid = cidFromHref(link.getAttribute("href"));
            if (!cid) return;

            const card = cardRootOf(link, cid);
            if (!card || cards.has(card)) return;
            if (card.dataset.castChecked) return;
            if (card.querySelector("." + CAST_LABEL_CLASS)) return;
            // DMM側で女優名が判明している作品は問い合わせ不要（リンクのアフィリエイト化だけ行う）
            if (card.querySelector(ACTRESS_LINK_SELECTOR)) return;

            cards.set(card, { cid, anchor: pickCastAnchor(card, link) });
        });

        return cards;
    }

    // 女優名を出す基準になるリンクを選ぶ。
    // ランキングページのようにサムネイル用とタイトル用の2本がある場合、
    // 中身が画像だけ（テキストが空）のサムネイルリンクを避けてタイトル側を選ぶ。
    function pickCastAnchor(card, fallbackLink) {
        const titled = card.querySelector('a[data-e2eid="title"]');
        if (titled) return titled;

        const links = Array.from(card.querySelectorAll(CARD_LINK_SELECTOR));
        return links.find(a => a.textContent.trim().length > 0) || fallbackLink;
    }

    // <h2><a>…</a></h2> のようにリンクだけを包むラッパーがある場合はその外側に出す。
    // ランキングページの h2 は flex の横並びなので、中に入れるとタイトルの右隣に出てしまう。
    function insertionNodeFor(anchor, card) {
        let node = anchor;
        for (let i = 0; i < 2; i++) {
            const parent = node.parentElement;
            if (!parent || parent === card || parent.children.length !== 1) break;
            node = parent;
        }
        return node;
    }

    function applyCast(card, anchor, actresses) {
        const names = namesOf(actresses);
        card.dataset.castChecked = "1";
        if (!names.length) return;
        if (!anchor.isConnected || card.querySelector("." + CAST_LABEL_CLASS)) return;

        const label = document.createElement("div");
        label.className = `text-xxs line-clamp-1 ${CAST_LABEL_CLASS}`;
        label.title = names.join(" ");
        label.innerHTML = castLinksHtml(names);
        insertionNodeFor(anchor, card).insertAdjacentElement("afterend", label);
    }

    async function fillCastOnCards() {
        if (Date.now() < castBackoffUntil) return;
        // 詳細ページは出演者欄の補完（main）に任せる
        if (location.pathname.includes("/content/")) return;

        const pending = collectPendingCards();
        if (!pending.size) return;

        ensureStyle();

        // キャッシュ済みはその場で描画し、未知のものだけ問い合わせる
        const need = new Map();
        pending.forEach((info, card) => {
            const cached = cacheGet(info.cid);
            if (cached) {
                applyCast(card, info.anchor, cached);
                return;
            }
            if (castInFlight.has(info.cid)) return;
            if (!need.has(info.cid)) need.set(info.cid, []);
            need.get(info.cid).push({ card, anchor: info.anchor });
        });

        if (!need.size) return;

        const cids = Array.from(need.keys());
        cids.forEach(cid => castInFlight.add(cid));
        log(`🔎 av-wiki に ${cids.length} 件問い合わせます`);

        try {
            const resolved = await resolveCastByCids(cids);
            cids.forEach(cid => {
                const names = resolved.get(cid) || [];
                cacheSet(cid, names);
                need.get(cid).forEach(({ card, anchor }) => applyCast(card, anchor, names));
            });
            saveCache();
        } catch (e) {
            // 通信失敗を未登録として記録しないよう、しばらく問い合わせを止める
            castBackoffUntil = Date.now() + 60 * 1000;
            err("❌ " + e.message);
        } finally {
            cids.forEach(cid => castInFlight.delete(cid));
        }
    }

    // ---------------------------------------------------------
    // 一覧ページ：ベスト盤を除外する絞り込み
    // ---------------------------------------------------------

    // /list/ だけでなく /av/list/ や /amateur/list/ のようなフロア別の一覧も対象にする
    function isListPage() {
        return /(^|\/)list(\/|$)/.test(location.pathname);
    }

    function loadHideBest() {
        try {
            return localStorage.getItem(BEST_FILTER_KEY) === "1";
        } catch (e) {
            return false;
        }
    }

    function saveHideBest(on) {
        try {
            localStorage.setItem(BEST_FILTER_KEY, on ? "1" : "0");
        } catch (e) {
            warn("⚠️ 絞り込み設定の保存に失敗しました");
        }
    }

    // カードの商品名を集める。自前の女優名ラベルは含めない
    function cardTitleText(card) {
        const parts = [];
        card.querySelectorAll(CARD_LINK_SELECTOR).forEach(a => {
            if (a.closest("." + CAST_LABEL_CLASS)) return;
            parts.push(a.textContent);
            a.querySelectorAll("img[alt]").forEach(img => parts.push(img.alt));
        });
        return parts.join(" ");
    }

    // 一覧ページ以外では全カードを表示に戻す
    function applyBestFilter() {
        const enabled = isListPage() && loadHideBest();
        const seen = new Set();
        let hiddenCount = 0;

        document.querySelectorAll(CARD_LINK_SELECTOR).forEach(link => {
            const cid = cidFromHref(link.getAttribute("href"));
            if (!cid) return;
            const card = cardRootOf(link, cid);
            if (!card || seen.has(card)) return;
            seen.add(card);

            // 一覧は <ul class="grid"><li><div data-e2eid="content-card"> の構造なので、
            // カード本体だけ隠すと li の枠が空いたまま残る。グリッドの1マスである li ごと隠して前に詰める
            const parent = card.parentElement;
            const cell = parent && parent.tagName === "LI" ? parent : card;
            seen.add(cell);

            const hide = enabled && BEST_TITLE_RE.test(cardTitleText(card));
            cell.classList.toggle(BEST_HIDDEN_CLASS, hide);
            if (hide) hiddenCount++;
        });

        // 対象外になったカード（ページ遷移後に残った要素など）も戻す
        document.querySelectorAll("." + BEST_HIDDEN_CLASS).forEach(el => {
            if (!seen.has(el)) el.classList.remove(BEST_HIDDEN_CLASS);
        });

        renderBestFilterState(enabled, hiddenCount);
    }

    // スイッチの見た目（ON/OFF と非表示にした件数）を更新する
    function renderBestFilterState(enabled, hiddenCount) {
        const panel = document.getElementById(BEST_FILTER_PANEL_ID);
        if (!panel) return;
        const toggle = panel.querySelector(".my-best-toggle");
        const state = panel.querySelector(".my-best-state");
        const count = panel.querySelector(".my-best-count");
        toggle.setAttribute("aria-pressed", enabled ? "true" : "false");
        toggle.title = enabled
            ? "クリックするとBEST・ベストの商品も表示します"
            : "クリックすると商品名にBEST・ベストを含む商品を隠します";
        state.textContent = enabled ? "ON" : "OFF";
        count.textContent = enabled ? `${hiddenCount}件を非表示中` : "";
    }

    // 一覧ページにだけ、「並び替え」のセレクトボックスの右隣にチェックボックスを出す。
    //   <div class="flex gap-3">
    //     <div class="text-xs flex flex-wrap items-center">並び替え <select id="sort">…</select></div>
    //     ← ここに追加
    //   </div>
    function ensureBestFilterPanel() {
        const existing = document.getElementById(BEST_FILTER_PANEL_ID);
        const sortSelect = isListPage() ? document.querySelector('select#sort') : null;
        const sortBox = sortSelect ? sortSelect.parentElement : null;

        if (!sortBox) {
            if (existing) existing.remove();
            return;
        }
        // Reactの再描画で並び替え欄が作り直された場合は付け直す
        if (existing && existing.previousElementSibling === sortBox) return;
        if (existing) existing.remove();

        const panel = document.createElement("div");
        panel.id = BEST_FILTER_PANEL_ID;
        panel.className = "text-xs flex items-center shrink-0";
        panel.innerHTML =
            `<button type="button" class="my-best-toggle" aria-pressed="false">`
          +   `<span class="my-best-switch"></span>`
          +   `<span>BEST・ベスト除外</span>`
          +   `<span class="my-best-state">OFF</span>`
          + `</button>`
          + `<span class="my-best-count"></span>`;
        panel.querySelector(".my-best-toggle").addEventListener("click", () => {
            saveHideBest(!loadHideBest());
            applyBestFilter();
        });
        sortBox.insertAdjacentElement("afterend", panel);
        // 2D/VR・配信形式・価格などのプルダウンが並ぶと横幅が足りなくなるため、
        // 並び替え欄の行を折り返せるようにしてスイッチがはみ出さないようにする
        if (panel.parentElement) {
            panel.parentElement.style.flexWrap = "wrap";
            panel.parentElement.style.rowGap = "4px";
        }
        renderBestFilterState(loadHideBest(), 0);
    }

    function updateBestFilter() {
        ensureBestFilterPanel();
        applyBestFilter();
    }

    let bestFilterTimer = null;
    function scheduleBestFilter() {
        clearTimeout(bestFilterTimer);
        bestFilterTimer = setTimeout(updateBestFilter, 100);
    }

    // ---------------------------------------------------------
    // ページ全体の処理
    // ---------------------------------------------------------

    // 商品リンク・女優名リンクをアフィリエイト用に書き換える
    // （一覧・ランキング・トップなど video.dmm.co.jp の全ページが対象）
    function convertToAffiliateLinks() {
        document.querySelectorAll(AFF_LINK_SELECTOR).forEach(link => {
            const affiliateUrl = toAffiliateUrl(link.href);
            if (affiliateUrl) {
                link.href = affiliateUrl;
            }
        });
    }

    // サイト(Next.js)は商品リンクのクリックをJSで横取りして内部ルーティングで遷移するため、
    // 書き換えた href が無視される。captureフェーズで React より先にクリックを捕まえて
    // preventDefault + stopImmediatePropagation し、アフィリエイトURLへの通常遷移を強制する。
    function interceptProductLinkClicks() {
        document.addEventListener("click", (e) => {
            // 修飾キー付きクリックはブラウザ標準動作に任せる
            // （新規タブ等では書き換え済みの href がそのまま使われるため対応不要）
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            if (!(e.target instanceof Element)) return;

            const link = e.target.closest(`a[href*="al.fanza.co.jp"], ${AFF_LINK_SELECTOR}`);
            if (!link || link.target === "_blank") return;

            let affiliateUrl;
            if (link.href.includes("al.fanza.co.jp")) {
                // 変換済みリンク（商品リンク・自前の女優名リンク）
                affiliateUrl = link.href;
            } else {
                // Reactの再描画で href が元に戻っている等、未変換のままクリックされた場合は
                // この場で変換する
                affiliateUrl = toAffiliateUrl(link.href);
            }
            if (!affiliateUrl) return;

            e.preventDefault();
            e.stopImmediatePropagation();
            window.location.href = affiliateUrl;
        }, true);
    }

    // 一覧の女優名補完は、まとめて1リクエストにするため少し待ってから実行する
    let castTimer = null;
    function scheduleCastFill() {
        clearTimeout(castTimer);
        castTimer = setTimeout(() => fillCastOnCards(), 150);
    }

    function runLogic() {
        // 詳細ページの出演者欄補完（テーブルが無いページは main 側でスキップされる）
        main();
        // 商品リンク・女優名リンクのアフィリエイト化（全ページ対象）
        convertToAffiliateLinks();
        // 一覧カードへの女優名表示
        scheduleCastFill();
        // 一覧ページのベスト盤除外
        scheduleBestFilter();
    }

    function observeFullPage() {
        let lastUrl = location.href;

        const observer = new MutationObserver(() => {
            // URLが変わったかチェック
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                log("🔄 URL変更を検知");
                // 前ページの「取得中...」の追跡状態は引き継がない
                loadingCell = null;
                loadingRow = null;
                loadingPrevHtml = "";
                runLogic();
            }

            // 新しい商品リンクが追加されていないか常に監視（全ページ対象）
            convertToAffiliateLinks();
            scheduleCastFill();
            scheduleBestFilter();
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ---------------------------------------------------------
    // 実行トリガーの設定
    // ---------------------------------------------------------
    function init() {
        ensureStyle();
        // 商品リンクのクリックを React より先に捕まえる（capture フェーズ）
        interceptProductLinkClicks();
        // 初回実行
        runLogic();
        // URLと要素の追加を継続監視
        observeFullPage();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
