
// リリース用：すべてのコンソール出力を無効化
if (true) { // 公開時は true、開発時は false にする
    console.log = function() {};
    console.warn = function() {};
    console.error = function() {}; // 重大なエラーも隠したい場合
}


// アフィリエイトID
const MY_AFF_ID = "6dy-990";

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

// 補助：テーブル待機関数
async function waitForTable() {
  return new Promise((resolve) => {
    const table = document.querySelector('table');
    if (table) return resolve(table);

    const observer = new MutationObserver(() => {
      const table = document.querySelector('table');
      if (table) {
        observer.disconnect();
        resolve(table);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

function fetchWikiInfo(productID){
    // 3. background.js 経由で Wiki にアクセス
  const wikiUrl = `https://av-wiki.net/${encodeURIComponent(productID)}/`;
  
  chrome.runtime.sendMessage({ action: "fetchWiki", url: wikiUrl }, (response) => {
    
    if (response.error || !response.data) {
        console.error("❌ Wikiのデータ取得に失敗しました");
        return;
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(response.data, "text/html");

    // 1. 全ての <dt> 要素（ラベル部分）を取得
    const dts = Array.from(doc.querySelectorAll('dt'));
    
    // 2. 探している品番（productID）が含まれる <dt> を探す
    // DMMの品番は小文字、Wikiは大文字の場合があるため両方小文字にして比較
    const targetDt = dts.find(dt => dt.innerText.includes("AV女優名"));

    if (targetDt && targetDt.nextElementSibling) {
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
        
        if (actressCell) {
            console.log("🎯 女優名を発見:", actressName);

            // 4. DMMのページに書き込む
            fillActressToDMM(actressName);
        }
    } else {
        console.warn(`⚠️ Wiki内に品番 ${productID} に一致する項目が見つかりませんでした。`);
        // デバッグ用：Wikiにどんな項目があったか出力
        console.log("Wiki上の項目一覧:", dts.map(dt => dt.innerText));
    }
    });
}

// DMMの出演者欄に書き込む関数
function fillActressToDMM(names) {
  // 名前が空、または「＊＊＊」などの伏せ字、あるいは取得失敗時は何もしない
    if (!names || names.includes("＊＊＊") || names.trim() === "") {
        console.log("⚠️ 有効な女優名ではないため、上書きをスキップします。");
        
        // もし「取得中...」のぐるぐるを表示していた場合は、それだけ消して元の状態に戻す
        const loadingText = document.querySelector('.actress-target-cell');
        if (loadingText && loadingText.innerHTML.includes("取得中")) {
            loadingText.innerHTML = ""; // または公式の表示を維持する処理
        }
        return; 
    }
  // 1. スタイルの定義（一度だけ追加）
    if (!document.getElementById("my-actress-style")) {
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

    // 1. 女優名が複数いる場合（Wikiがカンマやスペース区切りと想定）を分割してリンク化
    // 半角スペース、全角スペース、カンマ（全角・半角）、読点をすべて対象に分割
    const nameArray = names.split(/[\s,、　 ]+/).filter(n => n.length > 0);
    
    const linkHtml = nameArray.map(name => {
        const searchUrl = `https://video.dmm.co.jp/list/?key=${encodeURIComponent(name)}`;
        // ここでもリンク先をアフィリエイト化しておく
        const affSearchUrl = `https://al.fanza.co.jp/?lurl=${encodeURIComponent(searchUrl)}&af_id=${MY_AFF_ID}&ch=api`;
        return `<a href="${affSearchUrl}" class="my-actress-link">${name}</a>`;
    }).join(""); // スペースの代わりに margin-right で間隔を確保

    // 2. 出演者：枠の特定（重複防止のため厳密にチェック）
    const allCells = Array.from(document.querySelectorAll('td, th'));
    const castLabel = allCells.find(el => el.innerText.trim().replace("：", "") === "出演者");
    
    let targetCell;
    if (castLabel) {
        // すでに枠がある場合、その行の td を探す
        const row = castLabel.closest('tr');
        targetCell = row.querySelector('td:last-child');
        console.log("✅ 既存の出演者枠を更新します。");
    } else {
        // 新規作成
        console.log("➕ 出演者枠を新規作成します。");
        const tbody = document.querySelector("table tbody");
        if (!tbody) return;
        const newRow = document.createElement("tr");
        newRow.innerHTML = `
            <td align="right" valign="top" class="nw">出演者：</td>
            <td style="font-weight: bold; background-color: #fff9c4; padding: 2px 5px;"></td>
        `;
        tbody.appendChild(newRow);
        targetCell = newRow.querySelector('td:last-child');
    }

    if (targetCell) {
        targetCell.innerHTML = linkHtml;
    }
}

function showLoading() {
    // 1. 出演者ラベルを探す
    const allCells = Array.from(document.querySelectorAll('td, th'));
    const castLabel = allCells.find(el => el.innerText.trim().replace("：", "") === "出演者");
    
    let targetCell;
    if (castLabel) {
        // すでに枠がある場合、中身を確認する
        const row = castLabel.closest('tr');
        targetCell = row.querySelector('td:last-child');
        
        // --- ここが重要：既存の文字をチェック ---
        const currentText = targetCell.innerText.trim();
        // すでに名前（ハイフン以外かつ＊＊＊以外）が入っているなら、何もしない
        if (currentText !== "" && currentText !== "----" && !currentText.includes("＊＊＊")) {
            console.log("✅ すでに名前が登録されているため、上書きしません。");
            return false; // 取得不要であることを伝える
        }
    } else {
        // 出演者枠自体がない場合は新規作成
        const tbody = document.querySelector("table tbody");
        if (!tbody) return false;
        const newRow = document.createElement("tr");
        newRow.innerHTML = `
            <td align="right" valign="top" class="nw">出演者：</td>
            <td class="actress-target-cell" style="font-weight: bold; background-color: #fff9c4; padding: 2px 5px;"></td>
        `;
        tbody.appendChild(newRow);
        targetCell = newRow.querySelector('.actress-target-cell');
    }

    if (targetCell) {
        targetCell.innerHTML = `取得中... <span class="loading-spinner"></span>`;
        return true; // 取得実行OK
    }
    return false;
}

// メインロジックを関数化
async function main() {
    console.log("🔍 商品情報の読み込みを待機中...");

  // 先ほどの複雑なパス、または「table」自体を待つ
  const targetSelector = "table";

  try {
    const table = await waitForTable();
    console.log("✅ テーブルの描画を確認しました。");

const allHeaders = Array.from(document.querySelectorAll('th'));
const idHeader = allHeaders.find(th => th.innerText.trim() === "メーカー品番：");

if (idHeader) {
    // 3. <th> の親要素である <tr> を取得し、その中の <td> (値が入っている側) を探す
    const parentRow = idHeader.closest('tr');
    const valueCell = parentRow ? parentRow.querySelector('td') : null;

    if (valueCell) {
      const productID = valueCell.innerText.trim();
      if (showLoading()) {
        fetchWikiInfo(productID);
        console.log("🎯 品番の取得に成功:", productID);
      }
    } else {
      console.error("❌ 品番の見出しは見つかりましたが、値(td)が見つかりません。");
    }
  } else {
    // デバッグ用：見つからない場合、現在の th 一覧を出力
    console.warn("⚠️ '品番' という見出しが見つかりません。取得できた見出し:", allHeaders.map(h => h.innerText));
  }
  } catch (error) {
    console.error(error.message);
  }
}


// --- メイン処理をラップする関数 ---
let lastUrl = location.href;

const observeUrlChange = () => {
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      console.log("🔄 URLの変更を検知しました:", lastUrl);

      
      // URLが詳細ページのパターンの時だけ実行
      if (lastUrl.includes("video.dmm.co.jp/av/list") || lastUrl.includes("video.dmm.co.jp/list")) {
        // 少し待ってから実行（Reactの描画完了を待つ）
        setTimeout(() => convertToAffiliateLinks(), 1000);
      }
      // URLが詳細ページのパターンの時だけ実行
      if (lastUrl.includes("video.dmm.co.jp")) {
        // 少し待ってから実行（Reactの描画完了を待つ）
        setTimeout(() => main(), 1000);
      }
    }
  });

  // body全体の変化を監視してURLのチェックを行う
  observer.observe(document.body, { childList: true, subtree: true });
};

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

    const convertedCount = Array.from(links).filter(l => l.href.includes("al.fanza.co.jp")).length;
    console.log(`✅ ${convertedCount} 個のリンクを整形・変換しました。`);
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


// ---------------------------------------------------------
// 実行トリガーの設定
// ---------------------------------------------------------
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}

function init() {
    // 商品リンクのクリックを React より先に捕まえる（capture フェーズ）
    interceptProductLinkClicks();
    // 初回実行
    runLogic();
    // URLと要素の追加を継続監視
    observeFullPage();
}

function runLogic() {
    const url = location.href;
    // 詳細ページの場合
    if (url.includes("video.dmm.co.jp")) {
        main(); // 女優名補完
    }
    // 商品リンクのアフィリエイト化（ランキング・トップ・一覧など全ページ）
    convertToAffiliateLinks();
}

function observeFullPage() {
    let lastUrl = location.href;
    
    const observer = new MutationObserver(() => {
        // URLが変わったかチェック
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            console.log("🔄 URL変更を検知");
            runLogic();
        } 
        
        // 新しい商品リンクが追加されていないか常に監視（全ページ対象）
        convertToAffiliateLinks();
    });

    observer.observe(document.body, { childList: true, subtree: true });
}
