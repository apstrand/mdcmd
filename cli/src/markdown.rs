use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};

/// A standalone `![alt](src)` image reference found in the source. `line` is
/// the index into the returned `Text` where a one-line placeholder for it
/// was inserted (the caller splices in extra reserved rows and overlays the
/// decoded image once it knows the terminal's cell geometry).
#[derive(Clone, Debug)]
pub struct ImageRef {
    pub line: usize,
    pub alt: String,
    pub src: String,
}

pub struct ParsedMarkdown {
    pub text: Text<'static>,
    pub images: Vec<ImageRef>,
    /// Parallel to `text.lines`: the 0-indexed source line each rendered
    /// line came from, so a rendered row can be mapped back to a raw file
    /// line (e.g. to tell an external editor where to open).
    pub line_map: Vec<usize>,
}

pub fn parse_markdown(content: &str, palette: &crate::palette::Palette) -> ParsedMarkdown {
    let mut lines = Vec::new();
    let mut images = Vec::new();
    let mut line_map = Vec::new();
    let mut in_code_block = false;

    let primary_text_color = palette.text_primary;
    let secondary_text_color = palette.text_secondary;
    let accent_color = palette.accent;
    let code_color = palette.code;
    let border_color = palette.border_inactive;

    macro_rules! push_line {
        ($source_idx:expr, $line:expr) => {
            lines.push($line);
            line_map.push($source_idx);
        };
    }

    for (source_idx, raw_line) in content.lines().enumerate() {
        let trimmed = raw_line.trim();

        // 1. Code Block Toggle
        if trimmed.starts_with("```") {
            in_code_block = !in_code_block;
            push_line!(source_idx, Line::from(vec![
                Span::styled(raw_line.to_string(), Style::default().fg(palette.text_muted))
            ]));
            continue;
        }

        if in_code_block {
            push_line!(source_idx, Line::from(vec![
                Span::styled(raw_line.to_string(), Style::default().fg(code_color))
            ]));
            continue;
        }

        // 2. Standalone images: `![alt](src)`, optionally with a `"title"`
        // after the URL. Only recognized when the whole line is the image
        // reference (the common block-level usage) — an actual bitmap can't
        // sensibly flow inside a sentence in a wrapped text pane.
        if let Some(img) = parse_image_line(trimmed) {
            let placeholder = if img.alt.is_empty() { img.src.clone() } else { img.alt.clone() };
            let line_idx = lines.len();
            push_line!(source_idx, Line::from(vec![
                Span::styled(format!("🖼  {}", placeholder), Style::default().fg(secondary_text_color).add_modifier(Modifier::ITALIC))
            ]));
            images.push(ImageRef { line: line_idx, alt: img.alt, src: img.src });
            continue;
        }

        // 3. Headers
        if trimmed.starts_with("# ") {
            let title = &trimmed[2..];
            push_line!(source_idx, Line::from(vec![
                Span::styled("# ", Style::default().fg(accent_color).add_modifier(Modifier::BOLD)),
                Span::styled(title.to_string(), Style::default().fg(primary_text_color).add_modifier(Modifier::BOLD)),
            ]));
            push_line!(source_idx, Line::from(vec![
                Span::styled("─".repeat(title.len() + 2), Style::default().fg(border_color))
            ]));
            continue;
        } else if trimmed.starts_with("## ") {
            push_line!(source_idx, Line::from(vec![
                Span::styled("## ", Style::default().fg(palette.heading2).add_modifier(Modifier::BOLD)),
                Span::styled((&trimmed[3..]).to_string(), Style::default().fg(primary_text_color).add_modifier(Modifier::BOLD)),
            ]));
            continue;
        } else if trimmed.starts_with("### ") {
            push_line!(source_idx, Line::from(vec![
                Span::styled("### ", Style::default().fg(palette.heading3).add_modifier(Modifier::BOLD)),
                Span::styled((&trimmed[4..]).to_string(), Style::default().fg(primary_text_color).add_modifier(Modifier::BOLD)),
            ]));
            continue;
        } else if trimmed.starts_with("#### ") {
            push_line!(source_idx, Line::from(vec![
                Span::styled("#### ", Style::default().fg(palette.heading4).add_modifier(Modifier::BOLD)),
                Span::styled((&trimmed[5..]).to_string(), Style::default().fg(primary_text_color).add_modifier(Modifier::BOLD)),
            ]));
            continue;
        }

        // 4. Blockquotes
        if trimmed.starts_with(">") {
            let quote_text = if trimmed.len() > 1 {
                if trimmed.as_bytes()[1] == b' ' {
                    &trimmed[2..]
                } else {
                    &trimmed[1..]
                }
            } else {
                ""
            };
            push_line!(source_idx, Line::from(vec![
                Span::styled("│ ", Style::default().fg(accent_color).add_modifier(Modifier::BOLD)),
                Span::styled(quote_text.to_string(), Style::default().fg(secondary_text_color).add_modifier(Modifier::ITALIC)),
            ]));
            continue;
        }

        // 5. Tasks and standard lists
        if trimmed.starts_with("- [ ] ") || trimmed.starts_with("* [ ] ") {
            let text = &trimmed[6..];
            push_line!(source_idx, Line::from(vec![
                Span::styled("☐ ", Style::default().fg(accent_color)),
                Span::styled(text.to_string(), Style::default().fg(primary_text_color)),
            ]));
            continue;
        } else if trimmed.starts_with("- [x] ") || trimmed.starts_with("* [x] ") {
            let text = &trimmed[6..];
            push_line!(source_idx, Line::from(vec![
                Span::styled("☑ ", Style::default().fg(secondary_text_color)),
                Span::styled(text.to_string(), Style::default().fg(secondary_text_color).add_modifier(Modifier::CROSSED_OUT)),
            ]));
            continue;
        } else if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
            let text = &trimmed[2..];
            push_line!(source_idx, Line::from(vec![
                Span::styled("• ", Style::default().fg(accent_color)),
                Span::styled(text.to_string(), Style::default().fg(primary_text_color)),
            ]));
            continue;
        }

        // 6. Standard line
        let spans = parse_inline(raw_line, primary_text_color, code_color, palette.code_bg);
        push_line!(source_idx, Line::from(spans));
    }

    ParsedMarkdown { text: Text::from(lines), images, line_map }
}

