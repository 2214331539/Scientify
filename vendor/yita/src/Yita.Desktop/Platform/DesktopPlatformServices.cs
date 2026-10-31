using Yita.Core.Platform;
using Yita.Core.Selection;
using Yita.Core.Settings;
using Yita.Native.Mac;
using Yita.Native.Windows;
using Yita.Translation;

namespace Yita.Desktop;

internal sealed class DesktopPlatformServices
{
    // Canonical Windows paths are valid for I/O, but their device prefix is not useful in settings.
    internal static string DisplayPath(string path)
    {
        if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + path[8..];
        if (path.StartsWith(@"\\?\", StringComparison.Ordinal) && path.Length >= 7
            && char.IsAsciiLetter(path[4]) && path[5] == ':' && path[6] == '\\') return path[4..];
        return path;
    }

    internal string DataDirectory { get; } = Environment.GetEnvironmentVariable("SCIENTIFY_TRANSLATION_DATA") ?? Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Yita");
    internal IStartupRegistration Startup { get; } = ScientifyBridge.IsEmbedded ? new UnsupportedStartupRegistration() : OperatingSystem.IsWindows()
        ? new WindowsStartupService() : OperatingSystem.IsMacOS()
            ? new MacStartupRegistration() : new UnsupportedStartupRegistration();

    internal ISingleInstanceGuard AcquireInstance(bool requestActivation) => OperatingSystem.IsWindows()
        ? new WindowsSingleInstanceGuard(requestActivation)
        : new PortableSingleInstanceGuard(Path.Combine(DataDirectory, "desktop-instance.lock"), requestActivation);

    internal ISelectionRuntime? CreateSelectionRuntime() => OperatingSystem.IsWindows()
        ? new WindowsSelectionRuntime()
        : OperatingSystem.IsMacOS() ? new MacSelectionRuntime() : null;

    internal IStatusIcon? CreateStatusIcon(string iconPath) => OperatingSystem.IsWindows()
        ? new WindowsTrayIcon(iconPath) : null;

    internal IPlatformPermissionService? CreatePermissionService() => OperatingSystem.IsMacOS()
        ? new MacSelectionAdapter() : null;

    internal ISecretStore CreateSecretStore() => ScientifyBridge.IsEmbedded ? new ScientifySecretStore() : OperatingSystem.IsWindows()
        ? new WindowsCredentialSecretStore()
        : OperatingSystem.IsMacOS() ? new MacKeychainSecretStore() : new MemorySecretStore();

    internal async Task<ITranslationMemoryProtector?> CreateMemoryProtectorAsync(string memoryPath,
        CancellationToken cancellationToken = default)
    {
        if (OperatingSystem.IsWindows()) return new WindowsTranslationMemoryProtector();
        if (OperatingSystem.IsMacOS()) return await MacTranslationMemoryProtector.CreateAsync(
            allowCreate: !File.Exists(memoryPath), cancellationToken).ConfigureAwait(false);
        return null;
    }

    internal string PlatformName => OperatingSystem.IsWindows() ? "Windows" : OperatingSystem.IsMacOS() ? "macOS" : "Desktop";
}
