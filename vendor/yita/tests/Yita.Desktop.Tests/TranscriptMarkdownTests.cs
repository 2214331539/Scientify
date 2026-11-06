using Avalonia.Controls;
using Avalonia.Controls.Documents;
using Avalonia.Headless.XUnit;
using Avalonia.Media;
using Yita.Desktop;
using Yita.Settings;

namespace Yita.Desktop.Tests;

public sealed class TranscriptMarkdownTests
{
    [AvaloniaFact]
    public void AnswersRenderMarkdownAsSelectableNativeContent()
    {
        var text = new TranscriptTextBlock { FontSize = 15.5 };
        TranscriptMarkdown.Append(text.Inlines!, "## 研究结论\n\n**重要**、*斜体*、~~删除~~和 `x = 1`\n\n- 第一步\n- 第二步\n\n> 证据 &alpha; <https://example.com>\n\n```python\nprint('你好')\n```", AppSettings.Default, text.FontSize, 360);
        var plain = ReferenceTypography.GetText(text);
        Assert.Contains("研究结论", plain);
        Assert.DoesNotContain("##", plain);
        Assert.DoesNotContain("**", plain);
        Assert.DoesNotContain("```", plain);
        Assert.Contains("• 第一步", plain);
        Assert.Contains("print('你好')", plain);
        Assert.Contains("α", plain);
        Assert.Contains("https://example.com", plain);
        Assert.Contains(text.Inlines!.OfType<Span>(), span => span.FontWeight == FontWeight.Bold);
        var window = new Window { Content = text, Width = 380, Height = 400 };
        try { window.Show(); window.UpdateLayout(); text.SelectAll(); Assert.Contains("第二步", text.SelectedText); }
        finally { window.Close(); }
    }

    [AvaloniaFact]
    public void TablesAndSafeLinksRenderWithoutExecutingHtmlOrLoadingImages()
    {
        var text = new TranscriptTextBlock();
        TranscriptMarkdown.Append(text.Inlines!, "| 指标 | 值 |\n| --- | --- |\n| ACC | 0.95 |\n\n[论文](https://example.com) ![示意图](https://example.com/image.png) [危险](file:///test)", AppSettings.Default, 15.5, 360);
        var controls = text.Inlines!.OfType<InlineUIContainer>().Select(inline => inline.Child).ToArray();
        var table = Assert.Single(controls.OfType<Grid>());
        Assert.Equal(4, table.Children.Count);
        Assert.Single(controls.OfType<Button>());
        Assert.Empty(controls.OfType<Image>());
        var window = new Window { Content = text, Width = 380, Height = 400 };
        try
        {
            ScientifyAppearance.Apply(window.Resources, AppSettings.Default, false);
            window.Background = Avalonia.Media.Brushes.White;
            text.Foreground = Avalonia.Media.Brushes.Black;
            window.Show(); window.UpdateLayout();
            Assert.InRange(table.Bounds.Width, 0, 380);
            ReferenceLayoutTests.Capture(window, "scientify-markdown-table");
        }
        finally { window.Close(); }
    }

    [AvaloniaTheory]
    [InlineData(300, "> ")]
    [InlineData(200, "- ")]
    [InlineData(5000, "*")]
    public void DeeplyNestedAnswersFallBackToTextInsteadOfCrashing(int depth, string marker)
    {
        var text = new TranscriptTextBlock();
        // "> > >" and "- - -" nest one level per marker on a single line.
        var markdown = marker == "*"
            ? new string('*', depth) + "deep" + new string('*', depth)
            : string.Concat(Enumerable.Repeat(marker, depth)) + "deep";
        TranscriptMarkdown.Append(text.Inlines!, markdown, AppSettings.Default, 15.5, 360);
        Assert.Contains("deep", ReferenceTypography.GetText(text));
    }

    [AvaloniaFact]
    public void WideTablesWrapWithinTheTranscriptAndCellsAddNoBlankLine()
    {
        var text = new TranscriptTextBlock();
        var cell = string.Join(' ', Enumerable.Repeat("long-cell-content", 6));
        TranscriptMarkdown.Append(text.Inlines!, $"| A | B | C |\n| --- | --- | --- |\n| {cell} | {cell} | {cell} |", AppSettings.Default, 15.5, 360);
        var table = Assert.Single(text.Inlines!.OfType<InlineUIContainer>().Select(inline => inline.Child).OfType<Grid>());
        Assert.Equal(360, table.Width);
        var cells = table.Children.OfType<Border>().Select(border => (SelectableTextBlock)border.Child!);
        Assert.All(cells, block => Assert.Empty(block.Inlines!.OfType<LineBreak>()));
    }

    [Theory]
    [InlineData("https://example.com", true)]
    [InlineData("mailto:test@example.com", true)]
    [InlineData("javascript:alert(1)", false)]
    [InlineData("file:///test", false)]
    public void LinkActivationOnlyUsesWebAndMail(string url, bool allowed) => Assert.Equal(allowed, TranscriptMarkdown.SafeLink(url) is not null);
}
