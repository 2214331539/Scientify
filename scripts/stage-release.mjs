import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const source = 'target/release/bundle/nsis';
const installers = readdirSync(source).filter(
  (file) => file.endsWith('.exe') && file.includes(version),
);
if (installers.length !== 1)
  throw new Error(`Expected one ${version} NSIS installer, found ${installers.length}.`);
const directory = '.release';
mkdirSync(directory, { recursive: true });
const name = `Scientify_${version}_windows_x64_setup.exe`;
cpSync(join(source, installers[0]), join(directory, name));
const digest = createHash('sha256')
  .update(readFileSync(join(directory, name)))
  .digest('hex');
writeFileSync(join(directory, 'SHA256SUMS.txt'), `${digest}  ${name}\n`);
cpSync(
  'src-tauri/release-resources/licenses/THIRD_PARTY_LICENSES.txt',
  join(directory, 'THIRD_PARTY_LICENSES.txt'),
);
writeFileSync(
  join(directory, 'RELEASE_NOTES.md'),
  `# Scientify ${version}\n\n` +
    `Windows x64 Alpha：本地 PDF 与论文笔记、项目笔记、Python 环境与终端、Git / worktree、本地实验及可配置 AI。\n\n` +
    `## 下载与安装\n\n- 下载 **${name}**，运行后选择当前用户可写的安装目录。\n` +
    `- 安装包包含 Scientify、固定版本 Agent 和第三方许可；缺少 WebView2 时需要联网安装运行时。Python 与 Git 按需自行安装。\n` +
    `- 此预发布安装包尚未进行代码签名；Windows 可能提示发布者未知。SHA256SUMS.txt 用于核对下载完整性，不替代发布者签名。\n\n` +
    `## 数据与使用边界\n\n- 更新前关闭应用并备份 ScientifyData 及外部关联目录。JSON 导出不包含 PDF 和源码。\n` +
    `- 模型密钥当前保存在本机未加密凭据文件中，请勿分享整个数据目录；使用远程模型时遵循所选服务商的数据与计费规则。\n` +
    `- 手动终端与实验按本机用户权限执行，AI 正式运行使用工作区沙箱。\n` +
    `- 暂无自动更新、macOS / Linux 安装包、在线团队同步、论文推荐、Notebook 内核或 LaTeX 编译。\n\n` +
    `## 构建验证\n\n发布流程在 GitHub Windows runner 上检查版本与 main 归属，运行前端/Rust 检查和测试，再构建 NSIS。安装器冒烟验证覆盖隔离目录安装、载荷、重复安装与卸载后的数据保留；不替代真实用户桌面操作验收。\n`,
);
console.log(`Release files staged: ${name}, SHA256SUMS.txt, THIRD_PARTY_LICENSES.txt`);
