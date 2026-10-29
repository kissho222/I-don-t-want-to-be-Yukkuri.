# Online Lab

ブラウザ上で反応時間とカーソル同期を試す独立プロトタイプ。

Node.js 22.20.0 と ws 8.18.3 を使用。`npm ci --omit=optional --ignore-scripts` の後、`npm start` で起動します。Renderでは PORT を使用します。

反応時間は描画処理から入力処理までの端末内時間です。画面発光時刻ではなく、不正やホスト公平性を保証しません。
