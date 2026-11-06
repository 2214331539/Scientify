using System.Text;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Documents;
using Avalonia.Media;
using Markdig;
using Markdig.Extensions.EmphasisExtras;
using Markdig.Extensions.Tables;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;
using Yita.Settings;

namespace Yita.Desktop;

/// <summary>Render model Markdown as native, selectable content without HTML or remote image loading.</summary>
internal static class TranscriptMarkdown
{
    private static readonly MarkdownPipeline Pipeline = new MarkdownPipelineBuilder()
        .UsePipeTables().UseEmphasisExtras(EmphasisExtraOptions.Strikethrough).DisableHtml().Build();
    private static readonly FontFamily CodeFont = new("Cascadia Code, Menlo, monospace");
    // Deeper structure is shown as plain text: nested spans recurse in rendering and layout.
    private const int MaxDepth = 16;

    /// <param name="width">Width available to the transcript; tables wrap within it.</param>
    internal static void Append(InlineCollection output, string markdown, AppSettings settings, double fontSize, double width)
    {
        var start = output.Count;
        try
        {
            foreach (var block in Markdig.Markdown.Parse(markdown, Pipeline))
                AppendBlock(output, block, settings, fontSize, width, 0, 0);
        }
        catch (Exception)
        {
            // Model output is untrusted: anything Markdig or the renderer rejects is shown as written.
            while (output.Count > start) output.RemoveAt(output.Count - 1);
            AppendText(output, markdown, settings);
            Break(output);
        }
    }

    private static void AppendBlock(InlineCollection output, Block block, AppSettings settings, double size,
        double width, int indent, int nesting)
    {
        if (nesting > MaxDepth && block is not LeafBlock)
        {
            AppendText(output, PlainText(block), settings);
            Break(output);
            return;
        }
        switch (block)
        {
            case Table table:
                var grid = new Grid { Margin = new Thickness(0, 6), Width = Math.Max(160, Math.Min(720, width)) };
                var columns = table.OfType<TableRow>().Select(row => row.Count).DefaultIfEmpty(0).Max();
                for (var col = 0; col < columns; col++) grid.ColumnDefinitions.Add(new ColumnDefinition(GridLength.Star));
                for (var row = 0; row < table.Count; row++)
                {
                    grid.RowDefinitions.Add(new RowDefinition(GridLength.Auto));
                    var cells = (TableRow)table[row];
                    for (var col = 0; col < cells.Count; col++)
                    {
                        var text = new SelectableTextBlock { TextWrapping = TextWrapping.Wrap, FontSize = size,
                            FontWeight = cells.IsHeader ? FontWeight.SemiBold : FontWeight.Normal };
                        // A cell holds one line of inline content; no trailing paragraph break.
                        foreach (var child in (TableCell)cells[col])
                            if (child is LeafBlock cell) AppendInlines(text.Inlines!, cell.Inline, settings, 0);
                        var border = new Border { Child = text, Padding = new Thickness(8, 5), BorderThickness = new Thickness(0, 0, 0, 1) };
                        border.Bind(Border.BorderBrushProperty, new Avalonia.Markup.Xaml.MarkupExtensions.DynamicResourceExtension("PopupBorderBrush"));
                        Grid.SetRow(border, row); Grid.SetColumn(border, col); grid.Children.Add(border);
                    }
                }
                output.Add(new InlineUIContainer(grid));
                Break(output);
                break;
            case HeadingBlock heading:
                var title = new Span { FontWeight = FontWeight.SemiBold, FontSize = size * (heading.Level == 1 ? 1.35 : heading.Level == 2 ? 1.2 : 1.08) };
                AppendInlines(title.Inlines, heading.Inline, settings, 0);
                output.Add(title); Break(output);
                break;
            case CodeBlock code:
                output.Add(new Run(code.Lines.ToString()) { FontFamily = CodeFont, FontSize = size * .92 });
                Break(output);
                break;
            case ListBlock list:
                var number = int.TryParse(list.OrderedStart, out var first) ? first : 1;
                foreach (var item in list.OfType<ListItemBlock>())
                {
                    output.Add(new Run(new string(' ', Math.Min(indent, 8) * 3) + (list.IsOrdered ? $"{number++}. " : "• ")));
                    foreach (var child in item) AppendBlock(output, child, settings, size, width, indent + 1, nesting + 1);
                }
                break;
            case QuoteBlock quote:
                foreach (var child in quote)
                {
                    output.Add(new Run("│ "));
                    AppendBlock(output, child, settings, size, width, indent, nesting + 1);
                }
                break;
            case LeafBlock leaf:
                AppendInlines(output, leaf.Inline, settings, 0); Break(output);
                break;
            case ContainerBlock container:
                foreach (var child in container) AppendBlock(output, child, settings, size, width, indent, nesting + 1);
                break;
        }
    }

