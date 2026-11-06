namespace Yita.Core.Placement;

public readonly record struct PopupOffset(double X, double Y)
{
    public bool IsValid => double.IsFinite(X) && double.IsFinite(Y)
        && Math.Abs(X) <= 32768 && Math.Abs(Y) <= 32768;
}

public readonly record struct PopupSize(double Width, double Height)
{
    public bool IsValid => double.IsFinite(Width) && double.IsFinite(Height) && Width > 0 && Height > 0;
}

public readonly record struct WorkArea(double X, double Y, double Width, double Height)
{
    public double Right => X + Width;
    public double Bottom => Y + Height;
}

public static class PopupPlacementResolver
{
    public static PopupOffset CaptureLogicalOffset(SelectionAnchor anchor, double x, double y, double scaling) =>
        new((x - anchor.X) / ValidScale(scaling), (y - anchor.Y) / ValidScale(scaling));

    public static (double X, double Y) ResolveForScale(
        SelectionAnchor anchor, PopupSize logicalSize, WorkArea pixelWorkArea,
        double scaling, PopupOffset? logicalOffset = null, bool pointerAnchor = true)
    {
        scaling = ValidScale(scaling);
        var size = new PopupSize(logicalSize.Width * scaling, logicalSize.Height * scaling);
        if (logicalOffset is { IsValid: true } saved)
            return Resolve(anchor, size, pixelWorkArea, new PopupOffset(saved.X * scaling, saved.Y * scaling));
        // A selection range anchor keeps the popup below the selected text.
        if (!pointerAnchor) return Resolve(anchor, size, pixelWorkArea);
        // Beside the release pointer, never under it: the window's transparent
        // shadow and toolbar margin would otherwise swallow the next click or scroll.
        var offset = new PopupOffset(4 * scaling, -16 * scaling);
        if (anchor.X + offset.X + size.Width > pixelWorkArea.Right - 8)
            offset = offset with { X = -size.Width - 4 * scaling };
        if (anchor.Y + offset.Y + size.Height > pixelWorkArea.Bottom - 8)
            offset = offset with { Y = -size.Height + 16 * scaling };
        return Resolve(anchor, size, pixelWorkArea, offset);
    }

    private static double ValidScale(double scale) => double.IsFinite(scale) && scale > 0 ? scale : 1;

    public static (double X, double Y) Resolve(
        SelectionAnchor anchor,
        PopupSize size,
        WorkArea workArea,
        PopupOffset? savedOffset = null)
    {
        if (!double.IsFinite(anchor.X) || !double.IsFinite(anchor.Y)
            || !size.IsValid || !double.IsFinite(workArea.X) || !double.IsFinite(workArea.Y)
            || !double.IsFinite(workArea.Width) || !double.IsFinite(workArea.Height)
            || workArea.Width <= 0 || workArea.Height <= 0)
            return (workArea.X, workArea.Y);

        const double margin = 8;
        var x = anchor.X + 10;
        var y = anchor.Y + 12;
        if (savedOffset is { IsValid: true } offset)
        {
            x = anchor.X + offset.X;
            y = anchor.Y + offset.Y;
        }
        else
        {
            if (x + size.Width > workArea.Right - margin) x = anchor.X - size.Width - 10;
            if (y + size.Height > workArea.Bottom - margin) y = anchor.Y - size.Height - 12;
        }

        var maxX = Math.Max(workArea.X + margin, workArea.Right - size.Width - margin);
        var maxY = Math.Max(workArea.Y + margin, workArea.Bottom - size.Height - margin);
        return (Math.Clamp(x, workArea.X + margin, maxX), Math.Clamp(y, workArea.Y + margin, maxY));
    }
}

public readonly record struct SelectionAnchor(double X, double Y)
{
    public static SelectionAnchor FromLowerLeft(double x, double y) => new(x, y);
}
