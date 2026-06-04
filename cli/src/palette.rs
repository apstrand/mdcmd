use ratatui::style::Color;

#[derive(Clone, Copy, Debug)]
pub struct Palette {
    pub border_active: Color,
    pub border_inactive: Color,
    pub text_primary: Color,
    pub text_secondary: Color,
    pub text_dimmed: Color,
    pub accent: Color,
    pub accent_soft: Color,
    pub open_bg: Color,
    pub code: Color,
    pub code_bg: Color,
}

impl Palette {
    pub fn detect() -> Self {
        if is_light_mode() {
            // Light Mode Palette
            Self {
                border_active: Color::Rgb(37, 99, 235),      // Vibrant blue
                border_inactive: Color::Rgb(203, 213, 225),  // Light slate border
                text_primary: Color::Rgb(15, 23, 42),        // Dark slate text
                text_secondary: Color::Rgb(100, 116, 139),   // Muted slate text
                text_dimmed: Color::Rgb(156, 163, 175),      // Gray-400 for unselectable files
                accent: Color::Rgb(37, 99, 235),             // Vibrant blue accent
                accent_soft: Color::Rgb(219, 234, 254),      // Light blue highlight background
                open_bg: Color::Rgb(239, 246, 255),          // Lightest blue tint
                code: Color::Rgb(180, 83, 9),                // Amber/brown code text
                code_bg: Color::Rgb(241, 245, 249),          // Soft gray code background
            }
        } else {
            // Dark Mode Palette
            Self {
                border_active: Color::Rgb(59, 130, 246),
                border_inactive: Color::Rgb(30, 41, 59),
                text_primary: Color::Rgb(240, 243, 248),
                text_secondary: Color::Rgb(148, 161, 178),
                text_dimmed: Color::Rgb(71, 85, 105),        // slate-600
                accent: Color::Rgb(59, 130, 246),
                accent_soft: Color::Rgb(30, 58, 138),
                open_bg: Color::Rgb(15, 32, 66),
                code: Color::Rgb(251, 191, 36),
                code_bg: Color::Rgb(30, 41, 59),
            }
        }
    }
}

pub fn is_light_mode() -> bool {
    if std::env::var("WORKBENCH_LIGHT_MODE").is_ok() {
        return true;
    }
    if std::env::var("WORKBENCH_DARK_MODE").is_ok() {
        return false;
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
