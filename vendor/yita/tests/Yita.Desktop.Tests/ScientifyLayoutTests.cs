using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Headless;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Media.Imaging;
using Avalonia.Media;
using Avalonia.Threading;
using Avalonia.Styling;
using Avalonia.VisualTree;
using Yita.Core.Settings;
using Yita.Core.Parity;
using Yita.Desktop;
using Yita.Services;
using Yita.Translation;

namespace Yita.Desktop.Tests;

public sealed class ScientifyLayoutTests
{
    [AvaloniaFact]
    public void TranslationInputSendsOnEnterAndKeepsShiftEnterForNewlines()
    {
        var popup = new TranslationPopupWindow();
        var questions = new List<QuestionAction>();
        popup.QuestionRequested += (_, question) => questions.Add(question);
        try
        {
            popup.Show(); popup.BeginTranslation("source"); popup.SetText("译文"); popup.CompleteTranslation();
            var input = popup.FindControl<TextBox>("InlineQuestionTextBox")!;
            input.Text = "第一行"; input.CaretIndex = input.Text.Length; input.Focus();
            popup.KeyPressQwerty(PhysicalKey.Enter, RawInputModifiers.Shift); popup.KeyReleaseQwerty(PhysicalKey.Enter, RawInputModifiers.Shift);
            Assert.Empty(questions);
            Assert.Contains('\n', input.Text);
            input.Text = "解释这段译文";
            popup.KeyPressQwerty(PhysicalKey.Enter, RawInputModifiers.None); popup.KeyReleaseQwerty(PhysicalKey.Enter, RawInputModifiers.None);
            Assert.Single(questions);
            Assert.Equal("解释这段译文", questions[0].Question);
            Assert.Equal("", input.Text);
        }
        finally { popup.Close(); }
    }

    [AvaloniaFact]
    public void ConversationInputUsesTheSameEnterBehavior()
    {
        var settings = (YitaSettings.Default with { ProviderId = "mock" }).ToOriginal();
        using var factory = new TranslationProviderFactory();
        var window = new QuestionAnswerWindow(settings, "source", "translation", "", QuestionContextKind.Translation,
            new ReferenceTranslationRuntime(factory), new AiHistoryStore(),
            new AiHistoryContext(Guid.NewGuid(), DateTimeOffset.Now, "source", "translation", "英语", "简体中文"));
        try
        {
            window.Show();
            var input = window.FindControl<TextBox>("QuestionInputTextBox")!;
            input.Text = "follow up"; input.CaretIndex = input.Text.Length; input.Focus();
            window.KeyPressQwerty(PhysicalKey.Enter, RawInputModifiers.Shift); window.KeyReleaseQwerty(PhysicalKey.Enter, RawInputModifiers.Shift);
            Assert.Contains('\n', input.Text);
            Assert.True(input.IsEnabled);
            input.Text = "explain this sentence";
            window.KeyPressQwerty(PhysicalKey.Enter, RawInputModifiers.None); window.KeyReleaseQwerty(PhysicalKey.Enter, RawInputModifiers.None);
            Assert.Equal("", input.Text);
            Assert.Contains("explain this sentence", ReferenceTypography.GetText(window.FindControl<SelectableTextBlock>("TranscriptText")!));
        }
        finally { window.Close(); }
    }

    [Theory]
    [InlineData(@"\\?\F:\ScientifyData\translation\records", @"F:\ScientifyData\translation\records")]
    [InlineData(@"\\?\UNC\server\share\records", @"\\server\share\records")]
    [InlineData(@"F:\科研资料\records", @"F:\科研资料\records")]
    [InlineData("/Users/test/records", "/Users/test/records")]
    [InlineData(@"\\?\Volume{123}\records", @"\\?\Volume{123}\records")]
    public void DisplayPathsPreserveLocationAndLeaveOtherFormatsIntact(string original, string expected)
        => Assert.Equal(expected, DesktopPlatformServices.DisplayPath(original));

