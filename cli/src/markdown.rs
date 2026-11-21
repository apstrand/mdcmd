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

/// An inline `[text](url)` link found in the source. `line` is the index
/// into the returned `Text` of the (pre-wrap) line it appears on, and
/// `span` is the index of its `Span` within that line's `Line::spans` — the
/// caller locates its actual on-screen cells after layout to make it
/// clickable via an OSC 8 terminal hyperlink, and can also target `span`
/// directly to swap the rendered text for the full `[text](url)` source
/// (e.g. in a "show everything" fullscreen mode).
#[derive(Clone, Debug)]
pub struct LinkRef {
    pub line: usize,
    pub span: usize,
    pub text: String,
    pub url: String,
}

pub struct ParsedMarkdown {
    pub text: Text<'static>,
    pub images: Vec<ImageRef>,
    pub links: Vec<LinkRef>,
    /// Parallel to `text.lines`: the 0-indexed source line each rendered
    /// line came from, so a rendered row can be mapped back to a raw file
    /// line (e.g. to tell an external editor where to open).
    pub line_map: Vec<usize>,
}

pub fn parse_markdown(content: &str, palette: &crate::palette::Palette) -> ParsedMarkdown {
    let mut lines = Vec::new();
    let mut images = Vec::new();
    let mut links = Vec::new();
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

    let source_lines: Vec<&str> = content.lines().collect();
    // A multi-line construct (a table) consumes the source lines up to here.
    let mut resume_at = 0;

    for (source_idx, &raw_line) in source_lines.iter().enumerate() {
        if source_idx < resume_at {
            continue;
        }
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

        // 1b. GFM pipe tables
        if let Some(table) = parse_table(&source_lines, source_idx) {
            let rendered = render_table(&table, palette);
            for (line, source, line_links) in rendered {
                let line_idx = lines.len();
                for (span, text, url) in line_links {
                    links.push(LinkRef { line: line_idx, span, text, url });
                }
                push_line!(source, line);
            }
            resume_at = table.end;
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
        let mut line_links = Vec::new();
        let spans = parse_inline(raw_line, primary_text_color, code_color, palette.code_bg, accent_color, &mut line_links);
        let line_idx = lines.len();
        for (span, text, url) in line_links {
            links.push(LinkRef { line: line_idx, span, text, url });
        }
        push_line!(source_idx, Line::from(spans));
    }

    ParsedMarkdown { text: Text::from(lines), images, links, line_map }
}

/// Column alignment from a GFM delimiter row (`:--`, `:-:`, `--:`).
#[derive(Clone, Copy, Debug, PartialEq)]
enum Align {
    Default,
    Left,
    Center,
    Right,
}

/// A GFM pipe table found in the source: a header row, a delimiter row, then
/// body rows up to the first blank line or other block. Cell text is
/// still raw inline markdown.
#[derive(Debug)]
struct TableBlock {
    /// Source line index of the header row.
    start: usize,
    /// One past the source line index of the last body row.
    end: usize,
    aligns: Vec<Align>,
    header: Vec<String>,
    /// Padded or truncated to the header's column count, as GFM does.
    rows: Vec<Vec<String>>,
}

/// Splits a table row into trimmed cells on unescaped `|` (GFM splits even
/// inside code spans; `\|` is how a cell holds a literal pipe). The optional
/// leading and trailing pipes don't start or end extra cells.
fn split_table_row(line: &str) -> Vec<String> {
    let mut cells = Vec::new();
    let mut current = String::new();
    let mut chars = line.trim().chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars.peek() == Some(&'|') => {
                current.push('|');
                chars.next();
            }
            '|' => cells.push(std::mem::take(&mut current)),
            _ => current.push(c),
        }
    }
    cells.push(current);
    let trimmed = line.trim();
    if trimmed.starts_with('|') {
        cells.remove(0);
    }
    if trimmed.len() > 1 && trimmed.ends_with('|') && !trimmed.ends_with("\\|") {
        cells.pop();
    }
    cells.into_iter().map(|cell| cell.trim().to_string()).collect()
}

fn parse_delimiter_row(line: &str) -> Option<Vec<Align>> {
    // A delimiter row needs a pipe; a bare `---` is a rule or a setext heading.
    if !line.contains('|') {
        return None;
    }
    split_table_row(line)
        .iter()
        .map(|cell| {
            let left = cell.starts_with(':');
            let right = cell.ends_with(':');
            let dashes = cell.trim_start_matches(':').trim_end_matches(':');
            if dashes.is_empty() || !dashes.chars().all(|c| c == '-') {
                return None;
            }
            Some(match (left, right) {
                (true, true) => Align::Center,
                (true, false) => Align::Left,
                (false, true) => Align::Right,
                (false, false) => Align::Default,
            })
        })
        .collect()
}