struct InlineImageSyntax {
    alt: String,
    src: String,
}

/// Recognizes a line that consists entirely of `![alt](src)`, optionally
/// followed by a `"title"` inside the parens (e.g. `![alt](src "title")`).
/// Returns `None` for anything else, including images embedded mid-sentence.
fn parse_image_line(trimmed: &str) -> Option<InlineImageSyntax> {
    if !trimmed.starts_with("![") {
        return None;
    }
    let close_bracket = trimmed.find("](")?;
    let alt = trimmed[2..close_bracket].to_string();
    let rest = &trimmed[close_bracket + 2..];
    let close_paren = rest.find(')')?;
    // Tolerate a trailing Pandoc/Quarto attribute block, e.g.
    // `![alt](src){fig-alt="..." width="50%"}` — we don't parse the
    // attributes, just don't let their presence disqualify the image.
    let trailing = rest[close_paren + 1..].trim();
    if !trailing.is_empty() && !(trailing.starts_with('{') && trailing.ends_with('}')) {
        return None;
    }
    let inner = rest[..close_paren].trim();
    let src = match inner.find(" \"") {
        Some(space_idx) if inner.ends_with('"') => &inner[..space_idx],
        _ => inner,
    };
    if src.is_empty() {
        return None;
    }
    Some(InlineImageSyntax { alt, src: src.trim().to_string() })
}

