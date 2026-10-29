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
        var glass = PopupVisualStyleCatalog.IsBubbleV3(settings.PopupVisualStyle);
        // High-opacity reading surfaces avoid desktop text showing through the translation.
        resources["PopupBackgroundBrush"] = ReferenceMaterial.Gradient(0, 0, 0, 1,
            (dark ? "#FC292C2B" : "#FCFFFFFF", 0), (dark ? "#FA202222" : "#FAF7F8F7", 1));
        Color("PopupButtonBrush", "#FCF7F8F7", "#FC292C2B");
        Color("PopupBorderBrush", "#D4DAD7", "#515956");
        Color("PopupButtonBorderBrush", "#DDE2DF", "#49514E");
        Color("PopupButtonHoverBrush", "#EAEFEC", "#39413D");
        Color("PopupTextBrush", "#242727", "#E5E9EC");
        Color("PopupMutedBrush", "#626867", "#AAB5BD");
        Color("QuestionInputBrush", "#EFF2F0", "#191C1B");
        Color("ExplanationSurfaceBrush", "#FAFBFA", "#232625");
        Color("QuestionAnswerSurfaceBrush", "#FAFBFA", "#232625");
        Color("ExplanationHeaderBrush", "#F1F3F2", "#292D2B");
        Color("QuestionAnswerHeaderBrush", "#F1F3F2", "#292D2B");
        resources["PopupTailBrush"] = resources["PopupBackgroundBrush"];
        resources["PopupGlassEnabled"] = false; // Replace the thick reflective rim with a single fine edge.
        resources["PopupTextSurfaceBrush"] = Brushes.Transparent;
        resources["PopupTextSurfacePadding"] = new Thickness(0);
        resources["PopupSurfaceCornerRadius"] = new CornerRadius(glass ? 20 : 16);
        resources["PopupActionBarCornerRadius"] = new CornerRadius(12);
        resources["PopupButtonCornerRadius"] = new CornerRadius(6);
        resources["InputCornerRadius"] = new CornerRadius(9);
        resources["SettingsCardCornerRadius"] = new CornerRadius(10);
        resources["SettingsCardBorderThickness"] = new Thickness(1);
        resources["PopupEdgeThickness"] = new Thickness(1);
        resources["PopupRootMargin"] = new Thickness(12);
        resources["ConversationMargin"] = new Thickness(12);
        resources["PopupSurfaceShadow"] = BoxShadows.Parse(dark ? "0 5 12 0 #55000000" : "0 5 12 0 #180F2119");
        resources["PopupToolbarShadow"] = BoxShadows.Parse(dark ? "0 2 6 0 #44000000" : "0 2 6 0 #140F2119");
        resources["BrandLogo"] = Logo(dark);
    }
}
