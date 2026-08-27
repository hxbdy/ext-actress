// ==UserScript==
// @name         DMM Cast Auto-Filler
// @namespace    https://github.com/hxbdy/actress-ext
// @version      2.0.0
// @description  出演者不明の作品ページに出演者名を補完します。補完した女優名リンクおよびページ内の商品リンクは、作者のアフィリエイトリンクに書き換わります。
// @author       hxbdy
// @icon         https://raw.githubusercontent.com/hxbdy/actress-ext/main/icon.png
// @match        https://video.dmm.co.jp/*
// @connect      av-wiki.net
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @run-at       document-idle
// @antifeature  referral-link 商品リンクおよび女優名リンクを作者のアフィリエイトIDに書き換えます
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

    // アフィリエイトID
    const MY_AFF_ID = "6dy-990";

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

    // 商品URLをアフィリエイトURLに変換する（変換対象外なら null を返す）
    function toAffiliateUrl(url) {
        // すでにアフィリエイト化されている、または対象外ならスキップ
        if (!url || url.includes("al.fanza.co.jp")) return null;
        if (!url.includes("/av/content/") || !url.includes("id=")) return null;

        // 余計な計測パラメータ（_gl, _ga, _fplc等）を削除
        const cleaned = url.split('&_gl=')[0]
                           .split('&_ga=')[0]
                           .split('&_fplc=')[0];

        return `https://al.fanza.co.jp/?lurl=${encodeURIComponent(cleaned)}&af_id=${MY_AFF_ID}&ch=api`;
    }

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

    function fetchWikiInfo(productID) {
        const wikiUrl = `https://av-wiki.net/${encodeURIComponent(productID)}/`;

        if (!gmRequest) {
            err("❌ GM_xmlhttpRequest が利用できません");
            clearLoading();
            return;
        }

        gmRequest({
            method: "GET",
            url: wikiUrl,
            onload: (res) => {
                // fetch と違い 404 でも onload に来るのでステータスを見る
                if (res.status < 200 || res.status >= 300 || !res.responseText) {
                    err("❌ Wikiのデータ取得に失敗しました:", res.status);
                    clearLoading();
                    return;
                }
                handleWikiHtml(res.responseText, productID);
            },
            onerror: () => {
                err("❌ Wikiへの通信に失敗しました");
                clearLoading();
            }
        });
    }

    function handleWikiHtml(html, productID) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");

        // 1. 全ての <dt> 要素（ラベル部分）を取得
        const dts = Array.from(doc.querySelectorAll('dt'));

        // 2. 「AV女優名」の項目を探す
        const targetDt = dts.find(dt => dt.innerText.includes("AV女優名"));

        if (!targetDt || !targetDt.nextElementSibling) {
            warn(`⚠️ Wiki内に品番 ${productID} に一致する項目が見つかりませんでした。`);
            // デバッグ用：Wikiにどんな項目があったか出力
            log("Wiki上の項目一覧:", dts.map(dt => dt.innerText));
            clearLoading();
            return;
        }

        // 3. その隣にある <dd> （女優名が入っている場所）を取得
        const actressCell = targetDt.nextElementSibling;
        const anchorTags = Array.from(actressCell.querySelectorAll('a'));

        let actressName = "";
        if (anchorTags.length > 0) {
            // aタグがある場合は、それぞれのテキストを半角スペースでつなぐ
            actressName = anchorTags.map(a => a.innerText.trim()).join(" ");
        } else {
            // aタグがない場合（直書きの場合）のフォールバック
            actressName = actressCell.innerText.trim();
        }

        log("🎯 女優名を発見:", actressName);

        // 4. DMMのページに書き込む
        fillActressToDMM(actressName);
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
        // 名前が空、または「＊＊＊」などの伏せ字、あるいは取得失敗時は何もしない
        if (!names || names.includes("＊＊＊") || names.trim() === "") {
            log("⚠️ 有効な女優名ではないため、上書きをスキップします。");
            clearLoading();
            return;
        }

        ensureStyle();

        // 女優名が複数いる場合（Wikiがカンマやスペース区切りと想定）を分割してリンク化
        // 半角スペース、全角スペース、カンマ（全角・半角）、読点をすべて対象に分割
        const nameArray = names.split(/[\s,、　 ]+/).filter(n => n.length > 0);

        const linkHtml = nameArray.map(name => {
            const searchUrl = `https://video.dmm.co.jp/list/?key=${encodeURIComponent(name)}`;
            // ここでもリンク先をアフィリエイト化しておく
            const affSearchUrl = `https://al.fanza.co.jp/?lurl=${encodeURIComponent(searchUrl)}&af_id=${MY_AFF_ID}&ch=api`;
            return `<a href="${affSearchUrl}" class="my-actress-link">${name}</a>`;
        }).join(""); // スペースの代わりに margin-right で間隔を確保

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

    // メインロジック（女優名の補完）
    async function main() {
        log("🔍 商品情報の読み込みを待機中...");

        try {
            const table = await waitForTable();
            if (!table) {
                log("ℹ️ テーブルが無いページのため補完をスキップします。");
                return;
            }
            log("✅ テーブルの描画を確認しました。");

            const allHeaders = Array.from(document.querySelectorAll('th'));
            const idHeader = allHeaders.find(th => th.innerText.trim() === "メーカー品番：");

            if (!idHeader) {
                // デバッグ用：見つからない場合、現在の th 一覧を出力
                warn("⚠️ '品番' という見出しが見つかりません。取得できた見出し:", allHeaders.map(h => h.innerText));
                return;
            }

            // <th> の親要素である <tr> を取得し、その中の <td> (値が入っている側) を探す
            const parentRow = idHeader.closest('tr');
            const valueCell = parentRow ? parentRow.querySelector('td') : null;

            if (!valueCell) {
                err("❌ 品番の見出しは見つかりましたが、値(td)が見つかりません。");
                return;
            }

            const productID = valueCell.innerText.trim();
            if (showLoading()) {
                fetchWikiInfo(productID);
                log("🎯 品番の取得に成功:", productID);
            }
        } catch (error) {
            err(error.message);
        }
    }

    // 商品リンクをアフィリエイト用に書き換える関数
    // （一覧・ランキング・トップなど video.dmm.co.jp の全ページが対象）
    function convertToAffiliateLinks() {
        const links = document.querySelectorAll('a[data-e2eid="title"], a[href*="/av/content/"]');

        links.forEach(link => {
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

            const link = e.target.closest('a[href*="al.fanza.co.jp"], a[href*="/av/content/"]');
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

    function runLogic() {
        // 女優名補完（テーブルが無いページは main 側でスキップされる）
        main();
        // 商品リンクのアフィリエイト化（ランキング・トップ・一覧など全ページ）
        convertToAffiliateLinks();
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