    [AvaloniaTheory]
    [InlineData(380, 320)]
    [InlineData(600, 420)]
    public void BrandThemesPreserveSelectionAndDraftAndFitAtBothSizes(int width, int height)
    {
        ReferenceMotion.Enabled = false;
        var settings = (YitaSettings.Default with { UiLanguage = "zh-CN" }).ToOriginal();
        var popup = new TranslationPopupWindow();
        try
        {
            popup.ApplySettings(settings);
            popup.Show();
            popup.BeginTranslation("Reproducible research connects the paper, code and experimental environment.");
            popup.SetText("可复现的研究，将论文、代码与实验环境联系起来。\n\n你可以固定译文、对照原文，或继续向 AI 提问。会话也可以在 Scientify 侧边栏中继续。");
            popup.CompleteTranslation();
            var input = popup.FindControl<TextBox>("InlineQuestionTextBox")!;
            input.Text = "怎样验证实验结果？";
            var text = popup.FindControl<SelectableTextBlock>("TranslationText")!;
            text.SelectAll();
            var selected = text.SelectedText;
            popup.FindControl<Button>("ScientifyAssistantButton")!.IsVisible = true;
            foreach (var dark in new[] { false, true })
            {
                popup.RequestedThemeVariant = dark ? ThemeVariant.Dark : ThemeVariant.Light;
                ScientifyAppearance.Apply(popup.Resources, settings, dark);
                popup.Width = width; popup.Height = height;
                popup.UpdateLayout(); Dispatcher.UIThread.RunJobs();
                Assert.Equal(selected, text.SelectedText);
                Assert.Equal("怎样验证实验结果？", input.Text);
                Assert.True(input.Bounds.Width >= 100, "The compact popup must leave room to type a question.");
                foreach (var name in new[] { "ActionBarSurface", "InlineQuestionTextBox", "ScientifyAssistantButton", "CloseButton" })
                    AssertFits(popup, popup.FindControl<Control>(name)!);
                text.ClearSelection();
                ReferenceLayoutTests.Capture(popup, $"scientify-{(dark ? "dark" : "light")}-{width}x{height}");
                text.SelectAll();
            }
        }
        finally { popup.Close(); ReferenceMotion.Enabled = true; }
    }

    [AvaloniaFact]
    public async Task SettingsAndConversationUseTheBrandWithoutLosingDrafts()
    {
        ReferenceMotion.Enabled = false;
        var settings = YitaSettings.Default with { UiLanguage = "zh-CN", ProviderId = "mock" };
        var window = new MainWindow(null, new MemorySettings(settings), new MemorySecretStore()) { Width = 964, Height = 721 };
        using var factory = new TranslationProviderFactory();
        var conversation = new QuestionAnswerWindow(settings.ToOriginal(), "source", "译文", "", QuestionContextKind.Translation,
            new ReferenceTranslationRuntime(factory), new AiHistoryStore(),
            new AiHistoryContext(Guid.NewGuid(), DateTimeOffset.Now, "source", "译文", "英语", "简体中文")) { Width = 380, Height = 320 };
        var app = Application.Current!;
        var previousTheme = app.RequestedThemeVariant;
        try
        {
            window.Show(); await window.Initialization;
            conversation.Show();
            await conversation.AskAsync("如何理解这段文字？");
            var input = conversation.FindControl<TextBox>("QuestionInputTextBox")!;
            input.Text = "我还想了解……";
            conversation.FindControl<Button>("ScientifyAssistantButton")!.IsVisible = true;
            foreach (var dark in new[] { false, true })
            {
                app.RequestedThemeVariant = dark ? ThemeVariant.Dark : ThemeVariant.Light;
                ScientifyAppearance.Apply(app.Resources, settings.ToOriginal(), dark);
                foreach (var target in new Window[] { window, conversation })
                {
                    target.RequestedThemeVariant = dark ? ThemeVariant.Dark : ThemeVariant.Light;
                    ScientifyAppearance.Apply(target.Resources, settings.ToOriginal(), dark);
                    target.UpdateLayout(); Dispatcher.UIThread.RunJobs();
                }
                Assert.Equal("我还想了解……", input.Text);
                foreach (var name in new[] { "TitleText", "CloseButton", "QuestionInputTextBox", "ScientifyAssistantButton" })
                    AssertFits(conversation, conversation.FindControl<Control>(name)!);
                var title = conversation.FindControl<TextBlock>("TitleText")!;
                var copy = conversation.FindControl<Button>("CopyButton")!;
                Assert.True(title.TranslatePoint(default, conversation)!.Value.X + title.Bounds.Width <= copy.TranslatePoint(default, conversation)!.Value.X);
                Assert.NotNull(window.GetVisualDescendants().OfType<Image>().Single().Source);
                var navigation = window.FindControl<ListBox>("SettingsNavigation")!;
                var selected = (ListBoxItem)navigation.ContainerFromIndex(navigation.SelectedIndex)!;
                var caption = selected.GetVisualDescendants().OfType<TextBlock>().Single();
                Assert.Equal(((SolidColorBrush)window.Resources["AccentTextBrush"]!).Color, ((SolidColorBrush)caption.Foreground!).Color);
                ReferenceLayoutTests.Capture(window, $"scientify-settings-{(dark ? "dark" : "light")}");
                ReferenceLayoutTests.Capture(conversation, $"scientify-conversation-{(dark ? "dark" : "light")}");
            }
        }
        finally
        {
            window.Close(); conversation.Close(); ReferenceMotion.Enabled = true;
            app.RequestedThemeVariant = previousTheme;
            ReferenceTheme.Apply(app.Resources, Yita.Settings.AppSettings.Default);
        }
    }

