# NOTICE

PIX LIGHTS OUT
Copyright (c) 2026 KaseliaePenguin

## 1. Licenses of this repository

| Part | Files | License |
| --- | --- | --- |
| Source code | `src/`, `signaling/`, `scripts/`, `tools/`, configuration files | MIT License (see `LICENSE`) |
| Game assets | `public/assets/` (images, sounds, data), `public/icons/`, `promo/` | Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0), https://creativecommons.org/licenses/by-nc/4.0/ |
| Documents | `docs/`, `README.md` | CC BY-NC 4.0 |

When you reuse the game assets, credit "PIX LIGHTS OUT by KaseliaePenguin" and link to https://github.com/KaseliaePenguin/pix-lights-out . Commercial use of the assets is not permitted under this license.

## 2. AI-generated assets

All images, background music and sound effects in this game were generated with locally run AI models and then edited (cropping, palette reduction, looping, loudness normalization). Prompts for the music were written without naming real songs, series or composers (see `docs/sound/sound-guide.md`). The bitmap font (`public/assets/ui/ui-font-5x7.png`) was drawn for this project.

| Asset | Model | Model license |
| --- | --- | --- |
| Pixel art images | Stable Diffusion XL base 1.0 (Stability AI) | CreativeML Open RAIL++-M |
| Pixel art style | Pixel Art XL LoRA (nerijs/pixel-art-xl) | CreativeML Open RAIL-M |
| Background music | ACE-Step v1 3.5B (ACE Studio / StepFun) | Apache License 2.0 |
| Sound effects | Stable Audio Open 1.0 (Stability AI) | Stability AI Community License |
| Text encoder for sound effects | T5 base (Google) | Apache License 2.0 |

The models themselves are not included in this repository or in the published game.

### Stable Audio Open 1.0

Sound effects were generated with Stable Audio Open 1.0. Powered by Stability AI.

This Stability AI Model is licensed under the Stability AI Community License, Copyright © Stability AI Ltd. All Rights Reserved.

A copy of the agreement is included at `licenses/stability-ai-community-license.txt` (source: https://stability.ai/community-license-agreement). This project is a free, non-commercial hobby project.

## 3. Third-party services

The online mode connects browsers directly with WebRTC. It uses public STUN servers (Google `stun.l.google.com`, Cloudflare `stun.cloudflare.com`) and a signaling relay running on Cloudflare Workers to exchange encrypted connection information. These services see the IP address of the connecting device. The game is hosted on GitHub Pages.

The game does not bundle any third-party runtime libraries. Development tools (TypeScript, Vite, sharp, esbuild, Wrangler) are used only for building and are not distributed with the game.

## 4. Trademarks

PIX LIGHTS OUT is an independent fan-made game. It is not affiliated with, endorsed by or sponsored by Formula One Group, the FIA or any racing team. Team names and liveries in the game are fictional. All trademarks belong to their respective owners.
