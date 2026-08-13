use ratatui::style::Color;

#[derive(Clone, Copy, Debug)]
pub struct Palette {
    pub bg: Color,
    pub border_active: Color,
    pub border_inactive: Color,
    pub text_primary: Color,
    pub text_secondary: Color,
    pub text_muted: Color,
    pub text_dimmed: Color,
    pub accent: Color,
    pub accent_soft: Color,
    pub open_bg: Color,
    pub code: Color,
    pub code_bg: Color,
    pub heading2: Color,
    pub heading3: Color,
    pub heading4: Color,
}

impl Palette {
    /// `bg_rgb` is the terminal's background color as reported over OSC 11,
    /// if the caller already queried it (see [`is_light_mode`]).
    pub fn detect(bg_rgb: Option<(u8, u8, u8)>) -> Self {
        if is_light_mode(bg_rgb) {
            // Light Mode Palette
            Self {
                bg: Color::Rgb(255, 255, 255),
                border_active: Color::Rgb(37, 99, 235),      // Vibrant blue
                border_inactive: Color::Rgb(203, 213, 225),  // Light slate border
                text_primary: Color::Rgb(15, 23, 42),        // Dark slate text
                text_secondary: Color::Rgb(100, 116, 139),   // Muted slate text
                text_muted: Color::Rgb(71, 85, 105),         // Code-fence marker text
                text_dimmed: Color::Rgb(80, 100, 120),       // Unselectable files
                accent: Color::Rgb(37, 99, 235),             // Vibrant blue accent
                accent_soft: Color::Rgb(219, 234, 254),      // Light blue highlight background
                open_bg: Color::Rgb(239, 246, 255),          // Lightest blue tint
                code: Color::Rgb(180, 83, 9),                // Amber/brown code text
                code_bg: Color::Rgb(241, 245, 249),          // Soft gray code background
                heading2: Color::Rgb(37, 99, 235),
                heading3: Color::Rgb(29, 78, 216),
                heading4: Color::Rgb(30, 64, 175),
            }
        } else {
            // Dark Mode Palette
            Self {
                bg: Color::Rgb(15, 23, 42),
                border_active: Color::Rgb(59, 130, 246),
                border_inactive: Color::Rgb(30, 41, 59),
                text_primary: Color::Rgb(240, 243, 248),
                text_secondary: Color::Rgb(148, 161, 178),
                text_muted: Color::Rgb(100, 116, 139),
                text_dimmed: Color::Rgb(140, 150, 160),
                accent: Color::Rgb(59, 130, 246),
                accent_soft: Color::Rgb(30, 58, 138),
                open_bg: Color::Rgb(15, 32, 66),
                code: Color::Rgb(251, 191, 36),
                code_bg: Color::Rgb(30, 41, 59),
                heading2: Color::Rgb(96, 165, 250),
                heading3: Color::Rgb(147, 197, 253),
                heading4: Color::Rgb(191, 219, 254),
            }
        }
    }
}

/// Decide between the dark and light palette. Explicit env overrides win first
/// (useful for testing/CI); otherwise use the host terminal's real background
/// color, if the caller obtained one via an OSC 11 query, falling back to
/// heuristics for terminals that don't answer.
///
/// `bg_rgb` is threaded in rather than queried here so that it can share a
/// single stdio round-trip with the image-protocol capability query: issuing
/// two independent blind reads of stdin back to back is racy over high-latency
/// links like SSH, where a reply to the first query can arrive late and get
/// consumed by the second one's parser instead.
pub fn is_light_mode(bg_rgb: Option<(u8, u8, u8)>) -> bool {
    if std::env::var("MDCMD_LIGHT_MODE").is_ok() {
        return true;
    }
    if std::env::var("MDCMD_DARK_MODE").is_ok() {
        return false;
    }

    if let Some((r, g, b)) = bg_rgb {
        // ITU-R BT.601 luma, same weighting termbg used.
        let y = r as f64 * 0.299 + g as f64 * 0.587 + b as f64 * 0.114;
        return y > 128.0;
    }

    if let Ok(val) = std::env::var("COLORFGBG") {
        let parts: Vec<&str> = val.split(';').collect();
        if let Some(bg_str) = parts.last() {
            if let Ok(bg_num) = bg_str.parse::<u32>() {
                if bg_num == 7 || (bg_num >= 11 && bg_num <= 15) {
                    return true;
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("defaults")
            .args(&["read", "-g", "AppleInterfaceStyle"])
            .output();
        if let Ok(out) = output {
            let stdout = String::from_utf8_lossy(&out.stdout);
            return !stdout.contains("Dark");
        }
    }

    false
}
