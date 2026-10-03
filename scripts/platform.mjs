const targets = {
  'x86_64-pc-windows-msvc': {
    platform: 'win32',
    arch: 'x64',
    suffix: '.exe',
    label: 'windows_x64',
  },
  'aarch64-apple-darwin': { platform: 'darwin', arch: 'arm64', suffix: '', label: 'macos_arm64' },
};

export function hostTarget(platform = process.platform, arch = process.arch) {
  const target = Object.keys(targets).find(
    (name) => targets[name].platform === platform && targets[name].arch === arch,
  );
  if (!target)
    throw new Error(
      `Unsupported build host: ${platform}/${arch}. Use Windows x64 or Apple Silicon macOS.`,
    );
  return target;
}

export function targetInfo(
  target = process.env.SCIENTIFY_CODEX_TRIPLE ||
    process.env.TAURI_ENV_TARGET_TRIPLE ||
    hostTarget(),
) {
  if (!targets[target]) throw new Error(`Unsupported release target: ${target}`);
  return { target, ...targets[target] };
}