/// Recognizes a table whose header row is `lines[start]`.
fn parse_table(lines: &[&str], start: usize) -> Option<TableBlock> {
    let header_line = lines[start];
    if !header_line.contains('|') || header_line.starts_with("    ") || header_line.starts_with('\t') {
        return None;
    }
    let delimiter_line = lines.get(start + 1)?;
    let aligns = parse_delimiter_row(delimiter_line)?;
    let header = split_table_row(header_line);
    if header.len() != aligns.len() {
        return None;
    }

    let mut rows = Vec::new();
    let mut end = start + 2;
    while let Some(line) = lines.get(end) {
        // As in GFM, a line without a pipe is still a (one-cell) row; the
        // table ends at a blank line or where another kind of block begins.
        let trimmed = line.trim();
        if trimmed.is_empty() || ["#", ">", "```"].iter().any(|p| trimmed.starts_with(p)) {
            break;
        }
        let mut cells = split_table_row(line);
        cells.resize(header.len(), String::new());
        rows.push(cells);
        end += 1;
    }
    Some(TableBlock { start, end, aligns, header, rows })
}

/// Links found in inline text, as `(span index, text, url)`.
type InlineLinks = Vec<(usize, String, String)>;

/// One rendered cell: its spans and the links among them.
type RenderedCell = (Vec<Span<'static>>, InlineLinks);

/// One rendered line: its spans, the source line it maps to, and its links.
type TableLine = (Line<'static>, usize, InlineLinks);

/// Draws the table with box-drawing borders, each column as wide as its
/// widest cell. Cells keep their inline formatting (code, bold, links).
fn render_table(table: &TableBlock, palette: &crate::palette::Palette) -> Vec<TableLine> {
    let border = Style::default().fg(palette.border_inactive);
    let render_cells = |cells: &[String], bold: bool| -> Vec<RenderedCell> {
        cells
            .iter()
            .map(|cell| {
                let mut cell_links = Vec::new();
                let mut spans = if cell.is_empty() {
                    Vec::new()
                } else {
                    parse_inline(cell, palette.text_primary, palette.code, palette.code_bg, palette.accent, &mut cell_links)
                };
                if bold {
                    for span in &mut spans {
                        span.style = span.style.add_modifier(Modifier::BOLD);
                    }
                }
                (spans, cell_links)
            })
            .collect()
    };

    let header = render_cells(&table.header, true);
    let rows: Vec<_> = table.rows.iter().map(|row| render_cells(row, false)).collect();
    let cell_width = |spans: &[Span<'static>]| spans.iter().map(|s| s.width()).sum::<usize>();
    let widths: Vec<usize> = (0..table.aligns.len())
        .map(|column| {
            std::iter::once(&header)
                .chain(rows.iter())
                .map(|row| cell_width(&row[column].0))
                .max()
                .unwrap_or(0)
                .max(1)
        })
        .collect();

    let rule = |left: &str, mid: &str, right: &str| -> Line<'static> {
        let segments: Vec<String> = widths.iter().map(|w| "─".repeat(w + 2)).collect();
        Line::from(Span::styled(format!("{left}{}{right}", segments.join(mid)), border))
    };

    let row_line = |cells: &[RenderedCell]| {
        let mut spans: Vec<Span<'static>> = Vec::new();
        let mut line_links = Vec::new();
        for (column, (cell_spans, cell_links)) in cells.iter().enumerate() {
            spans.push(Span::styled(if column == 0 { "│ " } else { " │ " }, border));
            let space = widths[column] - cell_width(cell_spans);
            let (before, after) = match table.aligns[column] {
                Align::Right => (space, 0),
                Align::Center => (space / 2, space - space / 2),
                _ => (0, space),
            };
            if before > 0 {
                spans.push(Span::raw(" ".repeat(before)));
            }
            for (span, text, url) in cell_links {
                line_links.push((spans.len() + span, text.clone(), url.clone()));
            }
            spans.extend(cell_spans.iter().cloned());
            if after > 0 {
                spans.push(Span::raw(" ".repeat(after)));
            }
        }
        spans.push(Span::styled(" │", border));
        (Line::from(spans), line_links)
    };

    let delimiter_source = table.start + 1;
    let last_source = table.end - 1;
    let mut out: Vec<TableLine> = Vec::new();
    out.push((rule("┌", "┬", "┐"), table.start, Vec::new()));
    let (line, line_links) = row_line(&header);
    out.push((line, table.start, line_links));
    out.push((rule("├", "┼", "┤"), delimiter_source, Vec::new()));
    for (index, row) in rows.iter().enumerate() {
        let (line, line_links) = row_line(row);
        out.push((line, table.start + 2 + index, line_links));
    }
    out.push((rule("└", "┴", "┘"), last_source, Vec::new()));
    out
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

fn parse_inline(
    line: &str,
    text_color: Color,
    code_color: Color,
    code_bg_color: Color,
    link_color: Color,
    links_out: &mut Vec<(usize, String, String)>,
) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    let mut current_idx = 0;

    // `` ` ``, `**`, and `[` are distinct leading characters, so whichever
    // marker's absolute index is smallest unambiguously comes first — no
    // tie-breaking needed between them.
    while current_idx < line.len() {
        let next_tick = line[current_idx..].find('`').map(|i| current_idx + i);
        let next_bold = line[current_idx..].find("**").map(|i| current_idx + i);
        let next_link = line[current_idx..].find('[').map(|i| current_idx + i);

        let earliest = [next_tick.map(|i| (i, 0u8)), next_bold.map(|i| (i, 1u8)), next_link.map(|i| (i, 2u8))]
            .into_iter()
            .flatten()
            .min_by_key(|(i, _)| *i);

        match earliest {
            None => {
                spans.push(Span::styled(line[current_idx..].to_string(), Style::default().fg(text_color)));
                break;
            }
            Some((idx, 0)) => {
                // Inline code
                if idx > current_idx {
                    spans.push(Span::styled(line[current_idx..idx].to_string(), Style::default().fg(text_color)));
                }
                if let Some(close_idx) = line[idx + 1..].find('`') {
                    let real_close_idx = idx + 1 + close_idx;
                    let code_text = &line[idx + 1..real_close_idx];
                    spans.push(Span::styled(
                        format!(" {} ", code_text),
                        Style::default().fg(code_color).bg(code_bg_color)
                    ));
                    current_idx = real_close_idx + 1;
                } else {
                    spans.push(Span::styled(line[idx..idx + 1].to_string(), Style::default().fg(text_color)));
                    current_idx = idx + 1;
                }
            }
            Some((idx, 1)) => {
                // Bold
                if idx > current_idx {
                    spans.push(Span::styled(line[current_idx..idx].to_string(), Style::default().fg(text_color)));
                }
                if let Some(close_idx) = line[idx + 2..].find("**") {
                    let real_close_idx = idx + 2 + close_idx;
                    let bold_text = &line[idx + 2..real_close_idx];
                    spans.push(Span::styled(
                        bold_text.to_string(),
                        Style::default().fg(text_color).add_modifier(Modifier::BOLD)
                    ));
                    current_idx = real_close_idx + 2;
                } else {
                    spans.push(Span::styled(line[idx..idx + 2].to_string(), Style::default().fg(text_color)));
                    current_idx = idx + 2;
                }
            }
            Some((idx, _)) => {
                // `[text](url)`, optionally with a `"title"` after the URL.
                if let Some((link_text, url, consumed)) = parse_inline_link(&line[idx..]) {
                    if idx > current_idx {
                        spans.push(Span::styled(line[current_idx..idx].to_string(), Style::default().fg(text_color)));
                    }
                    let span_idx = spans.len();
                    spans.push(Span::styled(
                        link_text.clone(),
                        Style::default().fg(link_color).add_modifier(Modifier::UNDERLINED)
                    ));
                    links_out.push((span_idx, link_text, url));
                    current_idx = idx + consumed;
                } else {
                    // Not valid link syntax — treat the `[` as literal text
                    // and keep scanning from just past it.
                    spans.push(Span::styled(line[current_idx..idx + 1].to_string(), Style::default().fg(text_color)));
                    current_idx = idx + 1;
                }
            }
        }
    }
    spans
}

/// Parses a `[text](url)` link starting at the beginning of `s` (which must
/// start with `[`). Tolerates a trailing `"title"` inside the parens, like
/// `parse_image_line`. Returns the link text, the URL, and the number of
/// bytes of `s` the whole `[text](url)` syntax consumed, or `None` if `s`
/// doesn't start with valid link syntax (e.g. an unmatched `[`, or a `[...]`
/// not immediately followed by `(...)`).
fn parse_inline_link(s: &str) -> Option<(String, String, usize)> {
    let close_bracket = s.find(']')?;
    let text = &s[1..close_bracket];
    let rest = &s[close_bracket + 1..];
    if !rest.starts_with('(') {
        return None;
    }
    let after_paren = &rest[1..];
    let close_paren = after_paren.find(')')?;
    let inner = after_paren[..close_paren].trim();
    let url = match inner.find(" \"") {
        Some(space_idx) if inner.ends_with('"') => &inner[..space_idx],
        _ => inner,
    };
    let url = url.trim();
    if url.is_empty() || text.is_empty() {
        return None;
    }
    let consumed = close_bracket + close_paren + 3;
    Some((text.to_string(), url.to_string(), consumed))
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
        let mut links = Vec::new();
        let spans = parse_inline("Normal text with `code` and **bold**", Color::White, Color::Yellow, Color::Black, Color::Blue, &mut links);
        assert_eq!(spans.len(), 4);
        assert_eq!(spans[0].content, "Normal text with ");
        assert_eq!(spans[1].content, " code ");
        assert_eq!(spans[2].content, " and ");
        assert_eq!(spans[3].content, "bold");
        assert!(links.is_empty());
    }

    #[test]
    fn test_inline_link() {
        let mut links = Vec::new();
        let spans = parse_inline(
            "See [the docs](https://example.com/docs \"Docs\") for more.",
            Color::White, Color::Yellow, Color::Black, Color::Blue, &mut links,
        );
        assert_eq!(links, vec![(1, "the docs".to_string(), "https://example.com/docs".to_string())]);
        let link_span = spans.iter().find(|s| s.content == "the docs").expect("link span");
        assert!(link_span.style.add_modifier.contains(Modifier::UNDERLINED));
        assert_eq!(link_span.style.fg, Some(Color::Blue));
    }

    #[test]
    fn test_unmatched_bracket_is_literal() {
        let mut links = Vec::new();
        let spans = parse_inline("array[i] is fine", Color::White, Color::Yellow, Color::Black, Color::Blue, &mut links);
        assert!(links.is_empty());
        assert_eq!(spans.iter().map(|s| s.content.as_ref()).collect::<String>(), "array[i] is fine");
    }

    #[test]
    fn test_link_in_document() {
        let content = "Check the [README](README.md) for details.";
        let palette = get_mock_palette();
        let parsed = parse_markdown(content, &palette);
        assert_eq!(parsed.links.len(), 1);
        assert_eq!(parsed.links[0].line, 0);
        assert_eq!(parsed.links[0].span, 1);
        assert_eq!(parsed.links[0].text, "README");
        assert_eq!(parsed.links[0].url, "README.md");
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

    fn table_text(parsed: &ParsedMarkdown) -> Vec<String> {
        parsed.text.lines.iter().map(|l| l.to_string()).collect()
    }

    #[test]
    fn test_table_renders_with_borders_and_alignment() {
        let content = "Intro\n| Name | Qty | Price |\n|:-----|:---:|------:|\n| Apple | 3 | 1.50 |\n| Banana | 12 | 0.25 |\n\nOutro";
        let parsed = parse_markdown(content, &get_mock_palette());
        assert_eq!(
            table_text(&parsed),
            vec![
                "Intro",
                "┌────────┬─────┬───────┐",
                "│ Name   │ Qty │ Price │",
                "├────────┼─────┼───────┤",
                "│ Apple  │  3  │  1.50 │",
                "│ Banana │ 12  │  0.25 │",
                "└────────┴─────┴───────┘",
                "",
                "Outro",
            ]
        );
        assert_eq!(parsed.line_map, vec![0, 1, 1, 2, 3, 4, 4, 5, 6]);
        // Header cells are bold.
        let name = parsed.text.lines[2].spans.iter().find(|s| s.content == "Name").unwrap();
        assert!(name.style.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn test_table_without_outer_pipes_and_ragged_rows() {
        let content = "a | b\n--- | ---\n1\n| 1 | 2 | 3 |";
        let parsed = parse_markdown(content, &get_mock_palette());
        assert_eq!(
            table_text(&parsed),
            vec!["┌───┬───┐", "│ a │ b │", "├───┼───┤", "│ 1 │   │", "│ 1 │ 2 │", "└───┴───┘"]
        );
    }

    #[test]
    fn test_table_escaped_pipe_and_inline_formatting() {
        let content = "| Op | Note |\n|---|---|\n| `a\\|b` | see [docs](d.md) |";
        let parsed = parse_markdown(content, &get_mock_palette());
        assert_eq!(table_text(&parsed)[3], "│  a|b  │ see docs │");
        assert_eq!(parsed.links.len(), 1);
        let link = &parsed.links[0];
        assert_eq!(link.line, 3);
        assert_eq!(parsed.text.lines[3].spans[link.span].content, "docs");
        assert_eq!(link.url, "d.md");
    }

    #[test]
    fn test_pipe_lines_that_are_not_tables() {
        // No delimiter row; a bare `---` under a pipe line; inside a code block.
        for content in ["a | b\nc | d", "a | b\n---", "```\n| a |\n|---|\n```", "| a | b |\n|---|"] {
            let parsed = parse_markdown(content, &get_mock_palette());
            assert!(
                !table_text(&parsed).iter().any(|l| l.contains('┌')),
                "rendered a table for {content:?}"
            );
        }
    }
}
