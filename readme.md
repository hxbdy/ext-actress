# FANZA Cast Auto-Filler

出演者不明の動画ページに出演者名を追記します。
素人カテゴリにて効果を発揮します。

> **本スクリプトはアダルトサイト向けです。18歳未満の方は利用しないでください。**

## インストール
1. ブラウザに [Tampermonkey](https://www.tampermonkey.net/) または [Violentmonkey](https://violentmonkey.github.io/) をインストールする
2. 以下のURLを開く
   https://raw.githubusercontent.com/hxbdy/actress-ext/main/dmm-cast-auto-filler.user.js
3. 表示されるインストール確認画面で内容を確認してインストールする

以降はユーザースクリプトマネージャが自動で更新を確認します。

## 使い方

インストール後、`video.dmm.co.jp` の作品ページを開くだけで動作します。

- 出演者欄が空、`----`、`＊＊＊` のいずれかの場合のみ、出演者名を補完します
- すでに出演者名が入っているページは書き換えません
- 補完中は「取得中...」と表示され、見つからなかった場合は元の表示に戻ります

保管後のリンクはアフィリエイトリンクを含みます

## 開発

先頭の `DEBUG` を `true` にすると、動作ログがコンソールに出力されます。
