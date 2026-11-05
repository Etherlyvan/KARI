# KARI runtime cutout

Generated with the built-in `image_gen` tool on 5 November 2026 using the owner's KARI character sheet and the two approved visual concept previews as identity references. The source output was copied into this project as `assets/kari.png`; no website screenshot or personal photograph is used as the runtime asset.

Actual file: PNG with alpha, 1,254 × 1,254 pixels, 459,335 bytes. A single RGBA decode is approximately 6.0 MiB before browser/GPU overhead. This exceeds the earlier 1,024-pixel design target, so evaluate it on target mobile devices before claiming that target passed. The widget transfer itself measured about 8.1 KiB gzip. No separate animation rendering service is required.

This release animates a single cutout using CSS movement/glitch. Independent eye, hair and limb animation needs a prepared atlas or segmented assets in a later art pass; do not describe those as already implemented.

## Final generation prompt

```text
Use case: stylized-concept. Asset type: production transparent 2D character cutout for a tiny website companion, NOT a showcase or UI screenshot.
Use the KARI character shown in the conversation's reference character sheet and two showcase images as identity references only. Create ONE clean full-body front/three-quarter-view KARI in a friendly poised floating idle stance, both hands visible, one hand slightly open inviting conversation. Preserve enormous sharp swept hot-magenta hair, neon green expressive eyes and small mischievous smile on a dark face, dark purple-black slender humanoid body/limbs with angular green chest detail and magenta boot/limb accents. Adult-styled cartoon mascot; nonsexual, practical stylized bodysuit. Keep recognizable long angular hair silhouette from reference, not a round chibi head. Include only 3–5 tiny magenta fragment shapes close to the character, minimal green accent. Body/head remain clearly readable at 110px display height.
Output must be a SINGLE isolated character with a genuinely transparent alpha background. No background, checkerboard painted into the image, floor, frame, type, letters, logo, labels, duplicate poses, turnarounds, panels, or UI. Center full body with all hair/limbs/fragments inside the canvas, about 8% clear transparent margin. Keep lighting flat clean cel-shaded, 2D illustrated cutout with crisp hard edges; solid limited colors, minimal shading, no grain or painterly texture, no blur or large glowing aura. Aim for a compact square 1024x1024 asset suitable for efficient lossless PNG storage. This is an asset to be reused with CSS motion and speech bubble, not an animation atlas.
```