    private static void AppendInlines(InlineCollection output, ContainerInline? container, AppSettings settings, int depth)
    {
        if (container is null) return;
        if (depth > MaxDepth)
        {
            AppendText(output, PlainText(container), settings);
            return;
        }
        foreach (var inline in container)
        {
            switch (inline)
            {
                case LiteralInline literal:
                    AppendText(output, literal.Content.ToString(), settings);
                    break;
                case HtmlEntityInline entity:
                    AppendText(output, entity.Transcoded.ToString(), settings);
                    break;
                case AutolinkInline autolink:
                    AppendText(output, autolink.Url, settings);
                    break;
                case CodeInline code:
                    output.Add(new Run(code.Content) { FontFamily = CodeFont });
                    break;
                case LineBreakInline line:
                    AppendText(output, line.IsHard ? "\n" : " ", settings);
                    break;
                case EmphasisInline emphasis:
                    var span = new Span();
                    if (emphasis.DelimiterChar == '~' && emphasis.DelimiterCount == 2) span.TextDecorations = TextDecorations.Strikethrough;
                    else if (emphasis.DelimiterCount >= 2) span.FontWeight = FontWeight.Bold;
                    else span.FontStyle = FontStyle.Italic;
                    AppendInlines(span.Inlines, emphasis, settings, depth + 1); output.Add(span);
                    break;
                case LinkInline link when !link.IsImage && SafeLink(link.Url) is { } uri:
                    var label = new TextBlock { TextWrapping = TextWrapping.Wrap, TextDecorations = TextDecorations.Underline, MaxWidth = 280 };
                    AppendInlines(label.Inlines!, link, settings, depth + 1);
                    var button = new Button { Content = label, Padding = new Thickness(0), Margin = new Thickness(0),
                        MinHeight = 0, Background = Brushes.Transparent, BorderThickness = new Thickness(0) };
                    button.Bind(Button.ForegroundProperty, new Avalonia.Markup.Xaml.MarkupExtensions.DynamicResourceExtension("AccentBrush"));
                    ToolTip.SetTip(button, uri.AbsoluteUri);
                    button.Click += async (_, _) =>
                    {
                        try
                        {
                            if (TopLevel.GetTopLevel(button) is { } top && !await top.Launcher.LaunchUriAsync(uri))
                                ToolTip.SetTip(button, settings.UiLanguage == "zh-CN" ? "无法打开链接，请复制到浏览器。" : "Could not open link. Copy it to your browser.");
                        }
                        catch (Exception error) when (error is IOException or System.ComponentModel.Win32Exception)
                        {
                            ToolTip.SetTip(button, error.Message);
                        }
                    };
                    output.Add(new InlineUIContainer(button));
                    break;
                case ContainerInline nested:
                    AppendInlines(output, nested, settings, depth + 1);
                    break;
            }
        }
    }

    /// <summary>Text of a subtree, walked with an explicit stack so depth cannot overflow the call stack.</summary>
    private static string PlainText(MarkdownObject root)
    {
        var text = new StringBuilder();
        var pending = new Stack<MarkdownObject>();
        pending.Push(root);
        while (pending.Count > 0)
        {
            switch (pending.Pop())
            {
                case LiteralInline literal: text.Append(literal.Content.ToString()); break;
                case CodeInline code: text.Append(code.Content); break;
                case HtmlEntityInline entity: text.Append(entity.Transcoded.ToString()); break;
                case AutolinkInline autolink: text.Append(autolink.Url); break;
                case LineBreakInline: text.Append(' '); break;
                case ContainerInline inlines:
                    foreach (var child in inlines.Reverse()) pending.Push(child);
                    break;
                case LeafBlock leaf:
                    text.Append('\n');
                    if (leaf.Inline is { } inline) pending.Push(inline);
                    else text.Append(leaf.Lines.ToString());
                    break;
                case ContainerBlock blocks:
                    foreach (var child in blocks.Reverse()) pending.Push(child);
                    break;
            }
        }
        return text.ToString().Trim();
    }

    internal static Uri? SafeLink(string? url) => Uri.TryCreate(url, UriKind.Absolute, out var uri)
        && uri.Scheme is "https" or "http" or "mailto" ? uri : null;

    // Let emphasis inherit through spans; font segmentation alone must not reset its weight.
    private static void AppendText(InlineCollection output, string text, AppSettings settings)
    {
        foreach (var segment in Yita.Windows.TranslationTypography.Segment(text))
            output.Add(new Run(segment.Text) { FontFamily = ReferenceTypography.CreateFont(segment.UsesChineseFont
                ? settings.ChineseTranslationFontFamily : settings.EnglishTranslationFontFamily) });
    }

    private static void Break(InlineCollection output) => output.Add(new LineBreak());
}
