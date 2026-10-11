# DeContradictor

Gemini Liveとの会話で、問題・原因（ボトルネック）・解決策の関係を図にする実験アプリです。TOC Thinking ProcessとTRIZを組み合わせる構想の、音声会話とフロー図の試作段階です。

3Dキャラクターは使用しません。Geminiの発言は青・ピンクのロボアイコンと9種類の感情表示、自分の発言はGoogleログイン後のプロフィール画像で表示します。

## 起動

```powershell
npm install
npm run dev
```

表示されたURLの `/` を開くとGemini Live画面へ移動します。従来の `/live.html` も利用できます。Gemini AI StudioのAPIキーが必要です。キーは画面からブラウザ内に記憶できます。

## 機能

- Gemini Liveの音声・テキスト会話と、必要時のGoogle検索
- 感情データとReact Flow形式の更新データを受信して表示
- ノード・矢印の手動編集、自動配置、拡大縮小
- 会話・フロー図のブラウザ内自動保存、JSON出力・読込
- Googleログイン、プロフィール画像、APIキー・設定のDrive保存と会話・図のDrive同期

Googleログイン設定と保存内容は [docs/live-account-and-save.md](docs/live-account-and-save.md) を参照してください。OAuthクライアントIDはソースに設定済みです。Googleログインなしでも会話とローカル保存は利用できます。

## 開発確認

```powershell
node --test tests/live-session.test.js
npm run build
```
