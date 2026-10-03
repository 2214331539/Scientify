import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { targetInfo } from './platform.mjs';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const { platform, label } = targetInfo();
const mac = platform === 'darwin';
const source = mac ? 'target/release/bundle/dmg' : 'target/release/bundle/nsis';
const extension = mac ? '.dmg' : '.exe';
const installers = readdirSync(source).filter(
  (file) => file.endsWith(extension) && file.includes(version),
);
if (installers.length !== 1)
  throw new Error(`Expected one ${version} ${label} installer, found ${installers.length}.`);
const directory = '.release';
mkdirSync(directory, { recursive: true });
const name = `Scientify_${version}_${label}${mac ? '' : '_setup'}${extension}`;
cpSync(join(source, installers[0]), join(directory, name));
const digest = createHash('sha256')
  .update(readFileSync(join(directory, name)))
  .digest('hex');
writeFileSync(join(directory, `SHA256SUMS_${label}.txt`), `${digest}  ${name}\n`);
cpSync(
  'src-tauri/release-resources/licenses/THIRD_PARTY_LICENSES.txt',
  join(directory, `THIRD_PARTY_LICENSES_${label}.txt`),
);
const signed = process.env.MACOS_SIGNING === 'developer-id';
const notes = mac
  ? `## macOS Apple Silicon 预览版\n\n` +
    `- 下载 **${name}**。仅支持 Apple Silicon（M 系列），最低 macOS 14；不包含 Intel 版本。\n` +
    `- 打开 DMG，将 Scientify 拖到 Applications。Python 与 Git 按需自行安装。\n` +
    (signed
      ? '- 已使用 Developer ID 签名并完成 Apple 公证。\n'
      : '- 本次为 ad-hoc 签名、未经过 Apple 公证的预发布包。macOS 可能阻止首次打开；确认下载来源后，可在系统设置 → 隐私与安全性中使用系统提供的“仍要打开”。无需关闭 Gatekeeper。\n') +
    `- 数据默认保存在 ~/Library/Application Support/com.scientify.desktop/ScientifyData；应用内可迁移数据位置。更新前备份此目录和外部关联目录。\n` +
    `- 已在 GitHub 原生 ARM Mac runner 执行前端/Rust 检查、浏览器历史与 IPC 隔离验证、DMG 挂载、Agent 执行、覆盖安装数据保留及 LaunchServices 启动检查。最低系统版本、真实网站登录/下载及完整科研操作仍需更多真实设备反馈；这不是完整人工验收。\n` +
    `- 工作区中 Cmd+Q 先经过保存保护并返回 Projects，再次退出即可关闭应用。\n` +
    `- Mac 使用 WKWebView；HTTP 状态错误提示与 Windows 尚不完全一致，网站兼容性取决于系统 WebKit。\n`
  : `# Scientify ${version}\n\nWindows x64 与 macOS Apple Silicon 预发布版本：本地 PDF、论文笔记、Python 终端、Git、实验和可配置 AI。\n\n` +
    `## Windows x64\n\n- 下载 **${name}**，运行安装。缺少 WebView2 时安装器需要联网；Python 与 Git 按需自行安装。\n` +
    `- Windows 安装包未签名，可能提示未知发布者。SHA256SUMS.txt 验证下载完整性，不替代发布者签名。\n` +
    `- 更新前备份 ScientifyData 及外部关联目录。Windows CI 检查前端/Rust，并验证隔离安装、重复安装与卸载后数据保留。\n\n` +
    `## 共同说明\n\n- 包含固定版本 Agent 和各平台第三方许可清单。\n` +
    `- 本版本不包含云同步、在线团队协作或自动更新。两台电脑分别管理各自的本地数据。\n` +
    `- 模型密钥保存在本机未加密凭据文件中，请勿分享整个数据目录；手动终端与实验按本机用户权限执行，AI 正式运行沿用引擎沙箱。\n`;
writeFileSync(join(directory, `RELEASE_NOTES_${label}.md`), `${notes}\n`);
console.log(`Release files staged: ${name}`);
