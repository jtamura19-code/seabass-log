# iPhoneで使う手順

このアプリはGitHub Pagesで公開すると、iPhoneのChromeからHTTPSで開けます。釣行記録は公開サイトではなく、使っている端末のブラウザー内に保存されます。

## 公開手順

1. GitHubにサインインし、新しい**Public**リポジトリを作成します。リポジトリ名は `seabass-log` にします。
2. このフォルダーから `index.html`、`style.css`、`app.js`、`Designer.png`、`README.md`、`.github/workflows/pages.yml` をアップロードします。
3. リポジトリの **Settings > Pages** を開き、Build and deployment の Source を **GitHub Actions** にします。
4. **Actions** タブで `Deploy static site to GitHub Pages` が完了するまで待ちます。
5. 公開URL `https://GitHubのユーザー名.github.io/seabass-log/` をiPhoneのChromeで開きます。GPSを使うときは、Chromeの位置情報を許可してください。

GitHub Pagesで公開すると、アプリのHTML・CSS・JavaScriptと画像は誰でも閲覧できます。公開前に内容を確認してください。