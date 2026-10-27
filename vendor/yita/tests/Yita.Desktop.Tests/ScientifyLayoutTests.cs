using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Interactivity;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using Yita.Core.Settings;
using Yita.Desktop;

namespace Yita.Desktop.Tests;

public sealed class ScientifyLayoutTests
{
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
