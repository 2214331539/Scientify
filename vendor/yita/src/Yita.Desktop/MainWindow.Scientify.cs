using System.Text.Json;
using Yita.Core.Selection;
using Yita.Core.Settings;

namespace Yita.Desktop;

public sealed partial class MainWindow
{
    private string _hostModel = "scientify";
    private bool _hostStarted;
    private readonly bool _migrateScientifySettings = ScientifyBridge.IsEmbedded && !File.Exists(Path.Combine(
        Environment.GetEnvironmentVariable("SCIENTIFY_TRANSLATION_DATA")!, "desktop-settings.json"));

    private YitaSettings HostedModel(YitaSettings settings) => settings with
    {
        ProviderId = "deepseek", DeepSeekEndpoint = "https://scientify.invalid",
        DeepSeekModel = _hostModel, StartWithSystem = false,
    };

    internal async Task<object> HandleScientifyCommandAsync(JsonElement action)
    {
        await Initialization;
        switch (action.GetProperty("type").GetString())
        {
            case "configure":
                _hostModel = action.GetProperty("model").GetString()!;
                _settings = HostedModel(_settings);
                foreach (var session in _sessions.Values)
                    session.Settings = session.Settings with { DeepSeekModel = _hostModel };
                foreach (var conversation in _conversations) conversation.ApplyHostModel(_hostModel);
                if (!_hostStarted && _migrateScientifySettings)
                {
                    var legacy = action.GetProperty("legacy");
                    _settings = _settings with
                    {
                        IsEnabled = !legacy.TryGetProperty("enabled", out var enabled) || enabled.GetBoolean(),
                        UiLanguage = action.GetProperty("language").GetString() ?? "zh-CN",
                        SourceLanguage = LegacyLanguage(legacy, "sourceLanguage", "自动检测"),
                        TargetLanguage = LegacyLanguage(legacy, "targetLanguage", "简体中文"),
                        TargetLanguageMode = legacy.TryGetProperty("targetLanguage", out var target) && target.GetString() != "auto" ? "fixed" : "auto",
                        TranslationTone = legacy.TryGetProperty("style", out var tone) ? Yita.Settings.TranslationPreferenceCatalog.NormalizeTone(tone.GetString()) : "natural",
                        UseSelectionContext = legacy.TryGetProperty("contextEnabled", out var context) && context.GetBoolean(),
                        AiHistoryDirectory = Path.Combine(_platform.DataDirectory, "records"),
                    };
                    await _settingsStore.SaveAsync(_settings);
                }
                // Don't overwrite unsaved settings fields when the host changes model in the background.
                ModelComboBox.Text = _hostModel;
                if (!_hostStarted)
                {
                    _hostStarted = true;
                    ApplyRuntimeSettings();
                    _selectionRuntime?.Start();
                }
                return Status();
            case "status": return Status();
            case "appearance":
                ScientifyAppearance.Dark = action.GetProperty("dark").GetBoolean();
                Avalonia.Application.Current!.RequestedThemeVariant = ScientifyAppearance.Dark
                    ? Avalonia.Styling.ThemeVariant.Dark : Avalonia.Styling.ThemeVariant.Light;
                ReferenceTheme.Apply(Avalonia.Application.Current.Resources, _settings.ToOriginal());
                foreach (var popup in _popups) popup.ApplyHostAppearance();
                foreach (var conversation in _conversations) conversation.ApplyHostAppearance();
                UpdateThemePreview();
                return Status();
            case "settings":
                if (!IsVisible) { PopulateSettings(); Show(); }
                Activate();
                return Status();
            case "enabled":
                _settings = _settings with { IsEnabled = action.GetProperty("enabled").GetBoolean() };
                await _settingsStore.SaveAsync(_settings);
                ApplyRuntimeSettings();
                return Status();
            case "clipboard":
                TranslateClipboardFromTray();
                return Status();
            case "repair":
                await Task.Run(() => _selectionRuntime?.RepairInputCapture());
                return Status();
            case "translate":
                var text = action.GetProperty("text").GetString() ?? "";
                if (string.IsNullOrWhiteSpace(text) || text.Length > 20000) throw new ArgumentException("请选择 1–20000 个字符。");
                var area = Screens.Primary?.WorkingArea;
                var anchor = area is { } screen ? new ScreenPoint(screen.X + screen.Width / 2d, screen.Y + screen.Height / 2d) : new ScreenPoint(200, 200);
                _ = ShowSelectionTranslationAsync(new(SelectionTrigger.TrayCommand, anchor), new(text, SelectionSource.ManualClipboard));
                return Status();
            default: throw new ArgumentException("未知翻译命令。");
        }
    }

    private static string LegacyLanguage(JsonElement value, string key, string fallback) =>
        value.TryGetProperty(key, out var language) ? language.GetString() switch
        {
            "auto" => "自动检测", "zh-CN" => "简体中文", "en" => "英语", "ja" => "日语",
            _ => fallback,
        } : fallback;

    internal object Status() => new
    {
        enabled = _settings.IsEnabled,
        running = _selectionRuntime?.IsRunning == true,
        hotkeyRunning = _selectionRuntime?.IsHotkeyRunning == true,
        dataDirectory = _platform.DataDirectory,
        popupCount = _popups.Count,
        settingsError = _settingsFailure?.ToString(),
    };
}

internal sealed class ScientifySecretStore : ISecretStore
{
    // A protocol marker only; HttpClient is backed exclusively by the inherited Scientify pipe.
    public Task<string?> ReadApiKeyAsync(CancellationToken cancellationToken = default) => Task.FromResult<string?>("scientify-host");
    public Task SaveApiKeyAsync(string value, CancellationToken cancellationToken = default) => Task.CompletedTask;
}
