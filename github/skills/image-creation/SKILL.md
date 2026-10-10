---
name: image-creation
description: "Use when creating, editing, converting, or validating application logos and icons, especially SVG/PNG pairs, SVG path placement, image rasterization, icon sizing, contrast, and packaged assets."
argument-hint: "Describe the logo change and target asset files or dimensions"
---

# Image Creation

Use this workflow for app logos and icons in this repository, especially the SVG/PNG pair under `media/`.

## Repository Conventions

- `media/icon.svg` is the editable vector source. Make visual edits there first.
- `media/icon.png` is the packaged VS Code extension icon. `package.json` points to this PNG.
- Keep the SVG and PNG visually identical. Do not hand-edit the PNG after rasterizing it.
- Preserve the existing icon canvas and `viewBox` unless the request calls for a different size or aspect ratio. The current icon is 256 by 256 pixels.
- There is no dedicated icon-generation script. Do not add a dependency or build step just to regenerate this pair unless automation is requested.

## Workflow

1. Inspect the existing SVG and PNG before editing. Note their dimensions, `viewBox`, colors, existing silhouette, and how small details read at icon size. Use the image viewer for PNGs rather than treating binary files as text.
2. Identify the smallest SVG change that achieves the requested composition. Keep important foreground details, edges, and color hierarchy clear. For a watermark, place its path before the foreground artwork and use restrained opacity so the existing icon remains legible.
3. Edit the SVG source. Preserve or update its `<title>` and `<desc>` so they still describe the final image. Keep transforms local to the inserted or adjusted group; avoid changing the whole canvas just to place one element.
4. Rasterize to a temporary PNG first on macOS:

   ```sh
   sips -s format png media/icon.svg --out /tmp/app-icon-preview.png
   sips -g pixelWidth -g pixelHeight /tmp/app-icon-preview.png
   ```

   The current source rasterizes successfully with `sips`. Confirm that the output dimensions match the intended package dimensions before replacing the checked-in PNG.
5. Open the temporary raster with the image viewer and inspect the complete icon at native size. Check that the mark is recognizable, the foreground is not obscured, and contrast still works against the icon background.
6. Once the preview is correct, regenerate the package asset:

   ```sh
   sips -s format png media/icon.svg --out media/icon.png
   sips -g pixelWidth -g pixelHeight media/icon.png
   ```

7. Confirm `package.json` still references the intended PNG, review `git diff -- media/icon.svg media/icon.png`, and run `git diff --check -- media/icon.svg media/icon.png`. Keep unrelated files untouched.

## SVG Placement Notes

- Use the SVG `viewBox` coordinate system when positioning paths. For an imported logo path, scale and translate its own group rather than rewriting the path coordinates.
- Set an explicit fill for monochrome artwork. If the source mark is white and the icon background is dark, keep the source fill white and control subtlety with group opacity.
- Put background marks behind axes, bars, charts, text, and other foreground artwork in document order.
- Inspect at the final raster size, not only in a large SVG preview. Fine path detail and low-opacity marks can disappear or merge at small sizes.
- Avoid adding labels, gradients, effects, or decorative elements unless they are part of the requested design and remain clear at icon scale.

## Validation Boundaries

- `sips` validates successful SVG rasterization and reports raster dimensions; it does not validate that the composition is visually good. Always inspect the generated PNG.
- A clean diff check does not prove the PNG matches the SVG. Regenerate the PNG from the final SVG after the last vector edit.
- If `sips` is unavailable or cannot render a particular SVG feature, use an already-installed SVG rasterizer and confirm the same dimensions. Do not silently substitute a screenshot or change the asset dimensions.
