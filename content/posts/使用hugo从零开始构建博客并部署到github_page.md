+++
date = '2026-05-09T00:47:24+08:00'
draft = false
title = '使用hugo从零开始构建博客并部署到github_page'
+++

下面是根据我们之前整个对话过程整理的一份**从零开始用 Hugo 搭建个人博客并部署到 GitHub Pages** 的完整教程。我会把每一步的关键操作、容易踩的坑以及解决方案都写清楚，保证新手也能顺利上线自己的博客。

---

# 从零到一：Hugo 博客搭建与 GitHub Pages 自动部署教程

## 一、准备工作

你需要安装以下工具：

1. **Git**：版本管理  
   - 官网下载：https://git-scm.com/  
   - 安装后配置用户名和邮箱（后续要用）：
     ```bash
     git config --global user.name "你的GitHub用户名"
     git config --global user.email "你的GitHub注册邮箱"
     ```

2. **Hugo**：静态网站生成器  
   - 推荐安装 **extended 版本**（支持 Sass/SCSS）  
   - Linux (Ubuntu/Debian) 示例：
     ```bash
     sudo apt install hugo
     # 或者下载最新 .deb 包
     ```
   - Windows/macOS 请参考官网：https://gohugo.io/installation/

3. **GitHub 账号**：托管代码和网站  
   - 注册后登录，准备创建一个空仓库（**不要**初始化 README 或 .gitignore）。

---

## 二、创建 Hugo 站点并安装主题

### 1. 新建站点
```bash
hugo new site myblog
cd myblog
```

### 2. 初始化 Git 仓库
```bash
git init
```

### 3. 添加主题（推荐**直接复制**，不用子模块）

很多教程教你用 `git submodule add`，但这样修改主题很麻烦（见后文）。**推荐直接复制主题文件**，方便自定义：

```bash
# 进入 themes 目录
cd themes

# 克隆主题（以 LoveIt 为例）
git clone https://github.com/dillonzq/LoveIt.git

# 删除主题里的 .git 文件夹，让它变成普通文件
rm -rf LoveIt/.git

# 返回站点根目录
cd ../..
```

> **为什么不用子模块？**  
> 子模块会锁死主题版本，并且你无法直接修改主题后提交（因为官方仓库你没有写权限）。直接复制主题后，所有主题文件都归你的仓库管理，改起来随心所欲。

### 4. 配置站点
编辑站点根目录下的 `hugo.toml`（或 `config.toml`），至少设置：

```toml
baseURL = "https://你的用户名.github.io/"   # 注意最后有斜杠
title = "我的博客"
theme = "LoveIt"

# 其他主题相关配置请参考主题文档
```

### 5. 测试本地预览
```bash
hugo server -D
```
打开 http://localhost:1313/ 查看效果。按 Ctrl+C 停止。

---

## 三、写第一篇文章

```bash
hugo new posts/hello-world.md
```
编辑 `content/posts/hello-world.md`，修改标题、日期，正文用 Markdown 写。

预览时加上 `-D` 才能看到草稿（draft: true）。发布前将 `draft: true` 改为 `false` 或删除。

---

## 四、部署到 GitHub Pages

### 方法一：GitHub Actions 自动部署（推荐）

#### 1. 在 GitHub 上创建一个空仓库
- 仓库名建议为 `你的用户名.github.io`（这样网站域名就是 `https://你的用户名.github.io`）
- **不要**勾选 “Add a README” 等初始化选项，保持完全空白。

#### 2. 关联本地仓库与远程仓库
```bash
git remote add origin https://github.com/你的用户名/你的仓库名.git
```

#### 3. 添加 GitHub Actions 工作流文件
在站点根目录下创建 `.github/workflows/deploy.yml`，内容如下（以 Hugo 0.148.2 为例）：

