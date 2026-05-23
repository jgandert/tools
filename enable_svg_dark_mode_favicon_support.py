import os
import re

TARGET_FILE_NAME = "icon.svg"

STYLE_BLOCK = """
  <style id="dark-mode-inversion-style">
    @media (prefers-color-scheme: dark) {
      path, rect, circle, polygon, ellipse, line, polyline {
        filter: invert(100%) hue-rotate(180deg) !important;
      }
    }
  </style>"""


def find_svg_files(start_dir: str) -> list[str]:
    svg_files = []

    for root, _, files in os.walk(start_dir):
        if TARGET_FILE_NAME not in files:
            continue

        full_path = os.path.join(root, TARGET_FILE_NAME)
        svg_files.append(full_path)

    return svg_files


def patch_svg_file(file_path: str) -> bool:
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
    except IOError as e:
        print(f"Error reading {file_path}: {e}")
        return False

    cleaned_content = re.sub(
        r"\s*<style id=\"dark-mode-favicon-style\">.*?</style>",
        "",
        content,
        flags=re.DOTALL | re.IGNORECASE
    )

    cleaned_content = re.sub(
        r"\s*<style id=\"dark-mode-inversion-style\">.*?</style>",
        "",
        cleaned_content,
        flags=re.DOTALL | re.IGNORECASE
    )

    match = re.search(r"<svg[^>]*>", cleaned_content, re.IGNORECASE)

    if not match:
        print(f"No valid <svg> root tag found in {file_path}. Skipping.")
        return False

    svg_tag_end = match.end()
    new_content = cleaned_content[:svg_tag_end] + STYLE_BLOCK + cleaned_content[svg_tag_end:]

    if new_content == content:
        return False

    try:
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(new_content)
    except IOError as e:
        print(f"Error writing to {file_path}: {e}")
        return False

    return True


def main() -> None:
    current_directory = os.path.abspath(".")
    svg_paths = find_svg_files(current_directory)
    patched_svgs_count = 0

    for svg_path in svg_paths:
        if patch_svg_file(svg_path):
            patched_svgs_count += 1

    print(f"Patched {patched_svgs_count} SVG files with geometry-level dark mode inversion.")


if __name__ == "__main__":
    main()
