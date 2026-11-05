# KARI artwork

The runtime character is `kari.png`, generated from the owner's supplied character reference using the built-in image generation tool. It is a transparent 2D cutout, not a sprite atlas or a 3D model. Motion currently uses local CSS transforms/glitch layers; a future reviewed atlas can supply additional facial poses without changing the embed contract.

No inference calls are made for character animation. Keep future compressed artwork within the documented transfer/decoded-memory budgets and preserve transparent edges.
