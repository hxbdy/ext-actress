// ==UserScript==
// @name         DMM Cast Auto-Filler
// @name:en      DMM Cast Auto-Filler
// @namespace    https://github.com/hxbdy/actress-ext
// @version      2.1.1
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

    // 記事HTMLから「AV女優名」を取り出して配列で返す
    function extractActressNames(html) {
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

        // 半角スペース、全角スペース、カンマ（全角・半角）、読点をすべて対象に分割
        return raw.split(/[\s,、　 ]+/).filter(n => n.length > 0);
    }

    function fetchWikiChunk(slugs) {
        return new Promise((resolve, reject) => {
            if (!gmRequest) return reject(new Error("GM_xmlhttpRequest が利用できません"));

            const url = `${WIKI_API}?slug=${slugs.map(encodeURIComponent).join(",")}`
                      + `&per_page=${WIKI_CHUNK}&_fields=slug,content`;

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

    // slug の配列を渡すと slug -> 女優名配列 の Map を返す
    async function fetchWikiBySlugs(slugs) {
        const found = new Map();
        for (let i = 0; i < slugs.length; i += WIKI_CHUNK) {
            const posts = await fetchWikiChunk(slugs.slice(i, i + WIKI_CHUNK));
            posts.forEach(post => {
                const html = post && post.content && post.content.rendered;
                if (post && post.slug && html) {
                    found.set(post.slug, extractActressNames(html));
                }
            });
        }
        return found;
    }

    // cid の配列を渡すと cid -> 女優名配列 の Map を返す。
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

    // 見つかった名前の配列 / 未登録なら空配列 / キャッシュ無しは null
    function cacheGet(cid) {
        const entry = loadCache()[cid];
        if (!entry || !entry.t) return null;
        const names = entry.n || [];
        const ttl = names.length ? TTL_HIT : TTL_MISS;
        if (Date.now() - entry.t > ttl) return null;
        return names;
    }

    function cacheSet(cid, names) {
        loadCache()[cid] = { n: names, t: Date.now() };
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

    // DMMの出演者欄に書き込む関数
    function fillActressToDMM(names) {
        // 名前が取れなかった場合は何もしない
        if (!names || !names.length) {
            log("⚠️ 有効な女優名ではないため、上書きをスキップします。");
            clearLoading();
            return;
        }

        ensureStyle();

        const linkHtml = castLinksHtml(names);

        // 「取得中...」を出したセルが生きていればそこへ、Reactの再描画等で失われていれば探し直す
        const targetCell = (loadingCell && loadingCell.isConnected)
            ? loadingCell
            : findOrCreateCastCell().cell;

        if (targetCell) {
            targetCell.innerHTML = linkHtml;
        }

        // 書き込みに成功したので行は残す
        loadingCell = null;
        loadingRow = null;
        loadingPrevHtml = "";
    }

    function showLoading() {
        const { cell, created, row } = findOrCreateCastCell();
        if (!cell) return false;

        if (!created) {
            // --- ここが重要：既存の文字をチェック ---
            const currentText = cell.innerText.trim();
            // すでに名前（ハイフン以外かつ＊＊＊以外）が入っているなら、何もしない
            if (currentText !== "" && currentText !== "----" && !currentText.includes("＊＊＊")) {
                log("✅ すでに名前が登録されているため、上書きしません。");
                return false; // 取得不要であることを伝える
            }
        }

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

    // 詳細ページ用の問い合わせ。メーカー品番を優先し、配信品番(cid)も候補にする
    async function fetchCastForDetail(makerId, deliveryId) {
        const slugs = [];
        if (makerId) slugs.push(makerId.toLowerCase());
        if (deliveryId) cidToSlugCandidates(deliveryId.toLowerCase()).forEach(s => slugs.push(s));
        const candidates = slugs.filter((s, i) => slugs.indexOf(s) === i);

        try {
            const found = await fetchWikiBySlugs(candidates);
            let names = [];
            for (const slug of candidates) {
                const hit = found.get(slug);
                if (hit && hit.length) {
                    names = hit;
                    break;
                }
            }

            if (deliveryId) {
                cacheSet(deliveryId.toLowerCase(), names);
                saveCache();
            }

            if (names.length) {
                log("🎯 女優名を発見:", names.join(" "));
                fillActressToDMM(names);
            } else {
                warn("⚠️ av-wiki に該当する記事が見つかりませんでした。");
                clearLoading();
            }
        } catch (e) {
            err("❌ " + e.message);
            clearLoading();
        }
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

            if (!showLoading()) return;

            // 一覧ページで既に引いていればそれを使う
            const cached = deliveryId ? cacheGet(deliveryId.toLowerCase()) : null;
            if (cached) {
                log("💾 キャッシュから復元:", cached.join(" "));
                fillActressToDMM(cached);
                return;
            }

            log("🎯 品番の取得に成功:", makerId || deliveryId);
            fetchCastForDetail(makerId, deliveryId);
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

    function applyCast(card, anchor, names) {
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
