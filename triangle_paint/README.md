# Triangular Grid Tool

A lightweight, web-based tool for creating hexagonal/isometric vector art.

## Features

### 🖌️ Drawing & Tools

* **3 Modes:**
    * **✏️ Draw (`D`):** Paint individual triangles.
    * **🪣 Fill (`F`):** Flood fill connected areas.
    * **✋ Scroll (`S`):** Pan the canvas (mouse drag or touch).
* **Paint Types:**
    * **Color:** Use the picker or the history palette.
    * **🧼 Eraser (`1`):** A toggle to paint with transparency.
* **Shortcuts:**
    * `1`: Eraser | `2`, `3`, `4`: Recent Colors.
    * `D`: Draw | `F`: Fill | `S`: Scroll.

### 📐 Grid & Navigation

* **Zoom:** Slider to scale triangle size.
* **Resize:** Dynamic columns and rows.
* **Math:** 6 triangles form a perfect hexagon.

### 💾 History & Files

* **Undo/Redo:** `Ctrl+Z` / `Ctrl+Y`.
* **Storage:** Auto-saves to browser local storage.
* **Files:**
    * `Ctrl+S`: Save SVG (Compressed data embedded).
    * `Ctrl+O`: Load SVG.
* **Vector Output:** Adjacent faces merge into single paths; holes are preserved.