fn parse_inline(line: &str, text_color: Color, code_color: Color, code_bg_color: Color) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    let mut current_idx = 0;

    while current_idx < line.len() {
        let next_tick = line[current_idx..].find('`');
        let next_bold = line[current_idx..].find("**");

        match (next_tick, next_bold) {
            (Some(tick_idx), Some(bold_idx)) if tick_idx < bold_idx => {
                // Inline code is first
                let real_tick_idx = current_idx + tick_idx;
                if real_tick_idx > current_idx {
                    spans.push(Span::styled(line[current_idx..real_tick_idx].to_string(), Style::default().fg(text_color)));
                }
                if let Some(close_idx) = line[real_tick_idx + 1..].find('`') {
                    let real_close_idx = real_tick_idx + 1 + close_idx;
                    let code_text = &line[real_tick_idx + 1..real_close_idx];
                    spans.push(Span::styled(
                        format!(" {} ", code_text),
                        Style::default().fg(code_color).bg(code_bg_color)
                    ));
                    current_idx = real_close_idx + 1;
                } else {
                    spans.push(Span::styled(line[real_tick_idx..real_tick_idx + 1].to_string(), Style::default().fg(text_color)));
                    current_idx = real_tick_idx + 1;
                }
            }
            (_, Some(bold_idx)) => {
                // Bold is first
                let real_bold_idx = current_idx + bold_idx;
                if real_bold_idx > current_idx {
                    spans.push(Span::styled(line[current_idx..real_bold_idx].to_string(), Style::default().fg(text_color)));
                }
                if let Some(close_idx) = line[real_bold_idx + 2..].find("**") {
                    let real_close_idx = real_bold_idx + 2 + close_idx;
                    let bold_text = &line[real_bold_idx + 2..real_close_idx];
                    spans.push(Span::styled(
                        bold_text.to_string(),
                        Style::default().fg(text_color).add_modifier(Modifier::BOLD)
                    ));
                    current_idx = real_close_idx + 2;
                } else {
                    spans.push(Span::styled(line[real_bold_idx..real_bold_idx + 2].to_string(), Style::default().fg(text_color)));
                    current_idx = real_bold_idx + 2;
                }
            }
            (Some(tick_idx), None) => {
                // Inline code is first
                let real_tick_idx = current_idx + tick_idx;
                if real_tick_idx > current_idx {
                    spans.push(Span::styled(line[current_idx..real_tick_idx].to_string(), Style::default().fg(text_color)));
                }
                if let Some(close_idx) = line[real_tick_idx + 1..].find('`') {
                    let real_close_idx = real_tick_idx + 1 + close_idx;
                    let code_text = &line[real_tick_idx + 1..real_close_idx];
                    spans.push(Span::styled(
                        format!(" {} ", code_text),
                        Style::default().fg(code_color).bg(code_bg_color)
                    ));
                    current_idx = real_close_idx + 1;
                } else {
                    spans.push(Span::styled(line[real_tick_idx..real_tick_idx + 1].to_string(), Style::default().fg(text_color)));
                    current_idx = real_tick_idx + 1;
                }
            }
            (None, None) => {
                spans.push(Span::styled(line[current_idx..].to_string(), Style::default().fg(text_color)));
                break;
            }
        }
    }
    spans
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get_mock_palette() -> crate::palette::Palette {
        crate::palette::Palette {
            bg: Color::Black,
            border_active: Color::Blue,
            border_inactive: Color::Gray,
            text_primary: Color::White,
            text_secondary: Color::Gray,
            text_muted: Color::Gray,
            text_dimmed: Color::DarkGray,
            accent: Color::Blue,
            accent_soft: Color::DarkGray,
            open_bg: Color::Black,
            code: Color::Yellow,
            code_bg: Color::Black,
            heading2: Color::Blue,
            heading3: Color::Blue,
            heading4: Color::Blue,
        }
    }

    #[test]
    fn test_headers() {
        let content = "# My Heading\nSome text";
        let palette = get_mock_palette();
        let parsed = parse_markdown(content, &palette);
        assert_eq!(parsed.text.lines.len(), 3); // Heading line, line separator, text line
        assert_eq!(parsed.line_map, vec![0, 0, 1]);
    }

    #[test]
    fn test_lists_and_tasks() {
        let content = "- [ ] Unfinished task\n- [x] Finished task\n- Normal item";
        let palette = get_mock_palette();
        let parsed = parse_markdown(content, &palette);
        assert_eq!(parsed.text.lines.len(), 3);

        assert!(parsed.text.lines[0].to_string().contains("☐"));
        assert!(parsed.text.lines[1].to_string().contains("☑"));
        assert!(parsed.text.lines[2].to_string().contains("•"));
    }

    #[test]
    fn test_inline_formatting() {
        let spans = parse_inline("Normal text with `code` and **bold**", Color::White, Color::Yellow, Color::Black);
        assert_eq!(spans.len(), 4);
        assert_eq!(spans[0].content, "Normal text with ");
        assert_eq!(spans[1].content, " code ");
        assert_eq!(spans[2].content, " and ");
        assert_eq!(spans[3].content, "bold");
    }

    #[test]
    fn test_standalone_image() {
        let content = "Intro\n![A cat](images/cat.png)\nOutro";
        let palette = get_mock_palette();
        let parsed = parse_markdown(content, &palette);
        assert_eq!(parsed.text.lines.len(), 3);
        assert_eq!(parsed.images.len(), 1);
        assert_eq!(parsed.images[0].line, 1);
        assert_eq!(parsed.images[0].alt, "A cat");
        assert_eq!(parsed.images[0].src, "images/cat.png");
        assert!(parsed.text.lines[1].to_string().contains("A cat"));
    }

    #[test]
    fn test_image_with_title_and_no_alt() {
        let content = r#"![](pic.jpg "My title")"#;
        let palette = get_mock_palette();
        let parsed = parse_markdown(content, &palette);
        assert_eq!(parsed.images.len(), 1);
        assert_eq!(parsed.images[0].alt, "");
        assert_eq!(parsed.images[0].src, "pic.jpg");
    }

    #[test]
    fn test_image_with_quarto_attribute_block() {
        let content = r#"![First assembly.](images/IMG_0051.jpeg){fig-alt="First assembly."}"#;
        let palette = get_mock_palette();
        let parsed = parse_markdown(content, &palette);
        assert_eq!(parsed.images.len(), 1);
        assert_eq!(parsed.images[0].alt, "First assembly.");
        assert_eq!(parsed.images[0].src, "images/IMG_0051.jpeg");
    }

    #[test]
    fn test_image_inside_code_block_is_not_parsed() {
        let content = "```\n![alt](pic.png)\n```";
        let palette = get_mock_palette();
        let parsed = parse_markdown(content, &palette);
        assert!(parsed.images.is_empty());
    }
}
