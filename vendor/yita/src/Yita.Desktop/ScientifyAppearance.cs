using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using Yita.Settings;

namespace Yita.Desktop;

// Host palette mirrors src/styles/tokens.css. Yita still owns layout and interaction.
internal static class ScientifyAppearance
{
    internal static bool Dark { get; set; }
    private static readonly Bitmap LightLogo = new(AssetLoader.Open(new Uri("avares://Yita.Desktop/Assets/ScientifyLight.png")));
    private static readonly Bitmap DarkLogo = new(AssetLoader.Open(new Uri("avares://Yita.Desktop/Assets/ScientifyDark.png")));
    internal static Bitmap Logo(bool dark) => dark ? DarkLogo : LightLogo;

    internal static void Apply(IResourceDictionary resources, AppSettings settings, bool dark)
    {
        void Color(string key, string light, string night) => resources[key] = ReferenceTheme.Brush(dark ? night : light);
        Color("AppWindowBackgroundBrush", "#F7F7F7", "#1B1D1D");
        Color("AppCardBackgroundBrush", "#FFFFFF", "#202222");
        Color("AppCardBorderBrush", "#E5E7E6", "#343837");
        Color("AppFieldBackgroundBrush", "#FAFAFA", "#161818");
        Color("AppFieldBorderBrush", "#D1D6D4", "#49514E");
        Color("AppTextBrush", "#242727", "#E5E9EC");
        Color("AppMutedTextBrush", "#626867", "#AAB5BD");
        Color("AppHoverBrush", "#F0F0F0", "#2C302F");
        Color("AppPressedBrush", "#EAEAEA", "#343A37");
        // Keep explicitly chosen accent colors; the inherited default becomes Scientify graphite.
        if (settings.ColorTheme == "yita")
        {
            Color("AccentBrush", "#3D4643", "#C4CDCA");
            Color("AccentLightBrush", "#282F2C", "#E0E5E3");
            Color("AccentTextBrush", "#FFFFFF", "#171B19");
        }
        Color("SuccessBrush", "#246B45", "#8BD5A8");
        Color("DangerBrush", "#B03636", "#F19B9B");
        // A quiet, opaque reading plane: depth comes from its edge and shadow.
        Color("PopupBackgroundBrush", "#FFFFFF", "#242726");
        Color("PopupButtonBrush", "#FCF7F8F7", "#FC292C2B");
        Color("PopupBorderBrush", "#E0E4E2", "#3F4744");
        Color("PopupButtonBorderBrush", "#E3E7E5", "#424A47");
        Color("PopupButtonHoverBrush", "#EEF1EF", "#353B39");
        Color("PopupTextBrush", "#26292A", "#E5E9EC");
        Color("PopupMutedBrush", "#6B7170", "#A3AEB5");
        Color("QuestionInputBrush", "#F2F4F3", "#1B1E1D");
        Color("ExplanationSurfaceBrush", "#FAFBFA", "#232625");
        Color("QuestionAnswerSurfaceBrush", "#FAFBFA", "#232625");
        Color("ExplanationHeaderBrush", "#F1F3F2", "#292D2B");
        Color("QuestionAnswerHeaderBrush", "#F1F3F2", "#292D2B");
        resources["PopupTailBrush"] = resources["PopupBackgroundBrush"];
        resources["PopupGlassEnabled"] = false; // Replace the thick reflective rim with a single fine edge.
        resources["PopupTextSurfaceBrush"] = Brushes.Transparent;
        resources["PopupTextSurfacePadding"] = new Thickness(0);
        resources["PopupSurfaceCornerRadius"] = new CornerRadius(12);
        resources["PopupActionBarCornerRadius"] = new CornerRadius(10);
        resources["PopupButtonCornerRadius"] = new CornerRadius(6);
        resources["InputCornerRadius"] = new CornerRadius(15);
        resources["SettingsCardCornerRadius"] = new CornerRadius(10);
        resources["SettingsCardBorderThickness"] = new Thickness(1);
        resources["PopupEdgeThickness"] = new Thickness(1);
        resources["PopupRootMargin"] = new Thickness(12);
        resources["ConversationMargin"] = new Thickness(12);
        // A soft, wide shadow over a fine edge, as the app's own popovers.
        resources["PopupSurfaceShadow"] = BoxShadows.Parse(dark
            ? "0 1 2 0 #40000000, 0 8 20 -4 #66000000"
            : "0 1 2 0 #0A16221C, 0 8 20 -4 #1F16221C");
        resources["PopupToolbarShadow"] = BoxShadows.Parse(dark ? "0 1 4 0 #40000000" : "0 1 4 0 #120F2119");
        resources["BrandLogo"] = Logo(dark);
    }
}