```yaml
name: Build and deploy Hugo site to GitHub Pages

on:
  push:
    branches: ["main"]   # 如果你的默认分支是 master，改成 master
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    env:
      HUGO_VERSION: 0.148.2
    steps:
      - name: Install Hugo CLI
        run: |
          wget -O ${{ runner.temp }}/hugo.deb https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_extended_${HUGO_VERSION}_linux-amd64.deb \
          && sudo dpkg -i ${{ runner.temp }}/hugo.deb
      - name: Checkout
        uses: actions/checkout@v4
        with:
          submodules: recursive   # 如果你用了子模块，这里需要
          fetch-depth: 0
      - name: Setup Pages
        id: pages
        uses: actions/configure-pages@v5
      - name: Build with Hugo
        run: |
          hugo \
            --gc \
            --minify \
            --baseURL "${{ steps.pages.outputs.base_url }}/"
      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: './public'
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

> **注意**：如果你的仓库默认分支是 `master`，请把上面 `branches: ["main"]` 改成 `["master"]`。

#### 4. 提交并推送所有文件
```bash
git add .
git commit -m "Initial commit"
git push -u origin main   # 或用 master
```

如果推送时遇到 `GH013: Repository rule violations` 错误（提示包含了密钥），说明主题示例文件里有测试用的 token，按下面步骤处理：

```bash
# 移除主题中的 exampleSite 文件夹（它不影响你的博客）
git rm -r --cached themes/LoveIt/exampleSite
echo "themes/LoveIt/exampleSite/" >> .gitignore
git add .gitignore
git commit -m "Remove exampleSite with fake secret"
git push origin main
```

#### 5. 设置 GitHub Pages 源
- 打开仓库 Settings → Pages
- 在 “Build and deployment” → “Source” 中选择 **GitHub Actions**
- 不需要额外设置分支

#### 6. 等待自动部署
推送后，点击仓库的 **Actions** 标签查看进度。当绿色对勾出现后，访问 `https://你的用户名.github.io` 就能看到博客。

以后每次更新，只需要：
```bash
git add .
git commit -m "写文章更新"
git push origin main   # 或 master
```
GitHub Actions 会自动构建并发布。

### 方法二：手动部署（如果你不想用 Actions）

1. 本地执行 `hugo` 生成 `public` 文件夹。
2. 把 `public` 里的所有文件复制到仓库根目录（删除原有文件）。
3. 提交并推送：
   ```bash
   git add .
   git commit -m "Deploy site"
   git push origin main
   ```
4. 在 Settings → Pages 中，Source 选择 **Deploy from a branch**，分支选 `main`，目录选 `/ (root)`。

这种方法每次更新都要手动 `hugo` 并覆盖，比较麻烦，不推荐长期使用。

---

## 五、简化推送命令（可选）

每次输入三条命令很繁琐，可以设置一个 Git 别名：

```bash
git config --global alias.deploy '!f() { git add -A && git commit -m "$1" && git push origin main; }; f'
```

之后推送只需要：
```bash
git deploy "提交说明"
```

---

## 六、常见问题与解决

### 1. 主题修改后无法提交？  
如果你用了子模块，会出现 `modified: themes/LoveIt (modified content)` 且无法 commit。  
**解决**：按照上文“安装主题”中的方法，将主题转为普通文件夹（删除 `themes/LoveIt/.git`）。

### 2. 推送被拒绝：`GH013: Repository rule violations`  
GitHub 检测到你的提交里包含看起来像密钥的字符串（比如主题示例里的 Mapbox token）。  
**解决**：删除或忽略含有该密钥的文件，如上面所作，把 `themes/*/exampleSite` 加入 `.gitignore`。

### 3. 分支名不一致（main vs master）  
Hugo 新项目默认分支可能是 `master`，而 GitHub 新建仓库默认是 `main`。  
**解决方案**：统一即可，要么把本地重命名为 `main`（`git branch -M main`），要么修改工作流文件中的分支名。

### 4. GitHub Actions 没有触发？  
- 检查 `.github/workflows/deploy.yml` 是否在正确路径，并且已经推送到远程。
- 检查 `on.push.branches` 里的分支名是否与你的分支名一致。
- 在仓库 Settings → Actions → General 中确认 Actions 是启用的。

---

## 七、总结

现在你拥有了一个全自动的博客系统：

1. **写文章**：`hugo new posts/文章名.md`
2. **本地预览**：`hugo server -D`
3. **发布**：`git add . && git commit -m "xxx" && git push origin main`
4. **自动部署**：GitHub Actions 在云端构建并推送到 Pages

整个过程不再需要你手动运行 `hugo` 命令（除非本地预览）。享受写作吧！

如果还想添加自定义域名、修改主题样式、添加评论系统等，可以继续查阅 Hugo 和主题的官方文档。