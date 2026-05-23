import os
import zipfile
import argparse
from datetime import datetime

TARGET_FILE_NAME = "icon.svg"


def find_icon_files(start_dir: str) -> list[str]:
    found_files = []

    for root, _, files in os.walk(start_dir):
        if TARGET_FILE_NAME not in files:
            continue

        full_path = os.path.join(root, TARGET_FILE_NAME)
        found_files.append(full_path)

    return found_files


def create_zip(files: list[str], output_path: str, start_dir: str) -> None:
    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zip_file:
        for file_path in files:
            relative_path = os.path.relpath(file_path, start_dir)
            zip_file.write(file_path, relative_path)


def main() -> None:
    current_date = datetime.now().strftime("%Y-%m-%d")
    default_output = f"icons_{current_date}.zip"

    parser = argparse.ArgumentParser(description="Zip all icon.svg files with relative paths.")
    parser.add_argument(
        "--dir",
        default=".",
        help="Directory to start searching for icon.svg files"
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output zip file path (default: icons_YYYY-MM-DD.zip)"
    )
    args = parser.parse_args()

    start_directory = os.path.abspath(args.dir)
    output_filename = args.output if args.output is not None else default_output
    output_path = os.path.abspath(output_filename)

    # Automatically increment suffix if target file already exists to avoid overwriting
    if os.path.exists(output_path):
        base, ext = os.path.splitext(output_path)
        counter = 1

        while os.path.exists(output_path):
            output_path = f"{base}_{counter}{ext}"
            counter += 1

    icon_files = find_icon_files(start_directory)

    if not icon_files:
        print("No icon.svg files found.")
        return

    create_zip(icon_files, output_path, start_directory)
    print(f"Successfully zipped {len(icon_files)} files into {os.path.basename(output_path)}")


if __name__ == "__main__":
    main()
