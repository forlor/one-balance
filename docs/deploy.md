# One Balance 部署与配置指南

本指南将引导您完成 `One Balance` 在 Cloudflare Workers 上的部署与配置。

---

## 📋 准备工作

在开始部署之前，请确保您已准备好以下环境：

1. **Node.js**：建议使用 v18 或更高版本。
2. **pnpm**：包管理工具（可以通过 `npm install -g pnpm` 安装）。
3. **Cloudflare 账户**：用于部署 Workers 和 D1 数据库。
4. **API 密钥**：准备好需要轮询的 API 密钥（如 Google AI Studio 密钥）。

---

## 🛠️ 部署步骤

### 第一步：创建 Cloudflare AI Gateway

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)。
2. 导航到左侧菜单的 **AI** -> **AI Gateway**。
3. 点击 **Create Gateway**（创建网关）。
4. 将网关命名为 **`one-balance`**（或您自定义的名称，后续需在配置中保持一致）。
5. 创建完成后，您将获得网关的 API 端点。

### 第二步：克隆项目并安装依赖

打开终端，执行以下命令：

```bash
# 克隆项目仓库
git clone https://github.com/glidea/one-balance.git

# 进入项目目录
cd one-balance

# 安装项目依赖
pnpm install
```

### 第三步：初始化配置文件

项目使用 `wrangler.jsonc` 进行配置。运行以下命令从模板生成配置文件：

```bash
pnpm init:config
```

这将在项目根目录下生成 `wrangler.jsonc` 文件。

### 第四步：配置环境变量

打开生成的 `wrangler.jsonc` 文件，在 `"vars"` 节点下配置您的环境变量：

```json
"vars": {
    "AUTH_KEY": "your-super-secret-auth-key", // 您的本地客户端访问密钥（支持多 Key、过期时间及权限控制）
    "AI_GATEWAY": "one-balance",              // 您在第一步中创建的 AI Gateway 名称
    "CONSECUTIVE_429_THRESHOLD": "2",         // 连续触发 429 的阈值，达到后触发长期冷却
    "MAX_RETRIES": "4"                        // 请求失败时的最大重试次数
}
```

> **AUTH_KEY 高级配置格式**：
> `AUTH_KEY="key1=provider1,model1;key2;key3(1758077793)=provider2"`
> * 使用分号 `;` 分隔多个 Key。
> * 无限制的 Key（如 `key2`）可以访问所有模型，且只有无限制的 Key 才能登录 Web UI。
> * 括号内可附加 Unix 时间戳表示过期时间，如 `key3(1758077793)`。
> * 可以使用 `=` 限制该 Key 只能访问特定 Provider 或 Model。

### 第五步：部署到 Cloudflare

使用以下命令进行一键部署。部署脚本会自动引导您登录 Cloudflare、创建所需的 D1 数据库、应用数据库迁移并部署 Worker：

#### Mac / Linux 环境：
```bash
AUTH_KEY=your-super-secret-auth-key pnpm run deploycf
```

#### Windows 环境 (PowerShell)：
```powershell
$env:AUTH_KEY = "your-super-secret-auth-key"; pnpm run deploycf
```

部署成功后，终端将输出您的 Worker URL，例如：
`https://one-balance-backend.<your-subdomain>.workers.dev`

---

## 🗄️ 数据库迁移与管理（可选）

部署脚本会自动处理数据库迁移。如果您后续需要手动管理数据库，可以使用以下命令：

### 本地开发数据库迁移：
```bash
pnpm migrate
```

### 远程生产数据库迁移：
```bash
pnpm migrate:remote
```

---

## 🚀 启动本地开发服务器

如果您想在本地进行开发或测试，可以启动本地 Wrangler 开发服务器：

```bash
pnpm dev
```

本地服务器默认运行在 `http://localhost:8080`。

---

## 🔑 配置待轮询的 API 密钥

1. 部署完成后，在浏览器中访问您的 Worker URL：`https://<your-worker-url>`。
2. 使用您在 `AUTH_KEY` 中配置的**无限制 Key**进行登录。
3. 在 Web UI 界面中，添加、管理和启用您需要轮询的第三方 API 密钥（如 Google AI Studio 密钥）。