    private static void AssertFits(Window window, Control control)
    {
        var point = control.TranslatePoint(default, window)!.Value;
        Assert.True(point.X >= 0 && point.Y >= 0 && point.X + control.Bounds.Width <= window.Bounds.Width
            && point.Y + control.Bounds.Height <= window.Bounds.Height, $"Clipped {control.Name}: {point} {control.Bounds}");
    }

    private sealed class MemorySettings(YitaSettings settings) : ISettingsStore
    {
        public Task<YitaSettings> LoadAsync(CancellationToken cancellationToken = default) => Task.FromResult(settings);
        public Task SaveAsync(YitaSettings value, CancellationToken cancellationToken = default) => Task.CompletedTask;
    }

    [AvaloniaTheory]
    [InlineData(380, 320)]
    [InlineData(600, 420)]
    public void AssistantHandoffFitsTheReadingWindowAndPreservesTheQuestion(int width, int height)
    {
        ReferenceMotion.Enabled = false;
        var popup = new TranslationPopupWindow();
        try
        {
            popup.ApplySettings((YitaSettings.Default with { UiLanguage = "zh-CN" }).ToOriginal());
            popup.Show();
            popup.BeginTranslation("A reproducible experiment separates its data, code and environment.");
            popup.SetText("可复现的实验应当分别管理数据、代码与运行环境。\n\n固定此窗口后，可以选择另一段文字，同时保留当前的翻译和问题。");
            popup.CompleteTranslation();
            var action = popup.FindControl<Button>("ScientifyAssistantButton")!;
            action.IsVisible = true;
            popup.FindControl<TextBox>("InlineQuestionTextBox")!.Text = "这与实验版本管理有什么关系？";
            popup.Width = width; popup.Height = height;
            popup.UpdateLayout(); Dispatcher.UIThread.RunJobs();
            var position = action.TranslatePoint(default, popup)!.Value;
            Assert.True(position.Y >= 0 && position.Y + action.Bounds.Height <= popup.Bounds.Height);
            Assert.True(position.X >= 0 && position.X + action.Bounds.Width <= popup.Bounds.Width);
            var input = popup.FindControl<TextBox>("InlineQuestionTextBox")!;
            var inputPosition = input.TranslatePoint(default, popup)!.Value;
            Assert.True(inputPosition.X >= 0 && inputPosition.X + input.Bounds.Width <= popup.Bounds.Width);
            var sent = false;
            popup.AssistantRequested += (_, _) => sent = true;
            action.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            Assert.True(sent);
            Assert.Equal("这与实验版本管理有什么关系？", popup.PendingQuestion);
            if (Environment.GetEnvironmentVariable("YITA_PARITY_CAPTURE_DIRECTORY") is { Length: > 0 } directory)
            {
                Directory.CreateDirectory(directory);
                using var bitmap = new RenderTargetBitmap(new PixelSize(width, height));
                bitmap.Render(popup);
                bitmap.Save(Path.Combine(directory, $"scientify-yita-{width}x{height}.png"));
            }
        }
        finally { popup.Close(); ReferenceMotion.Enabled = true; }
    }
}
